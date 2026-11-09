# OpenCode v1.17.18 上游迁移原则与合并治理规范

Date: 2026-07-13

Status: proposal; source/release research and two independent design reviews complete; no production merge has been performed; implementation remains blocked until the missing `ses_138a` evidence is recovered

Target: `anomalyco/opencode` release `v1.17.18` at `b1fc8113948b518835c2a39ece49553cffe9b30c`

Local baseline: `dev-smark@3d34a00d7cfe7c17375cfe879763e39244699af3`, package version `1.15.10-smark`

Failed-merge archive: `origin/dev@7acb9ff2403d16baf76655acf27d60c8ef9b1fe6`; evidence only, never a migration source

Scope: This document defines the migration target, source-of-truth rules, schema and configuration ownership, local feature disposition, database migration policy, conflict protocol, verification gates, and stop conditions. It does not implement the migration, modify a database, regenerate an SDK, or claim feature parity.

## 1. Executive decision

The next synchronization must be a **forward port onto a clean `v1.17.18` base**, not another direct merge of `upstream` into `dev-smark`.

The governing decisions are:

1. Create the integration branch from the immutable upstream tag `v1.17.18`.
2. Treat the SMARK branch and its 466 local-only commits as a behavior inventory, not as a tree to merge wholesale.
3. Adopt upstream package ownership, public schemas, branded IDs, base SQL tables, migration engine, EventV2, protocol/OpenAPI, SDK generation, TUI package, and OpenTUI runtime as authoritative.
4. Preserve SMARK product behavior only as a typed additive extension, a separate local table/module, or an adapter at an upstream seam.
5. Preserve the V1/V2 compatibility boundaries that actually exist in `v1.17.18`, but never add a third SMARK authority or an unowned writer. A future V1 retirement is a separate migration, not a prerequisite invented by this synchronization.
6. Never use the failed `origin/dev` archive as a code donor. It is useful only for post-mortem evidence and locating earlier mistakes.
7. A green typecheck or package test suite is not a release gate by itself. The built binary, isolated database, real TUI renderer, generated clients, provider request shape, and cross-platform behavior must also pass.
8. Never run an upstream migration against the only copy of a divergent SMARK database. The default SMARK path is a read-only source plus a newly created target database, followed by verified import and atomic cutover.

This is a controlled forward-port strategy rather than a tree-layering strategy: preserve upstream's current compatibility architecture, replace SMARK-owned duplicates, and re-add local behavior only at explicit seams.

## 2. Research baseline and hard facts

### 2.1 Online release facts

| Item | Value |
| --- | --- |
| Release | `v1.17.18` |
| Release date | 2026-07-09 18:51:45 UTC |
| Tag commit | `b1fc8113948b518835c2a39ece49553cffe9b30c` |
| Release URL | <https://github.com/anomalyco/opencode/releases/tag/v1.17.18> |
| Source tree | <https://github.com/anomalyco/opencode/tree/v1.17.18> |
| Current upstream `dev` at research time | `34e58090595d44e3e7cc37498f16753a98627456` |

The current `dev` commit is deliberately excluded. A release migration must not silently include post-release development commits.

The `v1.17.18` release note itself is small:

- prevent crashes and bad pricing when GitHub Copilot reports a zero billing batch size;
- add a model-specific system prompt for Meta Muse Spark.

That small note is misleading if read in isolation. From `v1.17.7` through `v1.17.18`, upstream contains 741 commits and extensive architecture changes.

### 2.2 Git divergence

The common ancestor between the current local baseline and `v1.17.18` is:

```text
e4cc4e1682766853bccfb7acbd937a90728eeac2
```

| Measure | Result |
| --- | ---: |
| Local-only commits after the common ancestor | 466 |
| Upstream-only commits through `v1.17.18` | 1,856 |
| Files touched by both sides | 215 |
| Upstream-side changed files | 3,075 |
| Upstream-side additions/deletions | +388,029 / -183,320 |
| Local-side changed files | 648 |
| Local-side additions/deletions | +138,862 / -82,746 |

A direct virtual merge reports 206 conflicts:

| Conflict class | Count |
| --- | ---: |
| Content | 141 |
| Modify/delete | 43 |
| File location | 19 |
| Directory rename split | 1 |
| Add/add | 1 |
| Rename/delete | 1 |

This is larger than the failed v1.17.7-era merge. Direct conflict resolution is therefore not an acceptable primary strategy.

### 2.3 Incremental churn from v1.17.7 to v1.17.18

The incremental range changes 1,769 files with +167,929 / -42,314 lines. The highest file counts are:

| Area | Changed files |
| --- | ---: |
| `packages/app` | 343 |
| `packages/core` | 340 |
| `packages/opencode` | 278 |
| `packages/session-ui` | 102 |
| `packages/ui` | 94 |
| `packages/schema` | 74 |
| `packages/stats` | 55 |
| `packages/console` | 55 |
| `packages/web` | 48 |
| `packages/tui` | 44 |
| `packages/llm` | 40 |
| `packages/codemode` | 40 |
| `packages/plugin` | 33 |
| `packages/server` | 31 |
| `packages/protocol` | 26 |
| `packages/desktop` | 21 |
| `packages/client` | 21 |

The package counts show that the change is not centered on one CLI file. It changes public schemas, core domain ownership, protocol generation, session rendering, providers, TUI runtime, and desktop state management together.

### 2.4 Local worktree qualification

The repository had unrelated uncommitted work during this research, including stats, docs, model snapshot, web docs, and a third-party submodule. Those changes were excluded from the Git baselines and must not be folded into the migration accidentally.

### 2.5 Evidence availability qualification

The user identified `docs/session-ses_138a.md` as the complete record of the failed synchronization. At the time this proposal was independently reviewed, that path did not exist in the working tree and `git log --all -- docs/session-ses_138a.md` yielded no repository history. It therefore cannot currently be cited as a reproducible repository artifact.

This proposal uses the available `docs/merge-upstream-log.md`, current source, Git topology, and the immutable upstream tag as evidence. Before implementation begins, Phase 0 must recover the original `ses_138a` record or export it to a stable read-only artifact, record its SHA-256, and link every additional finding into the feature and failure ledgers. Until then, claims that depend only on that missing record are provisional and may not be used to waive a gate.

## 3. What upstream changed between v1.17.7 and v1.17.18

### 3.1 Release-level summary

| Release | Material changes relevant to migration |
| --- | --- |
| `v1.17.8` | Faster Session timelines without flicker or scroll jumps; OpenAI-compatible MCP schema sanitation; Cloudflare API key propagation; MCP timeout refresh and OAuth/error fixes. |
| `v1.17.9` | Agent step limits produce a final answer instead of failing; provider header and model detection fixes; GLM-5.2 high/max thinking; cache-preserving follow-up prompts. |
| `v1.17.10` | MCP instructions/resources, managed Provider integrations, `--mini`, namespaced plugin hooks, V2 plugin API, Session snapshot/revert work, cross-platform ACP and Snapshot fixes. |
| `v1.17.11` | Session snapshots and revert controls; significant tab, draft, Session navigation, Provider lifetime, and desktop-state corrections. |
| `v1.17.12` | MCP OAuth/skill/provider fixes; TUI yolo mode; ServerAuth transport; live SDK events, active Sessions, durable history, runtime operations, and Permission request endpoints. |
| `v1.17.13` | OpenAI-compatible reasoning enforcement; Copilot item-ID replay fix; V2 model picker and desktop Session isolation work. |
| `v1.17.14` | Code mode MCP adapter; MCP metadata/output-schema fixes; Copilot endpoint routing; equivalent directory matching; TUI spinner registration fix; OpenTUI 0.4.3. |
| `v1.17.15` | Unavailable Config directory handling; Z.ai context-overflow classification; home-relative Permission path handling. |
| `v1.17.16` | Grok reasoning variants and xAI cache/PDF behavior; desktop file browser, review state, and route corrections. |
| `v1.17.17` | Meta reasoning/request handling; V2 subagent/revert/free-model UI refinements. |
| `v1.17.18` | Copilot zero billing-batch defense; Meta Muse Spark system prompt. |

### 3.2 Structural changes not captured by short release notes

The source and commit history show deeper changes:

1. Public domain contracts moved into `packages/schema`.
2. Config V2, Database, base SQL tables, EventV2, Session projections, Provider catalog, and many domain services moved into `packages/core`.
3. V1 public contracts were isolated under `packages/core/src/v1` and migrated at input boundaries.
4. Server contracts were extracted into `packages/protocol`; generated clients and HttpApi clients expanded.
5. A standalone `packages/tui` became the TUI runtime owner.
6. `packages/session-ui` became a shared Session presentation package for app surfaces.
7. Session execution gained durable input admission, ordered message projections, context epochs, run coordination, snapshots, and runtime endpoints.
8. Provider and Model information moved toward a normalized Catalog with Provider-level and Model-level API/request composition.
9. Native and AI SDK LLM routes now converge on common LLM events.
10. OpenTUI was upgraded to 0.4.3, with an explicit spinner-registration module and one-version dependency expectations.
11. App/Desktop state became server-scoped, tab-scoped, and Session-scoped to prevent cross-server and cross-tab lifetime leaks.

## 4. Merge vocabulary and classification

Every local behavior or conflicting file must receive exactly one classification before implementation.

### 4.1 U: Upstream authority

The upstream definition is the single runtime source of truth. Local code may consume it but may not copy or redefine it.

Examples: Provider/Model IDs, each upstream-owned Config V1/V2 surface at its current boundary, Session base tables, EventV2, OpenAPI generation, TUI package ownership.

### 4.2 E: Local additive extension

The local behavior introduces a distinct product concept or optional field without replacing an upstream concept. It must extend the canonical module or use a separate local module/table.

Examples: Goal, RequestUsage, Session preview projection, shell encoding, bash compression.

### 4.3 A: Adapter

The local behavior translates an external or legacy representation into the upstream interface. The adapter must not become another source of domain truth.

Examples: V1/local Config migration, Provider alias materialization, ClaudeCode request decoration, NetworkProxy transport, old JSON import.

### 4.4 R: Retire

The old implementation duplicates or conflicts with upstream ownership and must not survive except as test fixtures or migration input.

Examples: local ProviderID/ModelID brands, the old Database singleton, legacy SyncEvent as the primary write path, old TUI implementation paths, generated SDK copied from the failed merge.

### 4.5 Classification rules

1. A concept cannot be both U and E. Local fields may extend an upstream type, but the base type remains U.
2. An adapter accepts legacy/external input and emits canonical output. Canonical code must never call back into the legacy model.
3. A compatibility import that exists only to make old source compile is not automatically an adapter.
4. A local feature without a behavior test remains unclassified and cannot be merged.
5. If the feature cannot identify an upstream seam, redesign the feature; do not restore the old package boundary.

## 5. Canonical ownership matrix

| Concern | Authoritative source after migration | Local disposition | Rule |
| --- | --- | --- | --- |
| Public IDs and wire contracts | `packages/schema/src/**` | R for duplicate brands | No local `ProviderID`, `ModelID`, `ProjectID`, Session/Permission wire clone. |
| Config V1 operational surface | `packages/opencode/src/config/config.ts`, `packages/core/src/v1/config/**` | U/A/E at this upstream boundary | `v1.17.18` still uses `@opencode/Config` broadly and writes project `config.json`; do not pretend it has retired. |
| Config V2 core surface | `packages/core/src/config.ts`, `packages/core/src/config/**` | U/A/E at this upstream boundary | Core consumers use `@opencode/v2/Config`; add no third SMARK schema or loader. |
| Config V1-to-V2 migration | `packages/core/src/v1/config/migrate.ts` | A | Extend one-way migration for SMARK legacy keys only where a V2 consumer needs them. |
| Config discovery and writes | The two upstream services and their documented precedence | U | Preserve current file discovery/writer behavior until a separately approved atomic Config convergence. |
| Provider/Model runtime shape | `packages/schema/src/provider.ts`, `model.ts`; `packages/core/src/catalog.ts` | A/E | Alias and special protocols materialize canonical records. |
| Database service | `packages/core/src/database/database.ts` | E for operational policy | Keep one `Database.Service`; no second singleton or transaction context. |
| Base SQL tables | `packages/core/src/<domain>/sql.ts` | E via separate tables | Never copy Session/Project/Permission/Share tables into `packages/opencode`. |
| Database migration engine | `packages/core/src/database/migration.ts` and ordered generated list | E via later migration | No parallel Drizzle folder runner in production. |
| Storage paths | `packages/core/src/database/path.ts` | U | Preserve path normalization and branded absolute paths. |
| Event model | `packages/core/src/event.ts`, `packages/schema/src/event.ts` | A then R for SyncEvent | New writes and projections use EventV2. |
| Legacy transcript wire schema | `packages/core/src/v1/session.ts` / `packages/schema` Session V1 contracts | E only through approved fields/metadata | `message-v2.ts` may implement hydration, not redefine the union. |
| New Session message/execution model | `packages/core/src/session/**` | E at service/projection seams | Preserve sequence, input, context epoch, replay, and projector invariants. |
| HTTP contract | `packages/protocol/**` and upstream HttpApi group assembly | E | Local endpoints must be fully typed in the same contract graph. |
| HTTP handlers | `packages/server/**` and canonical application handlers | E | Thin handlers; no `as any` registration or hand-written OpenAPI repair. |
| OpenAPI and SDK | generated from canonical contracts | R for copied generated output | Regenerate after source stabilization. |
| Permission schema | `packages/schema` / `packages/core` Permission modules | A/E | Auto-review is a policy service, not a second Ruleset. |
| Tool parameter/result contracts | upstream Tool schema and registry interfaces | E | Preserve local execution behavior behind canonical Tool interfaces. |
| LLM events/runtime | `packages/llm`, core/opencode LLM route adapters | A/E | Provider adapters emit canonical requests/events. |
| TUI | `packages/tui` | E | Reimplement local UI behavior inside the upstream package. |
| OpenTUI runtime | root catalog 0.4.3 and upstream lockfile closure | U | One version and one renderer/context graph. |
| App/Desktop/Session UI | upstream `packages/app`, `desktop`, `session-ui`, `ui` | E only | Do not overwrite the new component/state architecture. |
| CLI run/mini/attach | upstream CLI/runtime | E/A | Shared daemon, if retained, must be an explicit host adapter. |
| Stats | SMARK local projection/CLI feature | E | Rebase reads onto canonical tables and token semantics; no base schema fork. |
| Voice/Notebook/VS Code bridge | SMARK local product modules | E/A | Register through upstream Tool/TUI/plugin seams. |

## 6. Configuration migration policy

### 6.1 The actual v1.17.18 Config architecture

`v1.17.18` does **not** yet have one runtime Config service. It has two upstream-owned surfaces with different consumers and responsibilities:

| Surface | Evidence in v1.17.18 | Current authority |
| --- | --- | --- |
| opencode V1 operational service | `packages/opencode/src/config/config.ts` defines `@opencode/Config`, its `Info` extends `ConfigV1.Info`, and Provider, Session, Tool, MCP, CLI, server, Agent, plugin, and runtime code still import it. | Upstream authority for those existing consumers, global/project mutation, plugin origins, and compatibility behavior. |
| core V2 service | `packages/core/src/config.ts` defines `@opencode/v2/Config` and ordered `Entry` documents/directories used by core services. | Upstream authority for V2 core consumers and V1-to-V2 decode at that boundary. |

The V1 service discovers global files in `opencode.jsonc`, `opencode.json`, `config.json` order and `update()` writes project `config.json`. The V2 service reads `opencode.json` and `opencode.jsonc`, can decode/migrate V1 input, and is currently read-oriented rather than a replacement for all V1 mutation APIs. Calling `config.json` a read-only legacy input or claiming that V1 already has no runtime consumers would contradict the target tag.

The synchronization rule is therefore:

1. Preserve both upstream surfaces and their real consumer boundaries exactly enough to keep `v1.17.18` behavior.
2. Remove the SMARK fork as an independent third loader, schema authority, precedence graph, or writer.
3. Attach a local field to the upstream surface that owns its consumer today; define its semantics once and provide a typed one-way adapter when the other upstream surface needs it.
4. Do not make application code parse raw Config files or choose between V1 and V2 dynamically.
5. Treat full V1 retirement and a single writable V2 service as a later architecture project requiring an ADR, complete consumer inventory, writer migration, and atomic file-format cutover. It is not an invented exit criterion for this upstream synchronization.

### 6.2 Existing upstream V1-to-V2 mappings

Use upstream mappings rather than inventing another migration:

| Legacy field | Canonical field |
| --- | --- |
| `permission` and `tools` | `permissions` ordered rules |
| `agent` and `mode` | `agents` |
| `snapshot` | `snapshots` |
| `attachment` | `attachments` |
| `command` | `commands` |
| `reference` / `references` | `references` |
| `plugin` | `plugins` |
| `provider` | `providers` |
| `autoshare` | `share` |
| `compaction.preserve_recent_tokens` | `compaction.keep.tokens` |
| `compaction.reserved` | `compaction.buffer` |
| `experimental.mcp_timeout` | `mcp.timeout.request` |

The upstream migrator is `packages/core/src/v1/config/migrate.ts`. SMARK compatibility belongs there or in one dedicated, one-way SMARK migration adapter immediately after it. It must not fork `ConfigV1.Info`, `Config.Info`, or file discovery.

### 6.3 SMARK fields with a clear target seam

The V2 locations below are long-term semantic homes, not evidence that every current V1 consumer can be switched during this synchronization. During the compatibility period, the same semantic field may need an upstream V1 schema entry plus a typed V1-to-V2 mapping, but it must have one definition of meaning, one precedence rule, and one test matrix.

| Local field | Target | Decision |
| --- | --- | --- |
| `tool_output.bash_compression` | V1 Tool consumer bridge; V2 `ConfigToolOutput.Info` semantic home | E: additive optional field with one default and precedence rule. |
| `tool_output.shell_encoding` | V1 Shell consumer bridge; V2 `ConfigToolOutput.Info` semantic home | E: additive optional field; preserve current enum and Windows behavior. |
| `compaction.tail_turns` | Active upstream compaction owner; V2 `ConfigCompaction.Keep.turns` semantic home | E: do not create a parallel compaction Config object. |
| `compaction.preserve_recent_tokens` | `compaction.keep.tokens` | A: upstream already defines this semantic location. |
| `compaction.reserved` | `compaction.buffer` | A. |
| `experimental.mcp_timeout` | `mcp.timeout.request` | A. |
| Provider alias `extends` | Provider materialization adapter | A: not a Provider wire field. |
| Provider client-version/header decoration | Provider request adapter | A. |

### 6.4 SMARK fields requiring an explicit product decision

The following must not be silently carried into the canonical schema:

| Local field | Required decision |
| --- | --- |
| `logLevel` | Prefer CLI/environment/observability configuration. Add a canonical field only if runtime updates are a supported product behavior. |
| `server` | Separate server launch configuration from portable project Config, or add a canonical server module with documented ownership. |
| `disabled_providers` / `enabled_providers` | Migrate to canonical Provider enable/disable policy. Do not keep list policy and per-Provider state as competing truths. |
| `small_model` | Reconcile with upstream small-model selection. Preserve only if an explicit user override is still required. |
| `layout` | Retire unless an upstream UI consumer still supports the behavior. |
| `goal_max_turns` | Move to a Goal extension module, preferably under a namespaced SMARK section or `goal.max_turns`. |
| `experimental.primary_tools` | Move to Agent/Tool policy; do not make Tool availability depend on an unrelated Config fork. |
| `experimental.continue_loop_on_deny` | Move to Permission/run-loop policy with a typed behavior test. |
| `experimental.openTelemetry` | Reconcile with upstream observability configuration before adding anything. |

### 6.5 Compatibility rules

1. Old SMARK and upstream Config files must decode through hashed fixtures before any field is removed.
2. A dry run must parse the raw JSON/JSONC object and enumerate source key paths **before** invoking the upstream V2 decoder. `Schema.decodeUnknownOption(..., { onExcessProperty: "ignore" })` is useful for runtime tolerance but cannot prove migration completeness.
3. Decode may accept aliases. Writes must continue to follow the actual `v1.17.18` owner and file behavior until an atomic writer cutover is separately approved; this proposal must not silently redirect every write to a hypothetical V2 writer.
4. Deprecated keys must produce an actionable warning containing source file and JSON pointer.
5. Each consumer must import its assigned upstream Config service; no consumer may inspect the source format and branch between local, V1, and V2 schemas.
6. Unknown local fields must not be silently discarded. Unconsumed paths, invalid values, and conflicting aliases fail the migration unless a named product decision explicitly retires them.
7. `config.json` remains an upstream-supported global candidate and the current project update target in `v1.17.18`; it cannot be reclassified as legacy-only during this migration.
8. A value present under both a legacy and canonical key must follow an explicit precedence rule and report the losing source. Last-write-wins by accident is prohibited.

### 6.6 Required Config migration report

Every fixture and real dry run emits a machine-readable report with:

```text
source_path
source_sha256
parser_and_version
scope_and_precedence_position
raw_json_pointer_paths
consumed_paths_with_decoder_or_adapter
canonical_paths_emitted
defaulted_values
deprecated_paths_and_warnings
conflicts_and_selected_source
unconsumed_paths
target_runtime_owner: opencode-v1 | core-v2 | both-via-adapter
writer_target_if_mutated
round_trip_assertions
result: PASS | FAIL
```

Pass requires zero unexplained paths, zero conflicting values without a recorded decision, and exact preservation of all retained semantics. A decoder returning `Option.none`, ignoring an excess property, or successfully producing a partial `Config.Info` is not sufficient evidence.

### 6.7 Config exit condition

The Config phase passes when the upstream V1 and V2 surfaces have an explicit consumer/field ownership map, no third SMARK Config service or competing writer exists, every retained local key has a typed disposition, and all migration reports pass. The phase does **not** require prematurely deleting an upstream V1 service that the target tag still uses.

## 7. Schema and branded ID policy

### 7.1 Upstream brands are authoritative

Use these upstream definitions everywhere:

- `ProviderV2.ID` from `packages/schema/src/provider.ts`;
- `ModelV2.ID` and `ModelV2.Ref` from `packages/schema/src/model.ts`;
- Project, Session, Workspace, Message, Part, Permission, Event, and other public IDs from `packages/schema` or their `packages/core` re-exports.

The local `packages/opencode/src/provider/schema.ts` brands `ProviderID` and `ModelID` must retire. Equal string values do not make two Effect brands equivalent.

### 7.2 Legacy decode only

A legacy decoder may call `CanonicalID.make(String(value))`. That conversion must happen once at an input or database migration boundary. Canonical services must not accept unions of old and new brands.

### 7.3 Message and Part extensions

The upstream Session V1 union is the wire and persisted legacy transcript authority. Local additions must follow one of these patterns:

1. An upstream-compatible optional field accepted by the canonical schema.
2. A namespaced metadata field, when the data is representation or diagnostics rather than identity.
3. A separate projection table, when the data has its own query/lifecycle semantics.

Request-level accounting does not belong in a forked Message union. The existing `request_usage` and `request_usage_assistant` tables are the correct category, but must reference upstream Session/Message IDs and be updated from canonical events.

### 7.4 No schema shadowing

The following are prohibited:

- a local file exporting a same-named schema with a different brand or field set;
- an `as any` cast between handler and protocol schema;
- manually editing generated SDK types to accept a local shape;
- decoding one shape and writing another shape into the same JSON column without a versioned migration;
- retaining a compatibility re-export after all callers can import the canonical package.

## 8. Database and migration policy

### 8.1 Adopt the upstream database service

`packages/core/src/database/database.ts` owns:

- `Database.Service` and its Effect layer;
- database path and installation-channel selection;
- WAL, foreign key, cache, checkpoint, and migration initialization;
- a single shared database interface.

The local singleton in `packages/opencode/src/storage/db.ts` and its LocalContext transaction system must not coexist as a second owner.

### 8.2 Preserve local operational behavior as policy, not ownership

The following local behaviors may be reintroduced through the canonical database layer after measurement:

- `OPENCODE_DB_DURABLE` selecting `synchronous=FULL`;
- a longer busy timeout for an explicitly retained shared-daemon ownership model;
- large-WAL diagnostics;
- graceful checkpoint diagnostics.

They must not replace the upstream migration call, service tag, path rules, transaction model, or Effect layer.

The old `skipMigrations` behavior that rewrites every migration to `select 1` must not be ported. Skipping schema evolution while running new code creates untestable database states.

### 8.3 Base tables are upstream-owned

Use `packages/core/src/session/sql.ts`, `project/sql.ts`, `permission/sql.ts`, `share/sql.ts`, `event/sql.ts`, and other core domain tables unchanged as the starting point.

Important upstream fields/tables that the local schema lacks include:

- `session.metadata`;
- normalized `directory` and `path` custom columns;
- ordered `session_message.seq` and uniqueness constraints;
- `session_input` admission/promotion state;
- `session_context_epoch` baseline and snapshot;
- `project_directory` ownership/strategy data;
- Event sequence and durable replay state.

These cannot be omitted to preserve the older local table definitions.

### 8.4 Local independent tables

These are valid additive candidates:

| Table | Disposition |
| --- | --- |
| `request_usage` | Keep as an independent projection after rebasing FKs/types and event hooks. |
| `request_usage_assistant` | Keep with the same constraints; verify every terminal assistant path writes/finalizes a row. |
| `session_goal` | Keep as an independent Goal aggregate/projection; use canonical Session ID and EventV2. |
| Other local tables | Keep only after proving they are not now owned upstream and documenting lifecycle/retention. |

Do not copy upstream-owned tables into `packages/opencode` merely to keep local imports stable.

### 8.5 Destructive upstream migrations and forked-journal risk

The target migration list contains operations that are safe only under upstream's pre-launch assumptions, not under an unexamined SMARK production database. Two concrete examples are:

- `20260603040000_session_message_projection_order`: deletes every `session_message` row before adding required `seq` ordering;
- `20260622170816_reset_v2_session_state`: deletes `session_context_epoch`, `session_input`, `session_message`, `event`, `event_sequence`, clears `session.workspace_id`, and deletes `workspace`.

The upstream `applyOnly()` compatibility path also seeds `migration` from `__drizzle_migrations` by `name` when the new journal is empty. It does not compare migration body hashes or prove postcondition equivalence. That name-only bridge is valid for the upstream history it was written for, but it is not enough for a fork whose same-prefix migrations and later local migrations may differ.

Therefore, the old rule “run all upstream migrations, then run a SMARK bridge” is prohibited for a divergent SMARK database. A bridge that runs after a destructive delete is too late.

### 8.6 Default SMARK shadow-copy migration

The default migration for an existing SMARK installation is side-by-side reconstruction, not in-place mutation:

1. Acquire an exclusive cross-process migration lock, stop all application/daemon processes, and refuse to continue while any other database owner or open writer exists. The dedicated migrator is the only process permitted under this lock.
2. Before mutating checkpoint state, use the SQLite online backup API through that stable dedicated connection to create a self-contained immutable rollback database. Close and `fsync` the backup, run `quick_check`/`integrity_check`, and record source/backup logical digests, sizes, and SHA-256. An ordinary live three-file copy is never the rollback authority.
3. Only after the verified rollback exists, run `PRAGMA wal_checkpoint(TRUNCATE)` on the source; require `busy = 0` and every logged frame checkpointed. Close that final SQLite connection, prohibit all later source writes, require no non-empty source `-wal` or `-shm`, and optionally retain a second byte-identical copy of the now-closed main file for forensics.
4. Inspect the frozen source through a read-only connection without starting either application binary. Export normalized `sqlite_master`, table/index/trigger definitions, FK checks, row counts, logical content digests, `__drizzle_migrations`, `migration`, and `data_migration`.
5. Build a migration catalog that maps every source and target migration ID to origin, body hash, postconditions, and one status: `exact-artifact`, `mapped-equivalent`, `same-id-divergent`, `source-only`, `target-only`, or `unknown`.
6. Build a table/column plan before data moves. Every source object is classified `copy`, `transform`, `reproject`, `archive-only`, or `reject`; an omitted non-empty object is a failure.
7. Create a new sidecar target database in the same directory/filesystem as the active path through the exact `v1.17.18` empty-database path. This produces the upstream head schema and canonical `migration` journal without replaying destructive pre-launch migrations over source data.
8. Apply reviewed SMARK extension-schema migrations **after** the upstream head to create only independent extension tables and fields.
9. After the canonical Session/Event importer exists, import upstream-owned data through typed decoders and explicit transforms. Import local extension data only through its recorded U/E/A/R disposition.
10. Rebuild projections from the chosen canonical source. Do not blindly copy `event`, `event_sequence`, ordered `session_message`, or workspace links merely to recover row counts. Aggregate sequence must validate; where truthful sequence cannot be derived, retain legacy transcript data and an audit record rather than fabricating EventV2 history.
11. Run all schema, relationship, projection, Config, and real-binary gates against the sidecar path while the frozen source and rollback copy remain untouched.
12. Close/checkpoint the target, record final hashes and completion metadata, then execute the Section 8.9 cutover state machine. Retain the immutable rollback database until an explicitly defined rollback window expires.

An in-place path is allowed only for a database proven to be an exact upstream lineage: every applied migration has matching identity/body/postconditions, the dry-run plan contains no fork-only state, and destructive-migration data disposition is explicitly safe. The current SMARK fork must be assumed ineligible until that proof exists.

### 8.7 Three migration state domains

The implementation must not collapse three different histories:

| State | Meaning | Migration rule |
| --- | --- | --- |
| `migration` | Target TypeScript schema migration journal | In the sidecar, it reflects the target schema creation and reviewed post-head SMARK schema extensions only. |
| `__drizzle_migrations` | Legacy Drizzle schema history | Read as evidence and reconcile by ID, hash, and postcondition; never copy or name-seed blindly into the target journal. |
| `data_migration` | Completion state for idempotent/background data jobs | Reconcile each job by name, implementation hash, input assumptions, and verified postcondition; it is not a schema journal. |

A journal row is an identity claim, not body-hash evidence. For each `__drizzle_migrations.name`, resolve the exact migration file from the frozen `dev-smark` commit, hash its raw bytes plus referenced snapshot, and run independent schema/data postcondition queries. For each target ID, hash the exact TypeScript migration module and its position in `migration.gen.ts`. `mapped-equivalent` requires an explicit source-hash/target-hash mapping, proved postconditions, and independent reviewer approval; a missing file, ambiguous name, or database-only hash is `unknown`, not equivalent.

The current local `DataMigration.Service` includes `session_usage_from_messages` and writes its completion row only after paged work completes. Its disposition is **A then R**:

1. Do not port the background service or copy its `session_usage_from_messages` completion row into the target.
2. Replace it with a versioned shadow-import transform, `smark_session_usage_import_v1`, that runs only after canonical legacy Message/Part rows exist and before the target application layer starts.
3. Recompute each Session's cost/tokens from decoded legacy assistant usage using the frozen local algorithm, compare it with source `session.cost/tokens_*`, and independently compare available `step-finish` Part totals with the target `SessionProjector` usage semantics.
4. Any unexplained divergence, undecodable non-empty usage, or non-zero source total with no auditable source blocks that Session's migration. No calculation silently overwrites a more precise value.
5. Write target Session totals exactly once, verify aggregate postconditions, then insert only the new transform's completion row. Bind that row to the implementation and input-snapshot hashes in the external reconciliation manifest; archive the old row there as evidence rather than copying it.
6. After cutover, upstream EventV2 plus `SessionProjector` is the only incremental owner of Session usage; the old runtime job is retired.

All other `data_migration` rows follow the same explicit disposition format: source rows, target rows/fields, implementation hash, completion-row rule, idempotence key, verified postcondition, run phase, and background-enable condition. Background jobs remain disabled until their canonical inputs are complete.

Unknown non-empty journal rows, same-ID divergent migrations without an approved mapping, missing migration bodies, or completion rows without corresponding code are hard failures.

### 8.8 Data migration and failure-injection gates

Before cutover:

- run the process on at least fresh, old unmodified upstream, current SMARK, large real SMARK, interrupted, and repeated-input fixtures;
- compare normalized schema hash, migration manifests, row and relationship counts, per-table logical digests, FK violations, indexes, and key JSON decode results;
- prove that fresh and migrated target databases have the same base plus approved extension schema;
- verify Session/Workspace links, aggregate sequence, projector state, RequestUsage, Goal, and `data_migration` completion independently rather than relying on total row count;
- inject termination before/after source snapshot, target schema creation, each import batch, extension-journal write, data-job completion write, checkpoint, rename, and first target startup;
- rerun from the same source and assert stable schema hash, stable logical data digests, no journal growth, no duplicate Event/RequestUsage rows, and recoverable WAL/SHM state;
- verify rollback by restoring or reselecting the untouched backup, never by reverse-running unproven DDL;
- reject an unknown non-empty schema or journal rather than guessing.

No test may mutate the only copy of user data. A process crash, missing disk space, failed checkpoint, or failed atomic rename must leave either the old database selected or a fully verified target selected, never a mixed state.

### 8.9 Crash-safe cutover state machine

Cutover uses one atomic replacement of the canonical database path, never a two-rename swap:

| State | Required durable state | Crash recovery |
| --- | --- | --- |
| `SOURCE_FROZEN` | Exclusive migration lock held; all application connections closed; checkpoint successful; active source valid; immutable rollback copy verified. | Continue using the old active source or restore the verified copy. |
| `TARGET_READY` | Old active source still selected; target is in the same directory/filesystem, complete, integrity-checked, checkpointed/closed, `fsync`ed, and has no non-empty WAL/SHM; completion manifest binds source hash, target hash, schema hash, importer hash, and gate IDs. | Ignore/delete the unselected target and continue with old source. |
| `TARGET_ACTIVE` | A single platform atomic-replace primitive has replaced the canonical active path with the closed target; immutable rollback copy remains separate. | Active path is entirely old or entirely target, never a filename mixture. Validate completion metadata before normal startup. |
| `CUTOVER_VERIFIED` | Parent-directory durability completed, target opened and validated, mandatory post-open assertions passed, then migration lock released. | Use target; rollback means stop/close and atomically replace from the immutable copy under the same protocol. |

Before atomic replacement, both source and target connections are closed, stale active and target `-wal`/`-shm` files are absent after successful checkpoints, target/active/rollback paths are on the same filesystem, and target plus rollback files are durable. On POSIX, use one replacement `renameat`/equivalent followed by parent-directory `fsync`. On Windows, use a tested `ReplaceFileW` or `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` equivalent after proving no open handles. If the required primitive or durability guarantee is unavailable, cutover stops in `TARGET_READY` and the old source remains active.

Startup while the migration lock is held accepts a target only when its internal completion record and external manifest agree with the active file/schema hash. Failure injection is mandatory before and after checkpoint, final close, backup `fsync`, target `fsync`, atomic replacement, directory durability, first validation open, and lock release. The expected state and recovery action at each injection point must be recorded in the gate registry.

## 9. Session, Event, HTTP, OpenAPI, and SDK policy

### 9.1 Session models

Upstream intentionally has two related projections during transition:

- Session V1 Message/Part tables for the legacy transcript and compatibility endpoints;
- the newer ordered `session_message`, input queue, context epoch, and execution model.

They are not interchangeable duplicate schemas. The upstream projector and sequence rules determine how they coexist. SMARK must not restore unordered dual writes.

### 9.2 EventV2 is the write authority

New Session writes and projections must use upstream EventV2 and its durable aggregate semantics:

- strictly ordered aggregate sequence;
- replay identity and divergence checks;
- event, sequence, projector, and optional operational commit in one transaction;
- publication only after commit;
- typed and durable streams.

The local SyncEvent implementation may temporarily decode old retained events or bridge old consumers, but it must not remain the primary write path. The retirement condition must be tracked explicitly.

### 9.3 Local Session features

| Feature | Migration form |
| --- | --- |
| Session path and search | Query/projection extension over canonical Session tables and path types. |
| Session list last-message preview | Typed batch projection endpoint plus `packages/tui` presentation; no N+1 fetch. |
| RequestUsage | Independent tables/service fed by canonical run and terminal events. |
| Goal continuation | Independent Goal service/table/Tool using canonical Session IDs and run coordination. |
| Compaction tail/evidence behavior | Behavior extension inside upstream compaction seams; never a second compaction pipeline. |
| Manual compaction queued-message continuation | Regression test at the canonical Session runner seam before porting the local fix. |
| Hidden/repair metadata | Canonical schema extension or namespaced metadata with migration. |

### 9.4 Protocol and handler rules

All local endpoints must be defined in the same canonical protocol graph as upstream endpoints. For each endpoint:

- request path/query/body and response/error schemas are defined once;
- handler types must satisfy the contract without `as any`;
- handler stays thin and calls a domain service;
- all declared errors have stable wire forms;
- HTTP exercise coverage includes auth, effect, success, not-found, malformed input, and response-encode failure;
- public OpenAPI is derived, not repaired with path-specific overrides.

The previous local RequestUsage and preview endpoints used handler casts and manual OpenAPI repair. That pattern is prohibited.

### 9.5 Generated clients

The only accepted order is:

```text
schema/domain source
  -> protocol
  -> handlers
  -> OpenAPI
  -> generated clients/SDK
  -> consumer typecheck and integration tests
```

Generated output is always regenerated last. A generated file is never selected with ours/theirs and never manually patched to hide a source mismatch.

“No manual patch” does not mean deleting upstream's generator logic. In `v1.17.18`, `packages/sdk/js/script/build.ts` generates OpenAPI, removes unreachable duplicate Session schemas, runs `@hey-api/openapi-ts`, and performs fail-fast scripted transformations for Session history numeric query types and the SSE iterator generic. Those deterministic, checked transformations are part of the authoritative generation pipeline. Editing their output after the script completes is prohibited.

### 9.6 Generation manifest and compatibility clients

Every provisional or final generation records these common fields:

```text
candidate_commit
bun_version
generator_package_versions
command_and_working_directory
contract_input_paths_and_tree_hash
canonical_openapi_sha256
generator_script_sha256
generated_tree_sha256
scripted_post_processing_steps
working_tree_diff_after_first_run
working_tree_diff_after_second_run
status: provisional | final
```

A provisional manifest additionally records:

```text
provisional_consumer_test_evidence_gate_id
```

A final manifest additionally records:

```text
sdk_dist_tree_sha256
sdk_pack_sha256
external_consumer_lock_sha256
candidate_server_binary_sha256
candidate_server_package_sha256
consumer_test_evidence_gate_id
```

Final-only fields are schema-valid `NOT_APPLICABLE` in a provisional manifest; this is an explicit state, not a placeholder. They must contain real hashes/gate IDs in a final manifest.

The canonical OpenAPI JSON must be retained as an audit artifact before the build script removes its temporary copy. A second clean generation must produce the same canonical JSON and generated tree.

The checked-in V1 `packages/sdk/js/src/gen/**` tree has no generation entry in the inspected `v1.17.18` SDK build script, while V2 is generated into `src/v2/gen`. Before porting local contracts, V1 must receive exactly one recorded disposition:

1. identify and run its authoritative generator;
2. classify it as a frozen compatibility client and validate it against immutable contract fixtures;
3. retire it through explicit compatibility approval.

An unowned V1 generated tree may not silently absorb local endpoint changes. Final verification must build/pack from the clean checkout bound to `generated_tree_sha256`, install the SDK into a repository-external consumer with workspace resolution disabled, verify public exports, and use the installed package against the same release-candidate server for ordinary HTTP, typed errors, SSE first event, cancellation, and iterator return.

## 10. Provider, Model, Permission, Agent, and Tool policy

### 10.1 Provider and Model

Adopt upstream Provider/Model schemas and Catalog. Local Provider behavior must use adapters:

| Local behavior | Correct seam |
| --- | --- |
| Multiple Provider instances / `extends` aliases | Materialize a canonical Provider record from a base definition before Catalog projection. |
| DaXiao and other custom instances | Normal branded Provider IDs from user Config; not hard-coded enum branches. |
| ClaudeCode protocol behavior | Request/fetch decorator around an Anthropic-compatible Provider. |
| OpenAI OAuth aliases | Auth/integration adapter with explicit identity. |
| Client version and custom headers | Provider request adapter. |
| NetworkProxy | Shared transport adapter for AI SDK, native LLM, plugins, MCP, npm, and infrastructure HTTP. |
| Additional timeout telemetry | Typed transport errors and tracing around canonical request routes. |

An alias ID, protocol family, auth integration, and runtime capability are distinct concepts. Do not overload `providerID` to mean all four.

### 10.2 Provider verification

Unit tests that show a model in a picker are insufficient. Provider verification has two non-substitutable gates.

**Offline contract gate:** every retained adapter must prove URL/method, headers/auth, body after Provider and Model overlays, selected AI SDK/native route, reasoning/verbosity/variant parameters, stream protocol, abort, retry classification, and typed error decoding. Where a known-working old binary exists, compare the final request semantically after redacting credentials and nondeterministic values.

**Online success gate:** every Provider/model pair marked release-critical in the product matrix must use real credentials and the release-candidate binary to complete a non-empty streamed answer. At minimum this includes DaXiao Codex `gpt-5.5` and the DeepSeek historical-context scenario. Pass requires first content token, normal terminal event, persisted non-empty assistant output, consistent usage/event state, and clean process exit.

`401`, `403`, `404`, `422`, `5xx`, timeout, generic internal error, or a more precise typed Provider error all fail the online success gate. Missing credentials or an external outage yields `BLOCKED`, never `PASS`; release waits unless the user explicitly retires that Provider from the release-critical matrix.

A separate negative test must use invalid credentials or an intentionally rejected request and assert a precise typed error. Error quality cannot substitute for service usability. DaXiao Codex `gpt-5.5` specifically needs both the prior post-selection `internal error` reproduction and a successful replacement request.

### 10.3 Permission

Use upstream Permission schemas and ordered rules. Preserve local auto-review/precheck behavior as a policy service that consumes and emits canonical Permission requests/replies.

Subagent derivation, yolo/auto-approve, saved rules, home-relative paths, and server Permission endpoints must be reconciled in one matrix. Do not copy the old Ruleset into a local schema to make tests compile.

### 10.4 Agent and Tool

Use upstream Agent and Tool interfaces. Re-port local behaviors individually:

- explicit primary Agent selection and `auto` semantics;
- Tool output compression/truncation;
- shell encoding and Windows output decoding;
- Read outline/stub/evidence behavior;
- Grep/Glob partial filesystem failures;
- apply-patch per-file atomicity and LSP diagnostic deltas;
- Task inspected-file transfer and result budget;
- Goal Tool;
- VS Code Notebook Tools;
- cancellation and elapsed-time metadata;
- consecutive Tool-error and empty-completion safeguards.

Do not copy the old registry wholesale. Each Tool must be registered through the upstream registry and tested through its real canonical interface.

## 11. TUI, CLI, daemon, and visual behavior policy

### 11.1 Upstream TUI owns the runtime

The canonical TUI is `packages/tui`. The old `packages/opencode/src/cli/cmd/tui/**` implementation must not survive as a parallel tree or a mirror of re-export shims.

Local features are reimplemented at canonical paths such as:

- `packages/tui/src/component/dialog-session-list.tsx`;
- `packages/tui/src/component/prompt/index.tsx`;
- `packages/tui/src/routes/session/index.tsx`;
- `packages/tui/src/context/sync.tsx`;
- `packages/tui/src/context/thinking.ts`;
- `packages/tui/src/plugin/**`.

### 11.2 OpenTUI contract

Use upstream OpenTUI 0.4.3 for `core`, `keymap`, and `solid`, with one resolved runtime and one native binary version. Preserve upstream spinner registration through `packages/tui/src/component/register-spinner.ts`.

Prohibited:

- mixed OpenTUI 0.3.x/0.4.x dependency trees;
- lowercase intrinsic components without registration;
- two renderer/context graphs;
- old keymap and new keymap providers in one process;
- UI tests that import a shim instead of the real implementation.

### 11.3 Local TUI behavior to re-port

| Feature | Policy |
| --- | --- |
| Session preview | Add to upstream switcher without replacing root/search/pin/workspace behavior. |
| Token accounting and `/context` | Recalculate against upstream token semantics; domain calculation outside TUI, presentation inside TUI. |
| Reasoning visibility/collapse | Use upstream thinking model as baseline; port only demonstrated missing behavior. |
| Voice input | Add through canonical prompt/controller seams; verify device lifecycle and cancellation. |
| Notebook rendering/tools | Keep Tool domain outside TUI and add canonical renderers. |
| Smooth scrollbar/activity indicator | Preserve exact visual role; renderer-level tests must distinguish Session scrollbar from prompt activity indicator. |
| Diff/LSP diagnostics | Extend upstream diff and Tool presentation, not the old route file. |
| Plugin slots | Use upstream plugin runtime and exported slot interface. |

### 11.4 CLI run and daemon

Upstream `run`, `--mini`, attach mode, TUI worker/RPC, and desktop utility-process sidecar are the default lifecycle authority.

The SMARK shared daemon may be retained only if it remains an explicit product requirement. If retained:

- it is a host adapter, not part of the TUI package;
- run/mini/desktop do not accidentally pass through it;
- one default production path is selected;
- database ownership, channel, lock version, token, PID reuse, and stale-lock behavior are explicit;
- stop/status use authenticated private control operations;
- real multi-process Windows and Unix tests prove that no second database owner is created.

Two default worker models must never coexist.

### 11.5 TUI release-binary runtime gate

Source tests and `testRender` are necessary but cannot prove which native runtime entered the shipped binary. The release gate must:

1. Start from a clean checkout, empty install state, frozen lockfile, and recorded Bun version.
2. Resolve `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, and `opentui-spinner` peer dependencies from the repository root, `packages/opencode`, and `packages/tui`; record package versions, content hashes, and `realpath`. Pass requires exactly one realpath for each OpenTUI package, spinner peer core/solid realpaths equal to the application realpaths, and exactly one native-binary hash for the target. “Same compatible version at another path” is not sufficient.
3. Inspect the built/archive file list and prove the selected platform package contains the expected OpenTUI native binary, parser workers, and executable permissions.
4. Install or extract the final candidate package into a clean external directory and launch that installed `opencode`, not a source entry, workspace package, shim, or build-tree binary.
5. Drive the installed binary through a real Unix PTY and Windows ConPTY. Required actions are first screen and exit, historical Session open, streamed text/reasoning, resize, reconnect, spinner start/stop, prompt activity, scrollbar, and clean process-tree shutdown.
6. Save normalized frames and assert that streamed text is not duplicated, stopped spinners leave no residue, key text appears once after resize/reconnect, prompt activity does not occupy the Session scrollbar role, exit code is expected, timeout is not reached, and no child process remains.

The dependency-resolution report, native binary hash, installed binary hash, PTY transcripts, normalized frames, assertions, exit status, and process inventory are release evidence. A package test, lockfile grep, successful `--version`, or source-level renderer snapshot cannot replace this gate.

`G5-TUI-CLOSURE` applies the realpath assertions to the clean workspace install. `G6-PACKAGE` separately verifies archive file/content hashes. If the external installation resolves JavaScript packages at runtime, it repeats the unique-realpath and spinner-peer assertions there; if the runtime is fully bundled, a bundle/import trace must prove that the installed binary loads the packaged native hash and cannot fall back to workspace `node_modules`.

## 12. Local feature disposition ledger

The rows below are the known starting inventory, not the completeness boundary. The machine-readable ledger is complete only when every one of the 466 local-only commits maps to one or more feature rows or to an evidence-backed `no-product-impact` record, and the unmapped count is zero. Each feature row requires an owner, all source commits, target seam, Config/data impact, test, smoke evidence, and final status before release.

| SMARK feature | Class | Target disposition |
| --- | --- | --- |
| Provider aliases/multi-instance | A | Canonical Provider materialization adapter. |
| ClaudeCode request identity | A | Provider request/fetch adapter. |
| NetworkProxy | A/E | Shared transport module used by all HTTP routes. |
| Explicit primary Agent list | E | Canonical Agent selection policy. |
| Session path/search | E | Canonical query projection. |
| Session list preview | E | Typed protocol endpoint plus TUI presentation. |
| RequestUsage and terminal stats | E | Independent projection tables/service and CLI reader. |
| `DataMigration.Service` and `session_usage_from_messages` | A then R | Replace with versioned offline `smark_session_usage_import_v1`; never copy the old completion row; retire the background service after verified target totals. |
| Goal | E | Independent table/service/Tool and runner integration. |
| Detailed token accounting | E | Core calculation module plus TUI/Stats adapters. |
| Compaction tail/evidence/cancellation fixes | E | Upstream compaction/runner seams with regression tests. |
| Read outline/stub/file evidence | E | Canonical Read Tool implementation. |
| Shell compression/encoding | E | Canonical ToolOutput Config and Shell Tool. |
| Windows/PowerShell normalization | E/A | Platform adapters and real process tests. |
| VS Code bridge/Notebook | E/A | Canonical plugin/Tool/IDE seams. |
| Voice recording/transcription | E | Canonical TUI prompt module and lifecycle tests. |
| Permission auto-review/precheck | E | Policy service over upstream Permission contracts. |
| Snapshot large-file/ignored-file behavior | E | Upstream Snapshot service extension. |
| TUI reasoning and activity visuals | E | Behavior-level additions in `packages/tui`. |
| Old Database singleton | R | Replace with core Database service. |
| Legacy SyncEvent primary writes | A then R | Temporary decode bridge only. |
| Local duplicate Provider/Model schemas | R | Canonical upstream brands. |
| Old TUI path mirror | R | Direct imports from standalone package. |
| Failed merge generated SDK/OpenAPI | R | Regenerate from final contracts. |

## 13. Required migration procedure

### 13.1 Non-bypassable forward-port topology gate

The branch strategy is a release gate, not a recommendation. Let `CANDIDATE` be the commit under review. At minimum, the gate must prove the equivalent of:

```sh
test "$(git merge-base v1.17.18 "$CANDIDATE")" = "$(git rev-parse v1.17.18)"
test -z "$(git rev-list --merges v1.17.18.."$CANDIDATE")"
```

In addition:

1. The first-parent history begins at immutable `v1.17.18`; no commit has `dev-smark`, the failed archive, or a descendant of either as a merge parent.
2. Every one of the 466 local-only commits maps to feature IDs or an approved `no-product-impact` record. Unmapped count must be zero, and one commit may map to multiple features explicitly.
3. Every port commit has a machine-readable manifest containing feature IDs, all local source commits, target paths, U/E/A/R classification, invariant, tests, smoke evidence, data/config impact, and generated artifacts affected.
4. A diff-scope checker rejects an unreviewed commit spanning multiple ownership domains such as Config, Database, Session/Event, Provider, TUI, and generated output. A reviewed cross-domain migration boundary must name every affected invariant; “merge cleanup” is not a valid exception.
5. Forbidden-path/import queries reject restoration of the old TUI tree, local Provider/Model brands, old Database singleton ownership, parallel migration runner, untyped HttpApi registration, or failed-archive generated trees.
6. Generated artifacts are committed separately from hand-written schema, protocol, handler, and domain changes.
7. Phase N+1 cannot begin until every required Phase N manifest/gate is `PASS`, or an explicitly retired feature has user approval. `BLOCKED`, `NOT_RUN`, and waived evidence are not `PASS`.

The implementation must provide one deterministic verification command for this topology/manifest gate and store its output with the candidate evidence. A giant tree transplant followed by cleanup fails even if the final tree compiles.

### Phase 0: Freeze and capture the current product

1. Record `dev-smark` commit, package versions, config samples, database schema, and binary hash.
2. Recover `docs/session-ses_138a.md` or a stable export, hash it, and reconcile its findings with `docs/merge-upstream-log.md`; unresolved absence remains a recorded evidence blocker.
3. Export the 466 local-only commit inventory with parents, touched files, tests, and feature mapping; require zero unmapped commits.
4. Group commits by user-visible behavior rather than by file and assign U/E/A/R disposition.
5. Build black-box fixtures for every load-bearing feature in `CONTEXT.md`, every `[local-smark]` cluster, and every retained ledger row.
6. Capture real isolated CLI/TUI/provider traces from the existing working version, with binary and input hashes.
7. Make the daemon decision now: either adopt the upstream worker/runtime as the only default, or approve a shared-daemon host adapter with DB ownership, transport, auth, lock/PID, cancellation, reconnect, and Windows/Unix lifecycle specified. Record this as an immutable decision for the migration run.
8. Freeze the release-critical Provider/model matrix, credential prerequisites, supported OS/architecture matrix, and required installation channels.
9. Create the gate registry described in Section 15, including exact commands, owners, fixtures, artifact paths, assertions, and invalidation rules.

Exit gate `G0-INVENTORY`: every local commit and retained behavior has a disposition and observable pass/fail signal; the failed-sync evidence set is recovered, hashed, and reconciled; daemon ownership and release matrices are decided before any port begins. If `ses_138a` remains unavailable, this gate is `BLOCKED` and Phase 1 cannot start.

### Phase 1: Establish a clean upstream base

1. Create a new integration branch from `v1.17.18`.
2. Run upstream package typechecks/tests/build and a clean binary smoke test unchanged.
3. Pin the upstream lockfile and OpenTUI closure.
4. Do not merge `dev-smark`, `origin/dev`, or its generated files.
5. Enable the topology, manifest, forbidden-path, and phase-order checks before the first port commit.

Exit gates `G1-BASE` and `G1-TOPOLOGY`: untouched upstream is reproducibly green in target environments and the candidate lineage is mechanically proven to be a forward port.

### Phase 2: Migrate Config, IDs, Database, and base schemas

1. Adopt `packages/schema` IDs and contracts.
2. Preserve the two upstream Config surfaces at their current consumer boundaries, remove the third SMARK authority, and implement the audited migration adapter/report for SMARK fixtures.
3. Adopt the core Database service, base tables, paths, and target migration engine.
4. Implement journal reconciliation and the read-only source inspector; classify every destructive migration and every source object before any data importer runs.
5. Add post-head extension-schema migrations for approved independent local tables and freeze the explicit disposition of every `data_migration` job.
6. Prove empty sidecar creation, extension schema, fresh install, and old-unmodified-upstream migration. Run source-only dry-run plans against multiple real SMARK copies, but do not claim historical Event/Session import before Phase 3 adapters exist.

Exit gates `G2-CONFIG` and `G2-SCHEMA-PLAN`: no third Config authority or competing writer, one ID per concept, one target Database service/journal, reproducible target head plus extension schema, zero unexplained Config paths, zero unknown source objects/journal rows, and a complete approved import/cutover plan. These gates do not certify historical data import.

### Phase 3: Migrate Session, Event, protocol, and SDK

1. Adopt EventV2 and upstream Session projectors/execution.
2. Port Goal, RequestUsage, path/search, preview, compaction behavior, legacy transcript adapters, and the versioned Session usage import transform.
3. Implement the canonical Session/Event/Workspace import and projection rules, then run full shadow migration, interruption/repetition, and cutover-state tests against multiple real copies.
4. Define local protocol operations without handler casts.
5. Generate provisional OpenAPI and clients only to validate the current protocol graph; mark the generation manifest `provisional` and do not treat it as a release artifact.
6. Exercise every endpoint through those generated clients and validate durable replay/projection behavior.

Exit gates `G3-DATA-MIGRATION` and `G3-CONTRACT-PROVISIONAL`: real-copy target data has no silent loss, fabricated order, duplicate Event/usage, unresolved projection, or importer write back into the frozen source; crash-safe cutover tests pass; row/schema/handler/OpenAPI/provisional-client parity and durable replay tests pass. Any later importer, projector, contract, route, handler, or schema change invalidates the affected gate.

### Phase 4: Migrate Provider, Permission, Agent, and Tools

1. Adopt upstream Provider/Model Catalog and IDs.
2. Add alias, ClaudeCode, NetworkProxy, and diagnostics adapters.
3. Port Permission policy and Agent semantics.
4. Port Tools one behavior at a time with real implementation tests.
5. Run every offline Provider contract test. Live tests may remain credential-gated during ordinary PR work, but they are mandatory and non-skippable for the final release candidate.

Exit gate `G4-PROVIDER-TOOLS`: every retained Provider/Tool passes offline request-shape, stream, cancellation, error, filesystem/process, and permission tests. This does not replace final online success gate `G7-PROVIDER-LIVE`.

### Phase 5: Migrate TUI, CLI, and user-visible features

1. Keep upstream TUI/runtime structure intact.
2. Re-port preview, token/context, reasoning, voice, notebook, diagnostics, and visuals.
3. Implement only the worker/daemon lifecycle selected in Phase 0; changing that decision invalidates Phases 2 through 5 and requires a new migration run.
4. Test source-level renderer behavior and the dependency/native closure. A provisional installable artifact may be used for diagnostics, but it is not release evidence.

Exit gates `G5-TUI-CLOSURE` and `G5-TUI-SOURCE`: one OpenTUI dependency/native closure is proven for the integration tree and source-level renderer/runtime behavior passes. The final installed-binary gate cannot pass until Phase 6 creates formal packages.

### Phase 6: Freeze contracts, generate, package, and document

1. Freeze schema, routes, handlers, Provider catalog, dependency graph, and public contracts for the candidate.
2. Regenerate database schema/migration indexes through upstream tooling.
3. Regenerate final OpenAPI and every supported client/SDK through the authoritative pipeline; mark the generation manifest `final`.
4. Re-run every Phase 3 endpoint, protocol, generated-client, SSE, and consumer test against the final generation.
5. Resolve V1 client status as generated, frozen-compatible, or approved-retired; no unowned tree remains.
6. Regenerate model snapshots only after Provider source is stable.
7. Regenerate the lockfile once from the final dependency graph.
8. Build formal OS/architecture archives/packages, install them through user-facing paths in clean external directories, and run the complete Section 11.5 Unix PTY/Windows ConPTY matrix plus installed CLI/native workers and packed SDK consumers.
9. Update English and Chinese docs first, then check all translated copies for stale semantics.

Exit gates `G6-GENERATION`, `G6-PACKAGE`, and `G6-TUI-BINARY-FINAL`: clean double generation is identical with no post-script edits; all final contract tests have rerun; archive contents, checksums, permissions, platform selection, installed binary PTY/ConPTY behavior, package exports, and external SDK consumption pass.

Any later change to schema, route, handler, generator, Provider catalog, lockfile, TUI runtime, build script, or package manifest invalidates the affected Phase 6 evidence. Any commit after the final candidate invalidates all installed-binary and online Provider evidence regardless of path.

### Phase 7: Cutover audit

1. Re-run the local feature ledger against old and new binaries.
2. Run database migration against multiple real copies.
3. Run all package tests/typechecks/builds and real smoke tests.
4. Audit deleted tests, weakened assertions, skips, mocks, and compatibility shims.
5. Run mandatory fresh-install, migrated-install, live Provider, PTY/ConPTY, packaged SDK, and process-cleanup journeys against the exact same release-candidate artifacts.
6. Record unresolved differences as explicit blockers or user-approved removals.

Exit gates `G7-RC`, `G7-PROVIDER-LIVE`, and `G7-CUTOVER`: every retained feature is proven against the hashed candidate; every removed feature has explicit user approval; no required gate is `BLOCKED`, `NOT_RUN`, skipped, or supported only by stale evidence.

## 14. Conflict resolution protocol

For every conflict or migrated behavior, record:

```text
ID:
Local feature ID:
All local source commits:
Inventory coverage records:
Old path:
Upstream canonical path:
Classification: U | E | A | R
Behavioral invariant:
Data/config compatibility impact:
Chosen implementation:
Rejected alternative:
Regression test:
Real smoke test:
Generated artifacts affected:
Status: pending | ported | verified | intentionally retired
```

Additional rules:

1. No broad `ours` or `theirs` selection for source, tests, Config, schema, SQL, lockfiles, or generated clients.
2. For modify/delete and file-location conflicts, identify the canonical replacement path before resolving.
3. A deleted upstream file may not be restored merely because local tests import it.
4. A test migration must preserve behavior strength; path-only source assertions are not a substitute for runtime tests.
5. Do not add `@ts-nocheck`, `as any`, broad error swallowing, or duplicate exports to finish a phase.
6. Compatibility shims need an owner, caller count, removal condition, and deadline.
7. Generated files are not conflict-resolution surfaces.
8. A commit that transplants multiple old ownership domains without per-domain manifests and already-passing prerequisite gates is a giant merge and must be rejected.
9. A `no-product-impact` commit record still needs touched-path evidence and reviewer approval; it is not a bucket for unclassified work.

## 15. Verification matrix

### 15.1 Gate evidence contract

No prose statement such as “green”, “parity”, or “looks correct” closes a phase. Before a gate can run, its registry entry must contain:

```text
gate_id
owner
reviewer_identity
prerequisite_gate_ids
candidate_commit
source_and_input_closure_hash
exact_commands_and_working_directories
required_os_arch_terminal_bun_versions
fixture_paths_and_sha256
binary_or_package_absolute_path_and_sha256
isolated_home_config_data_cache_state_and_OPENCODE_DB
provider_model_and_credential_source_class
start_end_and_timeout
expected_assertions
stdout_stderr_pty_and_structured_artifact_paths
post_run_database_and_process_assertions
pass_condition
fail_condition
invalidated_by_paths_or_input_hashes
waiver_authority
evidence_manifest_sha256
reviewed_evidence_manifest_sha256
reviewer_result: APPROVED | REJECTED | NOT_REVIEWED
reviewer_timestamp
reviewer_attestation_or_signature
review_findings
result: PASS | FAIL | BLOCKED | NOT_RUN
```

Registry entries with placeholder commands, missing fixture hashes, no fail condition, the same owner/reviewer, `reviewer_result != APPROVED`, or mismatched evidence hashes are invalid. Command output and structured reports live under a candidate-addressed evidence directory such as `artifacts/migration/v1.17.18/<candidate-sha>/<gate-id>/`; secrets are redacted but credential class and Provider identity remain auditable. Any candidate, input-closure, command, assertion, or evidence-manifest change invalidates reviewer approval. Capability retirement and any allowed non-technical exception require a separate user-approval artifact, never the gate owner's self-approval.

Only evidence produced by the same candidate commit and the exact package/binary hash may enter release gates. `BLOCKED` and `NOT_RUN` never count as `PASS`. Database safety, topology, final generation, package install, TUI binary, and online Provider success gates have no technical waiver; the response is to fix, wait, or obtain explicit user approval to retire the affected product capability.

Evidence invalidation is input-closure based:

| Changed input | Minimum gates invalidated |
| --- | --- |
| Config schema/loader/writer/migrator or Config fixture | `G2-CONFIG` and all dependent real-user journeys |
| SQL schema, migration, importer, projection, database path/PRAGMA | `G2-SCHEMA-PLAN`, `G3-DATA-MIGRATION`, Session/usage journeys, and cutover |
| Public schema, protocol, route, handler, OpenAPI, generator | `G3-CONTRACT-PROVISIONAL`, `G6-GENERATION`, packed SDK, and all API consumers |
| Provider, Catalog, LLM route, auth, proxy/network transport | `G4-PROVIDER-TOOLS` and `G7-PROVIDER-LIVE` |
| TUI source, OpenTUI dependency, lockfile, build/package script | `G5-TUI-CLOSURE`, `G5-TUI-SOURCE`, `G6-TUI-BINARY-FINAL`, and `G6-PACKAGE` |
| Any candidate commit or release artifact hash | all Phase 7 installed-binary, PTY/ConPTY, and live-Provider evidence |

### 15.2 Verification domains

| Area | Required verification |
| --- | --- |
| Config | Upstream V1 and V2 fixtures, real SMARK fixtures, raw-key consumption report, current writer targets, alias conflicts, precedence/policy order, and no third authority. |
| IDs/schema | Decode/encode round trips, persisted row decode, wire errors, no duplicate brands/imports. |
| Database | Fresh creation, old-upstream in-place migration, SMARK shadow migration, journal reconciliation, destructive-migration disposition, repeat/interrupted runs, logical digests, FK/index/schema parity, WAL/SHM and atomic cutover. |
| EventV2 | Ordered sequence, idempotent replay, divergent replay rejection, projector atomicity, post-commit publication, reconnect. |
| Session | Create/list/search/path/preview, input admission, queued prompt continuation, compaction, revert, fork, deletion, metadata. |
| RequestUsage | Every success/error/abort/compaction/subagent path, no missing assistant row, totals match canonical usage. |
| Goal | active/pause/complete/blocked, budget/turn limits, cancellation, error continuation, queued prompts. |
| Protocol/API | Coverage/auth/effect exercise, malformed request, response encode failure, typed errors, generated-client call. |
| SDK | Generation manifest, canonical OpenAPI hash, deterministic scripted post-processing, V1 disposition, clean double generation, external pack/install consumer, HTTP/error/SSE/cancel/iterator tests. |
| Provider | Offline URL/headers/body/runtime, variants, OAuth/alias, proxy/no-proxy, timeout/cancellation/error decode, plus mandatory live streamed success for each release-critical pair. |
| Tools | Real filesystem/process behavior, permissions, cancellation, metadata, output truncation/compression, Windows paths/encoding. |
| TUI | Realpath/version closure from all workspace roots, spinner registration, real testRender tree, installed-binary PTY/ConPTY frames, resize/reconnect/stream/activity/scrollbar and process cleanup. |
| CLI binary | Installed release package with isolated `OPENCODE_DB`, Config, home/data/cache/state; first run, new/old Session, run/continue/reuse, clean exit and process cleanup. |
| Release package | Formal archive/package file list, checksums, permissions, platform selection, native/parser worker load, install wrapper, uninstall cleanup, and no workspace-source resolution. |
| Daemon | Only if retained: multi-process owner election, stale lock, PID reuse, auth, database isolation, stop/status on Windows and Unix. |
| Stats | Canonical token/cost projection, RequestUsage fallback, width/color, real isolated DB output. |
| App/Desktop | Server/tab/Session scoping, drafts, provider lifetime, timeline stability, revert, terminal and review state. |
| Performance | Session list/preview, timeline, message hydration, context panel, startup, large DB, large transcript, streaming repaint. |

### 15.3 Mandatory real-user scenarios

All scenarios use the same installed release-candidate artifacts and the evidence contract above. At minimum they prove:

1. **Fresh-install journey:** from empty home/config/data/cache/state, create or load an upstream-supported Config, create Project and Session, send a live prompt, execute at least one Tool, complete one Permission round-trip, persist a non-empty answer, restart the installed binary, and continue the same Session.
2. **Migrated-install journey:** from a hashed copy of a real SMARK Config/database, run the shadow migration, open an old Session, create a new Session, complete prompts in both, and verify EventV2, projections, RequestUsage, Goal, Config report, journals, and process cleanup. After the verified backup/checkpoint freeze, the importer must never write application data back into the source.
3. Session list shows the intended two-message preview without N+1 loading in both fresh and migrated states.
4. DaXiao Codex `gpt-5.5` completes a live streamed response with non-empty persisted output. A separate invalid-credential/rejected-request test returns the expected precise typed error.
5. DeepSeek historical-context reuse completes a live answer that demonstrably depends on retained context: the hashed old Session contains a generated `migration-context-<nonce>` value, the continuation prompt asks for the prior value without repeating it, the answer must contain the exact nonce, and the same prompt in an empty control Session must not recover it. Record Session IDs, fixture/nonce hashes, streamed output, and control result; a typed error or subjective answer review is not a pass.
6. RequestUsage writes request and assistant rows for the same run across success, Provider error, abort, compaction, and subagent terminal paths without duplication.
7. Token/context values update during streaming and settle to persisted canonical totals after restart.
8. Reasoning collapse/visibility remains stable during streaming, resize, reconnect, completion, and historical reopen.
9. Spinner and prompt activity rendering leave no growing residue and do not duplicate text or exchange roles with the Session scrollbar.
10. Voice and Notebook operations work end to end in supported environments or have explicit user-approved retirement; they must not silently disappear.
11. Windows PowerShell output, CRLF, paths, ConPTY rendering, process cleanup, and proxy routing remain correct; the equivalent Unix PTY journey also passes.
12. A formal archive/package installed in a clean external directory loads native/parser workers, runs CLI and TUI, selects the correct platform, and removes or exits without orphaned processes/files.
13. A packed SDK installed in an external consumer calls the same candidate server through ordinary HTTP and SSE, observes typed errors, cancels a stream, and closes its iterator.
14. Forced termination at migration import, journal, checkpoint, and cutover boundaries leaves the original selectable and a retry produces identical target logical digests without duplicate events or usage.

## 16. Test integrity rules

1. Compare the complete set of local test-changing commits against the new test tree.
2. A moved test must exercise the real new implementation, not a compatibility re-export.
3. Do not replace behavior assertions with source-text assertions unless the behavior is impossible to run and the gap is documented.
4. Do not increase timeouts to hide a deterministic lifecycle failure.
5. Do not classify a failure as upstream flaky without reproducing it on the untouched upstream tag.
6. Do not delete a test before classifying its behavior as retained, superseded, or intentionally retired.
7. Skips require an issue, reason, platform scope, and removal condition.
8. Full package green is necessary but not sufficient; mandatory scenarios remain release gates.
9. A test result without candidate/input hashes and an artifact path is diagnostic output, not release evidence.
10. A required external service outage or missing credential produces `BLOCKED`; test code must not turn it into skip/pass.

## 17. Stop conditions

Stop the migration rather than patch around any of these conditions:

- a third SMARK Config service/schema/precedence graph remains, or the two upstream Config surfaces have competing unassigned writers/consumers;
- two branded IDs exist for one concept;
- base SQL tables are defined in both core and opencode;
- the old local Drizzle folder runner and upstream target migration engine both execute in production;
- a destructive upstream migration is about to run against the only or authoritative SMARK source database;
- a migration/config journal contains an unknown non-empty record or a same-ID divergent entry without approved reconciliation;
- a `data_migration` completion row is copied without matching code semantics and verified postcondition;
- EventV2 and SyncEvent both author the same projection;
- a handler needs `as any` to register;
- OpenAPI requires a local path-specific repair after generation;
- generated SDK files need edits after the authoritative scripted generator/post-processing completes;
- two TUI trees or OpenTUI versions load;
- shared daemon and per-TUI worker are both default owners;
- a real migrated database fails schema decode;
- a retained Provider is covered only by picker/display tests;
- a release-critical Provider returns a typed error instead of completing the required live success journey;
- the shipped TUI has not been exercised from an installed package in Unix PTY and Windows ConPTY;
- a required gate is being treated as passed while `BLOCKED`, `NOT_RUN`, stale, or produced by another candidate hash;
- a giant cross-domain/tree-transplant commit bypasses the forward-port manifest;
- the 466-commit inventory has any unmapped entry;
- a user-visible feature is declared complete without a real implementation-level test;
- old tests are removed or weakened without an approved disposition record.

## 18. Go/no-go release criteria

Migration is ready for release only when:

1. The authority matrix has no unresolved ownership; the intentional upstream Config V1/V2 boundary is mapped and no third local authority exists.
2. The topology gate passes, all 466 local-only commits are mapped, and every retained local feature has status `verified` in the ledger.
3. The failed-sync evidence set is recoverable and hashed, or its absence remains a no-go rather than an implicit waiver.
4. Config reports and shadow-database migration reports show no silent loss, unknown journal state, fabricated Event order, or importer write into the frozen source.
5. Protocol, handlers, canonical OpenAPI, final generated SDKs, packed external consumers, and candidate server agree mechanically.
6. All target package typechecks/tests/builds pass from a clean checkout.
7. Every mandatory real-user scenario passes against the same installed candidate package/binary hash and isolated state.
8. DaXiao Codex `gpt-5.5`, DeepSeek historical context, Windows ConPTY, and at least one Unix PTY pass their mandatory live/runtime gates.
9. Formal archives/packages pass file-list, checksum, permission, platform-selection, native/worker-load, install, and process-cleanup assertions.
10. Final generated artifact diff is reproducible, and every post-generation contract/client test has rerun.
11. No required gate is `BLOCKED`, `NOT_RUN`, skipped, stale, or waived; no temporary shim, `@ts-nocheck`, broad cast, conflict marker, debug instrumentation, or unowned skip remains.
12. The user reviews and approves every intentionally retired SMARK behavior.

## 19. Mandatory branch and commit strategy

1. Branch from `v1.17.18`, for example `merge/v1.17.18-smark`.
2. Keep `dev-smark` immutable as the old behavioral reference during the port.
3. Keep `origin/dev@7acb9ff2` immutable as a failed-attempt archive.
4. Keep the integration range linear and subject to the Section 13.1 topology gate; do not merge either historical branch into it.
5. Commit by one migration domain and completed invariant, not by conflict batch or old directory.
6. Use this order: canonical base, Config boundary/migration, Database shadow migration, Event/Session, protocol/provisional SDK, Provider/Permission/Tools, TUI/CLI, final generated artifacts, formal packages, docs.
7. Keep generated artifacts in separate commits from their hand-written contract inputs.
8. Define `CANDIDATE` as the exact linear integration tip from which all release artifacts and evidence are produced. Prefer fast-forwarding the destination branch to that commit after the cutover audit.
9. If repository policy requires a final merge commit, create it only after all gates: first parent is the reviewed destination tip, second parent is the exact approved `CANDIDATE`, no conflicts or edits occur in the merge, and the merge tree hash equals the candidate tree hash. That merge commit is outside the audited integration range and is not a new release build source.
10. Any tree change during/after final integration creates a new candidate and invalidates the applicable gates. If artifacts are built from the merge commit rather than the exact candidate, all candidate-hash-sensitive release gates must rerun.

The final integration attestation records and mechanically verifies:

```text
destination_tip_before
candidate_commit
candidate_tree
integration_mode: fast_forward | controlled_merge
result_commit
result_tree
first_parent
second_parent
merge_conflict_count
post_merge_diff_against_candidate
release_artifact_source_commit
result: PASS | FAIL
```

Pass requires `result_tree == candidate_tree`, empty `post_merge_diff_against_candidate`, zero conflicts, and `release_artifact_source_commit == candidate_commit` unless all candidate-hash-sensitive gates were rerun for `result_commit`.

## 20. Source evidence

Online sources:

- Release: <https://github.com/anomalyco/opencode/releases/tag/v1.17.18>
- Source: <https://github.com/anomalyco/opencode/tree/v1.17.18>
- Core Config: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/config.ts>
- opencode V1 Config service: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/opencode/src/config/config.ts>
- V1 Config migration: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/v1/config/migrate.ts>
- Core Session SQL: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/session/sql.ts>
- Database service: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/database/database.ts>
- Database migration: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/database/migration.ts>
- Session projection-order migration: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/database/migration/20260603040000_session_message_projection_order.ts>
- V2 Session state reset migration: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts>
- Provider schema: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/schema/src/provider.ts>
- Model schema: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/schema/src/model.ts>
- EventV2: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/core/src/event.ts>
- TUI package: <https://github.com/anomalyco/opencode/tree/v1.17.18/packages/tui>
- SDK generation script: <https://github.com/anomalyco/opencode/blob/v1.17.18/packages/sdk/js/script/build.ts>

Available local sources reviewed include:

- `CONTEXT.md`
- `docs/merge-upstream-log.md`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/storage/db.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/request-usage.sql.ts`
- `packages/opencode/src/session/goal.sql.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/sync/index.ts`
- `packages/opencode/src/provider/schema.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/alias.ts`
- `packages/opencode/src/provider/claudecode.ts`
- `packages/core/src/network-proxy.ts`
- `packages/opencode/src/server/routes/instance/httpapi/**`
- `packages/opencode/src/cli/cmd/tui/**`
- local tests and `[local-smark]` markers across Session, Tool, Provider, Permission, TUI, CLI, database, Windows, voice, and Notebook behavior.

Requested but currently unavailable evidence:

- `docs/session-ses_138a.md`; absent from the working tree and repository history during independent review. It must be recovered and hashed in Phase 0 before its claims can be independently audited.

## 21. Final rule

The migration succeeds only if upstream architecture becomes the base **and** retained SMARK behavior remains observable. “The code compiles” does not prove either condition. The acceptance unit is a verified behavior attached to one assigned upstream ownership boundary, one canonical runtime path for that behavior, and evidence from the exact release candidate.

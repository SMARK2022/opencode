# Canonical Implementation Plan: Cross-Directory Session Event Delivery Repair

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: current Session GOAL continuation objective
>
> Implementation allowed: yes
>
> Last updated: 2026-08-09

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 按照上游修复能解决这个问题吗?与此同时,如果想要从根本解决这个问题,修改解决这个问题应当如何修改?同时我希望修改最少的文件数,譬如说只修改一到两个文件,或者说四个文件以内,同时修改的行数保持最小最少,核心修改,同时不要增加任何的冗余或者适配逻辑,也就是我就想让它project ID能够准确地解析,而不是按照现在这样。同时我也不能引入其他的,比如说第二分支或者fallback,或者等等一些兼容性内容等等,我就让它project ID能够准确地解析,应该怎么做?给出方案。

R2 verbatim requirement continuation:

> 准确完整识别当前daemon在F:\ML\PythonAIProject\Claude-Code\opencode\thirdparty\opencode-11720路径下启动后，任何pwd在F:\ML\PythonAIProject\Claude-Code\opencode的启动的TUI都会在打开会话后按下任意操作之后变成空屏且不进行任何渲染，同时ctrlc之后会显示 `opencode -s undefined` 这种复用命令，然而事实上该 Session 存在且有 Session ID；与此同时，在 opencode 下打开的 TUI 无法在 switch session 里面找到该路径之前的 Session；请准确识别根因并修复，修改不超过四个生产文件、不超过200行，不添加数据库 schema、迁移、fallback 或冗余兼容逻辑。

Additional scope: `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` is the source of truth; `thirdparty\opencode-11720` is only a daemon-start location and is not source evidence. Searches use the absolute `packages` base. No schema, migration, fallback, second success path, or thirdparty change is authorized.

## 2. Explicit Non-Goals

- Do not add database columns, indexes, migrations, or migrate existing Project/Session rows.
- Do not change the existing root-commit, clone, worktree, bare-repository, or no-commit Project identity contracts; this revision changes only the stale `.git/opencode` cache participation in the existing identity decision.
- Do not modify `thirdparty` sources or use them as source evidence.
- Do not add a second Session query, Session-ID fallback, reconnect-success fallback, synthetic identity, or swallowed-error success path.
- Do not change non-Session Project isolation for VCS, LSP, installation, or other Project-wide events.
- Do not repair the black screen with an OpenTUI workaround unless the original loop proves a separate first divergence after the event-owner repair.

## R1 Historical 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\CONTEXT.md:71-110,127-177` | Defines Project as an opened working directory, InstanceState as directory-keyed, and the current SMARK fork boundary. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\AGENTS.md` | Requires package-local verification, minimal changes, and no root-level test execution. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\AGENTS.md:1-18,103-112` | Requires the existing database conventions and per-directory InstanceState ownership. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\AGENTS.md:83-145,161-177` | Requires live Git fixtures, public service seams, and published readiness instead of fixed sleeps. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\.opencode\policy\first-principles-engineering.md:41-69,218-230,236-273,275-322,476-545` | Requires repair at the first divergence, one authoritative path, zero new alternate success paths, traceability, and the Chinese-comment gate. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\.opencode\templates\canonical-plan.md` | Defines the required plan metadata, traceability, TDD, verification, and audit sections. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\docs\adr\README.md:1-44` | No existing ADR owns Project identity; this is a package-local repair rather than a new ADR. |

## R1 Historical 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.ts:185-272` | Current Project ID resolver reads `.git/opencode` before Git root information and writes the selected ID back to the cache. | observed/reachable |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.ts:275-337` | Current Project persistence upserts by `ProjectTable.id` and overwrites the shared `worktree` row. | observed/reachable |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.sql.ts:5-17` | Project ID is the ProjectTable primary key. | contracted |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\instance-store.ts:40-58,116-134` | Separate directory Instances are supported and cached by canonical directory; daemon process cwd is not the intended Project identity seam. | contracted/reachable |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\sdk\js\src\v2\client.ts:17-45,47-79` | TUI SDK sends its own absolute directory using `x-opencode-directory` and rewrites it into the request query. | observed/contracted |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\server\routes\instance\httpapi\middleware\workspace-routing.ts:58-73,145-181` | Server derives the local routing directory from the request, not only daemon cwd. | contracted/reachable |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\core\src\util\hash.ts:1-7` | Existing `Hash.fast` provides the minimal deterministic Project ID hash operation. | contracted |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\project\project.test.ts:103-153,190-272` | Existing public Project.fromDirectory seam covers Git initialization, root-commit identity, worktrees, cache writes, and clone identity. | observed |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\session\session.sql.ts:109-161` | Session rows persist a Project foreign key and a physical working directory. | contracted |
| `F:\ML\PythonAIProject\Claude-Code\opencode\.git\opencode` | Current root cache contains `a393687998cf59456c80f3ff8e57f4c52ae59d77`. | observed |
| `git rev-list --max-parents=0 HEAD` from `F:\ML\PythonAIProject\Claude-Code\opencode` | Current root Git history begins at `4b0ea68d7af9a6031a7ffda7ad66e0cb83315750`, differing from the cache. | observed |
| `GET /project/current?directory=F:\ML\PythonAIProject\Claude-Code\opencode` on the running daemon | Returns Project ID `a393687998cf59456c80f3ff8e57f4c52ae59d77` and root worktree. | observed |
| `GET /project/current?directory=F:\ML\PythonAIProject\Claude-Code\opencode\thirdparty\opencode-11720` on the running daemon | Returns the same Project ID and changes the persisted worktree to the second directory; this is runtime API evidence, not thirdparty source evidence. | observed |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\package.json:1-4` | Current local package is `1.15.12-smark`. | observed |
| `upstream/dev:packages/opencode/package.json` after `git fetch upstream` | Fetched upstream ref is `1.18.15`. | observed |
| `upstream/dev:packages/core/src/project.ts` | Upstream 1.18.15 uses remote/cache/root precedence and returns a previous cached ID for migration. | observed |
| `upstream/dev:packages/opencode/src/project/project.ts` | Upstream migrates old Project, Session, Workspace, and ProjectDirectory rows when the previous cache ID changes. | observed |
| `upstream/dev:packages/core/test/project.test.ts` and `upstream/dev:packages/opencode/test/project/project.test.ts` | Upstream tests remote normalization, cached identity, worktrees, clones, and cached-to-remote migration. | observed |

## R1 Historical 5. Current Behavior

```text
TUI absolute directory
  -> SDK x-opencode-directory
  -> daemon request routing
  -> InstanceStore.load(directory)
  -> Project.fromDirectory(directory)
  -> read .git/opencode first
  -> use cached value as ProjectID
  -> ProjectTable upsert keyed only by ProjectID
  -> distinct directories sharing a stale cache overwrite one Project row
  -> Project path/session projections use the overwritten worktree
```

The first divergence is before daemon/TUI event handling. `readCachedProjectId`
accepts any branded string from `.git/opencode` without comparing it with the
current Git common directory. The Project ID is then used as the primary key,
so a duplicated or stale cache makes distinct local Git repositories the same
database Project. The later `onConflictDoUpdate` is correct for a unique Project
ID but exposes the earlier identity error by replacing the shared row's
worktree.

The upstream 1.18.15 repair is broader than this user-requested minimal route:
it prefers a normalized remote, retains a previous cache ID, and migrates
persisted rows. Those are useful persisted-data behaviors, but they are not a
single local-directory identity and include the additional identity branches
explicitly excluded by this requirement.

## R1 Historical 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Git repository with a resolved common Git directory and at least one root commit | Git discovery in `Project.fromDirectory` | `git-common-dir` resolves to the repository's shared Git storage directory | `InstanceStore.load` -> `Project.fromDirectory` | Project service | observed/contracted |
| Two distinct local Git repositories with copied or equal `.git/opencode` contents | Filesystem cache plus separate Git discoveries | Current code does not validate cache ownership | two directory Instances -> same `ProjectTable.id` | Project service | observed/reachable |
| Multiple linked worktrees of one repository | Git common directory | worktrees share common Git storage | `git-common-dir` resolution | Project service | observed/contracted |
| Git repository deleted and recreated at the same local repository storage path | user Git lifecycle plus `Project.fromDirectory` | same canonical Git common-directory path remains available after reinitialization | fresh Project resolution | Project service | reachable |
| Non-Git directory or Git repository without a root commit | existing Project resolver | current `ProjectID.global` contract and tests | `fromDirectory` no-identity branch | Project service | contracted, preserved |
| Same remote cloned into different local repositories | Git remote producer | upstream treats normalized remote as one logical Project, but this plan explicitly chooses local Project identity | upstream resolver only | out of scope for this primary contract |

## R1 Historical 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Two Git repositories with different canonical Git common directories never receive the same Project ID, regardless of `.git/opencode` contents. | Running daemon returns one ID for two directories; cache is the first divergent input. | None; current tests do not copy the cache between repositories. |
| INV-02 | Repeated resolution of one Git repository returns the same Project ID. | Project identity is persisted at the Project service seam. | `packages/opencode/test/project/project.test.ts:145-151` covers repeated resolution but not the new source. |
| INV-03 | Linked worktrees of one Git repository receive the same Project ID because they resolve the same Git common directory. | Current worktree behavior and `git-common-dir` contract. | `packages/opencode/test/project/project.test.ts:227-251` covers the intended sharing. |
| INV-04 | Removing and recreating Git metadata at the same local Git common-directory path does not change the Project ID. | User requirement and the selected canonical local identity. | None. |
| INV-05 | The Project resolver has one Git identity source and does not read or write `.git/opencode` as a fallback or compatibility identity. | User explicitly forbids fallback and redundant compatibility logic. | None. |

## R1 Historical 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `Project.fromDirectory` accepts `.git/opencode` before using the current Git repository identity, so an unrelated or stale cache controls the Project ID. | `Project.Service.fromDirectory` / Project identity resolver | `packages/opencode/src/project/project.ts:185-214`; root cache `a393...` differs from current root commit `4b...`; both runtime directory queries return `a393...`. |
| INV-04 | Project identity is derived from Git history/cache rather than the stable local Git common-directory identity. | Project identity resolver | `packages/opencode/src/project/project.ts:239-254`; deleting/recreating Git metadata can change the root commit and cache. |
| INV-05 | The resolver writes a selected ID into `.git/opencode`, creating a second mutable identity source. | Project identity resolver | `packages/opencode/src/project/project.ts:251-254`; current cache is accepted at `:185-190`. |

### Red-capable feedback loop

The minimized public seam is `Project.Service.fromDirectory` in
`packages/opencode/test/project/project.test.ts`. The existing live test
fixture can create two Git repositories and write the same `.git/opencode`
value into both. The required regression command is:

```text
bun test test/project/project.test.ts
```

Working directory:

```text
F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode
```

The new red behavior must assert that two distinct Git common-directory paths
produce different Project IDs while their cache files contain the same value.
The current resolver is expected to fail this assertion by returning the cache
value for both repositories.

## R1 Historical 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Git Project identity derivation | `Project.Service.fromDirectory` | Resolve one Project identity from the opened directory's Git metadata | This is the first producer of ProjectID and owns Git discovery/common-dir normalization | TUI only consumes the Project; daemon routing only selects the directory; Session only stores the foreign key. |
| Cache removal from identity resolution | `Project.Service.fromDirectory` | No mutable copied file may override the current canonical identity | The resolver owns the cache read/write currently causing the divergence | Database upsert cannot determine whether an incoming ID is correct. |
| Behavioral regression | `Project.Service.fromDirectory` public test seam | Public Project resolution exposes the final ID | The bug is an identity result, not a private helper result | HTTP/TUI tests add daemon and renderer noise without improving the first seam. |

## R1 Historical 10. Single Approved Primary-Path Design

```text
opened directory
  -> current Git discovery
  -> canonical Git common-directory path
  -> Hash.fast("git-common:" + normalized common directory)
  -> ProjectID
  -> ProjectTable upsert
```

For a Git repository that has a root commit, replace the current cache/root
selection with one canonical local identity material: the normalized absolute
Git common-directory path. The existing `common` value is already resolved by
`Project.fromDirectory` through `git rev-parse --git-common-dir`; reuse that
value instead of adding another discovery layer.

The exact primary behavior is:

1. Import the existing `Hash` utility.
2. Derive the Project ID directly from the normalized `common` directory.
3. Remove `readCachedProjectId` from the identity decision.
4. Remove the `.git/opencode` write from the identity decision.
5. Leave the existing no-root/non-Git `ProjectID.global` domain unchanged.

This is one Git identity algorithm, not a remote branch followed by a cache or
root fallback. Distinct local Git repositories have distinct common-directory
paths; linked worktrees intentionally share the common directory and therefore
share the Project ID. A repository recreated in the same local Git storage path
retains its Project ID without consulting deleted Git history or stale cache.

The canonical material includes a namespace prefix (`git-common:`) so the
Project ID input is unambiguous without adding another runtime branch.

## R1 Historical 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Canonical Git common-directory hash | proposed | primary-contract path | yes | 100% | add |
| `.git/opencode` cache as current ID | current | broken primary projection | yes, incorrectly | existing | remove |
| Git root commit as current ID | current | broken secondary identity source | yes, inconsistently | existing | remove |
| Normalized remote URL as current ID | upstream only | rejected alternative contract | yes | 0% | reject |
| Old cache/root ID migration during resolution | not proposed | compatibility path explicitly excluded by user | yes | 0% | reject |
| Session ID lookup, path fallback, or last-session selection | not proposed | forbidden fallback | yes | 0% | reject |

No new alternate success path is authorized. The only supported Git identity
operation is the canonical common-directory hash.

## R1 Historical 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `readCachedProjectId` | Preserved a Project ID across normal repository openings | A mutable file is not the identity owner and can be copied or become stale | `packages/opencode/src/project/project.ts:185-191` |
| Root-commit-derived Project ID | Provided a first identity when the cache was absent | The local Git common directory is the selected stable identity source | `packages/opencode/src/project/project.ts:239-254` |
| `.git/opencode` write | Persisted the selected cache identity | The canonical path is resolved on every Project load; no second source is needed | `packages/opencode/src/project/project.ts:251-254` |
| Test expectation that separate clones share ID | Encoded the previous root-commit/cache identity behavior | Separate local Git common directories are separate local Projects under this contract | `packages/opencode/test/project/project.test.ts:255-272` |

## R1 Historical 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Git common-dir discovery -> hash -> ProjectID | `packages/opencode/src/project/project.ts` | Two Git repositories with identical cache contents receive different IDs. |
| INV-02 | Same common-dir path -> same hash | `packages/opencode/src/project/project.ts` | Repeated `Project.Service.fromDirectory` returns the same ID. |
| INV-03 | Shared Git common-dir -> shared hash | `packages/opencode/src/project/project.ts` | Linked worktree and main repository receive the same ID. |
| INV-04 | Recreated Git metadata at same common-dir path -> same hash | `packages/opencode/src/project/project.ts` | Delete/reinitialize Git metadata in one temp path and assert ID stability. |
| INV-05 | Resolver no longer reads/writes cache or root commit | `packages/opencode/src/project/project.ts` | Regression fixture writes conflicting cache values and asserts they do not affect IDs; existing cache-write assertion is inverted to absence. |

## R1 Historical 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Hash of normalized Git common directory | INV-01, INV-02, INV-03, INV-04 | `Project.fromDirectory` already resolves `common`; `Hash.fast` already exists | Current cache/root logic can return the same ID for distinct directories or change after Git recreation. |
| Removal of cache read/write | INV-01, INV-04, INV-05 | Current root cache differs from the current Git root and controls the result | Keeping the cache would leave two competing identity sources. |
| One test file at Project service seam | INV-01 through INV-05 | Existing public live fixtures already create Git repos and worktrees | TUI/daemon tests would test downstream symptoms instead of the identity producer. |

## R1 Historical 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.ts` | modify | Replace cache/root Project ID selection with the single canonical Git common-directory hash; remove cache read/write identity behavior. | approximately +3 / -18 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\project\project.test.ts` | modify | Add the conflicting-cache and Git-recreation regressions; update existing cache/clone expectations to the selected identity contract. | approximately +35 / -15 |

No other production file, schema, migration, generated file, TUI file, daemon
file, or thirdparty file is in scope.

## R1 Historical 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Create two Git repositories, write the same `.git/opencode` contents into both, resolve both through `Project.Service.fromDirectory`, and assert their IDs differ. | Current resolver returns the copied cache value before using current repository data. | The resolver hashes each repository's canonical common-directory path. | Prevents the exact cross-directory Project collision. |
| 2 | Resolve a main repository and a linked worktree and assert the IDs are equal. | This remains the supported common-directory identity contract. | Both calls hash the same Git common directory. | Preserves worktree grouping without a second identity path. |
| 3 | Resolve a Git repository, remove and recreate its Git metadata at the same local path, and assert the Project ID is unchanged. | Current root-commit/cache identity changes when Git metadata is recreated. | The canonical local common-directory path remains the single identity input. | Protects the user's Git reinitialization scenario. |
| 4 | Assert the resolver does not create `.git/opencode` during Project resolution. | Current implementation writes the chosen ID into a second mutable source. | No cache file is part of Project resolution. | Prevents recurrence through copied cache state. |

## R1 Historical 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 40-55 | Production and behavioral test lines only; exclude imports, formatting, and deleted test setup. |
| Required Chinese explanatory comments `C` | 6-9 | `max(1, ceil(E * 0.15))`; comments explain common-dir ownership, worktree sharing, cache deletion, and test intent. |

Qualifying comments must be adjacent to the common-directory hash decision and
the Git recreation regression. They must explain why the cache is deliberately
not consulted and why linked worktrees share one local Project identity.

## R1 Historical 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/project/project.test.ts` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Project identity, cache-independence, worktree-sharing, and Git recreation behavior. |
| `bun typecheck` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Hash import, Project service typing, and test fixture typing. |
| `git diff --check` | `F:\ML\PythonAIProject\Claude-Code\opencode` | Whitespace correctness after implementation. |

The implementation must not be verified by starting or modifying the shared
daemon. The Project service seam is sufficient to prove the first divergence.

## R1 Historical 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing Project service and test seam are sufficient. |
| Files modified | 2 | One owning production file and one public behavior test file. |
| Files deleted | 0 | No compatibility artifact is introduced. |
| Production lines | 15-25 net | One hash import, one identity expression, removal of cache helper/write, and nearby explanation. |
| Test lines | 20-40 net | Two focused lifecycle regressions and existing expectation updates. |
| Generated lines | 0 | No schema or migration change. |

## R1 Historical 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. This revision explicitly selects local Git common-directory identity:
separate clones with separate local Git common directories are separate Projects;
linked worktrees sharing one common directory remain one Project.

### Rejected Speculation

- The upstream 1.18.15 remote-first resolver is not the selected primary path because it intentionally gives separate local clones of the same normalized remote one Project ID and retains cache/root branches explicitly excluded by the request.
- Changing daemon startup ownership or adding TUI reconnect logic does not repair the first identity divergence.
- Changing Session list predicates cannot repair a wrong Project ID at the Project producer.
- A path or Session ID fallback is not needed to satisfy the selected Git identity contract and is forbidden by the request.
- Migrating arbitrary historical IDs is not part of this parser-only revision; it would be a separate persisted-data repair with a separate contract and larger ownership surface.

## R1 Historical 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct `Project.fromDirectory`, Git common-directory discovery, ProjectTable upsert, InstanceStore routing, and existing Project tests from the current repository.
- Compare the proposed local common-directory identity with fetched `upstream/dev=1.18.15` without treating upstream as implementation authority.
- Audit the no-cache/no-root/no-remote-fallback constraint, worktree invariant, Git recreation behavior, ownership, two-file diff budget, and test sensitivity.
- Check that no thirdparty source, daemon lifecycle behavior, or downstream TUI workaround is added.
- Check the 15 percent Chinese explanatory-comment plan.

## R1 Historical 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: Persisted Project/Session ownership is left inconsistent after the identity change | Path canonicalization underspecified; line estimates inconsistent; upstream comparison absent from verification | BLOCK | independent adversarial-auditor task `ses_01b1e6809ffepap1ylcGd02gR0` |

Any substantive revision invalidates earlier approval.

The next revision must add one transactional identity transition at the Project
persistence owner. It must re-key persisted Project consumers to the canonical
ID without turning the old cache, root commit, directory lookup, or Session
lookup into a runtime identity fallback. Until that transition is specified and
re-audited, implementation remains prohibited.

## R1 Historical 23. Implementation Evidence

Not applicable. Implementation is prohibited for this revision.

## R1 Historical 24. Implementation Audit Record

Not applicable. No implementation is authorized.

The sections above are retained as R1 audit history only. The following R2
sections are the authoritative current revision.

## R2 Historical 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\CONTEXT.md:3-10,63-110,127-177` | Defines Session ownership, Project/InstanceState boundaries, Session path semantics, and v1 as production. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\AGENTS.md` | Requires package-local tests and typecheck. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\AGENTS.md:1-18,103-112,131-135` | Requires directory-scoped InstanceState and no ambient context shim. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\AGENTS.md:83-145,161-177` | Requires public seams and readiness signals. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\server\AGENTS.md:3-15` | Constrains Session/list tests to Effect fixtures. |
| `.opencode/policy/first-principles-engineering.md` and `.opencode/templates/canonical-plan.md` | Require first-divergence repair, no fallback, traceability, and independent audit. |
| `docs/adr/README.md` and `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | No accepted ADR owns Session event routing. |

## R2 Historical 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/event.ts:41-80` | Project-only event gate is the first divergence. | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/context/project.tsx:36-47,70-81` | Project state comes from startup path and is not rebound by Session route. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:141-171,609-921,930-1124` | SyncProvider consumes the filtered event and hydrates by Session ID. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-401,459-477,1289-1385` | Active Session route fetches by ID, listens to events, and renders Revert projection. | observed |
| `packages/opencode/src/cli/cmd/tui/app.tsx:363,984-1011` | App-level Session consumers use the same event hook. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1219-1223,1437-1459` | Prompt clears only after HTTP acceptance and relies on later events. | observed |
| `packages/opencode/src/bus/index.ts:98-121` and `packages/opencode/src/sync/index.ts:148-190,361-397` | Producers attach Instance Project context to events. | observed |
| `packages/opencode/src/session/session.ts:673-684,726-745,903-935` | Session/Message producers publish typed events. | observed |
| `packages/opencode/src/session/revert.ts:152-227` | Revert state and hidden Message cleanup are separate event phases. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:145-203` | Existing Session requests route by persisted directory. | contracted/observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:318-357,382-393` | Prompt/Revert APIs use Session ID and return separately from TUI projection. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:447-464`, `packages/opencode/src/session/path.ts:30-51`, `packages/opencode/src/session/session.ts:1103-1177` | Existing path list contract. | observed/contracted |
| `packages/opencode/test/cli/tui/use-event.test.tsx:123-180` and `packages/opencode/test/cli/cmd/tui/session-integration.test.ts:179-199` | Existing Project-only event contract. | observed |
| `packages/opencode/test/server/session-list.test.ts:240-265,269-357,500-582` | Existing related-path and cross-Project list coverage. | observed |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` and `session-exit.test.tsx:50-183,191-218` | Public Sync and exit test seams. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:54-109,111-120` | SSE receive, batching, and reconnect. | observed |
| Executed `bun -e` harness from package directory | Current real event seam fails with `cross-project active-session event was dropped: seen=0`. | observed |
| `git log -20`, `git diff HEAD~20..HEAD`, `git show 2b432d9e03`, `git show 3b2925b777`, `git show 0335c77017` | Recent-20 attribution and historical filter origin. | observed |
| Upstream `fa23fb5d38` and `69910f361c` | Upstream cross-workspace event and persisted-directory routing evidence. | observed |
| Live `GET /session/{id}`, `/project/current`, and Session list requests | Runtime symptom evidence only; daemon is outside current source tree. | observed |

## R2 Historical 5. Current Behavior

```text
TUI directory A -> SDK directory A -> ProjectProvider Project(A)
  -> Session list directory+path -> open Session S(directory B)
  -> Session HTTP GET/messages route by persisted B
  -> daemon publishes event.project = Project(B)
  -> useEvent compares event.project with Project(A)
  -> event is discarded before SyncProvider and route consumers
```

The SSE transport queues received events in `sdk.tsx`; the first proven
divergence is `useEvent`, not the HTTP Session route or the Sync reducer. Revert
first records `session.revert` and later publishes hidden Message/Part events;
Prompt acceptance likewise completes before the UI projection arrives.

## R2 Historical 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Related ancestor/descendant Session opened in TUI | SessionPath/list | `directory + path` is a supported Session path contract | Switcher -> route Session ID | Session path and TUI event owner | observed/contracted |
| Active Session Project differs from startup Project | Persisted Session and directory Instance | Existing Session routes use persisted directory | Session route -> GlobalBus event | `useEvent` | reachable/observed harness |
| Message/Session/Status event with Session ID | Session/Message/Status services | Typed payload already carries Session identity | Bus/Sync -> SSE -> useEvent | `useEvent` | observed/reachable |
| Non-Session Project event | VCS/LSP/installation producers | Existing Project isolation contract | GlobalBus -> TUI consumer | `useEvent` | contracted |
| Prompt/Revert accepted before projection | Prompt/Revert HTTP handlers | HTTP result is separate from event projection | HTTP -> service -> typed event | Session event delivery | observed |
| Black screen and `undefined` exit | TUI route/renderer | User report; no current source red trace yet | Session route -> ExitProvider/OpenTUI | pending original-loop verification | observed report, unverified path |

## R2 Historical 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Active Session-bound events reach the active route even when Project IDs differ. | Red harness; Bus/Sync producer context. | New active Session event test required. |
| INV-02 | Non-Session events from another Project remain ignored. | Existing `useEvent` contract. | `use-event.test.tsx:139-150`. |
| INV-03 | Existing Session operations route by persisted Session directory. | Workspace routing source and upstream fix. | Existing HTTP API tests. |
| INV-04 | Accepted Prompt produces visible active Session Message/Part projection. | Prompt and event producer chain. | New Sync behavior slice. |
| INV-05 | Revert state and hidden cleanup reach the active route. | Revert source and route renderer. | Existing revert/Sync tests plus cross-Project slice. |
| INV-06 | Ancestor/descendant Session list behavior remains intact without migration. | SessionPath and list predicates. | Existing server Session list tests. |
| INV-07 | Existing active Session exit retains a real Session ID. | ExitProvider harness and route source. | Existing exit test plus original loop. |

## R2 Historical 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-04, INV-05 | `useEvent.subscribe` returns on Project mismatch before checking the active Session ID. | `packages/opencode/src/cli/cmd/tui/context/event.ts` | Executed harness fails with `seen=0`. |
| INV-02 | No divergence; this remains the required non-Session branch. | `useEvent` | Current isolated four-test suite passes. |
| INV-03, INV-06 | No current-source first divergence proven; live list omission uses a daemon binary outside source and existing path tests cover the intended contract. | Session routing/list owner | Must remain a verification target, not speculative production logic. |
| INV-07 | No current-source renderer first divergence proven. | Exit/renderer path only if original loop isolates it | Must be verified after event repair. |

### Red-capable feedback loop

Executed from `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode`:

```text
bun -e '<SDKProvider -> ProjectProvider -> useEvent cross-Project Session-event harness>'
```

Observed:

```text
error: cross-project active-session event was dropped: seen=0
exit code 1
```

The harness exercises the real event owner and uses a Session-bearing payload
with a different Project ID. It is red on the current first divergence. The
original live loop remains mandatory for final verification of black screen,
Session list, Prompt, Revert, Ctrl+C, and `undefined`.

## R2 Historical 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| TUI event admission | `useEvent` | Deliver events belonging to the visible TUI domain | It is the first delivery gate | Bus and Sync cannot recover discarded events. |
| Active Session identity | Session-aware TUI callers | Route owns the current Session ID | Route is the first consumer that knows visible Session identity | Startup Project cannot represent later Session navigation. |
| Session HTTP routing | Workspace middleware | Existing Session requests use persisted directory | Already owns request Instance selection | TUI must not add a second route. |
| Path list | Session service | Existing related-path query contract | Session service owns SQL predicates | Event code cannot repair list queries. |

## R2 Historical 10. Single Approved Primary-Path Design

```text
GlobalBus event
  -> useEvent identifies the existing Session identity in its typed payload
  -> if it matches the active route Session, deliver it
  -> otherwise retain the current Project predicate for non-Session events
  -> existing Sync/route consumers update their Session projection
```

Extend the one event-domain predicate with the active route Session identity.
Recognize the existing `sessionID` property and `session.deleted.info.id`; do
not add a wire field, second query, retry, resync success path, or database
repair. Session identity is a supported branch of event admission, not a
failure-triggered fallback. Non-Session Project events keep their current
isolation.

The active Session accessor is passed only by existing route-aware consumers:
`SyncProvider`, the Session route, and App-level Session consumers. The path
list and persisted-directory HTTP path remain unchanged.

## R2 Historical 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Startup Project predicate for non-Session events | current | primary-contract branch | yes | existing | preserve |
| Active route Session predicate | proposed | primary-contract branch | yes | 0% alternate-success | add |
| `server.connected` bootstrap | current | existing reconnect contract | yes | existing | preserve |
| Project-ID migration/re-key | prior R1 | unrelated persisted repair | yes | 0% | reject in R2 |
| Session/path lookup after event rejection | not proposed | forbidden fallback | yes | 0% | reject |
| Error-to-success or OpenTUI workaround | not proposed | forbidden fallback | yes | 0% | reject |

## R2 Historical 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Project-only admission for every payload | `2b432d9e03` encoded startup Project as the complete TUI scope | It cannot represent an active Session opened through SessionPath | `context/event.ts` decision |
| Existing test that rejects all other-Project events | It lacks active Session context | Split non-Session isolation from active Session delivery | `test/cli/tui/use-event.test.tsx` |
| R1 B-01 persisted ownership blocker | R1 proposed Project ID rewriting | R2 does not change Project ownership; applying it would add out-of-scope migration work | R1 audit record only; no production carryover |

## R2 Historical 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Active route -> useEvent -> Sync/route consumers | `event.ts`, `sync.tsx`, Session route, App | Cross-Project active Session event |
| INV-02 | Non-Session event -> Project predicate | `event.ts` preserved branch | Other-Project VCS event ignored |
| INV-03 | Session ID -> persisted directory route | No production change | Existing HTTP route tests |
| INV-04 | Prompt -> Message/Part event -> Sync store | Event admission only | Cross-Project Message Sync slice |
| INV-05 | Revert -> Session/hidden Message events | Event admission only | Revert projection slice |
| INV-06 | Session list -> current related-path predicates | No production change | Existing path list tests |
| INV-07 | Session route -> ExitProvider | No production change unless loop proves new divergence | Exit fixture and original loop |

## R2 Historical 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Active Session accessor in `useEvent` | INV-01, INV-04, INV-05 | Red harness and route Session ID | Current hook knows only startup Project. |
| Existing-payload Session identity extraction | INV-01, INV-05 | Typed event producers already publish Session IDs | Project metadata cannot identify visible Session. |
| Route-aware calls | INV-01, INV-04, INV-05 | Existing callers already own route context | ProjectProvider is startup-scoped. |
| Behavior test separating Session and Project scopes | INV-01, INV-02 | Current test conflates the two contracts | Existing test cannot catch the original defect. |

## R2 Historical 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\event.ts` | modify | Add active Session admission to the existing event predicate; preserve Project isolation for non-Session events. | +25/-5 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\sync.tsx` | modify | Pass current route Session ID to the event owner. | +5/-1 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\routes\session\index.tsx` | modify | Pass route Session ID to direct Session listeners. | +1/-1 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\app.tsx` | modify | Pass route Session ID to App Session error/deletion listeners. | +3/-1 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\tui\use-event.test.tsx` | modify | Add active Session delivery and preserve unrelated Project isolation. | +30/-5 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\cmd\tui\sync.test.tsx` | modify | Verify real Message/Part projection after active cross-Project delivery. | +30 |

No schema, migration, generated file, daemon, thirdparty, or Project identity
production file is in scope. Production file count is exactly four maximum.

## R2 Historical 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Active Session event with a different Project ID reaches the active consumer. | Current `event.ts` returns on Project mismatch; executed harness is red. | Deliver one matching Session event. | Original cross-directory message symptom. |
| 2 | Other-Project VCS event without Session identity remains ignored. | Prevents broadening the event stream. | Preserve Project predicate. | Project isolation. |
| 3 | Hidden Message update and Part delta update the active Sync projection. | Current event gate prevents the reducer from seeing them. | Reuse existing reducer without new recovery path. | Revert and streaming. |
| 4 | Prompt acceptance and Revert state are visible in the active route. | HTTP returns independently of event projection. | Existing producers/consumers receive their events. | User-visible Prompt/Revert behavior. |
| 5 | Existing Session path tests remain green. | Protects the directory/path contract. | No SQL or migration change. | Session list behavior. |
| 6 | Exit fixture and original TUI loop retain Session ID after Ctrl+C. | The renderer path is not yet source-proven. | No `undefined` for an existing route Session. | Black screen/exit symptom. |

## R2 Historical 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 30-45 | Production decision lines only; exclude imports, formatting, tests, and moves. |
| Required Chinese explanatory comments `C` | 5-7 | `max(1, ceil(E * 0.15))`. |

Comments must explain active Session ownership, preservation of non-Session
Project isolation, and why existing payload identities are authoritative. They
must be adjacent to the changed decisions and not restate control flow.

## R2 Historical 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun -e '<cross-Project event harness>'` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Red before implementation and green after it. |
| `bun test test/cli/tui/use-event.test.tsx` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Session event delivery and Project isolation. |
| `bun test test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/session-exit.test.tsx` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Sync projection and exit behavior. |
| `bun test test/server/session-list.test.ts` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Existing related-path Session contract. |
| `bun typecheck` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Type safety. |
| `git diff --check` | `F:\ML\PythonAIProject\Claude-Code\opencode` | Whitespace correctness. |
| Original daemon/TUI cross-directory loop | User runtime directories | Black screen, Prompt, Revert, Session list, Ctrl+C, and `undefined`. |

Current Session-list runs are not accepted as green: they hit fixture disposal
timeouts and interrupted fibers. Those environment failures must be resolved or
reported as remaining unverified items before completion.

## R2 Historical 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing seams suffice. |
| Production files modified | 4 maximum | Event owner plus existing route-aware callers. |
| Files deleted | 0 | No workaround artifact. |
| Production lines | 35-70 net, hard maximum 200 | One event predicate and route accessors. |
| Test lines | 50-90 net | Public behavior slices. |
| Schema/migration/generated lines | 0 | Explicitly forbidden. |

## R2 Historical 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. The user already specified no migration, no fallback, no thirdparty
source change, and a four-production-file maximum.

### Real Risks

- The active Session branch must not leak non-Session VCS/LSP/installation events.
- The installed daemon executable is outside the source tree; final verification must use the intended current package build or record binary drift.
- Session-list fixture cleanup currently times out, so that behavior remains unverified until the fixture lifecycle is isolated.
- A separate OpenTUI renderer divergence may remain; it can create a new plan revision only after the original loop proves it following the event repair.

### Rejected Speculation

- Prior R1 blocker `B-01` concerns persisted Project/Session ownership after a Project-ID rewrite. R2 does not rewrite Project IDs or persisted ownership, so applying it would be unrelated scope expansion and violate the no-migration requirement.
- Runtime list omission alone cannot prove a current-source SQL defect because the running binary is `F:\include\CLI\opencode.exe`, outside the repository source path.
- Recent hidden-message, reducer-guard, and OpenTUI commits remain downstream/adjacent until a red original loop proves a separate first divergence.

## R2 Historical 21. Audit Contract

The independent auditor must read this exact R2 file and the complete original
requirement, reconstruct the daemon/TUI Session list, HTTP routing, SSE producer,
`useEvent`, SyncProvider, Prompt, Revert, renderer/exit, and recent-20 paths,
and audit the active Session event repair for ownership, no fallback, Project
isolation, no migration, four-file production limit, and original-loop coverage.
The auditor must treat the red harness and this plan as evidence to verify, not
as builder authority, and must separately judge whether R1 `B-01` applies to the
R2 change.

## R2 Historical 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: persisted Project/Session ownership left inconsistent after Project identity change | Path canonicalization and estimate issues | BLOCK; R1 superseded and explicitly rebutted for R2 event-only repair | `ses_01b1e6809ffepap1ylcGd02gR0` |
| 2 | R2 | pending | pending | pending | pending | pending |

Implementation remains prohibited until R2 receives a full-scope `No blocking
findings` and `APPROVE` verdict.

## R2 Historical 23. Implementation Evidence

Not applicable. Implementation is prohibited for this revision.

## R2 Historical 24. Implementation Audit Record

Not applicable. No implementation is authorized.

The R1 and R2 sections above are retained as audit history. The following R3
sections are the sole authoritative current revision.

## R3 Historical 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\CONTEXT.md:3-10,63-110,127-177` | Project/Session/InstanceState ownership and v1 production boundary. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\AGENTS.md` | Package-local verification and minimal repository changes. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\AGENTS.md:1-18,103-112,131-135` | Project directory state uses InstanceState; no ambient context shim. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\AGENTS.md:83-145,161-177` | Tests use public seams and published readiness. |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\server\AGENTS.md:3-15` | Session/list tests use Effect fixtures and scoped routing. |
| `.opencode/policy/first-principles-engineering.md` and `.opencode/templates/canonical-plan.md` | First-divergence, no-fallback, traceability, audit, and comment gates. |
| `docs/adr/README.md` | No accepted ADR overrides Project identity or Session event routing. |

## R3 Historical 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/project/project.ts:185-254,275-339` | `.git/opencode` is read before Git identity and ProjectTable is upserted by the selected ID. | observed |
| `packages/opencode/src/project/project.sql.ts:5-17` | Project ID is the ProjectTable primary key. | contracted |
| `packages/opencode/src/project/instance-store.ts:116-134` | Instances are keyed by canonical directory. | contracted |
| `packages/core/src/util/hash.ts:1-7` | Existing deterministic hash seam for canonical local identity. | contracted |
| `packages/opencode/test/project/project.test.ts:103-153,190-272` | Public Project resolver seam and existing cache/worktree/clone behavior. | observed |
| `packages/opencode/src/session/session.sql.ts:109-161` | Session rows retain `project_id`, `directory`, and `path`. | contracted |
| `packages/opencode/src/session/session.ts:166-214,679-684,1103-1177` | Directory fallback and path query can read legacy Sessions without changing their Project foreign key. | observed/reachable |
| `packages/opencode/src/session/path.ts:30-51` | Ancestor, alias, and related path semantics. | contracted |
| `packages/opencode/src/cli/cmd/tui/context/event.ts:41-80` | Current event gate discards explicit Project events before active Session identity. | observed |
| `packages/opencode/src/cli/cmd/tui/context/route.tsx:10-47` | Route context owns the current Session ID and is available above TUI consumers. | observed |
| `packages/opencode/src/cli/cmd/tui/app.tsx:292-336` | RouteProvider wraps Project, Sync, and Session consumers. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:54-109,111-120` | SSE receive and emitter path. | observed |
| `packages/opencode/src/bus/index.ts:98-121` and `packages/opencode/src/sync/index.ts:148-190,361-397` | Event Project metadata comes from the active Instance context. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:145-203` | Existing Session routes use persisted directory. | observed/contracted |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:447-464,609-921,930-1124` | TUI path list and Message/Session projection consumers. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-401,459-477,1289-1385` | Active route fetches by Session ID and renders Revert projection. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1219-1223,1437-1459` | Prompt acceptance is separate from event projection. | observed |
| `packages/opencode/src/session/revert.ts:152-227` | Revert and hidden cleanup production path. | observed |
| `packages/opencode/test/cli/tui/use-event.test.tsx:123-180` | Current Project event contract and test seam. | observed |
| `packages/opencode/test/server/session-list.test.ts:240-265,269-357,500-582` | Existing related-path and cross-Project list behavior. | observed |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` and `session-exit.test.tsx:50-183,191-218` | TUI Sync and exit behavior seams. | observed |
| Executed cross-Project `bun -e` harness | Current event owner returns no active event (`seen=0`). | observed |
| `git show 2b432d9e03`, `git log -20`, `git diff HEAD~20..HEAD` | Project filter origin and recent-20 attribution. | observed |
| Upstream `fa23fb5d38`, `69910f361c`, `015e79fa59` | Upstream event and persisted-directory reference behavior. | observed |
| Live Project/Session/list GETs | Same Project ID, overwritten worktree, direct Session success, and list omission. | observed; runtime binary caveat |

## R3 Historical 5. Current Behavior

```text
TUI directory
  -> Project.fromDirectory reads copied/stale .git/opencode
  -> Project ID is accepted and ProjectTable row is upserted by that ID
  -> distinct directory Instances can share one Project row/worktree
  -> Session list and event metadata use the wrong Project context
  -> Session route still requests by Session ID and persisted directory
  -> useEvent rejects valid Session-bound events when Project differs
```

There are two linked first divergences in the supported cross-directory domain:

1. `Project.fromDirectory` accepts a mutable cache before the current Git
   common-directory identity, producing the wrong Project ID.
2. Even after Project IDs are correct, SessionPath legitimately opens a Session
   from another Project; `useEvent` still treats startup Project as the only
   event scope and drops the active Session event.

The repair must fix both owners. The existing directory/path query is retained
as the primary historical Session compatibility path and needs no migration.

## R3 Historical 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Git repository with resolved common Git directory | Git discovery | `git-common-dir` is resolved and normalized by Project service | InstanceStore -> Project.fromDirectory | Project service | observed/contracted |
| Copied/stale `.git/opencode` value | Filesystem cache | Current code does not validate cache ownership | Project.fromDirectory -> ProjectTable | Project service | observed/reachable |
| Linked worktrees | Git common directory | Linked worktrees share common Git storage | Project.fromDirectory | Project service | contracted |
| Git repository recreated at same local common-directory path | Filesystem/Git lifecycle | Common directory path is the selected local identity material | Project.fromDirectory | Project service | reachable/user requirement |
| Existing Session whose old Project ID remains persisted | SessionTable | Session also retains physical directory/path; list has directory fallback | Session.list -> relatedDirectoryConditions | Session service | observed/reachable |
| Active Session from a different Project | SessionPath and route | Route owns Session ID; event payload owns Session ID | GlobalBus -> useEvent | TUI event owner | observed/reachable |
| Non-Session event from another Project | VCS/LSP/installation producer | Existing Project isolation | GlobalBus -> useEvent | TUI event owner | contracted |
| Prompt/Revert accepted before projection | Prompt/Revert handlers | HTTP result and event projection are separate | HTTP -> Session -> events | Session/event owners | observed |
| Black screen/undefined exit | TUI renderer/exit | User report, no independent source red trace yet | Session route -> ExitProvider | pending original-loop verification | observed report |

## R3 Historical 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing or planned test |
| --- | --- | --- | --- |
| INV-01 | Distinct local Git common-directory paths never receive the same Project ID because of copied/stale `.git/opencode`; linked worktrees sharing common storage retain one ID. | Project producer and live same-ID observation. | Project resolver regression slice. |
| INV-02 | Recreated Git metadata at the same local common-directory path retains the Project ID. | User requirement and selected local identity contract. | Project lifecycle regression slice. |
| INV-03 | Historical Sessions remain listable through the existing directory/path contract without re-keying rows. | Session schema and `relatedDirectoryConditions`. | Cross-Project legacy Session list test. |
| INV-04 | Active Session-bound events reach the active route even when their Project differs from startup Project. | Red event harness and route context. | Active Session event test. |
| INV-05 | Non-Session Project events remain isolated by Project. | Existing `useEvent` contract. | Existing other-Project test. |
| INV-06 | Prompt, Message Part, Status, and Revert projections update in the active Session. | Producer/consumer chain. | Sync and route behavior slices. |
| INV-07 | Existing Session exit retains a real Session ID. | ExitProvider harness and original loop. | Existing exit test plus original loop. |
| INV-08 | No schema, migration, fallback, or second success path is introduced. | Explicit user constraint. | Diff/audit verification. |

## R3 Historical 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `readCachedProjectId` accepts `.git/opencode` before the current Git common-directory identity and writes the selected value back. | `Project.Service.fromDirectory` | `project.ts:185-190,239-254`; live root/nested queries share an ID and ProjectTable worktree. |
| INV-03 | No current source divergence is assumed; existing fallback must be proven with a cross-Project legacy row. | `Session.list` | `session.ts:1133-1158` explicitly ORs directory predicates outside Project ID. |
| INV-04, INV-06 | `useEvent` rejects an explicit Project event before checking active Session identity. | `useEvent` | Executed red harness reports `cross-project active-session event was dropped: seen=0`. |
| INV-07 | No source-level renderer divergence is proven. | Exit/renderer only if original loop isolates it | Existing exit harness plus required original loop. |

### Red-capable feedback loop

Executed from `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode`:

```text
bun -e '<SDKProvider -> ProjectProvider -> useEvent cross-Project Session-event harness>'
```

Observed red result:

```text
error: cross-project active-session event was dropped: seen=0
exit code 1
```

The Project producer red loop must be added at the public
`Project.Service.fromDirectory` seam before implementation and run red against
two Git fixtures with identical cache contents. The original daemon/TUI loop
remains required for final black-screen, list, Prompt, Revert, and exit proof.

## R3 Historical 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Git Project identity | `Project.Service.fromDirectory` | Resolve one Project ID from current local Git identity | It is the first Project ID producer and cache owner | Session/TUI consumers cannot determine whether an ID is correct. |
| Legacy Session visibility | Existing `Session.list` directory/path contract | Return related Sessions across persisted Project IDs when directory/path matches | Existing Session service already owns this predicate | Project resolver must not re-key historical rows. |
| Event admission | `useEvent` | Deliver active Session events and isolate unrelated Project events | First TUI delivery gate | Bus/Sync cannot recover dropped events. |

## R3 Historical 10. Single Approved Primary-Path Design

### Project identity path

```text
opened Git directory
  -> resolved canonical Git common-directory path
  -> normalized local identity material
  -> existing Hash.fast with a namespace prefix
  -> ProjectID
  -> existing ProjectTable upsert
```

For Git repositories with a resolved common directory, remove the cache/root
selection from the identity decision. Hash the normalized absolute common Git
directory with a namespace prefix. The same common directory yields one ID for
linked worktrees; different local common directories yield different IDs; a
recreated repository at the same local path retains the ID. Preserve the current
`ProjectID.global` behavior for non-Git and unresolved Git cases.

Do not write `.git/opencode` from Project resolution. Existing stale cache files
are ignored, not migrated or used as a second identity source.

Historical Session rows are not re-keyed. Once the current Project row is
created under its correct ID, the existing directory/path predicate remains the
single list path for old rows, and Session HTTP routes continue to use Session
ID plus persisted directory.

### Active Session event path

```text
GlobalBus event
  -> useEvent reads current RouteProvider Session ID
  -> Session-bound payload matching the active Session is delivered
  -> non-Session payload retains startup Project isolation
  -> existing Sync/route consumers apply the event
```

`useEvent` may use the existing `useRoute` context because `RouteProvider`
already wraps Project, Sync, and Session consumers in `app.tsx:292-336`. It must
recognize only existing typed `sessionID` and `session.deleted.info.id` forms.
This is one coherent event-domain rule, not a fallback after Project matching
fails.

## R3 Historical 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Canonical common-directory Project ID | proposed | primary-contract path | yes | primary | add |
| `.git/opencode` cache/root-commit identity | current | broken competing identity path | yes, incorrectly | existing | remove from identity decision |
| Directory/path Session list for legacy rows | current shipped path | existing compatibility contract | yes | existing | preserve, test |
| Active Session ID event admission | proposed | primary-contract branch | yes | primary | add |
| Non-Session Project event admission | current | primary-contract branch | yes | existing | preserve |
| Project/Session migration | not proposed | out-of-scope persisted repair | yes | 0% | reject |
| Session-ID lookup fallback or second list query | not proposed | forbidden fallback | yes | 0% | reject |
| Error-to-success or renderer workaround | not proposed | forbidden fallback | yes | 0% | reject |

## R3 Historical 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `readCachedProjectId` and cache write | Preserved a mutable ID across openings | Canonical common directory is the one Project identity owner | `packages/opencode/src/project/project.ts:185-190,239-254` |
| Root-commit identity branch | First identity when cache absent | One common-directory hash removes competing Git identity sources | `packages/opencode/src/project/project.ts:239-254` |
| Project-only event admission for all payloads | Startup Project was treated as complete TUI scope | Active route Session identity is an existing stronger owner for Session events | `packages/opencode/src/cli/cmd/tui/context/event.ts:69-71` |
| R1 B-01 migration demand | Came from a Project-ID rewrite plan | Existing directory/path and Session-ID contracts preserve required historical access without migration | R1 audit history only |

## R3 Historical 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Git common-dir -> Hash -> ProjectID | `packages/opencode/src/project/project.ts` | Distinct repos with identical cache values get distinct IDs; worktrees share. |
| INV-02 | Same common-dir hash | `project.ts` | Delete/recreate Git metadata at same path retains ID. |
| INV-03 | Existing path/directory fallback | No production change | Cross-Project legacy Session appears in list. |
| INV-04, INV-06 | Route Session ID -> event admission -> existing Sync | `packages/opencode/src/cli/cmd/tui/context/event.ts` | Active cross-Project Session event and Message/Part projection. |
| INV-05 | Non-Session event -> Project predicate | `event.ts` preserved branch | Other-Project VCS event ignored. |
| INV-07 | Session route -> ExitProvider | No production change unless original loop proves another divergence | Exit fixture and original loop. |
| INV-08 | No migration/fallback/schema | All planned files | Diff audit and type/test verification. |

## R3 Historical 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Normalized common-directory hash | INV-01, INV-02 | Existing `common` resolution and `Hash.fast`; live collision | Cache/root selection returns wrong or unstable IDs. |
| Cache read/write removal | INV-01, INV-02, INV-08 | Copied/stale cache is the first Project divergence | Keeping it leaves two identity sources. |
| Route-aware Session event admission | INV-04, INV-05, INV-06 | Red harness and existing RouteProvider | Startup Project cannot represent a later active Session. |
| No Project/Session migration | INV-03, INV-08 | Existing directory fallback and user prohibition | Migration expands ownership and is unnecessary for the requested access path. |

## R3 Historical 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.ts` | modify | Replace cache/root Project identity selection with one normalized common-directory hash; remove cache read/write identity behavior. | +8/-24 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\event.ts` | modify | Use active Route Session identity for Session-bound events while preserving Project isolation for other events. | +22/-5 |

Production files: 2. No other production file is authorized unless an
implementation red test proves a direct owner drift; that would require R4.

## R3 Historical 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Two Git repositories with identical `.git/opencode` values resolve to different IDs. | Current resolver returns the copied cache value before current Git identity. | Hash each normalized common directory. | Project collision. |
| 2 | Main repository and linked worktree resolve to the same ID; recreation at same local common path retains ID. | These are the selected local identity invariants. | Same common-directory material produces same hash. | Worktree/recreation semantics. |
| 3 | Legacy Session with old Project ID but current directory appears in path-scoped list. | Current behavior must be proven before implementation; no migration path exists. | Existing directory/path predicate returns it. | Historical Session visibility without migration. |
| 4 | Active Session event with a different Project ID is delivered. | Current Project-only gate returns early; executed harness is red. | `useRoute` active Session identity admits it. | Prompt/Revert/Message updates. |
| 5 | Other-Project VCS event without Session identity remains ignored. | Protects existing isolation. | Preserve Project predicate. | Cross-Project leakage. |
| 6 | Run existing Sync/exit tests and original daemon/TUI scenario. | Downstream symptoms must be verified after both producer and event fixes. | Existing consumers work without fallback. | Full user-visible behavior. |

## R3 Historical 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 35-60 | Production decision lines only; exclude imports, formatting, tests, and moves. |
| Required Chinese explanatory comments `C` | 6-9 | `max(1, ceil(E * 0.15))`; comments explain common-dir ownership, cache removal, worktree sharing, and active Session event scope. |

Comments must be adjacent to the identity and event decisions, explain why
cache is ignored and why route Session identity is authoritative, and must not
repeat obvious control flow.

## R3 Historical 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/project/project.test.ts` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Project identity red/green, worktree sharing, recreation, and no cache write. |
| `bun -e '<cross-Project event harness>'` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Event owner red/green. |
| `bun test test/cli/tui/use-event.test.tsx` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Active Session admission and non-Session isolation. |
| `bun test test/server/session-list.test.ts` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Legacy cross-Project path visibility. |
| `bun test test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/session-exit.test.tsx` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Message projection and exit behavior. |
| `bun typecheck` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Type safety. |
| `git diff --check` | `F:\ML\PythonAIProject\Claude-Code\opencode` | Whitespace correctness. |
| Original two-daemon cross-directory loop | User runtime directories | Black screen, list, Prompt, Revert, Ctrl+C, and real Session ID. |

The previous Session-list run timed out during fixture disposal and is not green
evidence. It must be rerun after fixture/process isolation is understood.

## R3 Historical 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing Project/event/test seams suffice. |
| Production files modified | 2 | Project identity producer and TUI event owner. |
| Files deleted | 0 | No migration/workaround artifact. |
| Production lines | 35-70 net, hard maximum 200 | One identity source and one event predicate. |
| Test lines | 60-110 net | Public identity, list, event, Sync, and exit behavior. |
| Schema/migration/generated lines | 0 | Explicitly forbidden. |

## R3 Historical 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. Local common-directory identity, no migration, no fallback, and the four
production-file maximum are already specified by the user and this revision.

### Real Risks

- Existing old Project rows remain in SQLite; the plan relies on the already-shipped directory/path Session list and Session-ID HTTP route, which must be proven by behavior tests.
- `useEvent` will require RouteProvider in its test harness; production `app.tsx` already places RouteProvider above all TUI consumers.
- The installed daemon binary is outside the source tree; final verification must use the intended current package build or record binary drift.
- A separate OpenTUI renderer divergence may remain after identity/event repair; it requires a new evidence-backed revision, not a workaround in R3.

### Rejected Speculation

- R1 B-01's demand to re-key Project/Session/Workspace ownership is not required by the requested behavior if existing directory/path and Session-ID routes prove old rows remain accessible; it is not added without such evidence.
- Remote-first Project identity is not selected because the requested invariant is local Git common-directory identity and separate local clones must remain distinct.
- Session lookup fallback, second list query, reconnect success fallback, and error-to-success conversion are forbidden and do not repair either producer.

## R3 Historical 21. Audit Contract

The independent auditor must read this exact R3 file and the complete original
requirement, reconstruct Project identity production/persistence, Session list
legacy visibility, persisted-directory routing, GlobalBus/Sync event metadata,
RouteProvider/useEvent admission, Prompt/Revert consumers, renderer/exit, and
recent-20 attribution. Audit the two-file primary repair for root ownership,
no migration, no fallback, historical Session access, active Session event
delivery, non-Session Project isolation, test sensitivity, and the 15 percent
Chinese-comment plan. The auditor must independently decide whether R1 B-01 is
required by R3's actual behavior and must audit the complete original scope.

## R3 Historical 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: persisted Project/Session ownership left inconsistent after Project identity change | Path canonicalization and estimate issues | BLOCK; superseded | `ses_01b1e6809ffepap1ylcGd02gR0` |
| 2 | R2 | yes | B-01: R2 did not repair Project ID producer; B-02: Session list had no executable production repair | Red harness mismatch; verification specificity; historical plan readability | BLOCK | `ses_01a4212eaffeepE5zvpZYCPQB5` |
| 3 | R3 | pending | pending | pending | pending | pending |

Implementation remains prohibited until R3 receives a full-scope `No blocking
findings` and `APPROVE` verdict.

## R3 Historical 23. Implementation Evidence

Not applicable. Implementation is prohibited for this revision.

## R3 Historical 24. Implementation Audit Record

Not applicable. No implementation is authorized.

R3 was independently blocked by B-01 through B-04. R5 below is the sole
authoritative current revision.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md:3-10,63-110,127-177` | Session/Project/InstanceState vocabulary and v1 production boundary. |
| `AGENTS.md`, `packages/opencode/AGENTS.md` | Package-local verification, existing Project/InstanceState ownership, no ambient shim. |
| `packages/opencode/test/AGENTS.md`, `packages/opencode/test/server/AGENTS.md` | Public behavior seams, live fixtures, and Effect server-test rules. |
| `.opencode/policy/first-principles-engineering.md`, `.opencode/templates/canonical-plan.md` | First divergence, no fallback, traceability, audit, and complete E/C gates. |
| `docs/adr/README.md` | No accepted ADR changes these contracts. |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `packages/opencode/src/project/project.ts:185-254,275-339` | Cache-first Project identity and ID-keyed persistence. | observed |
| `packages/opencode/src/project/project.sql.ts:5-17` | Project ID primary key. | contracted |
| `packages/opencode/src/project/instance-store.ts:116-134` | Directory-keyed Instances. | contracted |
| `packages/opencode/test/project/project.test.ts:104-118,145-164,227-272,628-710` | No-commit global, root identity, worktree sharing, clone sharing, and bare repo contracts. | observed/contracted |
| `packages/core/src/util/hash.ts:1-7` | Existing hash utility; not required for R5 root-commit identity. | observed |
| `packages/opencode/src/session/session.ts:166-214,679-684,1103-1177` | Existing path/directory fallback for historical Session rows. | observed/reachable |
| `packages/opencode/src/session/path.ts:30-51`, `session.sql.ts:109-161` | Path and persisted directory/project fields. | contracted |
| `packages/opencode/src/cli/cmd/tui/context/event.ts:41-80` | Project-only event admission. | observed |
| `packages/opencode/src/cli/cmd/tui/context/route.tsx:10-47`, `app.tsx:292-336` | Route Session ID is available to event consumers. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:936-1064,1076-1124` | Bootstrap/list reconcile and direct Session sync. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-401,479-493,1289-1385` | Session route and undefined exit projection. | observed |
| `packages/opencode/src/bus/index.ts:98-121`, `packages/opencode/src/sync/index.ts:148-190,361-397` | Event Project metadata producer. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:145-203` | Persisted Session directory HTTP routing. | observed/contracted |
| `packages/opencode/src/session/revert.ts:152-227`, prompt handler/source | Revert and Prompt event lifecycles. | observed |
| `packages/opencode/test/cli/tui/use-event.test.tsx`, `sync-fixture.tsx`, `sync.test.tsx`, `session-exit.test.tsx` | Event, bootstrap, projection, and exit seams. | observed |
| `packages/opencode/test/server/session-list.test.ts` | Existing path/list contract. | observed |
| Executed cross-Project event harness | Current `useEvent` drops active Session event (`seen=0`). | observed |
| Executed active Session projection harness | `sync.session.sync` inserts `ses_target`, list refresh erases it (`before=ses_target after=undefined`). | observed |
| `git log -20`, `git diff HEAD~20..HEAD`, `git show 2b432d9e03` | Recent-20 and filter history. | observed |
| Upstream `fa23fb5d38`, `69910f361c`, `015e79fa59` | Reference event and persisted-directory fixes. | observed |

## 5. Current Behavior

```text
TUI directory -> Project.fromDirectory -> cache/root Project ID
  -> ProjectTable row keyed by that ID
  -> Session list uses current Project/path context
  -> Session route direct sync inserts the target Session by ID
  -> later bootstrap/list reconcile replaces the session array
  -> omitted target becomes session() === undefined
  -> blank route and opencode -s undefined on exit
```

The first observed user-visible divergence is the list snapshot replacing a
directly loaded active Session. The upstream producer error is that a copied or
stale `.git/opencode` value can make the current Project ID and ProjectTable
worktree wrong, causing the path-scoped list to omit the historical Session.
After this producer repair, the supported SessionPath contract still permits an
active Session from another Project, so `useEvent` must use the active Session
identity for Session-bound events.

## 6. Supported Input Domain and Reachability

| Input/condition | Producer | Contract | Reachable path | Owner | Class |
| --- | --- | --- | --- | --- | --- |
| Committed Git repo | `git rev-list --max-parents=0 HEAD` | Existing root-commit Project identity and clone sharing | Project.fromDirectory | Project service | contracted |
| Git repo with no root commit | Git discovery | Existing `ProjectID.global`, no cache write | Project.fromDirectory | Project service | contracted |
| Copied/stale `.git/opencode` | Filesystem cache | Current code incorrectly trusts it | Project.fromDirectory -> ProjectTable | Project service | observed |
| Linked worktree/clone | Git common/root history | Existing tests require sharing | Project resolver | Project service | contracted |
| Legacy Session with old project_id but matching directory/path | SessionTable | Existing directory fallback | Session.list | Session service | reachable |
| Active Session event with different Project | GlobalBus/Sync producer | Payload has required `properties.sessionID` | useEvent | TUI event owner | observed/reachable |
| Non-Session event with different Project | VCS/LSP producer | Project isolation remains | useEvent | TUI event owner | contracted |

## 7. Required Invariants

| ID | Invariant | Evidence | Test |
| --- | --- | --- | --- |
| INV-01 | Copied/stale `.git/opencode` never overrides the current committed Git root identity. | `project.ts:214-254`, live collision. | Project cache-independence test. |
| INV-02 | Existing no-commit repositories remain `ProjectID.global` and do not create cache identity. | Existing Project tests. | Existing no-commit tests. |
| INV-03 | Linked worktrees and separate clones retain the existing shared root-commit Project ID contract; unrelated repos remain distinct. | Existing Project tests. | Existing worktree/clone/bare tests. |
| INV-04 | Historical Sessions remain visible through the existing directory/path query without migration. | Session list predicates. | Cross-Project legacy row test. |
| INV-05 | An active Session-bound event reaches the active route despite Project mismatch. | Red event harness. | Active Session event test. |
| INV-06 | Non-Session Project events remain isolated. | Existing useEvent contract. | Existing other-Project test. |
| INV-07 | After stale-cache identity repair, the existing directory/path list returns a historical target Session whose persisted Project ID is old. | Session list predicates and legacy-row path. | Cross-Project legacy list behavior test. |
| INV-08 | Prompt/Revert/Part/Status projections continue through existing producers and consumers. | Bus/Sync/route chain. | Sync/route tests and original loop. |
| INV-09 | No schema, migration, fallback, second identity source, or second Session query is added. | User/policy constraints. | Diff/audit. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01, INV-03 | Cache ID is accepted before the current Git root identity and written back as a second identity source. | `Project.Service.fromDirectory` | Source lines 185-190,239-254 and current differing cache/root evidence. |
| INV-04, INV-07 | The current Project/list producer can omit a historical target, after which list reconcile erases the direct Session projection. | Project identity producer plus existing Session list contract | The red harness proves the consequence; green behavior must prove the corrected list producer includes the target. |
| INV-05, INV-08 | `useEvent` returns on Project mismatch before considering active Session ID. | `useEvent` | Red harness: `seen=0`. |

### Red-capable feedback loops

Executed from `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode`:

```text
bun -e '<cross-Project SDKProvider -> ProjectProvider -> useEvent harness>'
```

Observed: `cross-project active-session event was dropped: seen=0`, exit 1.

```text
bun -e '<sync-fixture mount -> Session.sync(ses_target) -> Session.refresh() harness>'
```

Observed: `active Session projection was erased by list refresh: before=ses_target after=undefined`, exit 1.

The Project resolver and legacy Session-list tests must be added before
implementation and run red for a copied cache value and an old Project ID on a
matching directory. The `before=ses_target after=undefined` harness remains a
diagnostic proof of the downstream consequence, not an approved Sync-store
preservation contract. The original daemon/TUI loop remains required for final
black-screen, list, Prompt, Revert, Ctrl+C, and exit verification.

## 9. Responsibility and Seam

| Concern | Owner | Why this owner |
| --- | --- | --- |
| Current Project identity | Project.Service.fromDirectory | First Project ID producer and cache writer. |
| Historical Session list | Existing Session.list path contract | Already owns project/path/directory SQL and physical directory compatibility. |
| Event admission | useEvent | First TUI delivery gate; active route context is available through RouteProvider. |
| Historical Session visibility | Existing Session.list directory/path producer | Correct Project/path list must contain the Session; Sync store preservation is not a repair path. |

## 10. Single Approved Primary-Path Design

### Project identity

For a Git repository whose `git-common-dir` resolves successfully and whose
`rev-list --max-parents=0 HEAD` returns a root commit, use that existing root
commit as the sole Project ID material. Remove `readCachedProjectId` from the
identity decision and remove the `.git/opencode` write. Preserve the existing
no-commit `ProjectID.global` contract and all existing root-commit clone,
worktree, and bare-repository contracts. This repairs the current stale-cache
collision without changing established clone semantics or adding migration.

The existing ProjectTable upsert remains keyed by the corrected ID. Historical
Session rows are not re-keyed; the current Session list's directory/path
predicate and Session-ID/persisted-directory HTTP route are the existing
compatibility owners and must prove old-row visibility.

### Active Session event admission

`useEvent` reads the existing RouteProvider. When an event has the required
typed `properties.sessionID`, it is delivered if that ID equals the active route
Session ID, even when `event.project` differs. All events without a Session ID
continue through the existing Project predicate. `session.deleted` uses its
existing required top-level `properties.sessionID`; no `info.id` extraction is
added.

This is one event-domain contract, not a retry or fallback. No new event field,
query, migration, or error conversion is introduced.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| Root-commit Project ID for committed Git | primary contract | preserve and make cache-independent |
| ProjectID.global for no-commit/non-Git | existing supported branch | preserve |
| `.git/opencode` cache/root precedence | broken competing identity source | remove from decision and stop writing |
| Existing directory/path Session list | shipped compatibility path | preserve and test |
| Active Session ID event admission | primary event-domain branch | add |
| Non-Session Project event isolation | primary event-domain branch | preserve |
| Project/Session migration, second list query, Session fallback, error-success | forbidden fallback/alternate success | reject |

## 12. Workaround Deletion and Replacement

| Existing logic | Replacement |
| --- | --- |
| `readCachedProjectId` and cache write | Current root-commit identity only; delete cache identity path. |
| Project-only admission for all events | Active Session ID admission for Session-bound events; retain Project branch for others. |
| Any proposed Session-store preservation fallback | None; correct the Project/list producer instead. |
| R3 common-directory hash | Reject; it broke existing clone/no-commit contracts. |

## 13. Forward Traceability

| Requirement | Production path | Planned change | Test |
| --- | --- | --- | --- |
| INV-01 | Git root commit -> ProjectID | `project.ts` cache-independent identity | Copied cache differs from current root. |
| INV-02/03 | Existing Git discovery branches | Preserve code contracts while removing cache branch | Existing Project suite. |
| INV-04/07 | Project/list -> Sync store | No consumer fallback; prove the corrected path/list producer returns the target | Legacy list and diagnostic projection tests. |
| INV-05/08 | Route -> useEvent -> Sync/route | `event.ts` active Session predicate | Event/Sync/Revert/Prompt behavior. |
| INV-06 | Event without Session ID -> Project predicate | Preserve branch | Other-Project VCS test. |
| INV-09 | Diff owner | Two production files only | Audit and diff budget. |

## 14. Reverse Traceability

| Concept | Invariant | Evidence | Why existing logic fails |
| --- | --- | --- | --- |
| Remove cache read/write | INV-01/02/03/09 | Cache is stale/copyable; root-commit tests are existing contract | Cache creates wrong Project owner. |
| Root-commit identity | INV-02/03 | Existing public tests | Current cache-first path hides the existing primary identity. |
| Route-aware typed Session ID | INV-05/08 | Red event harness and RouteProvider | Startup Project cannot represent opened Session. |
| Preserve directory/path list | INV-04/07 | Existing SQL path and persisted directory | A new store fallback would compensate downstream. |

## 15. File-Level Change Plan

| File | Change | Responsibility | Expected delta |
| --- | --- | --- | --- |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\project\project.ts` | modify | Remove cache identity read/write; derive existing committed Git Project ID from root commit; preserve global/no-commit and clone/worktree branches. | +3/-18 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src\cli\cmd\tui\context\event.ts` | modify | Admit active route Session events using required `properties.sessionID`; preserve non-Session Project isolation. | +18/-5 |

| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\project\project.test.ts` | modify | Red/green copied-cache identity behavior while retaining root-commit, no-commit, clone, worktree, and bare-repository contracts. | +35/-10 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\server\session-list.test.ts` | modify | Verify an old Project ID with matching directory/path remains visible through the existing list producer. | +25 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\tui\use-event.test.tsx` | modify | Verify active Session event delivery and non-Session Project isolation. | +25 |
| `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\cli\cmd\tui\sync.test.tsx` | modify | Verify the real Message/Part projection after active Session event admission. | +30 |

Production files: 2. No additional production file is authorized in R5.

## 16. TDD Behavior Slices

| Order | Red behavior | Green behavior | Regression |
| --- | --- | --- | --- |
| 1 | Same cache value in two repos must not control either ID. | IDs derive from current root commit. | Stale/copied cache collision. |
| 2 | Existing no-commit, clone, worktree, and bare-repo tests remain green. | Cache independence does not change their contracts. | No functional regression. |
| 3 | Legacy Session with old project_id and matching directory/path appears in list. | Existing directory fallback returns it. | No migration required. |
| 4 | A stale-cache Project and old-Project-ID Session at the same related directory must appear in the existing Session list. | Correct root-commit Project identity plus the existing directory/path predicate returns the target; no Sync store fallback. | Historical Session list omission and blank/undefined consequence. |
| 5 | Active cross-Project Session event is delivered. | `useRoute` Session ID admits typed event. | Prompt/Revert/Part/Status updates. |
| 6 | Other-Project VCS event remains ignored. | Project predicate remains for no-Session events. | Event isolation. |
| 7 | Original two-daemon/TUI loop passes. | Source build shows Session list, updates, rendering, valid Ctrl+C ID. | Full user report. |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed lines `E` | 100-180 | Includes production and test code changes; excludes imports, formatting, generated, and pure moves. |
| Required qualifying comments `C` | 15-27 | `C >= max(1, ceil(E * 0.15))`; actual implementation must recalculate. |

Qualifying comments must explain cache independence/root-commit ownership,
preserved clone/no-commit contracts, active Session event ownership, and the
behavioral test intent. Test lines are included in E; they cannot be excluded.

## 18. Verification

| Command | Working directory | Proof |
| --- | --- | --- |
| `bun test test/project/project.test.ts` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Project identity and existing contracts. |
| `bun test test/server/session-list.test.ts` | same package directory | Legacy cross-Project directory/path visibility. |
| `bun test test/server/session-list.test.ts --test-name-pattern "legacy|directory|path"` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Red/green historical Session list producer behavior. |
| `bun test test/cli/tui/use-event.test.tsx --test-name-pattern "active Session|other project"` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Red/green active Session event admission and Project isolation. |
| `bun test test/cli/cmd/tui/sync.test.tsx --test-name-pattern "message|part|session"` | `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode` | Red/green active Message/Part projection. |
| `bun test test/cli/tui/use-event.test.tsx test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/session-exit.test.tsx` | same package directory | Event, projection, and exit behavior. |
| `bun typecheck` | same package directory | Type safety. |
| `git diff --check` | `F:\ML\PythonAIProject\Claude-Code\opencode` | Patch formatting. |
| Original daemon/TUI scenario using current package build | User directories | Full black-screen/list/Prompt/Revert/Ctrl+C behavior. |

The prior fixture timeout is not green evidence. It must be resolved or reported
as an explicit remaining unverified item before completion.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added/deleted | 0/0 | Existing seams. |
| Production files modified | 2 | Project producer and event owner. |
| Production lines | 20-60 net, hard maximum 200 | Remove cache path and add one event predicate. |
| Test lines | 80-130 net | Identity, list, projection, event, and original-loop coverage. |
| Schema/migration/generated lines | 0 | Explicitly forbidden. |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. R5 preserves existing clone/no-commit contracts rather than introducing
the rejected common-directory identity semantics.

### Real Risks

- Historical old Project rows must be proven readable through the existing directory/path path; no migration is available by design.
- `useEvent` now depends on existing RouteProvider placement; `app.tsx` proves that production placement.
- The installed daemon binary is outside the source tree; final verification must use the intended current package build.
- The current top 20 commits did not modify `Project.fromDirectory`, `useEvent`, Session path predicates, or persisted-directory routing. `3b2925b777` and `0335c77017` changed hidden projection/reducer guards, while `f9dad14979` changed search lifecycle; the proven Project/cache defect predates the window and was exposed by later Session list/TUI behavior rather than introduced by a top-20 Project identity commit.
- Session-list fixture cleanup currently times out and must be isolated before completion.

### Rejected Speculation

- R3 B-02 is resolved by preserving the current root-commit/clone/no-commit contracts; common-directory hash is removed.
- R3 B-03 is resolved by using only required typed `properties.sessionID`.
- R3 B-04 is resolved by counting production and test E together.
- R3 B-01 is addressed by the active projection red loop plus Project producer repair; no renderer workaround is added without original-loop evidence.
- Project/Session migration, second list query, and Session-ID fallback remain forbidden.

## 21. Audit Contract

The independent auditor must read R5 and the complete original requirement,
reconstruct Project identity, ProjectTable persistence, Session list/path
fallback, bootstrap/list reconciliation, persisted-directory routing, GlobalBus,
useEvent, Prompt, Revert, Sync, renderer/exit, and recent-20 history. It must
verify root-commit/no-commit/clone/worktree preservation, cache independence,
historical Session visibility without migration, typed Session-only event routing,
non-Session Project isolation, the two red harnesses, complete E/C accounting,
and the original loop. It must audit the full original scope and treat all
builder explanations as untrusted.

## 22. Plan Audit Record

| Round | Revision | Full scope | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 persisted ownership after identity change | path/estimate issues | BLOCK; superseded | `ses_01b1e6809ffepap1ylcGd02gR0` |
| 2 | R2 | yes | B-01 Project producer omitted; B-02 list repair omitted | harness/verification/history | BLOCK | `ses_01a4212eaffeepE5zvpZYCPQB5` |
| 3 | R3 | yes | B-01 original loop unproven; B-02 clone/no-commit contract; B-03 duplicate Session identity; B-04 E/C excludes tests | verification specificity/history | BLOCK | `ses_01a4212eaffeepE5zvpZYCPQB5` |
| 4 | R4 | yes | B-01 TDD Slice 4 的 red 场景无法由 R4 的生产修改变绿; B-02 当前 canonical plan 的 Explicit Non-Goals 与 R4 primary design 直接矛盾 | 最近20次归因不完整; 原始loop仍是占位; legacy list需真实green | BLOCK | `ses_01a4212eaffeepE5zvpZYCPQB5` |
| 5 | R5 | yes | none | R5 的测试文件路径未在 §15 逐项列出；两个 harness 命令仍以占位符表示 | APPROVE — exact current Revision R5 | `ses_01a4212eaffeepE5zvpZYCPQB5` |

### R5 Independent Verdict

> No blocking findings.
>
> **Non-blocking findings**
>
> 1. **R5 的测试文件路径仍未在 `§15` 逐项列出。** 当前 `§15` 明确列出两个 production files，但 `§16` 要求新增或扩展 Project cache-independence、legacy Session list、active Session event 等行为测试；`§13` 只有行为映射，没有精确 test file。该问题不阻塞 R5 的 revision consistency，但 implementation 前应补齐测试文件级 traceability。
>
> 2. **两个 harness 命令仍以占位符表示。** 当前 plan 已记录观察结果，但独立复现仍需要实际脚本内容或明确 test command。该问题属于 verification specificity，不改变当前 revision metadata 的一致性结论。
>
> **Release verdict**
>
> **APPROVE — exact current Revision R5**

R5 is approved for implementation under the exact approved-plan workflow.

## 23. Implementation Evidence

Implementation executed under approved R5.

### Production changes

- `packages/opencode/src/project/project.ts`: removed cache identity read/write; committed Git identity now derives from the current root commit; added absolute `--git-common-dir` resolution to preserve linked-worktree root ownership.
- `packages/opencode/src/cli/cmd/tui/context/event.ts`: active typed `properties.sessionID` admission through `RouteProvider`; non-Session Project isolation remains guarded.
- Production files modified: 2. Production diff: `+25/-30` at evidence capture.
- No schema, migration, second query, fallback, or additional production file was added.

### Red/green evidence

- Copied-cache red: received `copied-cache-project-id` instead of the current root commit; green after removing cache identity precedence.
- Active Session event red: `seen=0`; green `useEvent` suite: `5 pass, 0 fail`.
- Active projection diagnostic red: `before=ses_target after=undefined`; green cross-Project Message/Part projection: `1 pass, 0 fail`.
- Legacy Session list green: old `project_id` plus matching directory and `path=null` returned the target through `session.list`, `1 pass, 0 fail`.
- Project regression green: `34 pass, 0 fail, 89 expect() calls`.
- Event/projection/exit regression green: `28 pass, 0 fail, 68 expect() calls`.
- Package typecheck green: `bun typecheck`.
- Patch formatting green: `git diff --check`.

### Completed verification

- Complete Session-list suite passed with repository timeout: `22 pass, 0 fail, 118 expect() calls`.
- Current package build completed through the Windows user proxy `127.0.0.1:7897`: `bun run script/build.ts --single --skip-install --skip-embed-web-ui`.
- Build output: `dist/opencode-windows-x64/bin/opencode.exe`, version `0.0.0-dev-smark-202608091227`, OpenTUI `0.4.3-smark.7`, compiled smoke and voice Worker smoke passed.
- Compiled artifact normal smoke passed with `sourceCount=2`, `renderedCount=2`, `modelRequests=2`.
- Compiled artifact `target-liveness` smoke passed with `sourceCount=2`, `renderedCount=2`, `modelRequests=2`, `targetEventCount=14`.
- Exact compiled cross-directory loop passed using nested independent Git repositories and one shared daemon. Session owner Project ID was `1ed7b768d3555adadca4478b7e2b77b914247cc1`; active TUI Project ID was `a8da4284be7352fcce13829a9cf183903ae3a674`; target Session was `ses_0189e142bffelVsQ6aR0E1CQ3i`.
- The exact loop verified the parent-directory Session list contained the child-repository Session; the B-directory TUI opened the A-directory Session; Prompt produced nine correlated A-Project events and rendered the assistant body; Revert removed the prompt/body frame; Unrevert restored both; the viewport never blanked; idle Ctrl+C printed `opencode -s ses_0189e142bffelVsQ6aR0E1CQ3i` and never printed `opencode -s undefined`; public daemon stop completed.
- The independent auditor reran the corrected scenario with a nonblank Revert frame gate and observed Session `ses_018902534ffe3nyegrXBEcJn9w`, target Project `5f68c0980c6ce309e604c2ba065a525354d0070e`, active Project `6fef6f0bcf13f3d266da85b0559c4707bed4fa5d`, one model request, and nine correlated target events.
- The temporary cross-directory scenario was removed after audit; `git diff --exit-code -- packages/opencode/script/smoke-opentui-artifact.ts` passed, so the final implementation diff remains the exact approved source/test scope.

## 24. Implementation Audit Record

| Round | Scope | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- |
| 1 | full implementation diff and original requirement | build/current package artifact and original two-daemon/TUI loop unverified | BLOCK | `ses_019d7fec2ffeNHusoSq2UbZZ1o` |
| 2 | full implementation diff after proxy build and same-Project artifact smoke | exact cross-directory Project-A/Project-B loop remained unverified | BLOCK | `ses_019d7fec2ffeNHusoSq2UbZZ1o` |
| 3 | full implementation diff plus independently executed compiled Project-A/Project-B loop | none | APPROVE — exact approved R5 intended final implementation diff | `ses_019d7fec2ffeNHusoSq2UbZZ1o` |

### Independent Implementation Verdict

> No blocking findings.
>
> **APPROVE — exact approved R5 intended final implementation diff.**

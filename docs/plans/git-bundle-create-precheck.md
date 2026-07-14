# Canonical Implementation Plan: Git Bundle Create Precheck

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: implementation
>
> Requirement source: User messages and Session GOAL dated 2026-07-15
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-15

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> “git命令里面还有这些副作用的一些命令,需要你检查检查。也就是这些内容,可能我们也需要考虑。其中的有副作用的一些命令,可能我们也需要考虑将其加入cautious。”

> “检查与判断是否precheck需要构建子文件夹来储存多种类型的子规则，但目前看下来可能整体不需要，因为体量在2000行以内且转移切分的成本较高。与此同时，扩展尚未匹配的对于git具有副作用命令的审计的规则”

> “审计逻辑，理论上不需要额外扩大剩余额外的权限面和逻辑面，不需要肆意扩大安全护栏，适当即可，subagent不得以我们当前没出现过的其他危险命令作为block理由，整体修改量保持准确较小，不要大范围重写，但可以适当智能化”

> “目标终态：< verified-implementation-and-commit>”

The command corpus in the preceding user message is part of the requirement.
The only Git-owned side effect in that corpus that the current precheck does not
already classify as `cautious` is:

```text
git bundle create .temp/testing/backup/fix-backup-5commits.bundle fix-backup-5commits
```

Confirmed requirement IDs:

- `REQ-01`: Decide from current evidence whether `precheck.ts` needs a child
  directory of rule files; do not split it without a present requirement.
- `REQ-02`: Classify the observed `git bundle create <file> <revs...>` operation
  as `cautious` through the existing precheck interface.
- `REQ-03`: Preserve the classifications already covering the other supplied
  Git commands and avoid widening unrelated Git or shell behavior.
- `REQ-04`: Keep the implementation narrowly owned, small, and free of a new
  rule framework, public interface, configuration, fallback, or speculative
  safety expansion.
- `REQ-05`: Complete independent plan and implementation audits, verification,
  and a commit containing only this GOAL's files.

## 2. Explicit Non-Goals

- Do not create `src/permission/precheck/`, move existing rules, or introduce a
  rule-provider/registry interface. The confirmed repair is one branch in the
  existing Git classifier, and no second implementation or reusable adapter is
  required.
- Do not change `PermissionPrecheck.evaluate`, `Decision`, `LEVELS`, the
  `safe < general < cautious < dangerous` ordering, reviewer routing, static
  Permission rule precedence, cache behavior, or event schemas.
- Do not classify unobserved Git operations such as `git bundle unbundle`, Git
  reflog mutation modes, or other conceivable commands. They are outside the
  supplied command corpus and are prohibited from driving this diff.
- Do not change generic shell redirection behavior. The supplied
  `git rev-parse ... > file` and `git reflog > file` commands are currently
  `general` because `>` makes the shell segment opaque; their filesystem effect
  is not owned by `classifyGit`.
- Do not change `BashArity`, Always-prefix suggestions, raw scanning, tokenizing,
  wrapper recursion, sensitive-path handling, or non-Git command rules.
- Do not execute the user's destructive Git history. The feedback loop invokes
  only the pure precheck classifier with command strings.
- Do not add an ADR. Declining a directory split for this bounded change is not
  a permanent load-bearing repository decision.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Requires minimal functions, no premature helpers, parallel tool use, package-local tests/typecheck, and default branch `dev`. |
| `packages/opencode/AGENTS.md` | Requires flat ESM/self-reexport module shape and keeps private helpers private; no new module is justified here. |
| `packages/opencode/test/AGENTS.md` | Requires tests through actual implementation and package-local execution; the existing pure precheck test needs no fixture or mock. |
| `CONTEXT.md` | Defines Permission as the ruleset governing what an Agent/Tool may do without asking and locates its canonical implementation under `packages/opencode/src/permission/`. |
| `docs/adr/README.md` | Says single-file or temporary “not worth it now” choices do not warrant an ADR. |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | Unrelated to Permission; establishes no additional constraint for this task. |
| `.opencode/policy/first-principles-engineering.md` | Requires the owning first-divergence repair, no speculative guardrails, full mappings, TDD, independent audits, and the Chinese-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this artifact's required sections and approval state. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts:570-623, 997-1024` | Produces canonical Bash patterns plus raw command metadata and sends them through `ctx.ask`; also shows the separate Always-prefix path that is unchanged. | reachable |
| `packages/opencode/src/permission/index.ts:221-353` | Resolves static Permission rules, passes only `auto` patterns to `PermissionAuto`, and preserves separate `ask` gates. | reachable |
| `packages/opencode/src/permission/auto.ts:47-108` | Calls `PermissionPrecheck.evaluate`; `general` is normally allowed, `cautious` is reviewed, and `dangerous` is denied. | reachable |
| `packages/opencode/src/permission/precheck.ts:311-369, 436-530` | Defines request evidence selection, shell phase ordering, level aggregation, token classification, safe proof, and `general` fallback. | reachable |
| `packages/opencode/src/permission/precheck.ts:1057-1097, 1241-1362` | Routes normalized `git` tokens to the dedicated Git classifier, which has no `bundle create` branch and then delegates safe proof to `gitSafe`. | observed |
| `packages/opencode/test/permission/precheck.test.ts:4-9, 872-965` | Existing public-seam helper and Git behavior tests already cover commit, reset, branch, stash, cherry-pick, and other supplied mutations. | observed |
| `packages/opencode/test/permission/precheck.test.ts:1111-1118` | Locks generic file redirection at `general`, proving that changing redirection is a separate behavior. | observed |
| `packages/opencode/package.json:8-17` | Defines package-local test, typecheck, and build commands; no lint script exists. | contracted |
| `git bundle -h` | Shows mode-specific syntax: `create <file>`, `verify <file>`, `list-heads <file>`, and `unbundle <file>`. It proves that matching all `bundle` modes would be broader than the observed `create` operation. | contracted |
| Pure classifier matrix from 2026-07-15 | Confirmed that supplied commit/branch/reset/stash/cherry-pick/add commands are already `cautious`, while `bundle create` is `general`; redirection commands are separately `general`. | observed |
| Red-capable `bun -e` feedback command from 2026-07-15 | Failed twice deterministically with `expected cautious, received general: unknown shell command`. | observed |
| `git status --short` and relevant-file diff from 2026-07-15 | Show unrelated user/agent changes elsewhere and no pre-existing diff in the two files this plan will modify. | observed |

## 5. Current Behavior

```text
Shell Tool command
  -> ShellTool.collect builds canonical Bash pattern
  -> ShellTool.ask supplies metadata.command
  -> Permission.Service.ask selects an `auto` pattern
  -> PermissionAuto.evaluate
  -> PermissionPrecheck.evaluate / bashEffect / evaluateShell
  -> evaluateCommand / classifyTokens
  -> classifyGit finds subcommand `bundle`
  -> no mutation branch matches; classifyGit returns undefined
  -> gitSafe does not prove `bundle` safe
  -> evaluateCommand returns `general: unknown shell command`
  -> non-strict PermissionAuto allows `general` without review
```

The public `evaluate` entry is already small. The relevant policy is localized
in the existing `classifyGit` helper, so the current defect does not demonstrate
a need for a child directory or a generic rule interface. `precheck.ts` is
1,533 lines, but file length alone does not justify moving a tightly ordered
five-phase classifier when the confirmed behavior needs one mode-specific Git
branch.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `git bundle create <file> <revs...>` from the supplied history | Shell Tool command string | Shell parser emits a normalized Permission pattern and retains `metadata.command` | Shell Tool -> Permission `auto` -> precheck -> `classifyGit` | `PermissionPrecheck` Git classification | observed |
| Supplied commit/branch/reset/stash/cherry-pick/add commands | Same producer | Same token path | Same path, already matched by existing branches | Existing `classifyGit` branches | observed |
| `git bundle verify <file>` | Git's local help contract | Same shell token path; no raw unsupported syntax | Same path | `classifyGit` exact mode boundary | contracted |
| `git rev-parse ... > file` and `git reflog > file` | Supplied command history | `>` is intentionally opaque to structural safe parsing | Shell raw/structural phases return `general` before Git can own the redirection effect | Shell syntax policy, unchanged | observed |
| Other Git subcommands not in the supplied history | None established for this GOAL | Not applicable | Conceivable only | Not assigned | speculative |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| `INV-01` | A visible Git operation from the supplied history that writes a bundle archive must cross the `cautious` review boundary rather than remain a non-strict `general` allow. | User requirement, red-capable feedback output, `PermissionAuto` routing | Missing for `bundle create`; planned slice adds it |
| `INV-02` | Mode-specific Git policy must not promote the entire `bundle` family when only `create` is confirmed to write the requested archive. | User restraint requirement and `git bundle -h` mode contract | Missing; planned slice keeps `verify` at `general` |
| `INV-03` | Existing Git commands in the supplied corpus retain their current `cautious` outcomes and reasons/order where already tested. | Classifier matrix and existing Git tests | `precheck.test.ts:872-965` |
| `INV-04` | Unknown or opaque behavior remains governed by the existing shell/Git fallback; this task adds no alternate parser, fallback, or new public/configuration seam. | Existing precheck phase contract and explicit non-goals | Whole precheck suite, especially redirection tests |
| `INV-05` | One bounded Git rule does not justify splitting the 1,533-line module; architecture changes require present composition or reuse evidence, not line count. | User requirement and repository style rules | Structural review/diff, not a runtime test |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| `INV-01` | `classifyGit` obtains `sub === "bundle"` but has no exact `tokens[i + 1] === "create"` branch, returns `undefined`, and lets the primary command path fall to `general`. | Private Git policy inside public `PermissionPrecheck.evaluate` | Source at `precheck.ts:1248-1310`; feedback command failed twice with `general: unknown shell command`. |
| `INV-02` | No current divergence; it constrains the repair so it does not add `bundle` to the generic state-changing list. | Same owner | `git bundle -h` shows distinct modes. |

Red-capable feedback loop, run twice from `packages/opencode`:

```sh
bun -e 'import { PermissionPrecheck } from "./src/permission/precheck.ts"; const command = "git bundle create .temp/testing/backup/fix-backup-5commits.bundle fix-backup-5commits"; const actual = PermissionPrecheck.evaluate({ permission: "bash", patterns: [command], metadata: { command } }); if (actual.level !== "cautious") throw new Error(`expected cautious, received ${actual.level}: ${actual.reason}`)'
```

Observed result on both runs:

```text
error: expected cautious, received general: unknown shell command
```

The minimized reproduction needs only the exact command string and the public
precheck interface. Removing `bundle create` removes the reported classification
gap; filesystem, Git repository, reviewer, and Session fixtures are not
load-bearing because precheck is a pure synchronous classifier.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Classify observed Git argv semantics | `classifyGit` inside `PermissionPrecheck.evaluate` | Return deterministic risk level/reason for visible shell evidence | The existing module already owns every Git mutation and safe-proof distinction | Shell Tool only produces evidence; PermissionAuto routes levels; reviewer judges context after `cautious` |
| Public regression behavior | `PermissionPrecheck.evaluate` test seam | Same input returns `cautious` for bundle creation | Existing tests use this public namespace and survive internal refactors | A private-helper test would couple to implementation; a reviewer test would be downstream of the first divergence |
| Generic redirection | Existing shell syntax phases | Unsupported file redirection remains opaque/general | Existing phase contract owns shell syntax | Git does not own `>` or the shell-created file |
| Directory/rule architecture | Existing `precheck.ts` deep module | Callers learn only `evaluate` and `canAlwaysAllowPrefix` | One local branch is naturally carried by the current private Git policy | A new child module/registry would expose or distribute complexity without reuse evidence |

## 10. Single Approved Primary-Path Design

```text
existing tokenized Git command
  -> existing global-flag/subcommand location in classifyGit
  -> exact subcommand/mode check: bundle + create
  -> existing Decision { level: cautious, stable reason }
  -> existing evaluateShell/PermissionAuto routing
  -> reviewer or configured user fallback
```

Modify the existing `classifyGit` decision sequence with one exact branch using
the already-computed subcommand index `i`:

```ts
if (sub === "bundle" && tokens[i + 1] === "create")
  return { level: "cautious", reason: "git bundle creation requires explicit approval" }
```

The branch repairs the first divergence at its owner. It must not add `bundle`
to the generic state-changing subcommand list because that would also promote
`verify` and `list-heads`, contradicting `INV-02`. It needs no helper, parser,
configuration, new file, alternate path, or fallback. Existing phase ordering,
reason selection, and higher-risk aggregation remain unchanged.

Architecture verdict for `REQ-01`: keep the implementation in
`src/permission/precheck.ts`. Reconsider a child directory only when a later,
separately evidenced task introduces multiple independently maintained rule
families or a real second adapter; this task does neither.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Existing shell -> token -> Git primary classification | current, modified | primary-contract branch | yes | 100% of changed production decision surface | preserve and repair |
| Existing unknown Git fallback to `general` | current | primary-contract pass-through for unmatched commands | yes | 0% new | preserve for non-matching modes |
| Exact `bundle create` branch | proposed | supported-domain branch within the primary contract | yes | one added decision branch | add |
| Alternate parser, retry, fallback classifier, or configuration switch | proposed nowhere | forbidden fallback/unsupported alternate path | n/a | 0% | reject |

New alternate success paths: zero. Diagnostic paths: zero. Decision-surface
ratio for alternate success/diagnostic behavior: `0%`.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Not applicable | No downstream workaround for `git bundle create` was found; the command simply falls through to `general`. | The plan repairs the owning classifier directly. | No deletion |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| `REQ-01`, `INV-05` | Existing deep `PermissionPrecheck` module | No production file split; record decision in this plan only | Diff/file inventory proves no new rule module |
| `REQ-02`, `INV-01` | `evaluate` -> `classifyTokens` -> `classifyGit` | `src/permission/precheck.ts`: exact `bundle create` cautious branch | Public `bash(...)` test with the exact user command returns `cautious` |
| `REQ-03`, `INV-02` | Same Git path for a different bundle mode | Same exact mode guard, no generic `bundle` entry | `git bundle verify backup.bundle` remains `general` |
| `REQ-03`, `INV-03`, `INV-04` | Existing Git and shell paths | No changes outside exact branch | Existing full precheck suite plus related Permission suites remain green |
| `REQ-04` | Existing interfaces and files | No helper, registry, config, dependency, or route change | Diff review, typecheck, build |
| `REQ-05` | Canonical workflow | Plan/audit evidence, implementation evidence, scoped commit | Plan and implementation audit records; post-commit status |

No confirmed requirement is unmapped.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Exact `bundle create` decision branch in `classifyGit` | `REQ-02`, `INV-01`, `INV-02` | Observed `general` output and Git mode contract | Existing branches omit `bundle`; the generic list cannot carry the rule without overmatching all modes |
| No new helper/module/interface | `REQ-01`, `REQ-04`, `INV-05` | Current dedicated Git helper and one missing mode | Existing private function already provides the correct seam; a new concept is unjustified |

No proposed production concept is unmapped.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `docs/plans/git-bundle-create-precheck.md` | add | Sole canonical plan, audit records, and implementation evidence | documentation only |
| `packages/opencode/test/permission/precheck.test.ts` | modify | Add one public-seam vertical behavior slice for exact create promotion and verify non-promotion | about +6 lines |
| `packages/opencode/src/permission/precheck.ts` | modify | Add one exact mode-specific Git cautious branch at the first divergence | about +3 lines |

No file moves, deletions, generated files, configuration changes, migrations,
dependencies, SDK changes, or new module exports are planned.

## 16. TDD Behavior Slices

Agreed public seam: `PermissionPrecheck.evaluate` through the existing local
`bash(command)` test helper. It exercises the same deterministic classifier
called by `PermissionAuto`, without testing private helpers or requiring mocks.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Exact supplied `git bundle create ...` command must return `cautious`; `git bundle verify backup.bundle` must remain `general` | `classifyGit` returns undefined for every bundle mode, then safe proof fails and command falls to general | Add one exact `sub === "bundle" && tokens[i + 1] === "create"` cautious return | Prevents both the original silent general allow and an overbroad all-bundle promotion |

TDD order is strict: add this one test, run the precheck suite and observe the
create assertion fail, add only the approved branch, rerun green, then run the
broader regression commands. Expected levels are independent literals derived
from the user requirement and Git's mode contract, not from implementation
constants or duplicated classifier logic.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 6 | Estimated non-blank executable production/test lines; excludes the plan, blank lines, and formatting |
| Required Chinese explanatory comments `C` | 1 | `max(1, ceil(6 * 0.15)) = 1` |
| Planned qualifying Chinese comments | 2 | One adjacent to the production branch and one adjacent to the behavioral assertions |

Planned explanations:

- Production: explain that `bundle create` writes an archive and that the exact
  mode check intentionally avoids promoting `verify`/`list-heads`.
- Test: explain that the paired assertions lock the observed backup command
  while protecting the user-required narrow Permission boundary.

Comments must remain adjacent, concise, and rationale-focused; comments that
merely restate the condition or test name do not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` after adding the test and before production | `packages/opencode` | Red: exact `bundle create` assertion fails while existing suite still executes |
| `bun test test/permission/precheck.test.ts` after production | `packages/opencode` | Green: new behavior plus all direct precheck regressions |
| Red-capable `bun -e` command from Section 8 | `packages/opencode` | Original exact user command now exits zero with `cautious` |
| `bun test test/permission/precheck.test.ts test/permission/auto.test.ts test/permission/next.test.ts` | `packages/opencode` | Related deterministic classification, routing, and Permission integration remain green |
| `bun typecheck` | `packages/opencode` | Package TypeScript contracts remain valid |
| `bun run build` | `packages/opencode` | Production package build succeeds |
| `git diff --check` | repository root | No whitespace errors in the scoped diff |
| `git status --short` and scoped `git diff` | repository root | Changed-file scope excludes unrelated worktree modifications |

No lint script exists in `packages/opencode/package.json`. SDK generation,
database generation/migration, and integration infrastructure are not reachable
from this pure TypeScript classifier change and are not run.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | Canonical plan only |
| Files modified | 2 | Existing classifier and its public-seam test |
| Files deleted | 0 | No workaround exists |
| Production lines | about 3 | One rationale comment plus exact condition/decision |
| Test lines | about 6 | One test with two outcomes and one qualifying comment |
| Generated lines | 0 | No generated chain is affected |

The budget is an audit signal, not permission to omit confirmed behavior.

## 20. Real Risks and Open Decisions

Real risks:

- `reason` is observable in reviewer/UI flows. The new branch therefore uses one
  stable static reason and does not interpolate file paths or command text.
- Adding plain `bundle` to the existing generic mutation list would overmatch
  `verify` and `list-heads`; the exact second token prevents that scope error.
- The worktree contains unrelated staged and unstaged files. Implementation and
  commit must use scoped diffs/staging and must not alter or include them.

### Open Decisions Requiring the User

None. The user supplied both the desired `cautious` boundary and the explicit
restraint against broader speculative guards.

### Rejected Speculation

- Splitting all precheck rules into a child directory, introducing a rule
  lattice/provider registry, or exposing runtime customization is rejected:
  there is no present caller/adapter/reuse requirement, and this GOAL has one
  local first divergence.
- `git bundle unbundle`, reflog mutation modes, and any other unobserved Git
  command are rejected as scope drivers. The user's audit contract explicitly
  forbids blocking on dangerous commands absent from the supplied history.
- Reclassifying generic `>` file redirection is rejected. It is a separate shell
  syntax policy with explicit existing `general` tests, not a Git subcommand
  defect.
- Changing `BashArity` or Always-prefix behavior is rejected. Static user
  approval semantics are a separate interface and no failure in that path was
  supplied or observed for this GOAL.
- Running real destructive Git commands is rejected because the pure classifier
  seam reproduces the exact Permission symptom deterministically.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.
- Respect the explicit requirement that Git commands absent from the supplied
  history cannot become blocking findings. Unsupported concerns must be marked
  rejected speculation or non-blocking, not used to expand implementation.
- Verify that declining the directory split is evidence-based and that the
  exact branch does not introduce a second semantic path.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | None | APPROVE — canonical plan revision R1 only. | `ses_09df0aef9ffe7LKb8zphRqZaNq` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

### Round 1 Verbatim Verdict

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

None.

## Rejected speculation

- Requiring a child directory, rule registry, provider interface, or runtime-customizable rule lattice is not justified by the affected path. The public entry point is already small (`packages/opencode/src/permission/precheck.ts:311-326`), shell risk aggregation remains one ordered semantic path (`packages/opencode/src/permission/precheck.ts:436-529`), and Git policy is localized in `classifyGit` (`packages/opencode/src/permission/precheck.ts:1248-1310`).
- Unobserved Git operations such as `git bundle unbundle` cannot drive this change. The original requirement explicitly limits expansion to side-effecting commands in the supplied corpus.
- Reclassifying `git rev-parse ... > file` or `git reflog > file` is not part of the Git-classifier defect. File redirection becomes opaque at the shell-syntax seam and has an explicit existing `general` contract (`packages/opencode/test/permission/precheck.test.ts:1111-1118`).
- A separate integration test that executes `git bundle create` against a real repository is unnecessary. `PermissionPrecheck.evaluate` is a pure classifier, and the existing public test seam directly observes the required Permission decision (`packages/opencode/test/permission/precheck.test.ts:4-9`).

## Requirement and traceability coverage

- **Architecture decision:** Covered by `REQ-01`/`INV-05`. The plan correctly distinguishes file size from module-interface complexity and declines a speculative split. Existing private helpers already categorize the phases while keeping one public source of behavioral truth.
- **Observed defect:** Covered by `REQ-02`/`INV-01`. The real path is:
  `ShellTool.collect` → `ShellTool.ask` → `Permission.Service.ask` → `PermissionAuto.evaluate` → `PermissionPrecheck.evaluate` → `classifyTokens` → `classifyGit`.
  Relevant source evidence appears at:
  - `packages/opencode/src/tool/shell.ts:570-623`
  - `packages/opencode/src/tool/shell.ts:997-1023`
  - `packages/opencode/src/permission/index.ts:242-300`
  - `packages/opencode/src/permission/auto.ts:63-88`
  - `packages/opencode/src/permission/precheck.ts:311-347`
  - `packages/opencode/src/permission/precheck.ts:1057-1097`
  - `packages/opencode/src/permission/precheck.ts:1248-1310`
- **First divergence and owner:** Correctly identified. `classifyGit` recognizes the `bundle` subcommand but has no mode-specific `create` decision, after which `gitSafe` cannot prove safety and the command reaches `general`. Git classification inside `PermissionPrecheck` owns that transition.
- **Corpus preservation:** Covered by `REQ-03` and existing Git branches/tests. Commit, branch, reset, stash, cherry-pick, add, and the other represented mutations already reach `cautious` branches (`packages/opencode/src/permission/precheck.ts:1266-1307`; `packages/opencode/test/permission/precheck.test.ts:872-965`).
- **Narrow scope:** Covered by the paired `bundle create → cautious` and `bundle verify → general` assertions. The negative assertion prevents an overbroad addition of all `bundle` modes to the generic mutation list.
- **Test sensitivity:** The proposed create assertion can fail against current behavior because no current branch returns `cautious` for `bundle create`. Expected values are independent behavioral literals, and the test uses the public `PermissionPrecheck.evaluate` seam.
- **Forward traceability:** Every confirmed requirement maps to a production path, exact file disposition, and behavioral or structural verification in plan §13.
- **Reverse traceability:** The sole new production concept—the exact mode-specific decision branch—maps to `REQ-02`, `INV-01`, and `INV-02`. No helper, configuration, module, dependency, or compatibility path is introduced.
- **Verification:** Commands are concrete and use the correct `packages/opencode` working directory for tests, typecheck, and build. The lack of a package lint script is correctly documented.
- **Chinese-comment planning:** Estimated `E = 6`, so the required minimum is `C = max(1, ceil(6 × 0.15)) = 1`. The plan schedules two nearby rationale-focused Chinese comments, one at the production boundary and one at the behavioral assertions. This satisfies the plan-stage comment gate, subject to recomputation from the implementation diff.

## Primary-path and fallback verdict

The plan preserves one authoritative semantic path:

visible shell command
→ existing tokenization
→ existing Git subcommand discovery
→ exact bundle/create classification
→ existing cautious reviewer/user boundary

The proposed branch repairs the first divergence in its owning classifier. It does not add a parser, retry, alternate data source, compatibility route, configuration switch, or failure-triggered success path.

The existing unmatched-command `general` result remains a primary-contract pass-through for commands outside the recognized subset; it is not a newly introduced fallback. New alternate success paths and diagnostic paths are both zero, yielding a `0%` new fallback/diagnostic decision-surface ratio.

## Release verdict

**APPROVE — canonical plan revision R1 only.**

Implementation remains disallowed until this clean full-scope verdict is recorded administratively and the plan metadata is changed to `Status: approved`, `Approved revision: R1`, and `Implementation allowed: yes` without substantive plan changes.
```

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `docs/plans/git-bundle-create-precheck.md`: added as the sole canonical plan,
  plan-audit record, and implementation-evidence record.
- `packages/opencode/src/permission/precheck.ts`: added one Chinese rationale
  comment and one exact `bundle + create` cautious decision branch.
- `packages/opencode/test/permission/precheck.test.ts`: added one public-seam
  behavior test with the exact supplied command, a `verify` non-promotion guard,
  and one Chinese rationale comment.
- Scoped production/test diff: 9 inserted lines, 0 deleted lines. No file move,
  helper, module, public interface, configuration, dependency, migration, or
  generated file is part of this implementation diff.
- Other staged/unstaged worktree files are unrelated concurrent changes and are
  excluded from this GOAL's diff and future commit.

### Red-Green Test Evidence

- Red command: `bun test test/permission/precheck.test.ts` from
  `packages/opencode` after adding only the test.
- Red result: 96 passed, 1 failed. The sole failure was the exact new create
  assertion: expected `{ level: "cautious" }`, received
  `{ level: "general", reason: "unknown shell command" }`.
- Green command: the same command after adding only the approved production
  branch.
- Green result: 97 passed, 0 failed, 461 assertions.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | `packages/opencode` | PASS: 97 tests, 461 assertions |
| `bun test test/permission/precheck.test.ts test/permission/auto.test.ts test/permission/next.test.ts` | `packages/opencode` | PASS: 220 tests, 684 assertions |
| Section 8 `bun -e` feedback command | `packages/opencode` | PASS: exit 0; exact supplied command classified `cautious` |
| `bun typecheck` | `packages/opencode` | Initial run exposed two errors in an unrelated concurrently modified `test/tool/parameters.test.ts`; after that concurrent file gained its intended object guard, the unmodified full command was rerun and passed with exit 0 |
| Temporary full-package typecheck excluding only the unrelated failing test | `packages/opencode` | PASS during diagnosis; temporary config was deleted after explicit user approval |
| `bun run build` | `packages/opencode` | PASS: all platform targets built; darwin-arm64 smoke test passed; only the existing large-chunk warning was emitted |
| `git diff --check` | repository root | PASS: no whitespace errors |
| Scoped status/diff | repository root | PASS: only the plan, precheck source, and precheck test belong to this GOAL |

No package lint script exists. SDK generation, database generation/migration,
and external integration infrastructure are not reachable from this classifier
change and were not run.

### Original Feedback-Loop Result

The exact Section 8 `bun -e` command was rerun after green and exited 0. Before
implementation it failed twice with `expected cautious, received general:
unknown shell command`; after implementation the same public-seam assertion
accepts the command as `cautious`.

### Actual Secondary and Replacement Path Inventory

- Existing shell -> token -> Git classification remains the sole primary path.
- The exact `bundle create` branch is a supported-domain branch within that
  path.
- Existing unmatched Git `general` pass-through remains unchanged for other
  modes, including the asserted `bundle verify` boundary.
- New alternate success paths: 0.
- New diagnostic paths: 0.
- Workarounds removed: none existed.
- Fallback/diagnostic decision-surface ratio: 0%.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 6 | Production condition/return plus test declaration/two assertions/closing line; excludes two comment lines, one blank line, and all Markdown plan lines |
| Qualifying Chinese comment lines `C` | 2 | Production comment explains exact mode/safety boundary; test comment explains the paired observable-boundary intent |
| Ratio `C / E` | 33.3% | `2 / 6` |
| Required minimum `C` | 1 | `max(1, ceil(6 * 0.15)) = 1` |

### Remaining Unverified Items

None for the changed surface. The full package typecheck and approved build both
passed. Unrelated concurrent worktree changes were not tested as part of this
GOAL and will not be staged or committed here.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | NB-01 Canonical comment calculation uses the wrong `E` methodology | APPROVE — exact canonical plan revision R1 and the audited implementation diff only. | `ses_09de2e039ffe1RBRTwlYUTkV1n` |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

### Round 1 Verbatim Verdict

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### NB-01 Canonical comment calculation uses the wrong `E` methodology

The implementation evidence at `docs/plans/git-bundle-create-precheck.md:521-528` reports `E = 8` by including the two comment lines. Under the policy, comments are counted separately as `C`, not included in executable-code count `E`.

The independently recomputed result is `E = 6`, `C = 2`, with a required minimum of `1`. The gate still passes comfortably, so this documentation arithmetic issue does not block release.

## Rejected speculation

- A child directory, rule registry, provider interface, or runtime-customizable rule lattice is not justified by this change. The public entry point remains small at `packages/opencode/src/permission/precheck.ts:311-326`, while Git-specific policy is already localized in `classifyGit` at `packages/opencode/src/permission/precheck.ts:1248-1313`.
- Unobserved Git operations such as `git bundle unbundle` cannot drive this implementation. The requirement explicitly prohibits expanding the guardrail based on commands absent from the supplied corpus.
- `git rev-parse ... > file` and `git reflog > file` do not justify changing `classifyGit`. Their write effect is produced by shell redirection, not the Git subcommand, and unsupported redirection is intentionally handled by the existing opaque/general shell path.
- A real repository fixture executing `git bundle create` is unnecessary. The affected interface is a pure classifier; filesystem creation is Git behavior rather than behavior implemented by `PermissionPrecheck`.
- Splitting `precheck.ts` merely because it is approximately 1,536 lines would distribute one ordered classifier without introducing an independently reusable or maintained responsibility.

## Requirement and traceability coverage

- **Architecture assessment:** Covered. The implementation retains the existing deep module and adds no directory, registry, helper, interface, configuration, dependency, or fallback.
- **Intended invariant:** The observed archive-writing command must cross the `cautious` boundary, while unrelated bundle modes must not be promoted.
- **Producer-to-consumer path:**
  `ShellTool.execute` → `collect` → `ShellTool.ask` with exact `metadata.command` (`packages/opencode/src/tool/shell.ts:982-1027, 570-623, 1399-1418`) → `Permission.ask` auto-controlled patterns (`packages/opencode/src/permission/index.ts:221-300`) → `PermissionAuto.evaluate` (`packages/opencode/src/permission/auto.ts:47-88`) → `PermissionPrecheck.evaluate` / `bashEffect` (`packages/opencode/src/permission/precheck.ts:311-347`) → `evaluateShell` → `evaluateCommand` → `classifyTokens` → `classifyGit`.
- **First divergence:** In the baseline implementation, `classifyGit` had no decision for `sub === "bundle"` with mode `create`. It returned `undefined`; `gitSafe` did not recognize `bundle`; the command therefore reached `general: unknown shell command`.
- **Owner:** Git argument classification inside `PermissionPrecheck`, specifically `classifyGit`.
- **Repair:** The exact `bundle + create` branch at `packages/opencode/src/permission/precheck.ts:1273-1275` repairs that owning transition.
- **Narrow boundary:** `git bundle verify backup.bundle` remains `general`, as asserted at `packages/opencode/test/permission/precheck.test.ts:937-941`. Local `git bundle -h` confirmed separate `create`, `verify`, `list-heads`, and `unbundle` modes.
- **Corpus preservation:** Existing branches continue to cover `commit`, `branch` mutation, `reset`, `stash`, `cherry-pick`, `add`, and the other represented Git mutations as `cautious`; no existing classification logic was modified.
- **Test sensitivity:** The added create assertion uses the public `PermissionPrecheck.evaluate` seam and cannot pass against the inspected baseline: baseline `classifyGit` has no bundle branch and `gitSafe` excludes bundle. The expected levels are literal behavioral outcomes rather than duplicated implementation logic.
- **Reverse justification:** The sole new production concept—the exact mode-specific decision branch—maps directly to the observed supplied command and the approved `REQ-02`/`INV-01` boundary. No unrelated production concept was introduced.
- **Verification independently reproduced:**
  - Direct precheck suite: **97 passed, 0 failed, 461 assertions**
  - Related Permission suites: **220 passed, 0 failed, 684 assertions**
  - Exact original feedback loop: **exit 0**
  - `bun typecheck`: **passed**
  - `bun run build`: **passed**, including the darwin-arm64 smoke test; only the documented large-chunk warning appeared
  - Scoped tracked-file `git diff --check`: **passed**
  - Direct whitespace check of the untracked canonical plan: no whitespace errors
- The worktree contains unrelated concurrent modifications, but the audited implementation remains limited to the canonical plan, `precheck.ts`, and `precheck.test.ts`.

## Primary-path and fallback verdict

The authoritative classification path remains:

visible shell evidence
→ existing shell parsing and aggregation
→ existing Git subcommand discovery
→ exact bundle/create decision
→ existing cautious Permission review boundary

The new branch is a supported-domain branch within that path, not an alternate classifier.

The existing unmatched-command `general` result remains a primary-contract pass-through for unsupported commands and non-matching bundle modes. It was not introduced or expanded by this diff.

Downstream reviewer allow/deny and reviewer-unavailable user approval behavior remain existing consumers of the `cautious` decision; they do not compete with `PermissionPrecheck` for Git classification.

- New alternate success paths: **0**
- New diagnostic paths: **0**
- New fallback/diagnostic decision-surface ratio: **0%**
- Superseded workarounds: **none found**

## Code quality and Chinese-comment verdict

The implementation:

- Preserves the existing private helper and public interface shape.
- Adds no `any`, casts, type suppression, non-null assertions, error conversion, dependency, configuration, or public export.
- Performs no unrelated production refactoring or formatting.
- Keeps the exact rule adjacent to the existing Git mutation decisions.
- Uses a stable reason without exposing command paths or dynamic content.
- Tests behavior through the public classifier seam without mocks.

Independent Chinese-comment calculation:

- `E = 6`
  - Production executable lines: exact condition and return = 2
  - Test code lines: test declaration, two assertions, closing line = 4
- `C = 2`
  - Production rationale at `precheck.ts:1273`
  - Test boundary rationale at `precheck.test.ts:938`
- Excluded from `E`: two comment lines, one blank line, all Markdown plan content, and unrelated worktree changes.
- Required minimum: `max(1, ceil(6 × 0.15)) = 1`
- Actual ratio: `2 / 6 = 33.3%`

**Code-quality gate: PASS. Chinese explanatory-comment gate: PASS.**

## Release verdict

**APPROVE — exact canonical plan revision R1 and the audited implementation diff only.**

The implementation may proceed to administrative recording and the separately requested scoped commit. This verdict does not authorize staging or committing unrelated worktree changes.
```

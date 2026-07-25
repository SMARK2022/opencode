# Canonical Implementation Plan: Precheck Opaque Git Mutation → Cautious

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: implementation
>
> Requirement source: Session GOAL / user messages 2026-07-25 (auto reviewer git/shell precheck gaps; opaque `$`/null-redirect auto-allows irreversible git; filter-repo/patch missing; token-semantic, high precision, ≤6 files / ≤800 lines; verified-implementation-and-commit)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，检查当前行为设计，理论上来说，shell的管道符号是可以降级成为cautious的，同时部分比较常见的git 的非可逆操作最好提升为cautious，同时最好保持较高的精确度，避免误报或者匹配格式风格过于狭小，保持基于token语义的匹配而非简单正则；然后针对完整问题进行完整的修改，请确保修改后的内容不会出现红测问题，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在6个代码文件以内，同时代码修改不超过800行。

> 目标终态：`<verified-implementation-and-commit>`

Prior conversation evidence (requirement context, not implementation authority):
historical `opencode.db` bash parts completed under auto after precheck returned
`general` for commands such as `git reset HEAD --quiet 2>/dev/null` and
`git -C "$REPO" apply --index …`, while clean forms of the same subcommands are
already `cautious`. User also directed that `curl|bash`-style dangerous raw
sensitivity must **not** be weakened for string/comment false positives.

Confirmed requirement IDs:

- `REQ-01`: Preserve existing safe/general/cautious/dangerous routing and
  existing green precheck tests (no red regressions).
- `REQ-02`: When shell syntax makes a segment opaque today (`$` expansion,
  benign null redirects), **token-visible irreversible/state-changing git (and
  closely related apply) commands must still reach `cautious`**, not auto-allow
  via `general`.
- `REQ-03`: Pipe (`|`) composition already maxes segment levels; keep
  read-only `|` chains able to stay `safe`, and mutation on either side
  `cautious` (no “all pipes are cautious” widening).
- `REQ-04`: Elevate common irreversible/history-rewrite git ops that are still
  `general` today—at minimum **`git filter-repo`**—via the existing token
  `classifyGit` path (not a new regex-only dangerous family).
- `REQ-05`: Elevate system **`patch`** apply forms that currently auto-allow
  (`patch -p1 -i …`) via token classification with help/version carve-outs.
- `REQ-06`: Prefer token-semantic classification; do not add broad raw regexes
  that match documentation/comment substrings (do not weaken
  `RE_D_CURL_PIPE_INTERPRETER`).
- `REQ-07`: Diff budget: ≤6 code files, ≤800 lines total change; sweet-spot,
  remove/replace obsolete logic rather than parallel paths.
- `REQ-08`: Independent plan + implementation audits, verification, and commit
  of only this GOAL’s paths.

## 2. Explicit Non-Goals

- Do not demote `remote download piped to interpreter` / decode-pipe dangerous
  raw rules; do not special-case comments to allow `curl|bash` substrings.
- Do not split `precheck.ts` into a rule directory/framework (already decided
  against in `docs/plans/git-bundle-create-precheck.md`).
- Do not change `PermissionAuto` routing, reviewer service, Permission static
  ruleset precedence, Always-prefix policy, arity tables, or public SDK schemas.
- Do not make every opaque shell (`echo $HOME`, `git status & rg`, newline
  sequences) become `cautious`.
- Do not force every file redirect (`echo > out`, `scp 2>file`) onto a new
  level if existing tests lock `general`; only fix **benign null redirects** and
  **variable-bearing command lines that still expose git/patch tokens**.
- Do not classify speculative unobserved git plumbing families beyond what this
  plan’s evidence list requires (`filter-repo`, system `patch`, opaque salvage
  for already-owned porcelain mutations).
- Do not execute destructive git against user repos; feedback uses pure
  `PermissionPrecheck.evaluate` strings.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Permission owns what Agent/Tool may do without asking; implementation under `packages/opencode/src/permission/`. |
| `AGENTS.md` | Minimal helpers, package-local tests/typecheck, default branch `dev`. |
| `packages/opencode/AGENTS.md` | Flat ESM / self-reexport; keep private helpers private. |
| `packages/opencode/test/AGENTS.md` | Test real implementation; no mocks for pure precheck. |
| `.opencode/policy/first-principles-engineering.md` | Own first divergence; no fallback ladders; mappings; Chinese comment gate. |
| `docs/plans/git-bundle-create-precheck.md` | Prior git precheck style: extend `classifyGit`, no directory split. |
| `packages/opencode/src/permission/auto.ts` | `safe`/`general` auto-allow; only `cautious` → reviewer; `dangerous` deny. |
| `packages/opencode/src/permission/reviewer/policy/policy.md` | Irreversible VCS needs explicit authorization (reviewer policy text). |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` `evaluateShell` ~431–466 | Aggregates segments; opaque injects `general`; max picks cautious/dangerous. | observed |
| `packages/opencode/src/permission/precheck.ts` `splitCommands` ~739–839 | `$` / `` ` `` in double quotes **taint+restart** drops segment; `>`/`<` (non fd-merge) same; causes loss of `classifyGit`. | observed |
| `packages/opencode/src/permission/precheck.ts` fd-merge skip ~793–804 | Precedent: benign redirect consumed without taint (`2>&1`). | observed |
| `packages/opencode/src/permission/precheck.ts` `classifyGit` ~1247–1311 | State-changing porcelain list; has `filter-branch` not `filter-repo`; no system `patch`. | observed |
| `packages/opencode/src/permission/precheck.ts` `classifyTokens` ~1053–1220 | Token engine entry for non-git cmds; place for `patch`. | observed |
| `packages/opencode/src/permission/auto.ts` ~63–77 | Proves `general` is auto-allow—opaque “requires explicit approval” reason is **not** a review gate. | observed |
| `packages/opencode/test/permission/precheck.test.ts` git suites ~73–108, 912–992 | Locks clean git mutations cautious; global `-C` cautious; stash list general. | observed |
| `packages/opencode/test/permission/precheck.test.ts` opaque/fd-merge ~1118–1184 | Locks `2>&1` salvage, file redirect `general`, `$`/`&`/newline general, remnant non-misclass. | observed |
| Red harness `bun …/precheck-red.mjs` (temp) | Observed: `git reset … 2>/dev/null` general; `git -C "$REPO" apply` general; `git filter-repo` general; `patch -p1 -i` general; clean apply/reset/checkout cautious; `git status \| head` safe; `git status \| git checkout` cautious. | observed |
| Historical DB session audit (conversation) | Completed auto allows for `git reset … 2>/dev/null`, `git -C "$REPO" apply`, trap `rm -rf "$tmp"`+checkout forms. | observed |

## 5. Current Behavior

```text
ShellTool.ask(metadata.command + patterns)
  -> Permission.ask / auto
  -> PermissionPrecheck.evaluate
       bashEffect: maxRisk(raw command, patterns)
       evaluateShell:
         dangerousRaw / cautiousRaw
         rawWrapperScripts recurse
         splitCommands -> segments + opaque flag
         evaluateCommand(tokenize -> unwrap -> classifyTokens/gitSafe)
         if opaque: push general
         max(dangerous, cautious, all-safe, else general)
  -> auto: safe/general allow; cautious reviewer; dangerous deny
```

**Critical product fact:** opaque `general` is **auto-allow**, not user prompt.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Clean `git reset/apply/checkout/…` | agent bash | none | classifyGit | precheck classifyGit | observed |
| `git … 2>/dev/null` | agent bash | none | splitCommands taints on `>` | precheck splitCommands | observed |
| `git -C "$REPO" apply …` | agent bash | none | double-quoted `$` taints | precheck splitCommands | observed |
| `git status \| git checkout` | agent bash | none | `\|` split + max | precheck evaluateShell | observed |
| `git status \| head` | agent bash | none | both safe → safe | precheck | observed |
| `git filter-repo …` | agent bash | none | classifyGit miss → general | precheck classifyGit | observed |
| `patch -p1 -i file` | agent bash | none | classifyTokens miss → general | precheck classifyTokens | observed |
| `echo $HOME` / `git status & rg` | agent bash | none | must stay non-safe/non-cautious per tests | precheck | contracted |
| `echo > out` / `scp 2>file` | agent bash | none | stay general per tests | precheck | contracted |
| Comment/doc `curl\|bash` substring | agent bash | none | stay dangerous (user policy) | dangerousRaw | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Token-visible git state-changing porcelain is `cautious` under auto. | classifyGit + auto.ts | precheck.test git suites |
| INV-02 | Benign null redirects (`N>/dev/null`) must not strip a token-visible git mutation down to auto-allow `general`. | red harness + DB | **missing (red)** |
| INV-03 | Double-quoted `$var` arguments must not strip token-visible git mutation down to auto-allow `general`. | red harness + DB | **missing (red)** |
| INV-04 | `|` maxes segment risk: read-only chain may be `safe`; any cautious segment wins. | evaluateShell | pipe tests / red harness |
| INV-05 | `git filter-repo` non-help is `cautious` (history rewrite). | missing branch | **missing (red)** |
| INV-06 | System `patch` apply forms are `cautious`; help/version not forced cautious. | missing branch | **missing (red)** |
| INV-07 | Unquoted dynamic expansion / background `&` / newline / file redirects keep existing levels (no mass cautious). | tests 1177–1184, 1155–1161 | existing |
| INV-08 | Remnant fragments after bail must not mis-promote `mkfs`/`rm` tokens. | tests 1143–1152 | existing |
| INV-09 | Dangerous remote-download-pipe family remains dangerous. | RE_D_CURL_PIPE | precheck.test 416–421 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `splitCommands` treats `2>/dev/null` like filesystem `>`: taints segment, drops tokens before `classifyGit`. | `splitCommands` in `precheck.ts` | `git reset HEAD` → cautious; same + `2>/dev/null` → general |
| INV-03 | Double-quoted `$` sets `tainted=true` and restarts segment mid-argv, discarding leading `git …` tokens. | `splitCommands` quote branch | `git -C /x apply` cautious (via -C global); `git -C "$REPO" apply` general |
| INV-05 | `classifyGit` state-changing list omits `filter-repo` (only `filter-branch`). | `classifyGit` | `git filter-repo --path …` → general |
| INV-06 | `classifyTokens` has no `patch` command branch. | `classifyTokens` | `patch -p1 -i f` → general |

Downstream symptom: auto.ts allows `general` → irreversible ops execute without reviewer.

### Red-capable feedback loop (executed)

Command (package-local pure evaluate via temp harness equivalent to tests):

```text
bun /var/folders/…/T/opencode/precheck-red.mjs
```

Observed reds (must become green after fix):

| Case | Current level |
| --- | --- |
| `git reset HEAD --quiet 2>/dev/null` | general |
| `git -C "$REPO" apply --index file.patch` | general |
| `git -C "$REPO" reset --hard` | general |
| `git filter-repo --path docs --invert-paths` | general |
| `patch -p1 -i changes.patch` | general |

Observed greens to preserve:

| Case | Level |
| --- | --- |
| clean apply/reset/hard/checkout/restore/force/rebase/clean | cautious |
| `git status \| head` | safe |
| `git status \| git checkout main` | cautious |
| `git status 2>&1` | safe |
| `echo $HOME`, `git status & rg` | general |
| `scp … 2>&1` | cautious |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Why not elsewhere |
| --- | --- | --- | --- | --- |
| Shell segment opacity vs token visibility | `PermissionPrecheck.splitCommands` / `evaluateShell` | Pure classify of bash strings | First place tokens are lost | ShellTool must not reimplement policy |
| Git subcommand risk | `classifyGit` | Token argv semantics | Already owns porcelain matrix | auto.ts only routes levels |
| System patch risk | `classifyTokens` | Same token engine as rm/mv | Non-git binary | Not reviewer prompt |
| Auto allow/deny/review | `PermissionAuto.evaluate` | Level → action | Unchanged | — |

## 10. Single Approved Primary-Path Design

```text
bash command string
  -> dangerousRaw / cautiousRaw (unchanged; curl|bash stays dangerous)
  -> splitCommands (repaired opacity rules)
       * consume benign null redirects like fd-merge (N>/dev/null, >/dev/null, N</dev/null)
       * for `$` and backticks: mark opaque (forbid whole-command safe elevation)
         but do NOT taint-restart mid-segment so leading argv remains classifiable
       * keep filesystem `>`/`<` taint behavior that existing tests lock
       * keep `( ) { } * ? [` taint behavior unless already covered by sibling-segment rules
  -> evaluateCommand(tokenize -> classifyTokens/classifyGit)
  -> max with opaque general so: mutation+opaque => cautious; pure safe+opaque => general
  -> classifyGit: add filter-repo as state-changing (help/version not required if sub is filter-repo with only --help? prefer: filter-repo always cautious except bare --help/-h/--version if easy token check)
  -> classifyTokens: patch apply cautious with help/version carve-out
```

**Why this repairs first divergence:** restores the existing token classifiers as the single semantic authority instead of inventing a second raw-regex git detector. Opacity still prevents **safe** auto for dynamic shells, but no longer **erases** cautious mutations (max(general, cautious)=cautious).

**filter-repo:** add `filter-repo` to the state-changing subcommand list (same reason as `filter-branch`). Optional precision: if only `--help`/`-h`/`--version` after sub, leave general—only if implementable with simple token scan without new framework.

**patch:** `normalizeCommandName(cmd)==="patch"` and not help/version-only → cautious with reason `patch apply modifies working tree`. Help-only: all args in `{--help,-h,--version,-v}` or no file/`-i`/`-p` apply signals → general. Prefer: any `patch` with additional non-help args → cautious (token list), matching “apply forms”.

**Pipes:** no separate pipe policy. `|` remains a segment boundary; INV-04 holds by existing max. User’s “管道可降为 cautious” is satisfied by ensuring mutation segments still classify when combined with opacity on other segments—not by forcing all pipes cautious.

**Remove/replace old logic:** delete reliance on taint-restart for `$`/`` ` `` as the way to “fail open to general”; replace with opaque-without-drop. Do not leave a parallel salvage classifier.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| classifyGit / classifyTokens primary | current+extend | primary-contract | yes (level decision) | ~100% of git/patch risk | preserve+extend |
| dangerousRaw curl\|bash | current | primary-contract | yes deny | dangerous family | preserve |
| New raw regex for git mutations | proposed? | forbidden fallback | would duplicate | — | **reject** |
| Second precheck module/dir | proposed? | forbidden fallback | — | — | **reject** |
| Demote curl\|bash to cautious | proposed? | forbidden (user) | — | — | **reject** |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why approved route supersedes | Delete or collapse |
| --- | --- | --- | --- |
| taint-restart on `$` discarding argv | avoid classifying expansion remnants as cmds | opaque-without-drop + full-segment tokenize avoids remnant-as-command; remnant tests still hold for true restart cases on other bails | replace `$`/backtick branch behavior |
| Dead `GIT_WRITES` in shell.ts (optional) | leftover | not required for this GOAL; only touch if budget and pure delete | **out of scope unless free** |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-02 / REQ-02 null redirect | splitCommands null-redirect consume | `precheck.ts` | precheck.test: `git reset HEAD 2>/dev/null` cautious |
| INV-03 / REQ-02 quoted `$` | splitCommands opaque-without-drop | `precheck.ts` | `git -C "$REPO" apply f` cautious; `git -C "$REPO" reset --hard` cautious |
| INV-04 / REQ-03 pipes | existing max | no change or regression assert | `git status \| head` safe; `git status \| git checkout x` cautious |
| INV-05 / REQ-04 filter-repo | classifyGit list | `precheck.ts` | `git filter-repo --path docs --invert-paths` cautious |
| INV-06 / REQ-05 patch | classifyTokens | `precheck.ts` | `patch -p1 -i f` cautious; help general if carved |
| INV-07–09 guards | existing branches | tests only if needed | existing opaque/redirect/curl tests stay green |
| REQ-01 no red | — | test file updates only additive | full precheck.test.ts green |
| REQ-07 budget | — | ≤2–3 files | review diff |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Benign null-redirect skip in splitCommands | INV-02 | same pattern as fd-merge; red case | fd-merge only handles `>&` not `>/dev/null` |
| `$`/backtick opaque-without-drop | INV-03 | DB + red | taint-restart deletes classifyGit input |
| `filter-repo` in state-changing set | INV-05 | missing sibling of filter-branch | list omission |
| `patch` token branch | INV-06 | system patch auto-allows | no owner branch |
| (rejected) raw git mutation regex | — | would false-positive docs | user forbid simple over-broad regex |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` | modify | null-redirect consume; `$`/backtick opaque-without-drop; classifyGit `filter-repo`; classifyTokens `patch`; nearby Chinese comments | +40–90 prod |
| `packages/opencode/test/permission/precheck.test.ts` | modify | red→green cases + regression guards for safe pipes / echo $HOME / file redirect | +40–80 test |
| (optional third) none | — | stay within 2 files if possible | 0 |

Total files ≤ 2 code files (well under 6). Lines ≪ 800.

## 16. TDD Behavior Slices

Public seam: `PermissionPrecheck.evaluate({ permission:"bash", patterns:[cmd], metadata:{command:cmd} })` via existing `bash()` helper in `precheck.test.ts`.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `git reset HEAD --quiet 2>/dev/null` → cautious | `>` taints segment | null-redirect skip | `git status 2>&1` still safe; `echo > out` still general |
| 2 | `git -C "$REPO" apply --index f` → cautious | quoted `$` drops argv | opaque-without-drop | `echo $HOME` still general; safe+opaque not safe-elevated |
| 3 | `git -C "$REPO" reset --hard` → cautious | same | same | hard reason may be state-changing or destructive-hard |
| 4 | `git filter-repo --path docs --invert-paths` → cautious | missing sub | add sub list | filter-branch still cautious |
| 5 | `patch -p1 -i changes.patch` → cautious | missing cmd | classifyTokens patch | `git apply` still cautious |
| 6 | `git status \| head -5` stays safe; `git status \| git checkout main` cautious | — | no pipe rewrite | INV-04 |

Independent expected values: only `level` (and stable reason prefixes where already patterned). No private helper asserts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~50–80 | exclude pure tests |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(E*0.15)) ≈ 8–12 | nearby at null-redirect, `$` opaque-without-drop, filter-repo, patch carve-out |

Comment topics: why null-redirect is benign vs file redirect; why `$` marks opaque but must not drop argv (auto-allow hole); filter-repo vs filter-branch; patch help carve-out.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | `packages/opencode` | all precheck behavior green |
| `bun test test/permission/auto.test.ts` | `packages/opencode` | auto routing still correct if touched indirectly |
| `bun typecheck` | `packages/opencode` | types clean |
| Re-run red harness cases via tests | `packages/opencode` | original loop green |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | extend existing |
| Files modified | 2 | precheck.ts + precheck.test.ts |
| Files deleted | 0 | — |
| Production lines | ≤100 | targeted splitCommands + two classify branches |
| Test lines | ≤100 | additive cases |
| Generated lines | 0 | — |

Hard cap: ≤6 files, ≤800 lines (user). Plan targets ≪ cap.

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| opaque-without-drop makes some dynamic safe commands become safe incorrectly | opaque still injects general → max(safe, general)=general |
| null-redirect skip mis-parses exotic redirections | only exact `/dev/null` targets; leave other `>` tainted |
| `patch` too broad (scripts named patch) | normalizeCommandName + help carve-out; same pattern as other cmds |
| reason string changes break brittle tests | match `toMatchObject({ level })` primarily; keep reason style consistent |

### Open Decisions Requiring the User

None for R1. Product defaults taken from evidence + auto.ts semantics.

### Rejected Speculation

- Classifying all opaque shells cautious (noise).
- Raw multi-line regex for git (doc false positives; user forbid).
- Changing curl|bash dangerous sensitivity.
- Precheck subdirectory split.
- Elevating all `sudo` to cautious (out of quoted scope).

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15% Chinese explanatory-comment plan.
- Confirm `general` auto-allow hole is closed for listed reds without red regressions on locked opaque/redirect tests.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | (1) Residual auto-allow holes outside R1 non-goals — `patch -p1 < file` (file redirect), unquoted `${VAR}`, and `$(…)` still lose/taint leading tokens and can stay `general`. Observed reds and REQ-02/05 focus on `2>/dev/null`, `"$VAR"`, `filter-repo`, and `patch -i`; plan §2 explicitly keeps filesystem `>`/`<` and non-variable opaque forms. Residual, not under-design of the quoted scope. (2) Spaced null redirects — §10 specifies contiguous `N>/dev/null` forms. `2> /dev/null` may remain `general` if whitespace is not consumed. Historical/red evidence uses unspaced `2>/dev/null`. (3) Comment budget estimate method — §17 estimates `E` excluding pure tests; policy counts production **and** test lines at implementation audit. Estimate drift only; implementer must recompute real `E`/`C`. (4) `patch` help/version carve-out — §10 allows either “always cautious except bare help” or “non-help args → cautious”. Either is fine if tests lock the chosen rule; avoid dual interpretations in code. | APPROVE | ses_06666c6a3ffeJPlak2mWso3cjs |

### Plan audit verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

**Applies only to:** `docs/plans/precheck-opaque-git-mutation-cautious.md` **revision R1** (plan audit).
Implementation remains disallowed until R1 is recorded as approved and a separate full-scope implementation audit of the actual diff also returns clean.

(Administrative note: this section records the independent plan verdict for R1 and sets approval fields only; no design change.)

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/permission/precheck.ts` | null-redirect skip; `$`/backtick opaque-without-drop; `filter-repo` in classifyGit; system `patch` in classifyTokens |
| `packages/opencode/test/permission/precheck.test.ts` | five new behavioral suites for reds + regressions |

`git diff --stat` (implementation only): 2 files, +64 / −9 lines.

### Red-Green Test Evidence

| Slice | Red (before) | Green (after) |
| --- | --- | --- |
| `git reset HEAD --quiet 2>/dev/null` | general | cautious |
| `git -C "$REPO" apply --index file.patch` | general | cautious |
| `git -C "$REPO" reset --hard` | general | cautious |
| `git filter-repo --path docs --invert-paths` | general | cautious |
| `patch -p1 -i changes.patch` | general | cautious |
| `git status \| head -5` | safe | safe |
| `git status \| git checkout main` | cautious | cautious |

New tests failed first (4 fail), then full suite green after implementation.

### Verification Commands and Results

| Command | CWD | Result |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | `packages/opencode` | 103 pass, 0 fail |
| `bun test test/permission/auto.test.ts` | `packages/opencode` | 22 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | clean |
| original red harness `precheck-red.mjs` | temp | planned reds now cautious; `patch < file` still general (non-goal) |

### Original Feedback-Loop Result

Original red harness cases for null-redirect, quoted `$REPO` git mutations, filter-repo, and `patch -i` are green (cautious). File-redirect `patch -p1 < file` remains general per non-goals.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| classifyGit / classifyTokens | primary | extended |
| dangerousRaw curl\|bash | primary | preserved |
| raw git-mutation regex | forbidden | not added |
| precheck subdirectory | forbidden | not added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 66 | non-blank +/- lines in precheck.ts + precheck.test.ts, excluding import-only/blank |
| Qualifying Chinese comment lines `C` | 15 | nearby // comments explaining opaque-without-drop, null-redirect, filter-repo, patch carve-out, auto-allow hole |
| Ratio `C / E` | 0.227 |  |
| Required minimum `C` | 10 | `max(1, ceil(66 * 0.15))` |

### Remaining Unverified Items

- Spaced null redirect `2> /dev/null` (non-blocking plan note; not in red corpus).
- Unquoted complex `${VAR}` / `$(…)` residual holes outside R1 non-goals.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | (1) splitCommands top summary still says bail restarts; `$`/backtick now opaque-without-drop — comment drift only. (2) spaced null redirect / `>>/dev/null` still taint. (3) `patch < file` / `${VAR}` residual general per non-goals. | APPROVE | ses_066332b6fffenMoZlWkMrmLD7O |

### Implementation audit verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

Applies only to plan R1 and the production/test diff of `precheck.ts` + `precheck.test.ts`. Auditor independent verification: precheck+auto tests 125 pass / 0 fail.

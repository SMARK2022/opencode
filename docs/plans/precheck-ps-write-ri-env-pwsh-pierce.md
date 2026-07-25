# Canonical Implementation Plan: Precheck PS Write / ri / env / pwsh Pierce

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: implementation
>
> Requirement source: Session GOAL 2026-07-26 — Clear-Content/Set-Content/Out-File → cautious; ri as delete; powershell/pwsh -Command join-all like cmd /c; env pierce like sudo for inner delete/move/git; no .env ruleset into bash precheck; token-semantic; ≤6 files / ≤800 lines; verified-implementation-and-commit
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-26
>
> R2 change: B-01 from plan audit R1 — `ri` must share `RE_D_PS_RECURSIVE_DELETE_ROOT` / token recursive-dangerous path with `Remove-Item` so `ri -Recurse /` is dangerous, not demoted by generic delete cautious.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，检查当前行为设计，理论上来说，高：Clear-Content / Set-Content / Out-File（及 lower-case）→ cautious（工作树覆写）
> 高：ri 并入删除集合（与 remove-item 同级）
> 中：powershell/pwsh 在 -Command 后 join 全部剩余 token 再递归 precheck（对齐 cmd /c）
> 中：env 对内层命令穿透（类似 sudo），至少删/移/git 变更要抬升
> 低/配置：.env 的 edit/read 硬 deny 继续用 ruleset，不必硬塞进 bash precheck；避免误报或者匹配格式风格过于狭小，保持基于token语义的匹配而非简单正则；然后针对完整问题进行完整的修改，请确保修改后的precheck不会出现红测问题，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。
> 我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在6个代码文件以内，同时代码修改不超过800行。

> 目标终态：`<verified-implementation-and-commit>`

Confirmed requirement IDs:

- `REQ-01`: `Clear-Content` / `Set-Content` / `Out-File` (any case via normalize) with non-help args → `cautious` (working-tree overwrite / truncate).
- `REQ-02`: PowerShell alias `ri` classified as file deletion at same level as `remove-item`, including: (a) ordinary delete → cautious; (b) `-Recurse` non-protected → cautious recursive PS delete; (c) `-Recurse` + protected root → **dangerous** via the same raw + token paths as `Remove-Item` (not stopped at generic delete cautious).
- `REQ-03`: `powershell` / `pwsh` / `powershell.exe` after `-Command`/`-c` must join **all remaining tokens** into the recursive script (same contract as `cmd /c`), so `pwsh -Command Remove-Item file.txt` is not stuck as wrapper-only `general`.
- `REQ-04`: `env` peels optional `KEY=value` assignments and recursively classifies the inner command (like `sudo`), so `env rm file` / `env git reset --hard` promote at least as high as the bare inner command; bare `env` stays non-safe general.
- `REQ-05`: Do **not** push `.env` edit/read hard-deny into bash precheck; ruleset remains owner.
- `REQ-06`: Token-semantic classification; no broad raw regex families for these commands; no red regressions on existing precheck suite; ≤6 code files, ≤800 lines.

## 2. Explicit Non-Goals

- Do not implement path ACL / ruleset deny for `*.env` or `~/.ssh` inside precheck.
- Do not change `PermissionAuto` level routing, reviewer service, or static Permission schema.
- Do not elevate all PowerShell cmdlets or all `env` uses to cautious.
- Do not decode/execute arbitrary PS for classification beyond existing `-EncodedCommand` path.
- Do not add precheck subdirectory/framework.
- Do not weaken `RE_D_CURL_PIPE_INTERPRETER` or prior opaque-git salvage.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Permission under `packages/opencode/src/permission/`. |
| `AGENTS.md` / `packages/opencode/AGENTS.md` | Minimal helpers; package-local tests/typecheck. |
| `.opencode/policy/first-principles-engineering.md` | Own first divergence; no fallback ladders. |
| `docs/plans/precheck-opaque-git-mutation-cautious.md` | Prior precheck style: extend classify/unwrap in place. |
| `packages/opencode/src/permission/auto.ts` | `general` auto-allows; only `cautious` reviews. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `precheck.ts` `FILE_DELETE_COMMANDS` ~72 | Has `remove-item`, missing `ri`. | observed |
| `precheck.ts` `RAW_FILE_DELETE_PATTERN` ~122 | Has `Remove-Item`, missing `ri`. | observed |
| `precheck.ts` `unwrap` POWERSHELL ~909–921 | Uses only `tokens[index+1]` for `-Command` (unlike cmd join-all). | observed |
| `precheck.ts` `unwrap` env ~947 | Short-circuits to ask/general; no inner pierce. | observed |
| `precheck.ts` `unwrap` sudo ~948–953 | Model for env pierce: `action: "script"`. | observed |
| `precheck.ts` `classifyTokens` delete/move ~1069–1089 | Token owner for file mutations; no PS write cmdlets. | observed |
| Red harness `precheck-red2.mjs` | All four REQ families currently `general`. | observed |
| Existing `precheck.test.ts` | Regression surface; cmd join, Remove-Item, sudo rm green. | contracted |

## 5. Current Behavior

```text
bash command
  -> evaluateShell
       unwrap(tokens):
         powershell -Command X  => script = tokens[i+1] only  // drops "file.txt"
         env ...                => ask/general, no pierce
         sudo cmd               => script = join(rest)        // model
         cmd /c a b c           => script = join(all after /c)
       classifyTokens:
         remove-item / rm / del => cautious
         ri / Clear-Content / Set-Content / Out-File => fallthrough general
  -> auto: general allow
```

## 6. Supported Input Domain and Reachability

| Input | Producer | Reachable path | Classification |
| --- | --- | --- | --- |
| `Clear-Content f` / lower-case | agent bash | classifyTokens | observed red |
| `Set-Content f x` / `Out-File f` | agent bash | classifyTokens | observed red |
| `ri f` / `ri -Force f` | agent bash | classifyTokens / raw | observed red |
| `ri -Recurse -Force dir` | agent bash | remove-item recursive branch needs `ri` | reachable |
| `pwsh -Command Remove-Item f` | agent bash | unwrap PS | observed red |
| `env rm f` / `env FOO=1 git reset --hard` | agent bash | unwrap env | observed red |
| `env` alone | agent bash | stay general | contracted |
| `cat .env` | already cautious | unchanged | observed |
| edit `.env` path deny | ruleset | non-goal | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Existing test |
| --- | --- | --- |
| INV-01 | PS content overwrite cmdlets with target args → cautious | **red** |
| INV-02 | `ri` (+ args) → same delete family as `remove-item` | **red** |
| INV-03 | `ri -Recurse` + protected root → **dangerous** (parity with `Remove-Item -Recurse /`); non-protected recurse → cautious | **red (required)** |
| INV-04 | `pwsh|powershell -Command` multi-token payload recursively classified | **red** |
| INV-05 | `env [KEY=val…] cmd…` level ≥ bare `cmd…` for delete/move/git | **red** |
| INV-06 | bare `env` / unknown env payload stays non-safe (general) | preserve |
| INV-07 | Existing Remove-Item/rm/cmd/sudo/git/opaque suites stay green | precheck.test.ts |
| INV-08 | No new `.env` hard-deny in precheck | non-goal |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01 | classifyTokens has no write-cmdlet set | classifyTokens | Clear-Content → general |
| INV-02 | FILE_DELETE / raw omit `ri` | FILE_DELETE_COMMANDS + RAW_FILE_DELETE | ri → general |
| INV-03 | `RE_D_PS_RECURSIVE_DELETE_ROOT` and token recurse branch only match `Remove-Item` / `remove-item`, not `ri`; after adding `ri` only to generic delete, raw cautious would fire first and demote protected-root recurse | RE_D_PS_RECURSIVE_DELETE_ROOT + classifyTokens | `Remove-Item -Recurse /` dangerous; `ri -Recurse /` general today, would be wrong cautious if only FILE_DELETE extended |
| INV-04 | PS `-Command` takes only next token | unwrap POWERSHELL | Remove-Item file dropped |
| INV-05 | env hard-ask without script pierce | unwrap env | env rm → general |

### Red-capable feedback loop (executed)

```text
bun /var/folders/…/T/opencode/precheck-red2.mjs
```

Observed reds: Clear/Set/Out-File, ri, pwsh -Command Remove-Item, env rm/git → **general**.  
Preserved greens: rm, Remove-Item, sudo rm, cmd del, git status, cat .env.

## 9. Responsibility and Seam

| Concern | Owner | Why here |
| --- | --- | --- |
| PS overwrite / ri / delete sets | `classifyTokens` + FILE_* constants | token semantic owner |
| raw opaque delete text | `RAW_FILE_DELETE_PATTERN` | mirror token set for opaque shells |
| PS -Command join | `unwrap` PowerShell branch | same as cmd /c owner |
| env pierce | `unwrap` env branch | same as sudo owner |
| .env path deny | Permission ruleset | REQ-05 |

## 10. Single Approved Primary-Path Design

```text
1) FILE_DELETE_COMMANDS += "ri"
   RAW_FILE_DELETE_PATTERN include ri (word-boundary, with Remove-Item)
   // B-01: ri 与 Remove-Item 同级 dangerous — 必须在 generic delete cautious 之前命中
   RE_D_PS_RECURSIVE_DELETE_ROOT: match \b(?:Remove-Item|ri)\b (case-insensitive already)
   classifyTokens recursive PS branch: cmd === "remove-item" || cmd === "ri"
     same -Recurse + protectedDeleteTarget → dangerous / else cautious recursive

2) FILE_WRITE_COMMANDS = clear-content, set-content, out-file
   classifyTokens: if FILE_WRITE_COMMANDS.has(cmd) && tokens.length > 1
     && not help-only → cautious "PowerShell file content write requires explicit approval"
   help-only (locked rule, same spirit as patch): every arg is --help|-h|--version|-v
     or no non-help args → general; any other arg → cautious

3) unwrap PowerShell -Command/-c:
   script = tokens.slice(index+1).join(" ")  // replace single-token; EncodedCommand path unchanged

4) unwrap env (replace always-ask):
   skip KEY=value tokens
   skip boolean flags -i -0 --null --ignore-environment
   for -u/--unset skip flag + following token
   if remaining: action script = joinShellTokens(rest)  // like sudo
   else: action ask (bare env)
```

No second classifier. No raw multi-line PS write regex. Token path primary; raw mirrors `ri` for opaque delete **and** protected-root recursive dangerous (parity with Remove-Item).

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| classifyTokens / unwrap primary | primary | extend |
| RAW_FILE_DELETE mirror for ri | primary-contract branch | extend |
| New raw regex for Clear-Content | forbidden | reject |
| .env in precheck | forbidden | reject |

## 12. Workaround Deletion and Replacement

| Item | Disposition |
| --- | --- |
| env always-ask without pierce | replace with sudo-like pierce |
| PS -Command single-token script | replace with join-all |

## 13. Forward Traceability

| Req / INV | Path | File | Test |
| --- | --- | --- | --- |
| REQ-01 / INV-01 | classifyTokens write set | precheck.ts | Clear/Set/Out-File → cautious |
| REQ-02 / INV-02–03 | FILE_DELETE + RAW delete + RE_D_PS_RECURSIVE_DELETE_ROOT + token ri recurse | precheck.ts | ri file cautious; ri -Recurse / dangerous; Remove-Item -Recurse / still dangerous |
| REQ-03 / INV-04 | unwrap PS join | precheck.ts | pwsh -Command Remove-Item f |
| REQ-04 / INV-05–06 | unwrap env pierce | precheck.ts | env rm; env FOO=1 git reset --hard; bare env general |
| REQ-05 | none | — | no new .env precheck asserts |
| REQ-06 | suite green | precheck.test.ts | full suite |

## 14. Reverse Traceability

| Concept | Req | Why existing insufficient |
| --- | --- | --- |
| FILE_WRITE_COMMANDS | REQ-01 | delete set does not cover truncate/overwrite |
| ri in delete + PS recursive dangerous raw/token | REQ-02 / INV-03 | alias missing; Remove-Item-only raw dangerous demotes ri |
| PS join-all | REQ-03 | single token drops args |
| env pierce | REQ-04 | short-circuit never sees rm/git |

## 15. File-Level Change Plan

| File | Change | Delta |
| --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` | write set, ri, PS join, env pierce, Chinese comments | +40–80 |
| `packages/opencode/test/permission/precheck.test.ts` | red→green suites + regressions | +40–70 |

## 16. TDD Behavior Slices

Seam: `PermissionPrecheck.evaluate` via existing `bash()` helper.

| Order | Red | Green |
| --- | --- | --- |
| 1 | Clear-Content / Set-Content / Out-File → cautious | write set |
| 2 | ri file → cautious; **ri -Recurse / → dangerous** (parity Remove-Item -Recurse /) | FILE_DELETE + RE_D + token ri recurse |
| 3 | pwsh -Command Remove-Item file.txt → cautious | PS join |
| 4 | env rm file.txt → cautious; env git reset --hard → cautious | env pierce |
| 5 | bare env general; git status safe; rm still cautious; env git status still general | regression |

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | --- |
| E | ~50–90 |
| C | ≥ max(1, ceil(E×0.15)) ≈ 8–14 |

Sites: PS write set purpose; ri alias; **ri in RE_D_PS_RECURSIVE_DELETE_ROOT before generic delete cautious**; PS join-all vs single token hole; env KEY=val/flag skip + pierce vs old ask.

## 18. Verification

| Command | CWD |
| --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode |
| `bun test test/permission/auto.test.ts` | packages/opencode |
| `bun typecheck` | packages/opencode |
| re-run precheck-red2.mjs | temp |

## 19. Diff Budget

| Metric | Estimate |
| --- | --- |
| Files modified | 2 |
| Production lines | ≤90 |
| Test lines | ≤80 |
| Total | ≪ 800 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| `ri` as substring false positive | word-boundary + normalizeCommandName as cmd only |
| PS -Command with quoted multi-word already one token | join still correct; no double-join issue |
| env -i / env -u flags | if first non-assignment is flag, remaining may still pierce poorly → keep general unless clear cmd; optional: skip known env flags `-i,-u,-0` lightly if observed |

### Open Decisions

None for R1. env flags other than KEY=val: if token starts with `-`, treat as non-command and leave general unless a later non-flag cmd appears (simple scan: skip KEY=val and skip leading `-*` option tokens that consume optional next arg only for `-u`/`--unset` — **keep minimal**: skip only `KEY=val`; if next is `-i`/`-u` leave general for R1 unless bare pattern `env cmd` works. Document residual for `env -i rm f` as non-blocking residual if not covered.

**Refined env pierce for R1:**  
After `env`, skip tokens matching `^[A-Za-z_][A-Za-z0-9_]*=.*`. Then skip known boolean flags `-i`, `-0`, `--null`, `--ignore-environment`. For `-u`/`--unset`, skip flag and following token. Then if remaining tokens non-empty, pierce. This stays token-semantic and small.

### Rejected Speculation

- All PS cmdlets cautious  
- Raw regex for Set-Content in comments  
- Moving .env deny into precheck  

## 21. Audit Contract

Independent auditor: full original scope; evidence for blockers; under/over-design; Chinese comment plan; no fallback ladders.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking | Non-blocking | Result | Ref |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: ri -Recurse protected root not same-level dangerous as Remove-Item (RE_D only Remove-Item; generic delete would demote) | N-01 weak INV-03 TDD; N-02 help dual wording; N-03 env flag residual vs refined | BLOCK | ses_065184aafffeHZlTLP4CqEE3X9 |
| 2 | R2 | yes | No blocking findings. | N-01 env residual docs; N-02 help dual wording; N-03 full Remove-Item matrix not re-duplicated for ri | APPROVE | ses_0650e0976ffe2j3tVlh4AS7veC |

### Plan audit R2 verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

Audited artifact: plan **Revision R2** only. Implementation allowed after this administrative approval recording.

### Plan audit R1 verdict (verbatim excerpt)

```text
BLOCK
```

B-01 concrete production consequence: after FILE_DELETE-only `ri`, `ri -Recurse /` becomes cautious via RAW_FILE_DELETE before token dangerous; `Remove-Item -Recurse /` stays dangerous deny. R2 repairs same primary raw+token path.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/permission/precheck.ts` | FILE_WRITE_COMMANDS; ri in delete/raw/RE_D/token recurse; PS -Command join-all; env pierceEnvTokens; Chinese comments |
| `packages/opencode/test/permission/precheck.test.ts` | four new behavioral suites |

`git diff --stat`: 2 files, +90 / −8.

### Red-Green Test Evidence

| Slice | Before | After |
| --- | --- | --- |
| Clear/Set/Out-File | general | cautious |
| ri file / ri -Recurse / | general | cautious / dangerous |
| pwsh -Command Remove-Item f | general | cautious |
| env rm / env git reset --hard | general | cautious |
| bare env / env git status | general | general |

New tests failed first (4 fail), then full suite green.

### Verification Commands and Results

| Command | CWD | Result |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 107 pass |
| `bun test test/permission/auto.test.ts` | packages/opencode | 22 pass |
| `bun typecheck` | packages/opencode | precheck clean; unrelated dirty `prompt.test.ts` errors pre-exist outside GOAL |
| precheck-red2.mjs | temp | all planned reds green |

### Original Feedback-Loop Result

precheck-red2.mjs: Clear/Set/Out/ri/pwsh-Command/env rm|git → cautious; Remove-Item -Recurse parity via tests; bare env general.

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| classifyTokens / unwrap / RE_D mirror | extended primary |
| env always-ask | replaced by pierce |
| PS single-token -Command | replaced by join-all |
| .env precheck deny | not added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 92 | non-blank +/- in precheck.ts + precheck.test.ts |
| Qualifying Chinese comment lines `C` | 15 | write set, ri/RE_D, PS join, env pierce, test intent |
| Ratio `C / E` | 0.163 |  |
| Required minimum `C` | 14 | ceil(92*0.15) |

### Remaining Unverified Items

- Unrelated package typecheck noise in dirty `prompt.test.ts` (not in GOAL paths).
- Complex `env` forms beyond KEY=val / -i / -u skip remain residual.

## 24. Implementation Audit Record

| Round | Plan revision | Full scope? | Blocking | Non-blocking | Result | Ref |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings. | N-01 env mv not explicit; N-02 ri non-protected recurse not re-listed; N-03 complex env residual | APPROVE | ses_065008372ffe5TKzLdCRQ1oL0V |

### Implementation audit verdict (verbatim)

```text
No blocking findings.
```

```text
APPROVE
```

Audited: plan R2 + precheck.ts / precheck.test.ts. Independent: precheck 107 pass, auto 22 pass.

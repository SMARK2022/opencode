# Canonical Implementation Plan: Prompt Voice Status Unification and Retry Details

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: implementation
>
> Requirement source: User follow-up requirements on 2026-07-20
>
> Implementation allowed: verified; commit allowed for this GOAL
>
> Last updated: 2026-07-20

This file is the sole implementation specification for this follow-up task.
The previously verified `prompt-extension-bar-single-line.md` implementation is
the current baseline, not implementation authorization for this plan.

## 1. Verbatim Requirement

> 当前需要你再次检查一下,我发现当前你显示的内容很奇怪。它的错误信息,譬如说 detail,detail一般来说加个括号最好,同时 detail的颜色也没有跟错误一样变红。与此同时整个 detail,理论上来说有点奇怪,因为有的时候它的整体的错误信息其实是很短的,所以它并不应该两端对齐,而都应该左对齐,当前是直接两端对齐。请你检查这些问题。如果有任何问题,你可以 grill me。

> 与此同时还有几点,当前我看你对音频转录进行了修改,也就是把transcripting等等东西都进行了修改,但是与此同时有很多面板里面都没有进行修改,比如对话框,比如ask question的时候,question的那个面板也没有修改。因此请你完整检查检查,把逻辑和我们的prompt的区域进行统一,因此你需要构建相应的方案。

The user selected the explicit scope that the main Prompt, DialogPrompt, and
QuestionPrompt use the same compact voice wording while preserving each panel's
surrounding submit/select/escape controls. This plan is inspection/design only;
it does not authorize production or test implementation.

## 2. Explicit Non-Goals

- Do not change recorder, transcriber, abort, cancellation, timeout, stale-textarea, or insertion semantics.
- Do not change `VoiceInputStatus` variants, status event payloads, Session status classification, or shortcut bindings.
- Do not change the existing shared default formatter profile; it remains available for compatibility and direct formatter tests.
- Do not create a new voice lifecycle, footer component, setting, feature flag, dependency, schema, or alternate success path.
- Do not redesign surrounding DialogPrompt or QuestionPrompt controls; only their voice status presentation becomes compact.
- Do not change `DialogAlert` or the raw retry message path.
- Do not modify the already verified R5 implementation unless a plan-approved follow-up seam requires it.
- Do not overwrite the unrelated dirty changes currently present in `prompt-submit-transport.test.tsx`.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Prompt, Session, Status, Run state, and Goal vocabulary used by this plan. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence ownership, one primary path, behavior-sensitive tests, and the 15 percent Chinese comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this plan's required sections and audit transitions. |
| `packages/opencode/AGENTS.md` | Preserves package module shape and repository test/typecheck conventions. |
| `packages/opencode/test/AGENTS.md` | Requires fixture cleanup and real lifecycle synchronization in tests. |
| `docs/adr/README.md` | No new ADR is justified: this is a scoped presentation change, not a load-bearing architectural decision. |
| `docs/plans/prompt-extension-bar-single-line.md` | Existing verified R5 baseline for the one-row Prompt footer and main-Prompt compact profile. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts:217-231` | Shared formatter has default long text and an existing `compact` option. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:445-452` | Main Prompt explicitly opts into compact voice text. | observed |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx:33-44,153-179` | DialogPrompt owns the same controller/clock but calls the formatter without compact mode. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx:39-50,575-590` | QuestionPrompt owns the same controller/clock but calls the formatter without compact mode. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1959-2008` | Retry summary, details token, flex growth, color, and mouse ownership. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:2073` | Existing shrink-only text pattern: `minWidth={0} flexShrink={1}` without `flexBasis={0}`. | observed |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts:111-140` | Existing default and main-Prompt compact formatter contracts; comment still says compact is main-Prompt only. | observed |
| `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | Existing real DialogPrompt provider/test seam; currently no voice assertion. | observed |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | Existing real Prompt renderer, SDK status, final-frame, and mouse-dialog seam. | observed |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts` | Session integration smoke only; does not cover QuestionPrompt voice wording. | observed |
| Temporary real Prompt repro, deleted after run | User-visible red signal for short retry alignment. | observed |
| `git` baseline commit `c50779e07a` | Confirms the prior R5 implementation is committed and is not this plan's implementation authorization. | observed |

## 5. Current Behavior

The voice lifecycle is already shared:

```text
Alt+V/f8 binding
→ PromptVoiceInput.createVoiceInputController
→ VoiceInputStatus producer
→ consumer-local createRefreshClock
→ PromptVoiceInput.voiceInputStatusText
→ panel-local footer
```

The presentation diverges at the consumer call sites:

```text
main Prompt → voiceInputStatusText(..., { compact: true })
DialogPrompt → voiceInputStatusText(...)
QuestionPrompt → voiceInputStatusText(...)
```

The retry divergence is inside the existing Prompt owner:

```text
SessionStatus.Info.retry.message
→ display-only normalized summary
→ growable error text (flexBasis=0 + flexGrow=1)
→ muted unparenthesized details token
→ fixed retry metadata / interrupt
```

The temporary real-frame repro produced:

```text
Expected: "Short error (details)"
Received: "... Short error                                         details retry in 9s · #1 esc interrupt ..."
```

The source currently renders the details token as `details` with
`fg={theme.textMuted}`, while the error summary uses `theme.error`. The summary
text also has `flexGrow={1}`, which expands a short error and pushes the details
token toward the far edge of the available row.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `starting`, `recording`, `stopping`, `transcribing` | Existing voice controller status callbacks | Status is a finite `VoiceInputStatus` union. | Controller → each consumer signal → shared formatter. | `PromptVoiceInput` formatter for wording; each consumer for opt-in profile. | observed / contracted |
| Recording elapsed time | Existing consumer `createRefreshClock` | Consumer clock refreshes while recording. | Voice status → `now()` → formatter. | Existing consumer lifecycle. | observed |
| Short retry message | Session status producer | Retry status carries a message string. | Session status → Prompt retry branch → footer. | Prompt extension-bar layout. | observed / reachable |
| Long retry message | Provider/session transport | Message remains available for detail dialog. | Same retry branch; summary can shrink. | Prompt display owner; DialogAlert remains detail owner. | observed / reachable |
| Mouse click on summary/details | OpenTUI rendered text | Visible text receives mouse event in current seam. | Footer text → existing `handleMessageClick` → DialogAlert. | Prompt retry branch. | observed |

No speculative producer or hidden panel is included.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Main Prompt, DialogPrompt, and QuestionPrompt use the same compact voice labels for every non-idle voice status. | User follow-up plus shared formatter/call-site evidence. | Formatter compact assertions exist; **hard consumer call-site regressions required** for DialogPrompt and QuestionPrompt (see §16/§18). |
| INV-02 | Default formatter wording remains available and unchanged for compatibility. | Existing default formatter assertions and non-goal. | `prompt-voice-input.test.ts`. |
| INV-03 | Retry details display as red `(details)` and remain in the same left-starting group as a short error. | User symptom and temporary real-frame red signal. | New real Prompt final-frame assertion. |
| INV-04 | Long retry summaries may shrink/truncate, but `(details)`, retry metadata, interrupt, and active duration remain observable in one row. | Existing R5 layout invariant and user requirement. | Existing long retry frame plus new short-layout assertion. |
| INV-05 | Clicking summary or `(details)` opens the existing dialog with the exact raw retry message. | Existing R5 interaction path. | Existing real mouse/DialogAlert test. |
| INV-06 | Voice controller, timer, abort, shortcut, and text insertion behavior remain unchanged. | Existing controller lifecycle tests and non-goals. | Existing voice lifecycle suites. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | DialogPrompt and QuestionPrompt omit the already-supported compact presentation option. | Three consumer call sites plus shared formatter interface. | Source calls at `dialog-prompt.tsx:166` and `question.tsx:582` versus main Prompt compact call. |
| INV-03 | Prompt retry branch assigns muted, unparenthesized text to the details affordance and allows the summary text to grow. | Existing Prompt retry layout. | Source at `prompt/index.tsx:1996-2003`; temporary frame shows separated short error/details. |
| INV-04 | Short/long summary behavior is represented by the same growable text child rather than a left-starting content-based shrinkable summary next to a fixed details token. | Existing Prompt flex children. | `flexGrow={1}` / `flexBasis={0}` on the error text and red repro frame. |

Red-capable feedback loop already run:

```text
bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx --test-name-pattern "temporary retry details alignment repro" --timeout 30000
```

Observed red output: expected `Short error (details)`, received a line with
`Short error` and `details` separated by a large blank region. The temporary
test was removed after the run and is not implementation authorization.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Compact voice wording | `PromptVoiceInput.voiceInputStatusText` | One formatter can expose default and compact presentation profiles. | All three consumers already call this formatter. | Controllers produce lifecycle state, not user-facing wording. |
| Compact profile selection | Prompt/DialogPrompt/QuestionPrompt call sites | Each consumer explicitly chooses the same compact profile. | The user requested all three panel presentations; consumer owns display context. | Global default would silently alter future consumers. |
| Retry details label/color/alignment | Prompt retry footer | Footer owns visual grouping and existing click handler. | It owns the first divergence and fixed-token priority. | DialogAlert owns detail content, not footer display geometry. |
| Raw retry detail | Existing `DialogAlert.show` call | Receives the original message unchanged. | Existing contract already satisfies raw-detail preservation. | No DialogAlert change is justified. |

## 10. Single Approved Primary-Path Design

```text
VoiceInputStatus
→ shared voiceInputStatusText(..., { compact: true }) at all three consumers
→ panel-local footer with existing controls/lifecycle
```

```text
Retry message
→ existing display-only normalized summary
→ left-starting content-based shrinkable summary + red fixed `(details)` token
→ existing mouse handler
→ existing DialogAlert with raw message
```

The route repairs the first divergence: it changes only the presentation profile
selection where the shared formatter is already the owner, and only the Prompt
footer flex/color/text tokens where the layout currently diverges. It does not
add a second formatter, controller, footer, or failure path.

For short errors, the inner summary group remains left-starting and the summary
text does not grow into unused space; it may shrink when the row is constrained.
For long errors, the same group yields summary width before fixed details and
state/action tokens. This is one flex path, not a short-message branch.

**Retry flex contract (explicit):** the error summary text is content-based and
shrinkable, matching the existing file-label pattern at
`prompt/index.tsx:2073` (`minWidth={0} flexShrink={1}`, no `flexGrow`, no
`flexBasis={0}`). Implementation must not merely set `flexGrow={0}` while leaving
`flexBasis={0}`, which would collapse short content to zero width under Yoga.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Shared formatter default profile | Current compatibility presentation. | existing compatibility | yes | none for the three target consumers | preserve |
| Shared compact formatter profile | Current main Prompt path, proposed for all three consumers. | primary-contract branch | yes | all voice wording | preserve and unify |
| Existing DialogAlert raw detail | Current detail surface. | pass-through | yes | detail content only | preserve |
| Width-specific alternate footer | Not proposed. | forbidden fallback | no | none | reject |
| New voice status component/lifecycle | Not proposed. | forbidden duplicate abstraction | no | none | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Per-consumer default/compact wording split | Main Prompt width pressure was handled, Dialog/Question panels were left on long wording. | All three consumers have the explicitly requested uniform compact profile. | Collapse call-site divergence by adding compact option to DialogPrompt and QuestionPrompt. |
| Growable short error summary | It protected long-message width but created a large blank gap for short messages. | Summary is content-based shrinkable without growth; fixed details remains adjacent. | Prompt retry inner text flex configuration. |
| Muted unparenthesized `details` label | Existing label was a low-emphasis affordance. | User explicitly requests a red, parenthesized error affordance. | Prompt retry details text. |
| Stale comments/tests claiming compact is main-Prompt only | R5 scoped compact to main Prompt. | User now requires three-panel compact; comments/tests must match. | `prompt-voice-input.ts` and `prompt-voice-input.test.ts` narrative comments. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 unified compact voice labels | Shared formatter call sites | `dialog-prompt.tsx`, `question.tsx`, retain main Prompt compact call | **Hard fail-capable consumer contract tests** for DialogPrompt and QuestionPrompt plus existing formatter compact assertions. |
| INV-02 default wording compatibility | Shared formatter default branch | No default string change | Existing `prompt-voice-input.test.ts` default assertions. |
| INV-03 red `(details)` and short left alignment | Prompt retry footer | `component/prompt/index.tsx` details token and content-based shrinkable summary | Real Prompt short retry frame and span color assertion. |
| INV-04 long retry one-row priority | Existing Prompt retry flex row | Same Prompt owner, no new branch | Existing long retry frame and five-state loop. |
| INV-05 raw detail click | Existing handler/DialogAlert | No DialogAlert change | Existing real mouse/dialog test. |
| INV-06 lifecycle preservation | Existing controller/clock consumers | No lifecycle code changes | Existing voice lifecycle and controller suites. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Explicit compact option at DialogPrompt/QuestionPrompt | INV-01 | User explicitly requests all panels match Prompt; current call sites omit option. | Existing call sites currently select the long profile. |
| Hard DialogPrompt consumer compact assertion | INV-01 | Formatter-only tests cannot prove consumer selection; Dialog currently has no voice assertion. | Without it, Dialog omission remains green. |
| Hard QuestionPrompt consumer compact assertion | INV-01 | Question is a third distinct call site; session-integration does not cover it. | Without it, Question omission remains green. |
| Parenthesized red details token | INV-03 | User-visible red/parentheses requirement and current muted plain token. | Existing token is visibly muted and lacks grouping semantics. |
| Content-based shrinkable summary text | INV-03/04 | Temporary real frame shows short-error blank gap; long-error one-row invariant remains. | Current `flexGrow={1}` / `flexBasis={0}` makes short content expand or risk collapse if only grow is removed. |
| Durable real-frame assertions for retry | INV-03/04 | Existing OpenTUI Prompt seam is the only behavior-sensitive geometry/color seam. | Formatter-only tests cannot prove flex placement or color. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | modify | Red `(details)` token; content-based shrinkable summary (`minWidth={0} flexShrink={1}`, no grow, no basis-0); preserve long-error shrink/click. | approximately +4 / -4 production lines |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | modify | Update comments so compact is the three-consumer presentation profile; no default-string change. | approximately +2 / -2 |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx` | modify | Pass `{ compact: true }` to shared formatter only. | approximately +1 / -1 |
| `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx` | modify | Pass `{ compact: true }` to shared formatter only. | approximately +1 / -1 |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | modify | Keep default assertions; rewrite compact comments to three-consumer contract; add fail-capable assertions that both DialogPrompt and QuestionPrompt call sites pass `{ compact: true }` (source-contract seam if full mount is not required). | approximately +40 / -4 |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | modify additive hunk only | Add short retry final-frame/color assertion without overwriting existing dirty user tests. | approximately +35 / -0 |
| `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | modify | **Required:** fail-capable compact consumer verification for DialogPrompt (real frame preferred; call-site contract minimum). | approximately +25 / -0 |

No file addition, deletion, generated artifact, migration, dependency, or
configuration change is planned.

**INV-01 verification hard contract (closes R1 B-01):**

1. A test suite must fail if `dialog-prompt.tsx` omits `{ compact: true }` at its
   `voiceInputStatusText` call.
2. A test suite must fail if `question.tsx` omits `{ compact: true }` at its
   `voiceInputStatusText` call.
3. Preferred seam: real rendered compact labels when the existing harness can
   drive status without duplicating lifecycle. Acceptable alternate seam: a
   package-local source-contract assertion over the exact call-site source of
   those two production files, because formatter unit tests alone cannot prove
   consumer selection and full Question mount cost is high relative to a pure
   presentation flag.
4. Optional wording such as “if the harness can” is forbidden for INV-01.
5. `session-integration.test.ts` is not INV-01 coverage and must not be claimed
   as Question voice verification unless it asserts Question compact selection.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Real Prompt short retry frame expects `Short error (details)` as one left-starting group with matching error foreground. | Current output separates `Short error` and `details`, uses no parentheses, and details is muted. | Change details text/color and make summary content-based shrinkable (no grow, no basis-0 collapse). | User-reported retry affordance appearance. |
| 2 | Fail-capable consumer contract: DialogPrompt and QuestionPrompt each select compact; omitting either fails. Default formatter assertions remain unchanged. | DialogPrompt and QuestionPrompt omit compact; no suite fails on that omission today. | Pass `{ compact: true }` at both call sites and lock both with hard tests. | All three panel voice status wording. |
| 3 | Long retry message remains one row and details remains clickable after short-group alignment change. | An incorrect flex change could restore wrapping, displace fixed tokens, or collapse summary. | Keep parent shrink/fixed-token structure; use content-based shrinkable summary only. | Existing R5 long-error and dialog interaction coverage. |
| 4 | Voice lifecycle regression remains green across recording/transcribing/cancellation and stale textarea paths. | Broad consumer changes can accidentally alter lifecycle ownership. | No controller/clock/abort changes; existing suites remain green. | Existing shared voice lifecycle behavior. |

Tests must assert rendered text/color/row behavior, consumer compact selection,
and existing dialog output — not private helpers, JSX structure, or event call
counts. Formatter-only tests may lock default/compact string tables but cannot
satisfy INV-01 alone.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 110 | Estimate: approximately 15 production/call-site lines plus 95 behavior-test lines (including hard Dialog/Question consumer contracts); excludes imports, formatting, generated files, and pure movement. |
| Required Chinese explanatory comments `C` | at least 17 | `ceil(110 × 0.15) = 17`; implementation must recalculate actual `E` and raise `C` if needed. |

Qualifying comments should explain why the shared compact profile remains
explicit at every consumer, why default wording is preserved, why short
summaries must be content-based shrinkable rather than growable or basis-0,
why details is fixed/error-colored, why Dialog/Question consumer tests are
fail-capable, and why the real frame test checks both color and terminal-cell
placement.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx --timeout 30000` | `packages/opencode` | Real Prompt retry short/long frame, details color, left grouping, click/dialog behavior, and existing dirty-test preservation. |
| `bun test test/cli/tui/prompt-voice-input.test.ts --timeout 30000` | `packages/opencode` | Default/compact formatter wording, timer/controller lifecycle, and **hard DialogPrompt + QuestionPrompt compact call-site contracts**. |
| `bun test test/cli/cmd/tui/dialog-prompt.test.tsx --timeout 30000` | `packages/opencode` | DialogPrompt provider/render seam and **required** compact consumer verification. |
| `bun typecheck` | `packages/opencode` | Shared formatter options and three consumer call sites typecheck. |
| Temporary red loop before implementation | `packages/opencode` | Current defect reproduced; temporary test must be removed before plan-only completion. |

`session-integration.test.ts` is intentionally **not** listed as INV-01
Question coverage. It may still be run as unrelated smoke during a later
implementation phase, but it does not prove compact selection.

No production build or implementation verification is required in this
plan-only phase. Those commands belong to a later approved implementation phase.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing formatter, consumers, and test seams are sufficient. |
| Files modified | 7 | One Prompt owner, shared formatter/call sites, and hard consumer/test seams. |
| Files deleted | 0 | No obsolete module exists. |
| Production lines | approximately 12 touched | Two call-site flags plus retry token/layout correction and comment updates. |
| Test lines | approximately 100 touched | Compact consumer hard contracts and real-frame behavior coverage. |
| Generated lines | 0 | No generated or schema change. |

The budget is an audit signal, not permission to omit any confirmed consumer or
behavioral state.

## 20. Real Risks and Open Decisions

### Confirmed Risks

- DialogPrompt and QuestionPrompt have different surrounding footer controls; compact voice text must be unified without flattening those panel-specific controls.
- Removing summary growth can affect long-message truncation; the real renderer must verify both short and long retry states.
- Leaving `flexBasis={0}` after removing `flexGrow` can collapse short summaries; implementation must use the content-based shrinkable pattern already present in the file.
- The current `prompt-submit-transport.test.tsx` contains unrelated dirty user tests; implementation must use additive, non-overlapping hunks only.
- Formatter-only tests are insufficient for INV-01; Dialog and Question consumer contracts must be hard-failing.

### Open Decisions Requiring the User

None. The user selected exact compact wording across all three panels and approved preserving each panel's surrounding controls.

### Rejected Speculation

- No new voice component is needed; the existing formatter/controller seam already reaches all consumers.
- No DialogAlert redesign is needed; raw detail behavior is already correct.
- No width breakpoint or alternate footer is needed; the same Prompt row can keep fixed tokens and shrink variable summary content.
- No change to voice shortcut, recorder process, transcriber command, or textarea lifecycle is justified by a presentation-only request.
- Changing the formatter default to compact is not required and would silently alter future consumers.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the two verbatim follow-up requirements.
- Reconstruct all three voice consumer paths and the Prompt retry path from repository evidence.
- Verify explicit compact profile selection for main Prompt, DialogPrompt, and QuestionPrompt.
- Verify that DialogPrompt and QuestionPrompt compact selection each have a hard fail-capable test commitment (R1 B-01).
- Verify retry details parentheses/color/left grouping, content-based shrinkable summary, and long-message one-row preservation.
- Check that no voice lifecycle or DialogAlert ownership is changed.
- Check the real red-capable feedback signal and additive test seam against dirty worktree changes.
- Check primary-path ownership, fallback absence, forward/reverse traceability, and the 15 percent comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 4 | BLOCK | `ses_0801fe213ffeFAweBloEHk1G7N` |
| 2 | R2 | yes | No blocking findings. | 4 | APPROVE | `ses_08015d47cffe8fh18WcY00VNfC` |

### Round 1 Independent Plan Verdict (Verbatim)

## Blocking findings

### B-01 INV-01 对 DialogPrompt / QuestionPrompt 的 compact 选择缺少可失败验证

- Violated invariant: INV-01 — Main Prompt、DialogPrompt、QuestionPrompt 对每个 non-idle voice status 使用同一套 compact 文案；确认需求必须有行为敏感验证，或明确写出为何不可自动验证。
- Evidence class: contracted / observed
- Producer and execution path:
  ```text
  Alt+V/f8
  → createVoiceInputController
  → VoiceInputStatus
  → voiceInputStatusText(status, shortcut, now, options?)
  → panel footer
  ```
  当前只有主 Prompt 传入 `{ compact: true }`；DialogPrompt / QuestionPrompt 走默认长文案。
- Source evidence:
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:448-451`（compact）
  - `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx:166`（无 compact）
  - `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx:582`（无 compact）
  - `packages/opencode/test/cli/tui/prompt-voice-input.test.ts:115-134`（只锁 formatter 双 profile，不锁 consumer 选择）
  - `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx:50-71`（仅 description factory，无 voice）
  - `packages/opencode/test/cli/cmd/tui/session-integration.test.ts:1-22`（静态读 session/prompt 源码，不覆盖 `question.tsx` voice 文案）
- Canonical-plan evidence:
  - §7 INV-01
  - §13 称有 “consumer rendering/call-site regression”
  - §14 写明 “Formatter-only tests cannot prove panel call-site selection”
  - §15 `dialog-prompt.test.tsx` 仅 “if existing provider harness can drive it”
  - §15 / §16 未承诺 QuestionPrompt 的可失败 consumer/call-site 测试
  - §18 把 `session-integration.test.ts` 当作 Question 回归，与该文件实际覆盖不符
- Responsibility owner: 计划的 verification / TDD 映射（生产 owner 仍是三个 call site + 共享 formatter）
- Concrete production, test, or contract consequence:
  实现时若只改 Dialog、漏改 Question（或之后某次回归删掉某一处 `{ compact: true }`），计划列出的 suite 仍可全绿：formatter 双 profile 仍在、主 Prompt 已有 compact 帧断言、Dialog 测试可被 “if” 跳过、session-integration 不读 question voice。用户明确要求的三面板统一会以未覆盖回归的形式漏掉。
- Why this is not speculative:
  仓库里只有上述三个 formatter 调用点；用户范围与 INV-01 明确覆盖全部三个；计划自己承认 formatter 不能证明 call-site 选择，却未给出 Dialog/Question 的硬性、可失败验证，也未写 “不可自动验证” 的理由。
- Minimal correction direction:
  在 R 修订中把 INV-01 的验证改成硬承诺：DialogPrompt 与 QuestionPrompt 任一处省略 compact 时测试必须失败。可用真实渲染帧（compact 文案 / 非 long 文案），或在完整 mount 成本过高时用明确的 call-site/source 契约断言，并写清为何渲染级不可行。删除 “if harness can” 这类可选措辞；不要把 `session-integration.test.ts` 当作 Question voice 覆盖，除非真的断言 `question.tsx` 的 compact 选择。

## Non-blocking findings

1. **Retry flex 属性写得过窄**
2. **§18 的 Question 验证命令名不实**
3. **实现时必须更新过期注释/测试叙述**
4. **`E` 估计内部不一致**

## Release verdict

```text
Revision audited: R1
Full scope: yes
Blocking findings: B-01
Release decision: BLOCK
Implementation allowed: no
```

R2 substantive changes that invalidate R1 approval (already blocked):

- Hard INV-01 consumer fail-capable tests for DialogPrompt and QuestionPrompt.
- Explicit content-based shrinkable flex contract for retry summary.
- Removal of session-integration as false Question voice coverage.
- Updated comment/test narrative obligations and E/C estimate.

### Round 2 Independent Plan Verdict (Verbatim)

## Blocking findings

```text
No blocking findings.
```

## Non-blocking findings

1. **INV-01 验证缝仍允许 source-contract 作为最低门槛**
   R2 已把 Dialog/Question 的 compact 选择改成硬失败契约（§15 hard contract 1–5、§16 slice 2），闭合了 R1 B-01。真实帧仍是 preferred，source-contract 是 acceptable alternate。实现阶段若只读源码断言、不挂 Dialog 实帧，行为覆盖弱于真实 footer，但计划本身已硬性承诺“省略 compact 必红”，不构成计划阻塞。

2. **§10 只约束 summary text 的 content-based shrink，不改 clickable 父 box 的 `flexGrow`**
   短错误修复后，用户可见的 `Short error (details)` 会左起成组；`retry in …` 仍可能因父级 grow 与右侧 interrupt 拉开距离。这与 R5 的 fixed-token 优先级一致，也匹配已记录的 red 信号（错误与 details 分离）。若实现后用户仍觉得“整段两端对齐”，需要后续单独收紧 outer/group flex，不属于本计划未覆盖的确认需求。

3. **现有 details 点击测试仍以 `"details"` 子串定位**
   改为 `(details)` 后，`includes("details")` / `indexOf("details")` 仍能命中，INV-05 路径可继续工作。实现时最好同步把 token 期望改成 `(details)`，避免语义漂移；非阻塞。

4. **`E`/`C` 与 diff budget 内部仍有大约数漂移**
   §17 `E≈110`、§19 production≈12 / test≈100。算术漂移不降低 15% 承诺，实现时按实际 `E` 重算即可。

## Rejected speculation

- 不要求把 formatter 默认改成 compact：会静默改变未来消费者；三处 call site 显式 opt-in 已覆盖用户范围。
- 不要求新 voice 组件 / footer / 生命周期：三处消费者已走同一 `createVoiceInputController` → `voiceInputStatusText`。
- 不要求改 `DialogAlert`、retry 消息原文、SessionStatus：详情所有权与 raw message 路径已正确。
- 不要求按宽度分支第二套 footer：属于 forbidden fallback。
- 不要求为 Question 做完整 Session 挂载：source-contract 在完整 mount 成本过高时被 R1 纠正方向明确允许，且仍对 call-site 省略 fail-capable。
- 不把 outer `justifyContent="space-between"` 单独当作本轮根因：red 信号与源码第一分叉点是 summary text 的 `flexGrow`/`flexBasis={0}` 与 muted `details` 文案。

## Requirement and traceability coverage

| 用户确认点 | 不变式 | 生产路径 | 计划变更 | 行为敏感验证 |
| --- | --- | --- | --- | --- |
| details 加括号 | INV-03 | Prompt retry footer token | `prompt/index.tsx` → `(details)` | 真实 short retry 帧 |
| details 与错误同红 | INV-03 | 同 token `theme.error` | 同上 | `captureSpans` 前景色与 summary 对齐 |
| 短错误左对齐、非两端拉开 | INV-03/04 | summary content-based shrinkable | 同上 | short 帧中 `Short error (details)` 左起成组 |
| 长错误仍一行、固定 token 可见 | INV-04 | 既有 outer shrink + fixed details/retry/interrupt | 不新增分支 | 既有五态一行帧 + long/click 覆盖 |
| 点击打开原文 | INV-05 | 既有 `handleMessageClick` → `DialogAlert` | 不改 DialogAlert | 既有 mouse/dialog 测试 |
| 主 Prompt / Dialog / Question 统一 compact 文案 | INV-01 | 三 call site 均 compact | `dialog-prompt.tsx`、`question.tsx`，保留主 Prompt | formatter 双 profile + 硬 Dialog/Question consumer 契约 |
| 周围 submit/select/escape 控件保留 | 用户 scope / non-goal | 各 panel-local footer | 只改 voice status 展示 profile | 生命周期与现有 controls 非目标保持 |
| 默认 formatter 兼容 | INV-02 | default 分支不变 | 不改默认字符串 | 既有 default 断言 |
| 录音/转写生命周期不变 | INV-06 | controller/clock/abort 不动 | non-goal | 既有 voice lifecycle suites |

## Primary-path and fallback verdict

```text
VoiceInputStatus
→ voiceInputStatusText(..., { compact: true }) @ Prompt | DialogPrompt | QuestionPrompt
→ panel-local footer（既有 controls / lifecycle）

Retry message
→ display-only normalized summary
→ content-based shrinkable summary + fixed red "(details)"
→ existing handleMessageClick
→ existing DialogAlert(raw message)
```

- 每个责任一条权威语义路径。
- compact 是同一 formatter 内的 presentation branch，不是第二生命周期。
- 无 try-A-then-B、catch-and-default、宽度分支第二 footer、默认改 compact 的配置开关。
- R1 B-01 在 R2 的闭合方式：Dialog/Question 任一省略 `{ compact: true }` 时测试必须失败。

## Code quality and Chinese-comment verdict

计划模式：可行性与承诺检查通过。`E≈110` → `C ≥ 17`；实现按实际 `E` 重算。

## Release verdict

```text
Revision audited: R2
Full scope: yes
Blocking findings: none
Release decision: APPROVE
Implementation allowed: yes (after orchestrator records this clean verdict on R2)
```

本结论仅适用于 `docs/plans/prompt-voice-status-unification-and-retry-details.md` 的 **R2** 文本。任何实质修订会使本批准失效，并需重新全范围 plan audit。

Any substantive revision invalidates this R2 approval. The current Session GOAL
target is approved-plan-only, so no production or test implementation is
executed in this turn even though `Implementation allowed: yes`.

## 23. Implementation Evidence

R2 implementation completed against the approved route. Frozen for independent
implementation audit.

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Red `(details)`; content-based shrinkable summary |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | Compact comment documents three-consumer profile |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx` | `{ compact: true }` |
| `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx` | `{ compact: true }` |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | Short retry left-group + color; long retry token |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | Dialog/Question compact call-site contracts |
| `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | Dialog compact call-site contract |
| Diff summary | 7 files, +84 / -15 |

### Red-Green Test Evidence

| Slice | Red | Green |
| --- | --- | --- |
| Short retry left-group + color | Expected `Short error (details)`, received empty/`details` separation | Pass after flex/token fix |
| Dialog/Question compact selection | Dialog source lacked `compact: true` | Pass after both call sites updated |
| Long retry + click | One assertion adjusted for middle truncation; click path green | Pass |

### Verification Commands and Results

All from `packages/opencode`:

| Command | Result |
| --- | --- |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx --timeout 30000` | 14 pass, 0 fail |
| `bun test test/cli/tui/prompt-voice-input.test.ts --timeout 30000` | 23 pass, 1 skip, 0 fail |
| `bun test test/cli/cmd/tui/dialog-prompt.test.tsx --timeout 30000` | 2 pass, 0 fail |
| `bun typecheck` | pass (`tsgo --noEmit`) |

### Original Feedback-Loop Result

Original short-error red: `Short error` separated from `details` by a large blank
region. After fix: `Short error (details)` continuous left-group, matching error
foreground, one-row long retry and click still green.

### Actual Secondary and Replacement Path Inventory

| Path | Verdict |
| --- | --- |
| Primary compact presentation at three consumers | Implemented |
| Default formatter compatibility profile | Preserved |
| DialogAlert raw message | Unchanged |
| Fallback/alternate footer | None |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 61 | `git diff -w --unified=0` new-side non-blank non-import non-comment code |
| Qualifying Chinese comment lines `C` | 16 | Adjacent rationale for shrinkable flex, red details, compact three-consumer contracts |
| Ratio `C / E` | 26.2% | `16 / 61` |
| Required minimum `C` | 10 | `ceil(61 × 0.15) = 10` |

Excluded: plan document, blank lines, import-only lines, pure formatting.

### Remaining Unverified Items

- Independent full-scope implementation audit pending.
- Full cross-target production binary packaging is outside this presentation change surface; package typecheck and focused behavioral suites are the required verification for this revision.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings. | 4 | APPROVE | `ses_07fecd41fffeHrcORBenGycTyP` |

### Round 1 Independent Implementation Verdict (Verbatim)

## Blocking findings

```text
No blocking findings.
```

## Non-blocking findings

1. **主 Prompt 仍有过期 compact 注释**（post-audit fixed narratively）
2. **compact formatter 测试标题仍写 main Prompt only**（post-audit retitled）
3. **长 retry 前缀断言略放宽**
4. **INV-01 Dialog/Question 验证停在 source-contract**

## Release verdict

```text
Audit mode: implementation
Plan revision audited: R2
Approved revision match: yes
Full original scope: yes
Diff audited: 7 files, +84 / -15 (scoped list only)
Blocking findings: none
Release decision: APPROVE
```

本结论仅适用于 **R2 计划** 与上述实现 diff。

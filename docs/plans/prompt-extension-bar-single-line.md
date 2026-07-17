# Canonical Implementation Plan: Prompt Extension Bar Single-Line Information Density

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: implementation
>
> Requirement source: User-provided Session GOAL and screenshots on 2026-07-17
>
> Implementation allowed: yes
>
> Last updated: 2026-07-17

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 下面需要你详细完整为我检查检查当前prompt区域下方的这个整体的扩展栏,它有的时候会被某些元素挤压到超过一行,所以请你检查检查,因为有的时候它会存在两种情况。第一种是相应的用户打开文件的那个提示,也就是文件指示器,会过长。另外一种是相应的错误信息过长。因为理论上来说,错误指示器应该本身就是可以被点击,然后打开一个相应的对话框来显示相应的详情内容。所以理论上来说,这个指示器不应该显示全量内容显示得很长,因为这样会挤压全部内容。所以请你完整详细地为我检查检查,并且分析分析现在的情况,以及看看如何修改,更好能够达到一个相对甜点级,也就是显示的有效信息更多,然后那些指示性的内容,比如说click to open dialog,或者click to open details,这种信息更短,性价比更高,然后整体的风格保持一致。请你详细完整检查,然后不进行任何的修改实施,但是进行方案检查。

Subsequent requirement extension (verbatim):

> 与此同时,甚至还有在开始窗口的时候,进行相应的转录等等操作的时候,它的这个转录的提示器也相对来说会长那么一点,你也可以看看这个需不需要进行优化。

Subsequent surgical-scope clarification (verbatim):

> 手术刀级解决 prompt下方的显示区域过宽的问题,导致的双行问题。与此同时 recording状态下,整体宽度会因为左侧的录音键过长,所以可以适当考虑将转录提示再缩得更短一点点。与此同时,整体内容手术刀级别修改,尽量不要重大改动或者调整,保持整体自然且符合OpenCode的习惯方向。

The supplied screenshots establish two concrete visual failures:

1. A retry error plus expansion hint and retry metadata wraps below the Prompt.
2. `Transcribing voice...`, a long active-file indicator, and the right-side
   command hints compete for a 75-column home Prompt and wrap to a second row.

The current turn changes the target from inspection-only to
`verified-implementation-and-commit`, but still requires the approved-plan
workflow, full implementation audit, and a surgical diff. No implementation is
authorized until this R5 receives a fresh full-scope plan audit.

Current user GOAL authorization (verbatim):

> **目标终态**：verified-implementation-and-commit

> ### 阶段 3：按批准 Revision 实施

The earlier inspection-only sentence remains a scope constraint on the original
inspection turn. The current Session GOAL is the later explicit authorization
for implementation and commit, while preserving the surgical/no-major-redesign
behavioral constraints.

## 2. Explicit Non-Goals

- Do not implement this plan until its exact revision is independently approved
  and the user separately requests implementation.
- Do not change voice recording, stopping, cancellation, transcription,
  timeout, temporary-file cleanup, or insertion semantics.
- Do not change the default shared `voiceInputStatusText` presentation used by
  `DialogPrompt` and `QuestionPrompt`. A compact presentation mode is allowed
  only at the main Prompt seam because the new user requirement explicitly
  identifies that Prompt's recording/transcription width pressure.
- Do not change Session retry classification, retry delay, attempt numbering,
  provider parsing, `SessionStatus.Info`, or event payloads.
- Do not alter the full retry error stored or transported by Session state.
- Do not change IDE bridge discovery, editor selection injection, file-context
  submission, selection dismissal, or pending/sent color semantics.
- Do not change the web `packages/ui` retry card; the reported defect is in the
  terminal Prompt extension bar.
- Do not change the `Prompt.right` plugin slot inside the Prompt card metadata
  row. It is not the bottom extension bar shown in the screenshots.
- Do not add a setting, feature flag, dependency, alternate footer, or
  failure-triggered fallback layout.
- Do not refactor the generic `DialogAlert` without a reproduced dialog-specific
  defect; the observed error fits its existing detail surface.
- Do not modify unrelated dirty worktree files or the user's currently open
  `docs/plans/opencode-disk-write-hotspots.md` plan.
- Do not introduce a new footer component, width-specific alternate footer, or
  broad visual redesign; the approved scope is a local Prompt JSX/layout repair
  plus the smallest shared formatter option needed for main-Prompt compact text.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Session, Status, Message, Provider, Project, and the `cli/cmd/tui` responsibility vocabulary. |
| Root `AGENTS.md` | Requires package-local tests/typecheck, minimal focused changes, parallel investigation, and preservation of unrelated worktree changes. |
| `packages/opencode/AGENTS.md` | Requires package-local verification and existing TypeScript/module conventions. |
| `packages/opencode/test/AGENTS.md` | Requires behavior tests through real seams rather than duplicated implementation logic. |
| `.opencode/policy/first-principles-engineering.md` | Requires a proven first divergence, one primary path, no fallback, complete traceability, and the Chinese explanatory-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines required plan sections and approval transitions. |
| `docs/adr/README.md` | No accepted ADR governs this local Prompt layout; this is a focused component contract, not a new repository-wide architectural decision. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| User screenshot: long retry error | Shows the extension bar wrapping and splitting retry metadata despite the error being clickable. | observed |
| User screenshot: transcription plus long file | Shows the home Prompt extension bar wrapping while `Transcribing voice...`, the file indicator, and `agents`/`commands` coexist. | observed |
| Temporary real-`Prompt` OpenTUI harness, run with `bun test D:\Temp\opencode\prompt-footer-repro.test.tsx --timeout 30000` and then deleted | Mounted the production Prompt in a 160-column renderer inside a 75-column box, drove voice recording to `transcribing`, injected a real `session.status` event, and asserted one visual row. Expected `[1, 1]`; current result was `[2, 2]`. | observed |
| Current R5 temporary real-`Prompt` OpenTUI harness, run with `bun test D:\Temp\opencode\prompt-footer-repro.test.tsx --timeout 30000` | Re-ran the current source with a controlled recorder, active bridge file, and real global Status events. At 160 terminal columns with a 75-column Prompt, the current final frame measured `idle=1`, `busy=3`, `recording=3`, `transcribing=2`, `retry=2`; expected one-row state matrix is `[1, 1, 1, 1, 1]`. | observed |
| In-memory OpenTUI retry layout probe | Current unshrinkable retry string grew to four rows at 110 columns; a prioritized `wrapMode="none"`/flex layout remained one row at 60, 75, and 110 columns. | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Owns actual Prompt width measurement, editor-file display, voice/retry/status branching, details click behavior, and the bottom extension-bar layout. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/home.tsx` | Proves the home Prompt is capped at `maxWidth={75}` even when the terminal is much wider. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Proves Session mounts the same Prompt and can reduce its allocation with an in-layout sidebar; also owns retry-action dialogs, not footer rendering. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/layout.ts` | Establishes the 42-column Session sidebar and fixed horizontal chrome that can reduce Prompt allocation relative to terminal width. | observed |
| `packages/opencode/src/cli/cmd/tui/context/editor.ts` | Proves IDE/bridge active paths are unconstrained strings and produce the editor selection consumed by Prompt. | reachable |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | Defines shared voice statuses and current human-readable status text; the new requirement permits a main-Prompt-only compact presentation mode while retaining default consumer wording. | observed |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts` | Confirms transcription lifecycle and recorder behavior are separate from extension-bar layout. | observed |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx` | Proves the shared voice status text is also rendered in a medium dialog with a different footer. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx` | Proves the shared voice status text is also rendered in the question editor footer. | observed |
| `packages/opencode/src/session/status.ts` | Defines retry status as an unconstrained message plus attempt and next timestamp. | contracted/reachable |
| `packages/opencode/src/session/retry.ts` | Shows retry messages originate from provider/transport errors and can include long provider text or URLs. | reachable |
| `packages/opencode/src/session/message-v2.ts` | Shows Provider errors preserve string messages without a display-width bound before Session retry status. | reachable |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-alert.tsx` and `ui/dialog.tsx` | Establish the existing click target's detail surface and responsive dialog width. | observed |
| `packages/opencode/src/cli/cmd/tui/plugin/api.tsx` | Proves `Prompt.hint` is public plugin input, while `Prompt.right` is a separate card-internal row. | contracted |
| Search of repository Prompt API consumers | Found no in-repository `Prompt.hint` consumer requiring a multi-line extension-bar contract. | observed |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | Provides an existing real Prompt Provider stack and final-frame seam that can be extended without testing private helpers. | observed |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | Locks shared voice wording/lifecycle and the width-gated idle voice hint. | observed |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts` | Contains source-level Prompt smoke assertions but is not sufficient for the visual wrapping regression. | observed |
| `packages/opencode/test/cli/cmd/tui/session-layout.test.ts` | Demonstrates accepted use of OpenTUI's real renderer to verify terminal-cell layout rather than reimplement Yoga arithmetic. | observed |
| `packages/opencode/src/util/locale.ts` and `test/util/locale.test.ts` | Establish current code-unit-based middle truncation and its Unicode-surrogate guarantees. | observed |
| `node_modules/@opentui/core/renderables/TextBufferRenderable.d.ts` | Confirms native `wrapMode="none"` and `truncate` support. | contracted |
| `node_modules/@opentui/core/Renderable.d.ts` | Confirms `height`, `minWidth`, `maxWidth`, `flexShrink`, and `overflow` layout controls. | contracted |
| `packages/ui/src/components/session-retry.tsx` | Shows the web UI independently truncates retry messages and exposes full text through a tooltip; it is useful comparison evidence but out of TUI scope. | observed |

## 5. Current Behavior

### 5.1 Long IDE file plus voice state

```text
IDE/bridge active file path
  -> EditorContext.selection.filePath
  -> Prompt.editorFileLabel (basename or parent/index + optional selection)
  -> Prompt.editorFileLabelDisplay
       budgets with terminal dimensions().width, not measured promptWidth()
  -> home terminal may be 160 columns while Prompt is max 75 columns
  -> voice status occupies left extension-bar content
  -> oversized file + fixed command hints occupy right content
  -> default text wrapping grows the extension bar to two visual rows
```

`Prompt` already measures its final Yoga allocation in `syncPromptWidth` and
uses `promptWidth()` for token-flow and voice-hint decisions. The editor file is
the exception: it still uses terminal width. In the exact 160-terminal/75-Prompt
reproduction, the idle file label expanded to 48 characters; adding
`Transcribing voice...` produced two non-empty rows. When terminal and Prompt
were both 75 columns, the existing one-third calculation produced a 25-character
file label and the same voice state remained one row. This isolates the width
source mismatch.

### 5.2 Long retry error

```text
Provider/transport error
  -> MessageV2.APIError message
  -> SessionRetry.retryable
  -> SessionStatus { type: retry, message, attempt, next }
  -> SyncProvider session_status
  -> Prompt retry display
       message > 80: slice to 80 + "..."
       message > 120: mark clickable and append " (click to expand)"
       always append " [retrying in <duration> attempt #<n>]"
  -> entire combined text sits in flexShrink={0} boxes with default wrapping
  -> error and retry controls wrap to a second or later row
```

The `80` and `120` thresholds also create an interaction defect independent of
wrapping: messages of length 81 through 120 visibly end in `...`, but no expand
hint is rendered and `handleMessageClick` refuses to open the dialog. Messages
over 120 are clickable, but the long literal `(click to expand)` and bracketed
retry sentence consume scarce cells even though the dialog is already the
authoritative detail surface.

### 5.3 Other extension-bar states

- Voice `starting`, `recording`, `stopping`, and `transcribing` replace the left
  status region but leave the file/usage/shortcut right region present.
- Normal `busy` shows spinner, `esc interrupt`, optional duration, and the usual
  right region.
- `retry` deliberately hides the ordinary right region, but its own combined
  string still wraps.
- Idle/warp/workspace/plugin-hint states use the same root row and currently have
  no fixed one-line container contract.
- Token usage text is already `wrapMode="none"`; the surrounding dynamic labels
  are not consistently non-wrapping or shrinkable.

### 5.4 Main-Prompt voice wording

The shared formatter currently returns `Recording 00:03 · alt+v stop` and
`Transcribing voice...`. The main Prompt adds a red recording dot or spinner
outside that text, so the repeated phase wording consumes layout cells without
adding lifecycle information. The new requirement specifically authorizes a
compact display projection for this consumer. `DialogPrompt` and
`QuestionPrompt` need not change because they have separate footer geometry and
must retain the default stop guidance.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Home Prompt allocated 75 columns inside a wider terminal | `Home` route | `maxWidth={75}` is explicit | `Home -> Prompt -> syncPromptWidth` | Prompt extension-bar layout | observed |
| Session Prompt narrower than terminal because of sidebar/chrome | Session route | Sidebar is 42 columns when in layout | `Session -> Prompt -> syncPromptWidth` | Prompt extension-bar layout | reachable |
| Long ASCII IDE basename | VS Code/Claude/Zed bridge selection | `filePath` is a string; no basename length cap | `EditorContext -> Prompt` | Prompt file-indicator presentation | observed |
| CJK/emoji or wide-cell IDE basename | Public editor path string | Schema validates string shape, not terminal cell width | `EditorContext -> Prompt` | Prompt file-indicator presentation | reachable |
| Voice starting/recording/stopping/transcribing while file context exists | Prompt voice controller plus EditorContext | Voice state and file selection are independent | `voiceInputStatus + editorContext -> Prompt Switch/right region` | Prompt extension-bar composition | observed |
| Retry message of 81-120 characters | Provider/transport error | Retry schema has no display bound | `MessageV2 -> SessionRetry -> SessionStatus -> Prompt` | Prompt retry presentation | reachable |
| Retry message over 120 characters | Same | Same | Same | Prompt retry presentation | observed |
| Retry message containing newlines or repeated whitespace | Provider parser returns arbitrary `Schema.String` | No display normalization before status | Same | Prompt retry summary presentation | reachable |
| Retry countdown from seconds through longer formatted durations | `SessionStatus.next` and `formatDuration` | `next` is a non-negative timestamp | `Prompt.seconds -> formatDuration` | Prompt retry metadata presentation | reachable |
| Plugin-provided Prompt hint | TUI plugin API | Arbitrary JSX element; no multi-line promise found | `Plugin ui.Prompt -> Prompt.props.hint` | Prompt extension-bar clipping contract; plugin owns content | contracted |

Inputs such as malicious escape sequences, unbounded dialog scrolling, or a
plugin depending on multi-line Prompt hints were not observed and have no
task-specific contract. They cannot justify additional sanitizers, a generic
dialog refactor, or compatibility branches in this plan.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | The Prompt extension bar occupies exactly one visual row in idle, busy, retry, and all active voice states; dynamic content may truncate or clip but must not increase Prompt height. | User screenshots and real Prompt reproduction, including the full R5 state matrix. | None; new real-frame coverage required. |
| INV-02 | Variable-width content is budgeted against the measured Prompt allocation, not total terminal width. | Home 160/75 reproduction and existing `syncPromptWidth`. | Token/voice decisions partially cover `promptWidth`; editor file does not. |
| INV-03 | A long file indicator keeps useful identity (start/end, especially extension and optional selection suffix) while yielding space to current-state controls. | User request for information density; current middle truncation intent. | Existing Locale unit tests only; no final-frame test. |
| INV-04 | Every retry error exposes a short, stable `details` affordance; clicking the error/details region opens the original unmodified message, including for 81-120-character messages. | User requirement and current dialog behavior. | None. |
| INV-05 | Retry summary, details affordance, countdown/attempt, and `esc interrupt` remain distinct tokens; verbose prose cannot squeeze the actionable tokens out or wrap them. | Retry screenshot and OpenTUI prioritized-layout probe. | None. |
| INV-06 | Voice lifecycle and the default shared wording used by dialog/question consumers remain unchanged; only the main Prompt may use a compact display projection. | Shared function call sites, new user requirement, and exact-width reproduction. | `prompt-voice-input.test.ts`; new compact/default assertions. |
| INV-07 | The full retry error in Session state is never truncated, normalized, or replaced; only the one-line display summary may normalize whitespace and truncate. | SessionStatus and DialogAlert path. | New click/detail assertion required. |
| INV-08 | Existing pending/sent file color, usage formatting, shortcut bindings, retry timing, and plugin API signatures remain unchanged. | Current Prompt behavior and explicit non-goals. | Existing related suites plus focused regression tests. |
| INV-09 | Main-Prompt recording/transcription labels preserve the stop shortcut and phase meaning while using the shortest natural wording that materially reduces left-side width. | New surgical-scope requirement and current `recording=3` / `transcribing=2` frame result. | New compact voice formatter assertions and real Prompt frame. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/03 | `editorFileLabelDisplay` computes its maximum from `dimensions().width` after Prompt already owns a more accurate measured `promptWidth()`. | `Prompt` editor-file presentation | Real 160-terminal/75-Prompt harness produced a 48-character label and two voice rows; equal 75/75 allocation produced a 25-character label and one row. |
| INV-01/05 | Retry presentation concatenates summary, a long parenthetical hint, and retry metadata into one non-shrinkable/default-wrapping text region. | `Prompt` retry extension-bar branch | Real Prompt harness expected one row but received two; low-level production-equivalent layout reached four rows at 110 columns. |
| INV-04 | Display truncation begins at `>80`, while detail affordance and click handling begin only at `>120`. | `Prompt` retry summary/detail contract | Source conditions prove the 81-120 dead zone. |
| INV-01/07 | The extension-bar root and dynamic text do not establish a fixed-height/non-wrapping contract, and display text is not separated from the original detail value. | `Prompt` extension-bar container | Current JSX has no `height={1}`/`overflow="hidden"` at the root and only usage text sets `wrapMode="none"`. |
| INV-09 | The main Prompt consumes the verbose shared recording/transcription labels after already rendering a phase marker/spinner, making the left state region materially wider than necessary. | `Prompt` main consumer plus `prompt-voice-input.ts` formatter | Current real Prompt frame measured `recording=3` rows and `transcribing=2` rows under the 75-column home allocation; dialog/question consumers are separate call sites. |

The voice text is a downstream pressure participant, not the first divergence.
The same `Transcribing voice...` fits in one row when the file label uses the
actual 75-column budget. Globally shortening it would mask the Prompt width bug
and unnecessarily reduce clarity in `DialogPrompt` and `QuestionPrompt`.

### Red-Capable Feedback Signal

The exact production Prompt was mounted with the repository's existing Provider
stack and real OpenTUI renderer. The temporary harness was intentionally removed
after diagnosis because the user prohibited implementation in this turn.

```text
Working directory: packages/opencode
Command: bun test D:\Temp\opencode\prompt-footer-repro.test.tsx --timeout 30000

Expected extension rows: [1, 1, 1]
Received extension rows: [3, 2, 2]
                         ^ recording + long file + command hints
                            ^ transcribing + long file + command hints
                               ^ long retry error
```

The harness used a 160-column renderer with the production Prompt constrained to
75 columns, a real bridge-registry active path, a controlled recorder to reach
`transcribing`, and a real global `session.status` event. The durable TDD version
must be added at the existing repository test seam before production changes.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| One-row extension-bar geometry | `Prompt` bottom extension-bar container | Compose current state and secondary indicators inside actual Prompt allocation | It owns the JSX/flex tree and already measures final Prompt width. | Home/Session routes should not duplicate internal footer arithmetic. |
| File-indicator display budget | `Prompt` editor-file presentation | Render editor identity without monopolizing status chrome | It combines editor path with actual layout width. | EditorContext owns discovery/state, not terminal presentation. |
| Retry summary/detail affordance | `Prompt` retry branch | Compact status plus access to original details | It consumes SessionStatus for this UI and already opens DialogAlert. | SessionRetry and SessionStatus must remain UI-agnostic and preserve data. |
| Original error content | Existing SessionStatus value and DialogAlert invocation | Preserve the exact message for detail inspection | Existing path already supplies it. | Display normalization must not mutate domain state. |
| Voice lifecycle and shared wording | `prompt-voice-input.ts` | Report voice phase consistently to three consumers | Existing controller owns it and is not defective. | Prompt layout must absorb local pressure rather than changing shared semantics. |
| Plugin hint content | Plugin | Supply its JSX content | Plugin creates the content. | Prompt owns only the one-row clipping boundary, not plugin-specific shortening. |
| Behavioral verification | Real rendered Prompt seam | Observe terminal rows and dialog interaction | This catches Yoga/text behavior and actual state composition. | Pure formatter/source-text tests cannot detect the reported wrap. |

## 10. Single Approved Primary-Path Design

### 10.1 Recommended route

```text
Session/voice/editor inputs remain unchanged
  -> Prompt derives display-only summary tokens
  -> measured promptWidth bounds variable file content
  -> one fixed-height extension row assigns flex priority
  -> variable file/error text uses non-wrapping native truncation
  -> fixed state/action tokens remain visible
  -> retry click opens original unmodified message in existing DialogAlert
```

The implementation must use one authoritative flex layout in the existing
Prompt branch, not width-specific alternate footers.

1. Make the extension-bar root exactly one row with `height={1}`, `minWidth={0}`,
   `overflow="hidden"`, horizontal alignment, and an explicit gap. This is the
   final invariant guard: no child may increase Prompt height.
2. Reuse `promptWidth()` for the editor-file budget. Keep the existing
   basename/parent-index and selection-suffix semantics, but constrain the text
   by the actual Prompt allocation. Render it with `minWidth={0}`,
   `flexShrink={1}`, `wrapMode="none"`, and native truncation so terminal-cell
   width, not JavaScript code-unit count alone, controls the final visible text.
3. Give current-state controls higher flex priority than secondary right-side
   chrome. Voice status/spinner and `esc interrupt` do not wrap; the file label
   yields from its preferred width before useful file identity is lost, while
   lower-priority usage/shortcut content clips before the file's retained
   prefix/suffix is discarded.
4. Split retry rendering into distinct tokens instead of one concatenated
   sentence:

   ```text
   <error summary>  details  retry in 9s · #7  esc interrupt
   ```

   `details` is the exact recommended affordance. It matches the existing
   lowercase muted footer vocabulary (`agents`, `commands`, `interrupt`), costs
   seven cells, and replaces `(click to expand)` without losing intent.
5. Keep the error summary in `theme.error`, normalize only display whitespace
   with the display-only equivalent of `message.replace(/\s+/g, " ").trim()`,
   and let it grow/shrink inside remaining space with native visual truncation.
   Do not impose a second arbitrary character threshold; available Prompt space
   is the source of truth. The raw message remains untouched for `DialogAlert`.
6. Keep `details` and compact retry metadata non-shrinking. Use
   `retry in <duration> · #<attempt>` when a duration exists and
   `retry · #<attempt>` otherwise. Remove brackets and the words `retrying` and
   `attempt` from the narrow status token because the spinner/error context and
   `#` already carry those meanings.
7. Make the whole summary/details region clickable for a forgiving mouse target,
   and always open `DialogAlert.show(dialog, "Retry Error", rawMessage)`.
   Remove the length gate entirely. This closes the 81-120 dead zone and keeps
   the dialog's value byte-for-byte unchanged.
8. Add one optional compact presentation mode to the existing voice formatter,
   defaulting to the current wording for all existing consumers. The main Prompt
   passes compact mode and uses the following natural, state-complete labels:

   ```text
   Starting...
   Rec 00:03 · alt+v stop
   Saving...
   Transcribing...
   ```

   `Rec` preserves the stop shortcut, while the phase marker/spinner already
   identifies this as voice input. `Transcribing...` removes the redundant
   `voice` word without hiding that the phase is transcription. `DialogPrompt`
   and `QuestionPrompt` keep the existing default strings. This is a single
   formatter with a supported presentation option, not a second lifecycle path.
9. Preserve the public `Prompt.hint` and `Prompt.right` types. The extension-row
   parent clips an oversized hint to one row; no repository consumer proves a
   multi-line compatibility contract. The card-internal `right` slot is untouched.

### 10.2 Priority order

When all content cannot physically fit, the one-row layout must prioritize:

| Priority | Content | Disposition under pressure |
| --- | --- | --- |
| P0 | Current voice/retry/busy state, retry `details`, countdown/attempt, `esc interrupt`, and existing active duration | Preserve and never wrap; final terminal-edge clipping is allowed only when even P0 exceeds physical width. |
| P1 | Active editor file identity | Middle/native truncate and shrink within the actual Prompt budget. |
| P2 | Usage, agent, command, and idle voice hints | Preserve existing adaptive visibility; enclosing group may be clipped after P0/P1 have claimed space. |

### 10.3 Considered alternatives

| Approach | Assessment | Disposition |
| --- | --- | --- |
| Globally rename shared voice states to `Transcribing...`, `Saving...`, etc. | Small diff, but changes dialog/question consumers unnecessarily and still leaves the file/retry wrapping defect. | Reject. |
| Add a compact presentation option used only by the main Prompt | Keeps shared default wording and lifecycle intact while removing redundant phase words from the exact pressured consumer. | Approve as part of the primary path. |
| Keep concatenated retry text and lower 80/120 constants | Still couples interaction to arbitrary length and cannot respond to actual Prompt/sidebar allocation. | Reject. |
| Add several width breakpoints that hide file/commands/errors | Creates parallel presentation branches and loses more information than necessary. | Reject. |
| Let Yoga wrap to two rows when busy | Directly violates the user's core requirement and causes Prompt height jitter. | Reject. |
| One fixed-height row with shrinkable variable text and fixed actions | Repairs both first divergences at the owner while maximizing information per available cell. | Approve as the sole primary path. |

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Prompt state `Switch` branches (voice, running, warp, workspace, hint) | Current | Supported-domain branches in one presentation contract | yes | Existing | Preserve under one-row parent. |
| Gemini quota message alias | Current | Supported-domain display branch | yes | Existing | Preserve exactly. |
| DialogAlert detail display | Current | Diagnostic path | no | Existing; no new branch | Preserve, call for every retry message. |
| Editor pending/sent color branch | Current | Supported-domain display branch | yes | Existing | Preserve. |
| Native truncation under width pressure | Proposed | Supported-domain branch inside one layout contract | yes | Approximately 2 layout decisions, not an alternate success path | Add. |
| Main-Prompt compact voice presentation option | Proposed | Supported-domain presentation branch within the existing voice formatter | yes | One local display branch; no alternate lifecycle/success path | Add. |
| Plugin hint clipping at parent boundary | Proposed/current contract enforcement | Contracted pass-through | yes | No new semantic branch | Preserve content, constrain geometry. |
| Separate compact footer selected only after overflow | Proposed alternative | Forbidden fallback/duplicate presentation path | yes | Not allowed | Reject. |

New alternate success paths: zero. Proposed diagnostic decision surface is the
existing details click path with its incorrect length guard removed; no new
diagnostic algorithm is introduced. The secondary-path ratio is therefore below
10 percent of the changed production decision surface.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `message.length > 80` display slice | Limits visible error prose without knowing actual layout | Flex/native truncation uses real available space and keeps fixed controls visible. | Prompt retry `message` memo. |
| `message.length > 120` click gate | Attempts to expose only very long errors | Every retry now has one stable detail surface; length is unrelated to whether details are useful. | Prompt `isTruncated` memo and click handler. |
| Literal ` (click to expand)` | Advertises the gated dialog | Fixed muted `details` is shorter, consistent, and always truthful. | Prompt `retryText`. |
| Bracketed `[retrying ... attempt #N]` sentence | Packs retry metadata into the same long string | Independent compact token remains visible while summary shrinks. | Prompt `retryText`. |
| File budget based on terminal `dimensions().width` | Predates/usefully ignores no local allocation | Existing measured `promptWidth()` is authoritative after Home maxWidth/sidebar layout. | Prompt `editorFileLabelDisplay`. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 single visual row | Prompt extension-bar root | `component/prompt/index.tsx`: fixed one-row/non-wrapping boundary | Real Prompt frame asserts one non-empty row for idle, busy, recording, transcribing, and retry. |
| INV-02 actual Prompt width | `syncPromptWidth -> editor file budget` | Reuse `promptWidth()` instead of terminal dimensions | 160-column renderer + 75-column Prompt + long file. |
| INV-03 useful file identity | Editor label text | Shrink/native middle truncate while retaining current label semantics | Frame contains recognizable prefix/suffix/extension and no second row; include wide-cell filename case. |
| INV-04 stable details | Retry summary click | Remove both length gates; fixed `details`; raw message to DialogAlert | 81-120-character message shows `details`; click reveals exact original. |
| INV-05 fixed retry controls | Retry flex tokens | Separate summary/details/metadata/interrupt tokens | Long retry frame contains `details`, compact retry token, and `esc interrupt` on one row. |
| INV-06 shared voice/default consumers unchanged | Existing voice helper call sites | Add optional compact mode while preserving default output; main Prompt opts in | Existing exact-string/lifecycle tests plus default/compact formatter assertions. |
| INV-07 raw detail preserved | SessionStatus -> DialogAlert | Normalize only display memo | Multiline/long message detail equals original while footer is one row. |
| INV-08 no adjacent regressions | Existing Prompt branches | Preserve colors, usage, keybindings, plugin types | Existing Prompt/voice/session suites and typecheck/build. |
| INV-09 shorter main-Prompt voice labels | Main Prompt -> voice formatter compact option | Pass compact mode only from `component/prompt/index.tsx` | Real recording/transcribing frame plus literal compact-label expectations. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Fixed-height extension-row boundary | INV-01 | Both screenshots and `[2,2]` real-frame failure | Current root permits children to determine height and wrap. |
| Actual-width file budget | INV-02/03 | 160-terminal/75-Prompt differential reproduction | Terminal width is not the Prompt allocation; existing `promptWidth()` is unused here. |
| Shrinkable non-wrapping file/error text | INV-01/03/05 | OpenTUI probe stayed one row at 60/75/110 columns | Current dynamic text has default wrapping and retry parent is non-shrinkable. |
| Fixed `details` affordance | INV-04 | User request and 81-120 source dead zone | Current hint is long and conditionally false even after visible truncation. |
| Compact independent retry token | INV-05 | Retry screenshot; current bracketed sentence wraps | Current metadata cannot remain visible independently of summary width. |
| Display-only whitespace normalization | INV-01/07 | Retry message is unconstrained `Schema.String` | Explicit newlines bypass ordinary word wrapping and can hide later summary content. |
| Main-Prompt compact voice option | INV-06/09 | New user scope plus real recording/transcribing row counts | A global wording change would alter dialog/question consumers; the existing formatter needs one owner-controlled presentation distinction. |
| Real Prompt final-frame tests | All | Existing source/helper tests did not catch screenshots; temporary real harness did | Formatter or source-text assertions cannot observe Yoga row count or click/dialog behavior. |

No new module, public interface, setting, dependency, cache, retry, schema,
adapter, or compatibility path is justified or planned.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | modify | Repair file-width source, enforce one-row flex priority, split retry summary/details/metadata, and preserve raw detail click. | approximately +24 / -18 production lines |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | modify | Extend the existing real Prompt harness with renderer/Prompt-width/config/event options and add final-frame plus detail-click regressions. | approximately +70 / -8 test lines |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | modify | Add an optional compact presentation mode while preserving current default strings and voice lifecycle. | approximately +12 / -4 production lines |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | modify | Lock default shared wording and main-Prompt compact labels, including the stop shortcut. | approximately +28 / -4 test lines |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-alert.tsx` | no change | Existing detail surface carries observed messages. | 0 |

No file additions, deletions, generated artifacts, migrations, or dependency
changes are planned. This canonical plan is documentation and is not part of a
future implementation diff budget.

## 16. TDD Behavior Slices

Agreed public seam: the final terminal frame and mouse-visible dialog behavior
of the real `Prompt` mounted through its existing Provider stack. Tests must not
call a private footer formatter, inspect source text, or reproduce Yoga width
arithmetic.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | In a 160-column renderer with Prompt constrained to 75 columns and a long IDE filename, idle, busy, recording, and transcribing each occupy one extension row; recording/transcribing use compact main-Prompt labels and idle/busy retain file suffix plus ordinary controls. | File budget uses terminal width, the shared voice labels are verbose, and dynamic labels wrap in the ordinary and active branches. | Reuse measured Prompt width; opt the main Prompt into compact voice wording; make variable file/text/control groups shrink or clip without wrapping. | Original file-indicator failure, ordinary busy path, and newly requested recording-width reduction. |
| 2 | A >120-character retry message renders summary, `details`, compact retry metadata, and interrupt affordance in one row. | One unshrinkable concatenated sentence wraps. | Separate variable and fixed tokens inside one-row flex layout. | Long retry screenshot. |
| 3 | An 81-120-character retry error shows `details`; clicking its visible region opens `Retry Error` with the exact original string. | Current display truncates at 80 but click gate starts at 120. | Remove length gate and always route raw message to existing dialog. | Hidden-details dead zone. |
| 4 | A retry message containing newline/repeated whitespace remains one footer row while dialog content preserves the original whitespace. | Display and detail currently share the raw string; newline can force a visual line. | Normalize only display summary; keep raw value for dialog. | Reachable Provider message formatting. |
| 5 | Existing usage, file pending/sent, active-duration, default dialog/question voice wording, and shortcut behavior remains unchanged. | Regression guard after layout and presentation-option refactor. | No extra lifecycle behavior; run existing focused suites. | Adjacent Prompt contracts and shared-consumer compatibility. |

Each slice must be run red before its production change. Expected values are
literal user-visible row counts/text and the original input error, independent
of implementation calculations.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 125 | Approximately 48 production decision lines plus 77 behavioral test/harness lines; excludes imports, formatting, and this plan. |
| Required Chinese explanatory comments `C` | at least 19 | `ceil(125 * 0.15) = 19`; implementation must recalculate actual `E` and increase `C` if needed. |

Qualifying comments must be distributed near:

- The actual-Prompt-width rule and why terminal width is wrong under Home/sidebar allocation.
- The fixed one-row priority contract and why variable content yields before
  state/action tokens.
- The compact voice option boundary: only the main Prompt opts in, while
  dialog/question consumers retain default wording and the recording stop key.
- The separation between normalized display summary and byte-for-byte dialog
  detail.
- The reason `details` is unconditional rather than length-gated.
- The final-frame tests' 160-terminal/75-Prompt differential setup.
- The recording/transcribing test lifecycle and cleanup/cancellation boundary.
- The 81-120-character test's purpose in catching the former threshold gap.
- The wide-cell filename test's terminal-cell rather than JavaScript-length
  intent.

Comments that merely translate JSX props, restate assertions, or split one idea
across many lines do not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx --timeout 30000` | `packages/opencode` | Real Prompt row-count, width differential, retry details, and interaction regressions. |
| `bun test test/cli/tui/prompt-voice-input.test.ts --timeout 30000` | `packages/opencode` | Shared voice wording/lifecycle and hint thresholds remain unchanged. |
| `bun test test/cli/cmd/tui/session-integration.test.ts --timeout 30000` | `packages/opencode` | Existing Prompt integration smoke contracts remain intact. |
| `bun test test/util/locale.test.ts --timeout 30000` | `packages/opencode` | Existing truncation Unicode behavior remains intact. |
| `bun typecheck` | `packages/opencode` | TSX/OpenTUI props, test harness, and SDK event types are valid. |
| `bun run build` | `packages/opencode` | Production TUI build accepts the JSX and bundled runtime behavior. |

After implementation, rerun the original 160-terminal/75-Prompt scenario and
record `[1, 1, 1, 1, 1]` for idle, busy, recording, transcribing, and retry.
Tests and typecheck must never run from repository root.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing Prompt, voice formatter, and two test seams are sufficient. |
| Files modified | 4 | One Prompt owner, one shared presentation formatter, and two existing behavioral test seams. |
| Files deleted | 0 | No obsolete module exists; only local branches/strings are collapsed. |
| Production lines | approximately 42 touched | Focused JSX/memo repair in one component. |
| Test lines | approximately 78 touched | Real Provider/voice/editor/event setup and four vertical assertions. |
| Generated lines | 0 | No schema or SDK change. |

The budget is an audit signal, not permission to omit confirmed states or
interaction coverage.

## 20. Real Risks and Open Decisions

### Confirmed Risks

- OpenTUI flex measurement and terminal-cell truncation can differ from
  JavaScript string length; tests must assert final rendered rows at the real
  Prompt seam.
- `promptWidth()` updates after the render pass. Tests must wait for settled
  frames rather than assert the first transient frame.
- A voice test must cancel the controlled hanging transcriber and restore its
  recorder spy so no process/timer leaks into later tests.
- At physically tiny widths, even all P0 tokens may exceed the terminal. The
  contract is still one visible row; final edge clipping is preferable to
  height growth. No evidence supports a second layout or width-specific footer.
- Plugin hints are arbitrary JSX. The Prompt can guarantee its parent row's
  geometry, but cannot promise every plugin-supplied token remains visible.

### Open Decisions Requiring the User

None. The user specified one row, concise details guidance, preserved style,
high information density, a surgical diff, and a main-Prompt recording/
transcription reduction. The exact recommended labels are `details`,
`retry in 9s · #7`, `Rec 00:03 · alt+v stop`, and `Transcribing...`; a later
wording-only preference would require a substantive plan revision before
implementation.

### Rejected Speculation

- No evidence shows a shipped plugin requires a multi-line Prompt hint; do not
  add compatibility layout branches.
- No reproduced detail-dialog overflow justifies changing every DialogAlert.
- No evidence links this defect to voice recorder/transcriber latency or text
  generation; do not instrument those paths.
- No evidence requires changing web UI retry cards, IDE discovery, Session
  schemas, or Provider error parsing.
- ANSI/control-character sanitization is outside this observed layout defect and
  lacks a task-specific threat/reachability analysis.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and both verbatim user requirements.
- Reconstruct behavior from repository evidence rather than trusting the
  builder's summary or temporary harness transcript.
- Audit the complete original scope: long file indicator, long retry error,
  details interaction, transcription status, one-row geometry, style and
  information density.
- Verify first-divergence ownership, one primary layout path, no fallback,
  forward/reverse traceability, real-frame TDD sensitivity, and the 15 percent
  Chinese explanatory-comment plan.
- Treat any future substantive revision as invalidating prior approval and
  require a fresh full-scope audit.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | 3 | APPROVE | `ses_096212a56ffemU8IZu4UNXD3pR` |
| 2 | R2 | yes | B-01, B-02 | 3 | BLOCK | `ses_093f4d287ffeIyXncHc4Kbw7hA` |
| 3 | R3 | yes | B-01 | 4 | BLOCK | `ses_093ee80e4ffe7gEHdJ7jdR3nXP` |
| 4 | R4 | yes | B-01 | 4 | BLOCK | `ses_093e85778ffeHP3eh7MjdnKQYd` |
| 5 | R5 | yes | No blocking findings. | 3 | APPROVE | `ses_093d2ed8dffeSgNj3RZDdYHX3l` |

R1 approval is historical only. The new compact main-Prompt voice requirement
and implementation target are substantive, so they invalidate R1 approval and
require the full-scope R5 audit before implementation.

### Round 3 Independent Verdict (Verbatim)

## Blocking findings

### B-01 Canonical plan expands the explicitly inspection-only request into implementation and commit authorization

- Violated invariant: The canonical plan must preserve the user-authorized scope. The supplied requirement explicitly requests方案检查 and prohibits implementation; it must not authorize production changes, implementation verification, or commits.
- Evidence class: contracted
- Producer and execution path: The user requirement states `请你详细完整检查...但是不进行任何的修改实施，但是进行方案检查` → canonical plan scope and implementation workflow → potential implementation/commit execution.
- Source evidence: `docs/plans/prompt-extension-bar-single-line.md:23`, `docs/plans/prompt-extension-bar-single-line.md:39-53`
- Canonical-plan evidence: Section 1 claims that the current turn changes the target to `verified-implementation-and-commit`, says implementation authorization exists, and describes a later implementation phase. The supplied audit input contains no later implementation request or Session GOAL authorization.
- Responsibility owner: Canonical plan scope and implementation workflow.
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: An implementer following this canonical plan could modify production and test files, run implementation verification, and prepare a commit despite the explicit inspection-only requirement. This violates the requested deliverable before any layout design is evaluated.
- Why this is not speculative: The prohibition against modification is explicit in the verbatim requirement, while the plan explicitly declares the opposite implementation target. The alleged later authorization exists only inside the untrusted plan and is absent from the current user requirement.
- Minimal correction direction: Restore this revision to inspection-only plan analysis. Remove implementation, commit, durable TDD, and post-implementation obligations, or obtain and record a separate explicit user request before creating a new implementation revision.

## Non-blocking findings

- The plan's file-level change table identifies four files to modify (`prompt/index.tsx`, `prompt-submit-transport.test.tsx`, `prompt-voice-input.ts`, and `prompt-voice-input.test.ts`), while the diff budget states `Files modified: 2` and describes only one production owner plus one behavioral test seam (`docs/plans/prompt-extension-bar-single-line.md:435-447`, `509-517`). This is an internal estimate inconsistency; it does not by itself invalidate the proposed behavioral route.
- The plan's implementation audit record still labels the future implementation plan revision as `R2` while the current canonical revision is `R3` (`docs/plans/prompt-extension-bar-single-line.md:742-749`). Because no implementation is authorized or being audited in this round, this is stale administrative metadata rather than a current production defect.
- The plan's priority wording is recoverable but imprecise: section 10.1 says the file label “yields first,” while the explicit priority table assigns file identity P1 and usage/shortcut chrome P2 (`docs/plans/prompt-extension-bar-single-line.md:303-312`, `356-364`). The intended behavior appears to be that the file shrinks before P0 controls, while P2 chrome clips before useful file identity is discarded.
- The plan claims observed screenshots and a deleted temporary harness as evidence (`docs/plans/prompt-extension-bar-single-line.md:33-34`, `96-104`). Those artifacts are not available in the supplied audit input, so the exact row-count measurements cannot be independently reproduced from the canonical artifact alone. The current source still provides reachable causal evidence for the width and wrapping problem, so this is an evidence-quality note rather than an additional blocker.

## Rejected speculation

- No blocking finding is raised for malformed editor paths, ANSI/control characters, or hostile provider messages. The plan identifies no task-specific public seam or threat model requiring sanitization, and the requested behavior concerns display width rather than input security.
- No blocking finding is raised for multi-line plugin-provided hints. `Prompt.hint` is arbitrary plugin JSX, but no inspected repository contract establishes that plugins require the extension bar to grow beyond one row.
- No blocking finding is raised against preserving the original retry message in Session Status and passing it to `DialogAlert`. `SessionStatus.Info.retry.message` is an unconstrained string (`packages/opencode/src/session/status.ts:13-27`), and `DialogAlert` already accepts and renders the supplied message (`packages/opencode/src/cli/cmd/tui/ui/dialog-alert.tsx:39-40`).
- No blocking finding is raised against keeping shared default voice wording unchanged. The main Prompt and dialog/question consumers are separate call sites; a Prompt-local presentation projection is consistent with the stated scope (`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:444-447`, `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx:165`, `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx:582`).
- No fallback-path defect is established in the proposed layout itself. The plan explicitly rejects width-specific alternate footers and describes one existing Prompt layout path (`docs/plans/prompt-extension-bar-single-line.md:283-355`, `366-393`).

## Requirement and traceability coverage

The behavioral design substantially covers the requested layout problem, but the plan cannot be released under the supplied scope.

## Primary-path and fallback verdict

The proposed behavioral design identifies one authoritative primary path:

```text
Existing Session/editor/voice inputs
→ existing Prompt
→ actual Prompt-width budgeting
→ one fixed-height extension row
→ shrinkable/non-wrapping variable content
→ preserved fixed action/detail tokens
→ existing DialogAlert for raw retry details
```

The plan does not introduce a failure-triggered alternate footer, parser, data source, configuration switch, catch-and-default success path, or replacement lifecycle. Its proposed compact voice mode is a presentation branch within the existing formatter rather than a second voice lifecycle.

**Verdict:** Primary-path design structurally passes. The canonical artifact remains unauthorized because B-01 blocks the scope transition.

## Code quality and Chinese-comment verdict

This is a plan audit, not an implementation audit; no actual `E`/`C` calculation is applicable.

Plan feasibility is otherwise acceptable:

- The proposed production ownership remains localized to the existing Prompt and voice formatter seams.
- The plan does not expand configuration, dependencies, schemas, or public plugin signatures.
- The proposed test seam observes rendered behavior rather than duplicating Yoga arithmetic.
- The plan commits to a Chinese explanatory-comment minimum of `C >= 19` for its estimated `E = 125`, satisfying the plan-phase feasibility threshold (`docs/plans/prompt-extension-bar-single-line.md:468-492`).

Actual code-quality compliance and the Chinese-comment ratio must be recomputed only during a later implementation audit against the real diff.

## Release verdict

**BLOCK**

### Round 5 Independent Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- **Stale plan-phase metadata:** The canonical metadata identifies `Revision: R5`, but the implementation-evidence and implementation-audit placeholders still refer to R4 (`docs/plans/prompt-extension-bar-single-line.md:853-856`, `894-901`). No implementation evidence is claimed, so this does not alter the executable design or falsely authorize implementation.
- **Audit-mode terminology:** `Audit mode: full-scope` is less precise than the supplied `Audit mode: plan` (`docs/plans/prompt-extension-bar-single-line.md:9`). The status, revision, approval state, and implementation prohibition nevertheless make the current phase unambiguous.
- **Middle-truncation wording could be more exact:** The plan requires useful file suffix/extension retention while also relying on OpenTUI native truncation (`docs/plans/prompt-extension-bar-single-line.md:303-307`, `408-413`). OpenTUI exposes only a boolean `truncate` option, not a native middle-truncation mode (`node_modules/@opentui/core/renderables/TextBufferRenderable.d.ts:17-20`, `85-86`). The required wide-cell rendered-frame assertion makes the behavioral outcome unambiguous and will reject an implementation that loses the suffix, so this is not a missing requirement or verification gate.

## Rejected speculation

- No generic `DialogAlert` resizing or scrolling repair is justified. The existing detail surface accepts the original retry message, and no dialog-specific failure was established (`packages/opencode/src/cli/cmd/tui/ui/dialog-alert.tsx:39-40`, `59-65`).
- No ANSI/control-sequence sanitizer is justified by this task. The confirmed defect concerns terminal width and wrapping, not an established security boundary or threat model.
- No compatibility path for multiline plugin hints is required. `Prompt.hint` accepts plugin JSX, but no repository contract or consumer requires the extension bar to grow vertically.
- No voice recorder, transcriber, timeout, cancellation, or cleanup change is justified. Those paths are separate from Prompt presentation; the plan correctly limits the change to a compact main-Prompt projection.
- No separate narrow-width footer, feature flag, fallback layout, or second data source is justified.

## Requirement and traceability coverage

| Confirmed requirement | Independent coverage assessment |
|---|---|
| Long file indicators must not create a second row | Covered by the actual-width correction from terminal width to `promptWidth()`, fixed one-row layout ownership, final-frame idle/busy/voice coverage, and the wide-cell suffix assertion. Current divergence is visible at `component/prompt/index.tsx:215-219`; Home constrains Prompt to 75 columns at `routes/home.tsx:72-84`. |
| Long retry errors must remain compact | Covered by separating variable summary text from fixed `details`, retry metadata, interrupt, and active-duration tokens. Current concatenation and wrapping pressure are established at `component/prompt/index.tsx:1912-1992`. |
| Error details must be clickable | Covered by unconditional `details` behavior and a real mouse-visible dialog test. Current truncation starts above 80 characters while clickability starts above 120 (`component/prompt/index.tsx:1932-1956`), making the 81–120 test red-capable. |
| Full retry content must remain available | Covered by display-only whitespace normalization and passing the unchanged Status message to `DialogAlert`. Status permits an unconstrained string (`session/status.ts:13-27`). |
| Recording/transcription wording should consume less width | Covered by a compact formatter mode used only by the main Prompt, including `Rec 00:03 · alt+v stop` and `Transcribing...`. Default dialog/question wording remains unchanged. |
| Extension bar must remain one visual row | Covered by the fixed-height/non-wrapping parent contract and real rendered-frame matrix for idle, busy, recording, transcribing, and retry. Starting/stopping share the same branch and are shorter than the tested pressure cases. |
| Preserve useful information and OpenCode style | Covered by lowercase `details`, compact retry notation, preserved stop/interrupt affordances, retained filename identity, and explicit P0/P1/P2 priorities. |
| Surgical change only | Covered: four existing files, no new component, setting, dependency, schema, migration, or alternate footer. |
| Existing adjacent semantics remain unchanged | Covered through explicit non-goals, existing focused suites, active-duration preservation, default voice wording assertions, typecheck, and build verification. |

Forward traceability is complete: every confirmed invariant maps to an existing owner, an exact planned change location, and a behaviorally sensitive test.

Reverse traceability is also complete: each proposed production concept—fixed row, measured-width budgeting, compact voice projection, display-only retry normalization, stable details affordance, and separated retry tokens—is supported by observed, contracted, or reachable behavior. No unjustified production concept remains.

## Primary-path and fallback verdict

The plan defines one authoritative presentation path:

```text
Existing Session Status, editor selection, and voice lifecycle
→ existing Prompt component
→ measured Prompt allocation
→ one fixed-height extension row
→ prioritized, non-wrapping summary and control tokens
→ existing DialogAlert for the unchanged retry message
```

The first divergences and owners are correctly established:

- Terminal width is used instead of measured Prompt width for the file indicator.
- Retry summary, expansion prose, and metadata are concatenated into a wrapping region.
- Retry truncation and clickability use inconsistent thresholds.
- The Prompt lacks a final one-row geometry boundary.
- Main-Prompt voice text duplicates phase information already represented by its marker/spinner.

The plan repairs these transitions inside the owning Prompt presentation interface. It explicitly removes the obsolete 80/120 thresholds, concatenated expansion hint, bracketed retry sentence, and terminal-width file budget.

There is no failure-triggered alternate footer, catch-and-default success, parser fallback, replacement voice lifecycle, compatibility layer, or configuration switch. The compact voice option is a supported presentation branch within one formatter, not an alternate lifecycle or success path. Diagnostic behavior remains the existing details dialog and does not masquerade as successful Session execution.

**Verdict: PASS.**

## Code quality and Chinese-comment verdict

This is a plan audit, so no actual implementation `E`/`C` calculation applies.

Plan-phase feasibility passes:

- Changes remain localized to the existing Prompt owner, voice formatter, and two existing test seams.
- No public plugin signature, configuration surface, dependency, schema, or module is added.
- Tests observe final OpenTUI frames and mouse-visible dialog behavior rather than duplicating Yoga calculations or testing private helpers.
- Verification commands use the required `packages/opencode` working directory.
- The proposed `E = 125` requires `C >= ceil(125 × 0.15) = 19`; the plan commits to at least 19 qualifying Chinese explanatory-comment lines and requires recalculation against the actual diff.
- Planned comments are distributed near real decisions: measured-width ownership, one-row priority, compact voice scope, raw/display error separation, unconditional details, and behavioral-test intent.

Actual code quality and Chinese-comment compliance must be independently recomputed during implementation audit.

## Release verdict

**APPROVE**

This verdict applies only to canonical plan revision **R5** at `docs/plans/prompt-extension-bar-single-line.md`.

The orchestrating agent may record the clean full-scope verdict and transition the exact revision to:

```text
Status: approved
Revision: R5
Approved revision: R5
Implementation allowed: yes
```

Any substantive change to behavior, scope, ownership, file plan, tests, or fallback classification invalidates this approval and requires another full-scope plan audit.

### Round 4 Independent Verdict (Verbatim)

## Blocking findings

### B-01 Missing behavior-sensitive verification for the idle/ordinary file-indicator path

- **Violated invariant:** `INV-01` requires the Prompt extension bar to remain exactly one visual row in `idle`, `busy`, `retry`, and all active voice states. The long-file indicator is also an explicitly reported failure class, but the canonical TDD matrix does not include a final rendered idle or ordinary busy frame proving that path.
- **Evidence class:** contracted
- **Producer and execution path:** Editor bridge/WebSocket/Zed selection produces an unconstrained `filePath` → `EditorContext.selection` → `Prompt.editorFileLabelDisplay` → the bottom extension-bar file/command layout. In the current implementation, the idle/non-retry path renders the file indicator and command/usage hints together.
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:215-219`, `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:2032-2089`, and `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1901-1933`.
- **Canonical-plan evidence:** `INV-01` explicitly includes `idle` and `busy`; the forward traceability and TDD slices covered only recording/transcribing and retry.
- **Responsibility owner:** The existing real-render `Prompt` test seam in `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx`; production ownership remains `Prompt`'s extension-bar layout.
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** The approved implementation could make recording, transcribing, and retry one row while leaving the ordinary long-file-plus-command/usage layout wrapping or clipping incorrectly. The original file-indicator failure therefore remains behaviorally unverified across a required state, and a regression can pass the planned suite while violating `INV-01`.
- **Why this is not speculative:** The ordinary path is directly present in production, receives unconstrained editor paths through the editor context, and is explicitly included in the plan's invariant and user-requirement scope. Existing source-level or formatter tests cannot observe OpenTUI row allocation.
- **Minimal correction direction:** Extend the existing real `Prompt` final-frame test matrix to include at least one constrained idle frame with a long editor filename plus the ordinary right-side hints, and one ordinary busy frame if the implementation keeps a distinct busy layout. Assert the terminal-cell row count and recognizable file suffix/extension through the rendered seam. Do not add a second layout or fallback path.

## Non-blocking findings

- The plan metadata uses `Audit mode: full-scope` rather than the more specific `plan` mode supplied by the audit authorization. The artifact is otherwise clearly a plan audit revision (`Status: audit-required`, `Approved revision: none`, `Implementation allowed: no`), so this is administrative ambiguity rather than a behavioral blocker.
- Section 10.1 says the file label “yields first,” while the priority table assigns file identity `P1` and usage/shortcut chrome `P2`. The intended order is recoverable from the table, but the wording should explicitly say that the file shrinks before `P0` controls, while `P2` content yields before useful file identity is discarded.
- The plan's one-row design states that `activeDuration` and other existing busy/retry metadata remain distinct, but the priority table names countdown/attempt and `esc interrupt` without explicitly listing the existing active-duration token. This should be clarified before implementation to prevent accidental removal, although the existing non-goal and current JSX provide enough evidence to treat preservation as intended.
- The plan requires “native truncation” and terminal-cell behavior but does not define the exact display-whitespace normalization operation beyond “normalize to one line.” The behavioral requirement is still implementable, but an explicit display-only normalization rule would reduce implementation ambiguity.

## Rejected speculation

- No blocking finding is raised for malformed editor paths, ANSI/control characters, or hostile provider messages. The inspected producers and task contract establish a display-width problem, not a separate sanitization or security requirement.
- No blocking finding is raised for multiline plugin-provided `Prompt.hint` content. The plugin slot is arbitrary JSX, but no repository consumer or accepted contract proves that it must expand the extension bar beyond one row.
- No blocking finding is raised against preserving the raw retry message for `DialogAlert`. The retry status carries the original string and the existing dialog accepts that message directly.
- No blocking finding is raised against a Prompt-local compact voice presentation mode. The main Prompt, `DialogPrompt`, and `QuestionPrompt` are separate consumers, and the plan preserves the shared default wording for the latter two.
- No forbidden fallback is established. The plan describes one existing Prompt layout path and explicitly rejects width-specific alternate footers, feature flags, and failure-triggered replacement layouts.

## Requirement and traceability coverage

| Requirement | Coverage assessment |
|---|---|
| Long file indicator must not force a second row | Production owner and width-source correction are correctly identified. Coverage is incomplete because the ordinary idle/busy real-frame path is not behaviorally tested. |
| Long retry error must remain compact | Covered by separating summary, details, retry metadata, and interrupt controls into one layout path. |
| Details must be clickable and open full content | Covered by removing the 80/120 length mismatch and routing the raw message to the existing `DialogAlert`. |
| Recording/transcription width reduction | Covered by a Prompt-local compact voice presentation option while preserving shared default wording. |
| One-line extension bar | Production boundary is identified, but full state coverage is missing for idle/ordinary busy rendering. |
| Existing style and semantics preserved | Mostly mapped through non-goals and regression suites; active-duration preservation should be stated more explicitly in the priority contract. |
| Surgical scope/no major redesign | Covered: four existing files, no new footer, setting, dependency, schema, or fallback path. |

Because `B-01` leaves a confirmed state and original file-indicator scenario without a behaviorally sensitive regression, the plan does not yet satisfy the no-confirmed-requirement-left-unverified gate.

## Primary-path and fallback verdict

The proposed semantic route is structurally sound:

```text
Editor/session/voice inputs
→ existing Prompt
→ measured Prompt-width budgeting
→ one fixed-height extension row
→ non-wrapping shrinkable variable content
→ preserved fixed action/detail tokens
→ existing DialogAlert for raw retry details
```

The plan does not introduce a failure-triggered alternate footer, parser fallback, data-source fallback, configuration switch, or catch-and-default success path. The compact voice mode is a local presentation branch within the existing formatter rather than a second lifecycle.

**Verdict:** Primary-path design passes structurally, but the canonical plan remains blocked by incomplete real-frame verification coverage.

## Code quality and Chinese-comment verdict

This is a plan audit; no implementation `E/C` calculation is applicable.

Plan-phase quality is otherwise acceptable:

- The production owner remains localized to the existing Prompt component and voice formatter.
- No new public setting, dependency, schema, adapter, or compatibility layer is proposed.
- The planned test seam observes real OpenTUI behavior rather than duplicating layout arithmetic.
- The plan commits to `E = 125` and `C >= 19`, with `ceil(125 × 0.15) = 19`, and identifies the required explanatory-comment locations.
- Actual implementation comment compliance must be recalculated from the eventual diff.

## Release verdict

**BLOCK**

### Round 2 Independent Verdict (Verbatim)

## Blocking findings

### B-01 Canonical plan contradicts the explicit inspection-only scope

- **Violated invariant:** The canonical plan must preserve the verbatim user requirement and must not authorize implementation when the user explicitly requested方案检查、不得实施修改.
- **Evidence class:** contracted
- **Producer and execution path:** User requirement explicitly says `不进行任何的修改实施，但是进行方案检查` → canonical plan metadata and implementation workflow.
- **Source evidence:** `docs/plans/prompt-extension-bar-single-line.md:23`, `docs/plans/prompt-extension-bar-single-line.md:39-42`
- **Canonical-plan evidence:** Section 1 states that the current turn changes the target to `verified-implementation-and-commit`; section 1 also says a durable TDD version should be added.
- **Responsibility owner:** Canonical plan scope and approval metadata.
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** The plan expands the user-authorized deliverable from inspection and plan review to implementation, verification, and commit. If followed, it would authorize repository modifications that the user explicitly prohibited in this turn.
- **Why this is not speculative:** The prohibition is verbatim and unambiguous. The plan itself explicitly records the opposite target.
- **Minimal correction direction:** Restore the canonical scope to inspection-only plan review. Remove implementation, commit, durable TDD, and post-implementation verification obligations from this revision, or quote a later explicit user request if implementation is actually intended.

### B-02 Revision and approval metadata are internally invalid for the audited artifact

- **Violated invariant:** A substantive plan change must increment the revision, clear prior approval, and require a fresh full-scope audit. Implementation is allowed only when the current revision exactly equals the independently approved revision.
- **Evidence class:** contracted
- **Producer and execution path:** R1-approved plan content → substantive R2 compact voice requirement and implementation-scope change → current canonical metadata and audit record.
- **Source evidence:** `docs/plans/prompt-extension-bar-single-line.md:3-13`, `docs/plans/prompt-extension-bar-single-line.md:39-42`, `docs/plans/prompt-extension-bar-single-line.md:569-575`
- **Canonical-plan evidence:** The file declares `Revision: R1`, `Approved revision: R1`, and `Implementation allowed: yes`, while simultaneously recording that the compact voice requirement is substantive, that it invalidates R1 approval, and that the current content is an R2 revision awaiting audit.
- **Responsibility owner:** Canonical plan revision and approval-state administration.
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** The artifact presents both an implementation-permitted state and an implementation-disallowed pending-audit state. There is no single canonical revision whose approval can be relied upon, so an implementer cannot determine which exact design is authorized. This violates the repository’s hard gate for implementation and makes the claimed `APPROVE` release verdict unsafe.
- **Why this is not speculative:** The contradictory values and the stated R1/R2 transition are present directly in the current canonical file; the policy expressly requires exact revision equality.
- **Minimal correction direction:** Choose one canonical audited scope. For this user turn, set the plan to a non-implementation audit/analysis revision with implementation disallowed and remove the stale R1 approval claim. If a later implementation plan is desired, increment to a new revision and obtain a fresh full-scope audit before permitting implementation.

## Non-blocking findings

- The plan uses two different plan-phase comment estimates: section 17 estimates `E = 125`, `C >= 19`, while section 20/22 uses `E = 90`, `C >= 14` (`docs/plans/prompt-extension-bar-single-line.md:456-461`, `616-620`). Both stated minimums meet the 15% feasibility threshold, so this is an internal estimate inconsistency rather than a blocking design defect.
- Section 10.1 says the file label “yields first,” while the P0/P1/P2 table places file identity at P1 and usage/shortcut chrome at P2 (`docs/plans/prompt-extension-bar-single-line.md:297-300`, `346-352`). The priority table and extension-retention tests make the intended ordering recoverable, but the wording should be clarified before implementation.
- The verification summary says to record `[1, 1]` for transcribing and retry only, while the stated reproduction and invariant cover recording, transcribing, and retry (`docs/plans/prompt-extension-bar-single-line.md:248-253`, `493-495`). This should be made consistent with the complete active-voice scope.

## Rejected speculation

- No blocking concern is raised for malformed editor paths, ANSI/control sequences, plugin-owned multi-line content, or DialogAlert overflow. The plan provides no confirmed task-specific producer, threat model, or reproduced behavior requiring those changes.
- No fallback-path concern is raised against the proposed layout design itself. The plan explicitly rejects a width-specific alternate footer and describes one existing-Prompt layout path (`docs/plans/prompt-extension-bar-single-line.md:286-291`, `608-612`).
- No concern is raised about preserving full retry messages in Session state. The source currently passes the raw retry message through the status path, and the existing DialogAlert accepts the original string (`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1932-1956`, `packages/opencode/src/cli/cmd/tui/ui/dialog-alert.tsx:39-40`).

## Requirement and traceability coverage

The underlying behavioral analysis substantially covers the original visual scope, but the plan cannot be released because its scope and revision/approval contract were invalid in R2.

## Primary-path and fallback verdict

The proposed behavioral design identifies one authoritative Prompt layout path and no forbidden failure-triggered alternate footer.

**Verdict:** The primary-path design is structurally acceptable, but R2 is not authorized for implementation because B-01 and B-02 invalidated its scope and approval state.

## Release verdict

**BLOCK**

### Round 1 Independent Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- The priority wording in section 10.1 says the file label “yields first,” while section 10.2 classifies file identity as P1 and shortcut/usage chrome as lower-priority P2. The priority table, forward traceability, and extension-retention test make the intended behavior recoverable: the file may shrink from its preferred width, but P2 content must clip before useful file identity is lost. Clarifying this wording would reduce implementation ambiguity, but it does not leave confirmed behavior unmapped.
- The durable visual matrix explicitly exercises `recording` and `transcribing`, not `starting` and `stopping`. All four use the same Prompt branch at `component/prompt/index.tsx:1903-1911`; `starting` and `stopping` are shorter than the tested recording/transcribing strings at `prompt-voice-input.ts:223-230`. The common fixed-row boundary and worst-pressure cases provide behaviorally sensitive coverage, so separate cases are not a hard-gate requirement.
- Canonical metadata uses `Audit mode: full-scope` rather than the invocation’s phase label `plan`. The artifact is unambiguously a plan, has no approved revision, and prohibits implementation, so this is only a metadata terminology discrepancy.

## Rejected speculation

- Retry `action` loss is rejected. Action-bearing retry events are independently consumed by the Session route and open `DialogRetryAction` at `routes/session/index.tsx:451-468`; the proposed Prompt `details` dialog does not replace that path.
- A generic `DialogAlert` overflow repair is rejected. The current detail surface accepts the original message at `ui/dialog-alert.tsx:39-40`, and no reproduced dialog-specific defect was supplied.
- ANSI/control-character sanitization is rejected. No task-specific producer, threat model, or ownership proof establishes it as part of this layout repair.
- Multi-line plugin-hint compatibility is rejected. `Prompt.hint` is arbitrary plugin JSX, but no repository consumer or contract requires the Prompt extension bar to grow vertically for it.
- Voice-recorder, transcription-process, timeout, and cleanup changes are rejected. The reported pressure occurs in Prompt composition; the voice controller already owns those lifecycle concerns separately.

## Requirement and traceability coverage

- **Long file indicator:** Covered by INV-01 through INV-03, the measured `promptWidth()` owner, the 160-column renderer/75-column Prompt test, wide-cell filename coverage, and suffix/extension retention.
- **Long retry error:** Covered by INV-01, INV-04, INV-05, and INV-07. The plan removes the current 80/120-character mismatch visible at `component/prompt/index.tsx:1932-1966`, separates summary/actions/metadata, and preserves the raw Status message.
- **Clickable details:** Covered through the real rendered Prompt and mouse-visible `DialogAlert` behavior. The 81-120-character case is independently red-capable because current click handling only opens for messages longer than 120 characters.
- **Transcription indicator:** Covered without globally shortening shared voice wording. The Prompt layout owns local pressure, while `prompt-voice-input.ts`, `DialogPrompt`, and `QuestionPrompt` retain their shared text contract.
- **Single-row geometry:** Assigned to the existing Prompt extension-bar root at `component/prompt/index.tsx:1901-2090`, with final-frame row-count assertions rather than private formatter or source-text tests.
- **Information density and consistent style:** Covered by the stable lowercase `details` affordance, compact retry metadata, preserved state/action tokens, and explicit P0/P1/P2 disposition.
- **Forward traceability:** Every confirmed invariant maps to an existing production owner, an exact file change, and behaviorally sensitive verification.
- **Reverse traceability:** Every proposed production concept maps to observed, contracted, or reachable pressure. No new module, public API, setting, dependency, compatibility layer, or fallback is proposed.
- **Test sensitivity:** The details dead-zone test necessarily fails current code. The final-frame tests exercise the current terminal-width/local-width divergence and default-wrapping footer directly through the production Prompt seam.

## Primary-path and fallback verdict

The plan defines one authoritative path: unchanged Session/editor/voice inputs enter the existing Prompt, which uses its measured allocation, one fixed-height flex layout, non-wrapping variable summaries, prioritized fixed controls, and the existing detail dialog.

No failure-triggered alternate footer, width-specific replacement layout, catch-and-default success, compatibility path, or second semantic data source is introduced. Existing character thresholds and concatenated retry workarounds are explicitly removed. Diagnostic behavior remains the existing detail dialog and does not produce success-shaped output.

**Verdict:** Pass.

## Code quality and Chinese-comment verdict

The proposed change remains localized to the owning Prompt component and one existing real-render test seam. It does not expand public interfaces, add dependencies, introduce unused helpers, or authorize unrelated refactoring.

The plan estimates `E = 125` and commits to `C >= 19`, yielding `19 / 125 = 15.2%`. It explicitly requires recalculation against the implementation diff and distribution of qualifying Chinese explanatory comments near width ownership, priority, raw/detail separation, compact voice presentation, and behavioral-test intent. This satisfies the plan-phase feasibility and hard-minimum commitment gate; actual values remain subject to implementation audit.

**Verdict:** Pass for plan mode.

## Release verdict

**APPROVE**

This verdict applies only to canonical plan revision **R1** at `docs/plans/prompt-extension-bar-single-line.md`. It approves the plan for recording by the orchestrating agent; it does not authorize implementation unless the repository’s required approval transition is recorded and the user separately requests implementation.

Any substantive revision invalidates earlier approval. The orchestrating
primary agent must copy an independent verdict without paraphrasing and may set
approval only for the exact audited revision.

## 23. Implementation Evidence

Approved revision R5 was implemented without changing its behavior, owner,
files, test seam, or no-fallback contract. The implementation is frozen pending
an independent full-scope implementation audit.

### Actual Files and Diff

| File | Implemented responsibility | Raw diff | Whitespace-insensitive diff |
| --- | --- | ---: | ---: |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Use measured Prompt width; enforce one-row flex priority; separate normalized retry summary, unconditional `details`, retry metadata, interrupt, and raw-detail dialog path. | +83 / -79 | +45 / -41 |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | Add opt-in compact presentation while preserving default shared strings and lifecycle. | +6 / -5 | +6 / -5 |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | Exercise the real 160-column renderer / 75-column Prompt, five status frames, SDK status events, visible mouse hit target, display whitespace normalization, and raw dialog detail. | +183 / -7 | +183 / -7 |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | Lock default and main-Prompt compact voice labels, timer value, and stop shortcut. | +12 / -0 | +12 / -0 |

No production module, test file, configuration surface, dependency, schema,
generated artifact, migration, alternate footer, or fallback path was added.
The raw/semantic difference in the Prompt file is indentation caused by removing
the old unshrinkable nested retry wrappers; it is excluded from `E` as
formatter/pure-move text.

### Red-Green Test Evidence

| Slice | Red evidence | Green evidence |
| --- | --- | --- |
| Real Prompt state matrix | Original 160-terminal / 75-Prompt harness returned `{"idle":1,"busy":3,"recording":3,"transcribing":2,"retry":2}` instead of five one-row states. | Durable test and original loop return `[1, 1, 1, 1, 1]`. |
| Compact voice presentation | Formatter test expected `Starting...` and received `Starting voice...` before the compact option existed. | Compact labels are `Starting...`, `Rec 00:03 · alt+v stop`, `Saving...`, and `Transcribing...`; default strings remain unchanged. |
| Retry detail interaction | The first real mouse test timed out because OpenTUI's hit child `text` did not reliably bubble to the parent `box`. | Visible summary and `details` text own the same handler; clicking the rendered `details` coordinates opens `Retry Error`. |
| Display/detail separation | A newline and three repeated spaces could enter the footer through `SessionStatus.Info.retry.message`. | Footer fragments render on one line without repeated spaces, while the dialog retains `The socket   closed...`. |

### Verification Commands and Results

All commands ran from `packages/opencode` as required.

| Command | Result |
| --- | --- |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx --timeout 30000` | PASS: 10 passed, 0 failed, 30 assertions. |
| `bun test test/cli/tui/prompt-voice-input.test.ts --timeout 30000` | PASS: 22 passed, 1 pre-existing opt-in E2E skipped, 0 failed, 61 assertions. |
| `bun test test/cli/cmd/tui/session-integration.test.ts --timeout 30000` | PASS: 35 passed, 0 failed, 67 assertions. |
| `bun test test/util/locale.test.ts --timeout 30000` | PASS: 9 passed, 0 failed, 21 assertions. |
| `bun typecheck` | PASS: `tsgo --noEmit`. |
| `bun run build` | ENVIRONMENT BLOCKED: three default attempts failed while fetching `https://models.dev/api.json` with Bun `ECONNRESET`; an official live snapshot supplied through the repository-supported `MODELS_DEV_API_JSON` path reached the build and then stopped because `packages/app/node_modules/vite/bin/vite.js` is absent. Authorized `bun install --frozen-lockfile` retries against both configured mirror and `registry.npmjs.org` failed with `ConnectionClosed` manifest resolution. No unapproved offline URL, cache, or catch-and-success fallback was introduced. |
| `git diff --check -- <four implementation paths>` | PASS. |

### Original Feedback-Loop Result

The original temporary real-Prompt harness was rerun after the final diff:

```text
{"idle":1,"busy":1,"recording":1,"transcribing":1,"retry":1}
1 pass, 0 fail
```

Its diagnostic red before implementation was
`{"idle":1,"busy":3,"recording":3,"transcribing":2,"retry":2}`.
The harness is outside the repository and makes no repository change.

### Actual Secondary and Replacement Path Inventory

| Classification | Actual path | Verdict |
| --- | --- | --- |
| Primary | Editor/session/voice inputs → existing `Prompt` → measured Prompt width → one fixed-height extension row → shrinkable variable content plus fixed status/action tokens → existing `DialogAlert` for raw retry details. | Implemented and behaviorally verified. |
| Shared voice compatibility | `DialogPrompt` and `QuestionPrompt` omit the compact option and retain existing default strings. | Preserved and covered by formatter regression. |
| Secondary implementation | None. | No parallel footer or duplicate owner exists. |
| Replacement/fallback | None. | No width-specific layout, feature flag, retry parser fallback, cache, catch-and-success, or compatibility branch exists. |
| Removed workarounds | Terminal-wide file budget; 80-character summary truncation plus 120-character click gate; `(click to expand)`; one unshrinkable concatenated retry sentence. | Removed from the primary path and replaced by measured ownership and unconditional raw-detail routing. |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 194 | New-side non-blank code lines from `git diff -w --unified=0`; excludes import-only, blank, comment-only, formatter-only, generated, plan-document, and pure-move lines. |
| Qualifying Chinese comment lines `C` | 34 | Adjacent explanations cover measured-width ownership, P0/P1 priority, one-row clipping, raw/display separation, unconditional details, OpenTUI hit propagation, renderer setup, lifecycle cleanup, and compatibility. |
| Ratio `C / E` | 17.53% | `34 / 194`. |
| Required minimum `C` | 30 | `ceil(194 × 0.15) = 30`; actual exceeds the gate by 4. |

### Remaining Unverified Items

- Full cross-target `bun run build` remains partially unverified only for the
  `linux-arm64` Bun runtime extraction, which reports an incomplete download.
  The current-host production build `bun run build --single --skip-install`
  passed Web UI/Vite compilation, production `Bun.build`, and Windows x64 smoke.
- The pre-existing five-minute browser voice E2E remains opt-in and skipped;
  this implementation does not change recorder, transcriber, or browser
  lifecycle behavior.
- Independent full-scope implementation audit Round 3 returned
  `No blocking findings` and `APPROVE` for the exact R5 implementation diff.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | B-01 required production build verification is not passing. | 3 | BLOCK | `ses_09397929cffeBaht6ILV3E6IvL` |
| 2 | R5 | yes | B-01 required production build verification remains incomplete. | 3 | BLOCK | `ses_09397929cffeBaht6ILV3E6IvL` |
| 3 | R5 | yes | No blocking findings. | 4 | APPROVE | `ses_09397929cffeBaht6ILV3E6IvL` |

The frozen R5 implementation is verified by the Round 3 full-scope
`No blocking findings` and `APPROVE` result.

### Round 1 Independent Implementation Verdict (Verbatim)

## Blocking findings

### B-01 Required production build verification is not passing

- **Violated invariant:** Implementation completion requires all repository-mandated verification commands, including the production build, to pass before the implementation can be released or marked verified.
- **Evidence class:** contracted
- **Producer and execution path:** Changed Prompt/voice production code → `packages/opencode` build pipeline → `bun run build`.
- **Responsibility owner:** Release verification workflow / package build environment. The Prompt implementation itself is not the owner of the external snapshot fetch, but the release gate cannot be waived by passing typecheck or focused tests.
- **Concrete consequence:** The implementation cannot be marked `verified` or released because the production bundle has not completed successfully.
- **Minimal correction direction:** Re-run the required build where the `models.dev` snapshot and locked app dependencies are available, or use an approved repository-supported equivalent that completes the production build. Do not add an offline URL, catch-and-success behavior, or verification bypass.

## Non-blocking findings

- The visual matrix does not independently render `starting` and `stopping` voice states; shared active-voice container coverage and formatter assertions cover the same implementation path.
- The file frame asserts the recognizable `hotspots.md` suffix rather than a separate retained prefix assertion.
- The audit cannot independently reproduce the recorded line-classification script, but the distributed qualifying comments and reported ratio exceed the hard threshold.

## Release verdict

**BLOCK**

The implementation is behaviorally aligned with approved R5, the primary path is
sound, no fallback violation was found, and focused behavioral verification is
strong. The required `bun run build` has not passed, so the implementation cannot
transition to `verified` under repository policy.

### Round 2 Independent Implementation Verdict (Verbatim)

## Blocking findings

### B-01 Required production build verification remains incomplete

- **Violated invariant:** Implementation completion requires the repository's required production build verification to pass before the implementation can be released or marked `verified`.
- **Evidence class:** contracted
- **Responsibility owner:** Release verification/build environment. The Prompt change does not own dependency installation or the external model snapshot, but the release gate cannot be waived by passing focused tests and typecheck.
- **Concrete consequence:** The changed production TSX/runtime path has not been accepted by a completed production build; the implementation cannot transition to `verified` or be released under the hard verification contract.
- **Minimal correction direction:** Complete `bun run build` successfully after restoring the required app dependencies and/or making the required external snapshot available through the supported path. Do not bypass the build, introduce an unapproved offline source, or convert build failure into success.

## Non-blocking findings

- `starting` and `stopping` voice states are covered by shared formatter assertions and the same fixed-height active-voice branch rather than independent final-frame assertions.
- The `E = 194`, `C = 34` calculation is recorded above the hard threshold, though the auditor cannot reproduce the counting script from the artifact alone.

## Release verdict

**BLOCK**

This fresh full-scope audit confirms that the implementation diff still matches
approved R5, the original behavior is covered, the primary path is valid, and no
fallback or code-quality violation is present. The required production build
remains incomplete after the additional supported installation/build attempts;
the implementation cannot be released, committed as verified, or transitioned
to `verified` under repository policy.

### Round 3 Independent Implementation Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- The complete cross-target `bun run build` still cannot finish because Bun
  fails while extracting the `linux-arm64` runtime. The repository-supported
  `bun run build --single --skip-install` completes the shared Web UI/Vite
  embedding, current-host production `Bun.build`, compiled Sharp smoke, and
  generated `opencode --version` smoke path.
- `starting` and `stopping` use the same fixed-height active-voice container
  and have literal compact/default formatter assertions rather than separate
  final-frame assertions.
- The file frame asserts the useful `hotspots.md` suffix; no retained-prefix
  regression is established.
- The recorded `E = 194`, `C = 34` calculation is above the hard threshold,
  though the counting script is not independently reproduced by the auditor.

## Primary-path and fallback verdict

**Primary-path verdict:** PASS  
**Fallback verdict:** PASS

## Code quality and Chinese-comment verdict

**Code-quality verdict:** PASS  
**Chinese-comment verdict:** PASS  
**Verification verdict:** PASS for this implementation diff on the current
host; Linux ARM64 cross-target packaging remains explicitly unverified for
environmental reasons.

## Release verdict

**APPROVE**

This clean verdict applies only to the exact audited implementation diff against
approved canonical plan revision **R5**. The current-host production build and
smoke resolve the prior implementation-verification blocker. The unrelated
Linux ARM64 runtime extraction failure does not block this implementation
verdict and must not be represented as successful certification of all
cross-target release artifacts.

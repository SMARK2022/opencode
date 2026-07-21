# Canonical Implementation Plan: Edit Multi-Replacement and Normalized Match

> Status: verified
>
> Revision: R9
>
> Approved revision: R9
>
> Audit mode: full-scope
>
> Requirement source: User request on 2026-07-21 (verbatim in §1)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-21
>
> R9 closes R8 B-01: continuous `actualOld` is INV-16 history ground truth only;
> elevated disk apply remains Pi preserve (INV-04). Delete full-file
> `replace(actualOld)===contentNew` as an apply correctness rule.
>
> Plan audit: No blocking findings (adversarial-auditor task
> `ses_07dfdc31dffeBtupV2pkQw79fH`).
>
> Implementation audit: No blocking findings + APPROVE
> (adversarial-auditor task `ses_07db62000ffesxE1s8H9j9ikp9`).

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 请你针对如上的内容,详细完整检查一下PI的具体工具的设计以及相应内容。我觉得它的edit设置,相应的edits效果很好,也就是请你看看我们能否把相应的old code,new code这种逻辑改成edits,也就是一次可以编辑一大组的这种形式。与此同时,请你一页检查一下它的模糊、保守回退的一些算法方法,我希望也移植到我们的相应的逻辑里面。因此请你详细完整检查。当前是进入完整的方案构建阶段,我希望尽量能够适当地模仿相应PyAgent的构建和设计,但同时又要使用我们的设计语言和设计的命名规范。

Subsequent explicit addition (verbatim):

> 与此同时额外补充一点,理论上来说,如果模糊匹配了,那么我们也需要按照前一个逻辑,将old code进行适当的更新,来避免模型的内容和记忆和实际的内容不一样。也就是遵照我们那个格式化之后的代码,也进行适当old code的替换的逻辑一样。因此请兼顾到这一点。与此同时,如果你当前方案R6是不行的话,那么我最终允许你放行直到R12。同时再次提醒,请你保证你每一次的方案都是完整审计且高质量之后再提交线审计,也就是先自审。自审完成之后,觉得自己没有问题了,再进行审计员审计,避免滥用审计员。

Supporting analysis supplied by the user (not rewritten into new requirements,
but used as evidence of intended shape):

- Pi `edit` accepts `edits: [{ oldText, newText }, ...]` matched against one
  original snapshot, applied reverse-order, rejecting empty/not-found/duplicate/
  overlapping/no-op edits.
- Pi exact-match description is backed by exact-first then conservative
  normalized match (trailing whitespace, NFKC, smart quotes/dashes/spaces),
  preserving original bytes of untouched lines.
- OpenCode currently exposes single `oldString`/`newString`/`replaceAll` and
  true literal exact match; `closestWindow` is diagnostic-only.
- Prefer OpenCode naming (`filePath`, `oldString`, `newString`, `replaceAll`)
  while adopting Pi’s multi-edit and progressive match designs.

## 2. Explicit Non-Goals

- Do not change `apply_patch` / `packages/opencode/src/patch/**` success
  matching. Prior plan `docs/plans/edit-apply-patch-match-recovery.md` (R9
  verified) keeps Patch exact-only; this task does not reopen that contract.
- Do not change write/create permission, external-directory gate, LSP touch,
  Format, Snapshot, Bus/FileWatcher events, BOM preservation, or file locks
  beyond the data needed to describe multi-edit metadata.
- Do not add similarity-scored replacement success. `closestWindow` remains
  diagnostic-only after match failure.
- Do not add `matchMode` as a model-facing parameter in R1. Progressive
  exact→normalized is one primary matching contract (Pi behavior). Opt-in
  modes are rejected for this revision as under-specified product surface.
- Do not rename Tool id `edit`.
- Do not change `apply_patch` vs `edit` registry selection (`usePatch`).
- Do not port Pi TUI preview / renderCall / renderResult.
- Do not add network, config flags, migrations, or SDK package generation
  unless Effect Schema → Tool JSON Schema automatically surfaces the new
  parameters (expected, no manual SDK rewrite).

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Tool owns parameter schema + execute; Session/Message carry prior tool parts for blind-edit gate. |
| Root `AGENTS.md` | Package-local tests/typecheck; default base `dev`; parallel tools. |
| `packages/opencode/AGENTS.md` | Effect module shape; `bun typecheck` from package dir. |
| `packages/opencode/test/AGENTS.md` | Behavior tests through real Tool seam; real FS fixtures. |
| `.opencode/policy/first-principles-engineering.md` | One primary path; no invented fallbacks; full traceability; 15% Chinese comment gate. |
| `.opencode/templates/canonical-plan.md` | Required plan structure and approval gates. |
| `docs/plans/edit-apply-patch-match-recovery.md` (R9 verified) | Historical decision: Edit success was exact literal; closest is diagnostic-only. This task **explicitly supersedes only the Edit success match contract** for progressive normalized match and multi-edit; Patch remains exact-only. |
| Pi reference tree `.temp/pi/packages/coding-agent/src/core/tools/edit.ts` + `edit-diff.ts` | Source design to imitate under OpenCode naming. |
| Pi CHANGELOG 0.63.2 / prepareArguments | Mixed single-edit + multi-edit schemas caused invalid tool calls; final shape is `edits[]` only with legacy fold before validation. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/pi/.../edit.ts` | Schema `path`+`edits[]`; `prepareEditArguments` legacy fold; execute queue; prompt guidelines. | observed |
| `.temp/pi/.../edit-diff.ts` | `normalizeForFuzzyMatch`, `fuzzyFindText`, `applyEditsToNormalizedContent`, reverse apply, overlap reject, preserve unchanged lines. | observed |
| `.temp/pi/.../CHANGELOG.md` around multi-edit | Mixed schemas → invalid calls; `edits[]` only + `prepareArguments`. | observed |
| `packages/opencode/src/tool/edit.ts` | Current Parameters, blind-edit gate, create-via-empty-oldString, `replace`, lock, LSP/format/bus. | observed |
| `packages/opencode/src/tool/edit.txt` | Model contract: exact literal fail; multi-match fail; `replaceAll`. | contracted |
| `packages/opencode/src/patch/match.ts` | `closestWindow` diagnostic only; `locateExact` for Patch (out of scope). | observed |
| `packages/opencode/src/util/line-ending.ts` | LF normalize + file-level restore helpers. | contracted |
| `packages/opencode/src/util/bom.ts` | BOM strip/join used by edit write path. | contracted |
| `packages/opencode/src/tool/tool.ts` | Decode happens in wrapper; no `prepareArguments` hook today. | observed |
| `packages/opencode/src/tool/json-schema.ts` | Optional `jsonSchema` override on Tool.Def. | observed |
| `packages/opencode/src/tool/todo.ts` | Nested array item schema pattern (`Schema.Array(Struct)`). | observed |
| `packages/opencode/src/tool/write.ts` | Auto-format ground-truth: `metadata._formattedContent` when format changes disk. | observed |
| `packages/opencode/src/session/processor.ts` `completeToolCall` | Consumes `_formattedContent` to overwrite `state.input.content`; strips key from persisted metadata. | observed |
| `packages/opencode/test/tool/write.test.ts` | Proves `_formattedContent` set/not-set. | observed |
| `packages/opencode/test/tool/edit.test.ts` | Tool seam coverage: create, replace, replaceAll, multi-match reject, nonliteral reject, closest, blind edit, CRLF/BOM. | observed |
| `packages/opencode/src/tool/registry.ts` | Edit registration and patch/edit mutual exclusion. | reachable |

## 5. Current Behavior

```text
Model tool call
  -> Tool wrapper Schema.decode(Parameters)
  -> EditTool.execute
      -> blind-edit gate (oldString !== "" requires prior read/write/edit of same path)
      -> assertExternalDirectory
      -> per-file Semaphore lock
      -> if oldString === "": create/overwrite path with newString
      -> else: Bom.readFile -> convert old/new to file line ending
           -> replace(content, old, new, replaceAll?)  // exact indexOf only
           -> permission ask(diff) -> write -> format -> bus
      -> LSP diagnostics delta in result
```

`replace` success domain today:

1. unique exact literal `oldString` → single replacement
2. exact `replaceAll: true` → all literal occurrences
3. otherwise throw (not found with optional closest excerpt, or multiple matches)

No multi-region batching. No unicode/whitespace normalized success path.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Single exact unique `oldString` | Model via Tool | Prior read gate when non-empty | `EditTool` → `replace` | Edit Tool | observed |
| `replaceAll: true` multi exact | Model | Explicit flag | `replace` | Edit Tool | observed |
| `oldString === ""` create/overwrite | Model | No prior-read required | create branch | Edit Tool | observed |
| Multi discrete regions same file | Model (desired) | Not supported; needs N tool calls or apply_patch | missing | Edit Tool | contracted (user requirement) |
| Smart quotes / unicode dash / trailing WS drift vs file | Model copy from chat/OCR/read normalization | Currently fails exact; Pi succeeds via normalize | missing success path | Edit match owner | observed (Pi) + user request |
| Overlapping multi-edits | Model | Must reject | missing | Edit match owner | reachable |
| Duplicate non-`replaceAll` match | Model | Must reject | `replace` | Edit Tool | observed |
| Blind edit without prior read | Model | Must reject | gate in execute | Edit Tool | observed |
| `apply_patch` hunk match | Model when usePatch | Out of scope | Patch owner | Patch | observed |
| Speculative hostile concurrent writers outside lock | External process | Not owned | N/A | N/A | speculative |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | One `edit` call may apply one or more non-overlapping replacements to a single file, all matched against the same pre-edit snapshot. | User requirement; Pi `applyEditsToNormalizedContent` | none (multi) / single covered |
| INV-02 | Each non-`replaceAll` edit’s `oldString` must resolve to exactly one occurrence under the **sole occurrence coordinate system** defined in §10 (Pi-aligned). Ambiguity rejects without write. | Pi `countOccurrences` always normalize-aware; OpenCode multi-match test | `rejects duplicate exact matches without replaceAll` + hybrid dash/quote fixture |
| INV-03 | Progressive locate: try exact literal first on the batch base, then normalized form (NFKC + line `trimEnd` + smart quotes/dashes/special spaces → ASCII/space). Locate never invents similarity scores. | Pi `fuzzyFindText`; user port request | none for success; nonliteral suite currently expects fail for some of these |
| INV-04 | When the batch elevated to normalized apply space, write-back preserves original bytes of line blocks not touched by replacements. | Pi `applyReplacementsPreservingUnchangedLines` | none |
| INV-05 | Overlapping matched ranges across the batch reject before write. | Pi overlap check | none |
| INV-06 | Empty `oldString` is only valid as the single create/overwrite edit (length-1 batch). Multi-edit entries may not use empty `oldString`. | OpenCode create path; Pi empty reject adapted | create tests |
| INV-07 | Explicit `replaceAll: true` expands **every** occurrence of that edit’s `oldString` counted in the same sole occurrence coordinate system as INV-02; still subject to batch overlap rejection against other edits. | OpenCode replaceAll + Pi occurrence domain | `replaces all occurrences with replaceAll option` + hybrid multi-occurrence case |
| INV-08 | No-op batch (final content === original) rejects. | Pi `getNoChangeError`; OpenCode identical old/new | identical tests (partial) |
| INV-09 | Model-facing JSON Schema / Parameters present `filePath` + `edits[]` as the only replacement shape (no top-level `oldString`/`newString`/`replaceAll`). Legacy top-level fields are folded before schema validation and are not advertised on the wire. | Pi CHANGELOG #2639; `test/tool/parameters.test.ts` | parameters suite + execute legacy fold |
| INV-10 | Naming stays OpenCode: `filePath`, `oldString`, `newString`, `replaceAll`, `edits` — not Pi `path`/`oldText`/`newText`. | User requirement | n/a |
| INV-11 | Blind-edit, permission, BOM, line-ending write-back, LSP, format, events remain for successful multi-edit. | Current edit.ts | existing suite |
| INV-12 | Match failure still may attach `closestWindow` diagnostic; closest never becomes success. | R9 plan; current `replace` | closest tests |
| INV-13 | Indent/tab/escape/anchor mismatches that are **not** covered by the defined normalizer still fail (not a free fuzzy scorer). | User analysis of semantic risk; current nonliteral tests partially | `rejects every nonliteral replacement class` (must be revised only for normalizer-covered classes) |
| INV-14 | Non-create `oldString` whose `normalizeForMatch(oldString)` is empty (e.g. only spaces/tabs that trimEnd to `""`) is rejected before locate/expand. Create remains only raw `oldString === ""` on a length-1 batch. | R5 plan audit B-01; empty-needle `indexOf`/`replaceAll` hazard | new reject fixture |
| INV-15 | All `packages/opencode` TypeScript sites that type against Edit Parameters top-level `oldString`/`newString`/`replaceAll` compile after the schema change (`bun typecheck`). | R5 plan audit B-02; TUI `props.input.replaceAll` | typecheck + minimal TUI/display read of `edits[0]` |
| INV-16 | After a successful Edit, persisted tool `state.input` must reflect disk ground truth for the model’s memory: (a) when match used actual file bytes that differ from the model-supplied `oldString`, rewrite each edit’s `oldString` to the actual pre-edit slice(s); (b) when auto-format changes a create/overwrite payload (empty `oldString` singleton), rewrite `edits[0].newString` to the final on-disk text — same product contract as write’s `_formattedContent` → `input.content`. Channel is ephemeral metadata stripped before durable metadata store. | User R7 addition; `write.ts` + `processor.ts` completeToolCall | write tests for format; new edit match-sync + create-format tests |

## 8. First Divergence and Root Cause

This is a feature gap, not a production incident. The first divergence from the
desired invariants:

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `Parameters` only allows one `oldString`/`newString` pair; execute applies one `replace`. | `packages/opencode/src/tool/edit.ts` Tool parameters + execute | Parameters lines 36–45; execute single replace |
| INV-03 | `replace` only uses `indexOf` exact match; no normalized stage. | `edit.ts` `replace` | lines 308–331 |
| INV-09 | Tool wrapper has no pre-decode argument fold; cannot safely hide legacy fields from model schema while accepting them. | `packages/opencode/src/tool/tool.ts` | decode at line 131 with no prepare hook |
| INV-16 | Edit never rewrites persisted `state.input` after match/format; only write uses `_formattedContent` → `input.content`. | `edit.ts` + `processor.ts` | write path only; edit leaves model oldString even if match was non-literal |

Root cause of multi-edit gap: Edit Tool’s public contract is single-replacement.

Root cause of match fragility vs Pi: success domain intentionally literal-only
(post R9). User now explicitly expands Edit success domain to progressive
normalized match for Edit only.

Root cause of memory drift after non-exact match / create-format: Edit does not
participate in the write/processor ground-truth input rewrite channel.

Red-capable feedback for the feature seam (TDD):

```text
cd packages/opencode && bun test test/tool/edit.test.ts
```

Current result (pre-change): multi-edit and normalized-match cases do not exist;
nonliteral suite asserts failure for trailing-space / smart-quote style inputs
that will become success under INV-03.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Model-visible edit parameters + prompt text | `tool/edit.ts` + `edit.txt` | `filePath` + `edits[]` | Tool owns Agent-facing schema | Patch has different language |
| Legacy argument fold before validation | `tool/tool.ts` optional `prepareArguments` + edit registration | raw args → schema shape | Pi evidence: must run pre-decode | Schema-only union re-exposes mixed shape in JSON Schema |
| Batch match + apply pure function | New `tool/edit-apply.ts` (prefer dedicated file mirroring Pi `edit-diff.ts` depth) | `applyEdits → { contentNew, usedNormalized, syncEdits }` | Pure string transform + actual-old extraction | `patch/match.ts` owns Patch locate + diagnostic closest; must not absorb Edit batch apply |
| Progressive exact→normalized locate | Same edit-apply owner | find unique ranges | Edit-specific success contract | Do not reuse for Patch success |
| Preserve untouched lines under normalized apply | Same edit-apply owner | byte-stable write-back | Only needed when normalized base differs | N/A |
| Actual matched old slices for input sync | Same edit-apply owner returns per-edit actual old text | apply result includes `syncEdits` | Match owner knows ranges + original bytes | Processor must not re-parse files |
| Emit ephemeral ground-truth input | `EditTool.execute` metadata `_syncInput` | strip-before-persist channel | Same product contract as write `_formattedContent` | Processor only merges; does not invent match truth |
| Persist ground-truth tool input | `session/processor.ts` `completeToolCall` | merge `_syncInput` into `state.input`; keep write `_formattedContent` | Already owns terminal tool part write | Tools must not write Message parts directly |
| Diagnostic closest excerpt | existing `patch/match.closestWindow` | failure messages only | Already shared | Unchanged |
| File IO, lock, permission, format, LSP | `EditTool.execute` | side effects after pure apply | Existing ownership | apply module stays pure |

## 10. Single Approved Primary-Path Design

```text
raw tool args
  -> prepareArguments (edit): fold legacy top-level oldString/newString/replaceAll into edits[]
     - if typeof edits === string: JSON.parse array (Pi model quirk)
     - if edits missing and oldString/newString present: edits = [{ oldString, newString, replaceAll }]
     - strip top-level oldString/newString/replaceAll after fold
  -> Schema.decode(Parameters): { filePath, edits: [{ oldString, newString, replaceAll? }, ...] }
  -> EditTool.execute
      -> require edits.length >= 1
      -> blind-edit gate when any edit.oldString !== ""
      -> assertExternalDirectory (metadata includes full edits summary)
      -> lock(filePath)
      -> if isCreate(edits): single empty oldString → create/overwrite path (existing semantics)
      -> else:
           Bom.readFile
           ending = detectLineEnding(content)
           baseLF = normalizeLineEndings(content)
           editsLF = map normalizeLineEndings on old/new
           { contentNewLF, usedNormalized, syncEdits } = applyEdits(baseLF, editsLF)
               // probe elevation → single replacementBase
               // findMatch / count / replaceAll expand on replacementBase only
               // overlap reject; reverse apply; preserve if usedNormalized
               // newString never normalizeForMatch
               // syncEdits: actual old slices from original bytes (INV-16)
           contentNew = convertToLineEnding(contentNewLF, ending)
           reject if contentNew === contentOld (no-op)
           ask permission with combined diff
           write Bom.join → format.file → maybe re-read final
           build metadata._syncInput when ground-truth differs (INV-16)
           bus
      -> create path also: format → maybe _syncInput.edits[0].newString = final
      -> LSP delta + output "Edit applied successfully." (+ count of blocks)
```

### Ground-truth input sync (INV-16; write/`_formattedContent` parity)

**Why:** After normalized match, model `oldString` may differ from bytes actually
removed. After create + auto-format, model `newString` may differ from disk.
History replay must carry disk truth (write already rewrites `input.content`
via `_formattedContent`).

**Channel:**

| Producer | Ephemeral metadata | Processor effect |
| --- | --- | --- |
| `write` (unchanged) | `_formattedContent: string` | `input.content = value` only |
| `edit` (new) | `_syncInput: { filePath?: string, edits: EditReplacement[] }` | **Replace** the edit parameter surface (see below) |

`completeToolCall` (resolves R7 B-02):

1. If `_syncInput` is a non-null object with `edits` array:
   ```text
   next = {
     filePath: string from _syncInput.filePath if present,
               else existing state.input.filePath,
     edits: _syncInput.edits,
   }
   // Explicitly drop legacy top-level oldString / newString / replaceAll
   // and any other obsolete replacement keys from the prior input object.
   state.input = next
   ```
   This is **not** a shallow merge that leaves stale top-level fields beside
   `edits`. Legacy stream args store `{ filePath, oldString, newString }`;
   after success the persisted input must be **only** `{ filePath, edits }`.
2. Else if `_formattedContent` is a string → set `input.content` (write path;
   leave other keys).
3. Strip `_syncInput` and `_formattedContent` from durable metadata and from the
   event-metadata strip path (~549).

**`actualOld` = continuous pre-edit needle (resolves R7 B-01):**

`actualOld` must be a contiguous substring of pre-edit `baseLF` such that, for
that occurrence, substituting `actualOld → newString` on `baseLF` is the same
substitution the match intended. It must **not** expand to an entire preserve
line-block that is larger than the matched needle (mid-line smart-quote case).

Construction after ranges are known on `replacementBase`:

1. If `!usedNormalized` (ranges already on `baseLF`):  
   `actualOldSlice = baseLF.slice(start, start + length)` per range.
2. If `usedNormalized`: build `normalizeWithMap(baseLF)` once:
   - Produce `normalized` text equal to `normalizeForMatch(baseLF)`.
   - Produce `map: number[]` where `map[i]` is the start index in `baseLF` of
     the original span that produced normalized character `i`, and
     `map[normalized.length]` is the end index after the last character.
   - NFKC / deleted trailing spaces / quote folds must advance the original
     cursor correctly (deleted originals contribute no normalized chars;
     multi-codepoint NFKC expands map entries accordingly).
   - For a range `[nStart, nStart+nLen)` on `replacementBase` (which equals
     `normalized` when elevated):  
     `actualOldSlice = baseLF.slice(map[nStart], map[nStart + nLen])`.
3. **Forbidden:** using preserve’s full rewritten line-block text as `oldString`
   when the match needle is a mid-line substring.
4. `actualOld` aggregation per edit:
   - one hit → that slice;
   - `replaceAll` with all slices byte-identical → that slice;
   - `replaceAll` with heterogeneous slices → keep model `oldString`
     (document in `edit.txt`).
5. `syncEdits[i] = { oldString: actualOld, newString: edit.newString (LF form), replaceAll? }`.

**Separation of concerns (resolves R8 B-01):**

- **Disk apply (INV-04):** when `usedNormalized`, write-back is Pi preserve
  (touched line blocks may drop trailing spaces / normalize other characters on
  those lines only). Hand-written file expectations must follow preserve, not
  continuous-only whole-file replace.
- **History `oldString` (INV-16):** continuous `actualOld` is only what the model
  is told was the matched needle. It must remain mid-line scoped. It is **not**
  a second apply algorithm and must **not** be used as a full-file oracle for
  `contentNewLF`.

Emit `_syncInput` when any `actualOld !== model oldString`, or create+format
rewrites `newString`, or legacy top-level keys were present and must be cleared
after success (if execute knows args were folded from legacy, always emit
`_syncInput: { filePath, edits: syncEdits }` on success so top-level keys die).
Simplest correct rule: **on every successful non-noop edit/create, emit
`_syncInput: { filePath, edits: syncEditsOrCreate }`** so the parameter surface
is always canonical after success.

**Create + auto-format:** after format, if final LF text ≠ applied newString,
`sync` newString to finalText; still full `_syncInput` shape with
`edits: [{ oldString: "", newString: finalText }]`.

**Non-create + auto-format:** do not invent surgical multi-region `newString`
rewrites; match-phase `actualOld` still applies; post-format diff uses re-read.

**Permission ask** may show model-proposed edits; completed `state.input` is
ground-truth after `_syncInput`.

### Progressive match contract (one path; sole occurrence domain)

Port Pi’s owner algorithm (`.temp/pi/.../edit-diff.ts` `applyEditsToNormalizedContent`
+ `fuzzyFindText` + `countOccurrences`). OpenCode names differ; semantics do not.

**Normalizer `normalizeForMatch` (closed set, Pi):**

- `String.prototype.normalize("NFKC")`
- per-line `trimEnd`
- smart single quotes `\u2018\u2019\u201A\u201B` → `'`
- smart double quotes `\u201C\u201D\u201E\u201F` → `"`
- dashes `\u2010-\u2015\u2212` → `-`
- special spaces `\u00A0\u2002-\u200A\u202F\u205F\u3000` → ` `

**`findMatch(content, oldString)` (Pi `fuzzyFindText`):**

1. Exact: `content.indexOf(oldString)`; if hit → `{ found, index, matchLength: oldString.length, usedNormalized: false, contentForReplacement: content }`.
2. Else normalized: `nContent = normalizeForMatch(content)`, `nOld = normalizeForMatch(oldString)`; if `nContent.indexOf(nOld)` hit → offsets **in normalized space**, `usedNormalized: true`, `contentForReplacement: nContent`.
3. Else not found.

**Sole occurrence + apply coordinate system (resolves R1 B-01 and R2 B-01):**

Pi’s uniqueness is not “exact count if exact located.” `countOccurrences` always
projects both sides through `normalizeForMatch` before counting
(`edit-diff.ts:251-255`). Pi has no `replaceAll`; OpenCode extends the same
domain without inventing a second exact-only expander.

**Definitions**

- `countOccurrences(c, s)` = number of non-overlapping hits of
  `normalizeForMatch(s)` inside `normalizeForMatch(c)` (Pi split-count).
- `needsNormalizedOccurrenceDomain(base, edit)` is true when
  `countOccurrences(base, edit.oldString) > 0` and at least one of:
  - `findMatch(base, edit.oldString).usedNormalized === true`, or
  - `countOccurrences(base, edit.oldString) !==` exact `indexOf` walk count of
    literal `oldString` in `base` (hybrid siblings / length-changing normalizer
    cases where exact walk under-counts the sole domain).

**Empty-after-normalize guard (resolves R5 B-01):**

For every non-create edit, before elevation/locate/expand:

```text
if (normalizeForMatch(edit.oldString).length === 0)
  reject (empty/ineffective oldString after normalization)
```

Raw `oldString === ""` is still only legal on the length-1 create branch (INV-06).
Whitespace-only needles such as `"   "` or `"\t"` are **not** create and **not**
successful replace under R6 — they reject. This preserves a closed domain and
avoids empty-needle `indexOf("")` / non-advancing expansion.

**OpenCode sole rule (no cross-string map-back):**

**Single elevation predicate** (implement exactly this):

```text
exactLiteralCount(base, s) =
  non-overlapping indexOf walks of literal s in base

usedNormalized =
  edits.some(e => findMatch(baseLF, e.oldString).usedNormalized)
  || edits.some(e =>
       countOccurrences(baseLF, e.oldString) !== exactLiteralCount(baseLF, e.oldString)
     )
```

Rationale: if normalize-aware count differs from exact literal count (hybrid
en-dash siblings, or any case where exact under/over-counts the sole domain),
elevate even when the first hit was exact. If every edit’s first hit is exact
**and** counts agree, stay on raw base — including ordinary `replaceAll` of pure
ASCII tokens in files that only have unrelated trailing spaces elsewhere.

1. Compute `usedNormalized` with the predicate above.
2. **`replacementBase = usedNormalized ? normalizeForMatch(baseLF) : baseLF`.**  
   All subsequent locate / count / expand offsets are indices into
   **`replacementBase` only**. Never take indices from string A and apply them
   to string B.
3. **Locate on `replacementBase`:** for each edit,  
   `match = findMatch(replacementBase, edit.oldString)`. Not found → reject.  
   On elevated base, exact stage is exact-in-normalized-space.
4. **Count on `replacementBase` (always via `countOccurrences`, Pi):**  
   `occurrences = countOccurrences(replacementBase, edit.oldString)`.
5. **Uniqueness:** if `occurrences > 1` and `replaceAll !== true` → reject.
6. **Range expansion — branch on elevation only (resolves R3 B-01):**

   | `usedNormalized` | How to build ranges for one edit |
   | --- | --- |
   | `false` | Non-overlapping exact `indexOf(edit.oldString)` walks **on `replacementBase` (= baseLF)**. If `replaceAll`, take every hit; else take the single unique hit. Equivalent success bytes to today’s `content.replaceAll` / single replace when counts agree. |
   | `true` | Non-overlapping walks of `normalizeForMatch(edit.oldString)` **on `replacementBase` (= normalizeForMatch(baseLF))**. If `replaceAll`, every hit; else the single unique hit. |

   Forbidden in all cases:

   - Enumerating spans on `normalizeForMatch(X)` and applying those offsets to `X` when `normalizeForMatch(X) !== X`.
   - Using raw `baseLF.replaceAll` after elevation (misses hybrid siblings; wrong coordinate system if mixed with normalized offsets).

7. **`newString` is never passed through `normalizeForMatch`.** Only LF-normalize
   for the line-ending workspace. Insert literal `newString` at each range on
   `replacementBase` (then preserve overlay when elevated).
8. **Apply:**  
   - if `usedNormalized`:  
     `applyReplacementsPreservingUnchangedLines(baseLF, replacementBase, ranges)`  
   - else: apply ranges directly on `baseLF` (`replacementBase === baseLF`).  
   Reverse-offset order. Overlap reject after all ranges (including replaceAll
   expansions) are known.

**Fixtures that must be locked by tests:**

- Content `x-y` + `x\u2013y`, `oldString = "x-y"`, no `replaceAll` → **reject**;
  file unchanged.
- Same, `replaceAll: true` → elevate (`count !== exactLiteralCount`); both
  siblings replaced; independent expected final string.
- Unique smart-quote / trailing-WS match elevates; untouched line with trailing
  spaces keeps those bytes (INV-04).
- **R3 B-01 regression:**  
  `base = "pad  \nfoo bar foo"`, `oldString = "foo"`, `replaceAll: true` →  
  `usedNormalized = false` (exact count equals normalize count); expand with
  exact walks on raw base; final file  
  `"pad  \nqux bar qux"` (trailing spaces on `pad` line preserved; not shifted
  by a normalized offset). Hand-written expected string only.
- Tab/indent/escape/anchor still fail (INV-13).

**Not in normalizer (still fail):** tab↔space indent conversion, escape
sequences (`\\n` vs newline), arbitrary anchors, Levenshtein/closest scoring.

### Multi-edit apply

- Match all edits against one pre-edit snapshot (not sequential intermediate files).
  Locate+count+expand for **every** edit completes before any replacement mutates
  the working string. Sequential “apply edit 0, then match edit 1 on the result”
  is a forbidden implementation of INV-01.
- Behaviorally sensitive case (must reject under snapshot, would succeed under
  sequential): content `"foo"` with  
  `edits: [{ oldString: "foo", newString: "bar" }, { oldString: "bar", newString: "baz" }]`  
  → second `oldString` is absent from the original snapshot → not-found; file stays `"foo"`.
- After locate+expand, sort all ranges by start offset; reject overlaps.
- Apply from highest offset to lowest.
- `replaceAll` expansions participate in the same overlap check.

### Schema (model-facing)

```ts
EditReplacement = {
  oldString: string  // unique unless replaceAll; non-empty except create singleton
  newString: string
  replaceAll?: boolean
}

Parameters = {
  filePath: string
  edits: EditReplacement[]  // min length 1
}
```

`Parameters` Effect Schema and `ToolJsonSchema.fromSchema(Parameters)` / registry
wire JSON Schema must expose **only** `filePath` + `edits` (items with
`oldString`/`newString`/`replaceAll`). Top-level `oldString`/`newString`/
`replaceAll` must **not** appear as properties on the tool input schema.

Legacy fold is invisible to models (pre-decode only).

**When both `edits` and top-level pair are present:** fold **only if** `edits`
is missing/empty after optional JSON-string parse. Do **not** append legacy into
an already-provided `edits` array (intentional OpenCode narrowing vs Pi
`edits.push(legacy)`). If both are present with non-empty `edits`, drop legacy
fields and keep `edits` as authoritative.

### Naming map (Pi → OpenCode)

| Pi | OpenCode |
| --- | --- |
| `path` | `filePath` |
| `oldText` / `newText` | `oldString` / `newString` |
| `edits[]` | `edits[]` |
| `normalizeForFuzzyMatch` | `normalizeForMatch` |
| `fuzzyFindText` | `findMatch` (returns exact \| normalized) |
| `applyEditsToNormalizedContent` | `applyEdits` |
| `usedFuzzyMatch` | `usedNormalized` |
| (none) | `replaceAll` (retained) |

### Why this repairs the first divergence

- Multi-edit gap is closed at the Tool parameter + pure apply owner.
- Match fragility for common model copy artifacts is closed by progressive
  normalized stage inside the same apply function — not a second competing
  replacer chain.
- Mixed-schema risk is closed by `edits[]`-only public schema + pre-decode fold.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Exact unique replace | current + proposed stage 1 | primary-contract branch | yes | ~35% | preserve as stage 1 |
| Normalized unique replace | proposed stage 2 | primary-contract branch (same contract) | yes | ~20% | add |
| `replaceAll` in sole domain (elevate when normalize count ≠ exact count) | proposed supersedes exact-only replaceAll | primary-contract branch | yes | ~15% | replace current exact-only expander |
| Create via empty oldString singleton | current | primary-contract branch | yes | ~10% | preserve |
| Multi-edit batch | proposed | primary-contract branch | yes | ~10% | add |
| Legacy top-level oldString fold | proposed | existing compatibility (pre-decode) | n/a (input only) | ~5% | add, Tool boundary only |
| `_syncInput` / write `_formattedContent` ground-truth input | proposed / existing | pass-through observability (input rewrite, not alternate match) | n/a success | diagnostic/compat | add edit; preserve write |
| `closestWindow` on failure | current | diagnostic | no | diagnostic | preserve |
| Historical whitespace/indent/escape/anchor success replacers | removed by R9 | forbidden fallback | would yes | 0 | remain deleted |
| Similarity-scored success | never | forbidden fallback | would yes | 0 | reject |
| `matchMode` model parameter | user analysis idea | speculative product surface | n/a | 0 | reject R1 |
| Apply_patch normalized success | not requested | out of scope | n/a | 0 | reject |

New alternate success paths invented after primary failure: **none**. Stage 2 is
part of the defined progressive match domain, not “exact failed → try unrelated
scorer”.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Multiple sequential `edit` calls for one file | Single-pair API | One call multi `edits[]` | Model guidance in `edit.txt` |
| Use `apply_patch` for multi-hunk same file | Only batch editor | Edit multi remains simpler for small discrete string edits; apply_patch stays available | no code deletion |
| R9 exact-only Edit success (subset) | Predictability after fuzzy history | User now explicitly expands Edit progressive match; Patch remains exact-only | Update edit contract + tests; do not reintroduce pre-R9 multi-strategy replacer chain |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 multi-edit snapshot | prepare→decode→applyEdits→write | `edit.ts`, `edit-apply.ts`, `edit.txt` | two disjoint regions succeed; dependency case rejects (see TDD slice 1b) |
| INV-02 uniqueness | applyEdits sole occurrence domain | `edit-apply.ts` | ambiguous exact-looking hybrid dash case rejects; multi-edit ambiguous rejects |
| INV-03 progressive match | findMatch exact then normalized + elevation | `edit-apply.ts` | unique smart quote / trailing WS succeeds; tab-indent still fails |
| INV-04 preserve untouched lines | apply with preserve helper | `edit-apply.ts` | untouched trailing spaces kept when another line matches normalized |
| INV-05 overlap | applyEdits range check | `edit-apply.ts` | overlapping edits reject; file unchanged |
| INV-06 create | execute create branch | `edit.ts` | empty singleton still creates; empty in multi-edit rejects |
| INV-07 replaceAll | expand in sole occurrence domain | `edit-apply.ts` + `edit.ts` | exact replaceAll; hybrid en-dash siblings both replaced when replaceAll |
| INV-08 no-op | applyEdits / execute | `edit.ts` | identical content rejects |
| INV-09 wire schema + fold | Parameters + prepareArguments + parameters tests | `tool.ts`, `edit.ts`, `parameters.test.ts`, snapshot | JSON Schema required filePath+edits only; no top-level oldString; legacy execute still works |
| INV-10 naming | Parameters field names | `edit.ts` | type/schema assertions / usage |
| INV-11 side effects | execute post-apply | `edit.ts` | existing event/BOM/CRLF/LSP tests still pass |
| INV-12 diagnostic | replace failure path | `edit.ts` | not-found still may include closest |
| INV-13 non-normalizer classes fail | findMatch | `edit-apply.ts` | tab/indent/escape/anchor still fail |
| INV-14 empty-after-normalize reject | applyEdits pre-locate guard | `edit-apply.ts`, `edit.txt` | `"   "` / `"\t"` reject; file unchanged |
| INV-15 typed consumers compile | TUI read `edits[0]` | session TUI files in §15 | `bun typecheck` green |
| INV-16 match oldString actualize | applyEdits syncEdits + `_syncInput` | `edit-apply.ts`, `edit.ts` | tool result metadata has actual old; optional processor test |
| INV-16 create+format newString | execute after format | `edit.ts` | `_syncInput.edits[0].newString === final disk` |
| INV-16 processor merge | completeToolCall | `session/processor.ts` | `_syncInput` merges; keys stripped; write `_formattedContent` still works |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `edits[]` parameter | INV-01, INV-09, INV-10 | User + Pi | Current Parameters is single pair |
| `prepareArguments` on Tool.Def | INV-09 | Pi CHANGELOG; tool.ts decode order | No pre-decode hook; dual fields in Schema pollute JSON Schema |
| `edit-apply.ts` pure module | INV-01–08, INV-14 | Pi edit-diff split | `replace` is single-shot and embedded in edit.ts; collapse/delete superseded `export function replace` so no second success replacer remains |
| TUI/ACP `edits[0]` field migration | INV-15 | typed `props.input.replaceAll` sites | Schema change breaks typecheck without these edits |
| `applyEdits` → `syncEdits` actual old slices | INV-16 | match ranges + original bytes | Processor cannot re-derive match truth |
| Edit `_syncInput` metadata | INV-16 | write `_formattedContent` pattern | Edit has no full-file `content` field |
| Processor `_syncInput` merge | INV-16 | completeToolCall already rewrites write input | Extend same seam; keep write key |
| `normalizeForMatch` | INV-03 | Pi algorithm | No normalizer in success path |
| `countOccurrences` always normalize-aware | INV-02, INV-07 | Pi `countOccurrences` | Exact `indexOf` count is a second domain (R1 B-01) |
| Preserve-unchanged-lines apply | INV-04 | Pi | Exact apply does not rewrite normalization space |
| Overlap detection | INV-05 | Pi | Single edit has no batch ranges |
| Batch elevation to normalized space | INV-03 | Pi `usedFuzzyMatch` batch rule | N/A today |
| parameters.test + snapshot wire proof | INV-09 | existing parameters suite | execute-only tests cannot prove LLM schema |
| `edit.txt` multi-edit guidance | INV-01 | Pi promptGuidelines | Current text only describes single pair |
| Per-edit `replaceAll` | INV-07 | OpenCode existing flag | Must move flag into array items |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/tool.ts` | modify | Optional `prepareArguments?(args: unknown): unknown` invoked before `Schema.decode` | +10–20 |
| `packages/opencode/src/tool/edit-apply.ts` | add | Pure: normalizeForMatch, findMatch, countOccurrences, applyEdits, preserve helper, actual-old extraction → syncEdits, errors | +280–380 |
| `packages/opencode/src/tool/edit.ts` | modify | Parameters → filePath+edits only; prepareArguments fold; execute uses applyEdits; emit `_syncInput`; create+format newString sync; keep create/IO/LSP | +100 / −60 net ~+50–100 |
| `packages/opencode/src/session/processor.ts` | modify | completeToolCall: merge `_syncInput` into input; strip `_syncInput` + existing `_formattedContent` | +15–30 |
| `packages/opencode/src/tool/edit.txt` | modify | Document edits[], snapshot match, non-overlap, progressive locate, sole occurrence domain, replaceAll, create singleton | rewrite ~30 lines |
| `packages/opencode/test/tool/edit.test.ts` | modify | Multi-edit, overlap, normalized success, hybrid uniqueness, replaceAll hybrid, preserve bytes, legacy fold, nonliteral split | +220–300 |
| `packages/opencode/test/tool/parameters.test.ts` | modify | Decode accepts edits shape; rejects missing edits; wire JSON Schema has no top-level oldString | +30–50 |
| `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` | modify | Update edit tool parameter snapshot to edits-only | snapshot churn |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Replace `props.input.replaceAll` (and any top-level old/new string typing) with `edits[0]`-aware reads so `Tool.InferParameters<typeof EditTool>` typechecks | ~5–20 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | modify | Same `edits[0]?.replaceAll` (or drop badge) type-safe display | ~5–15 |
| `packages/opencode/src/cli/cmd/tui/routes/session/pending-tool-input.ts` | modify | Prefer counting `edits[].oldString`/`newString` when present; fall back to top-level only for legacy stored args | ~10–25 |
| `packages/opencode/src/acp/agent.ts` | modify | ACP completedToolContent: if `edits` present, use first (or joined) old/new for single-file diff display; empty multi-edit body acceptable | ~15–30 |
| `packages/opencode/src/patch/**` | none | Out of scope | 0 |

Display consumers must typecheck and not throw. Full multi-edit ACP unified diffs
remain non-goals; minimal `edits[0]` read is required where TypeScript currently
names top-level fields.

## 16. TDD Behavior Slices

Agreed public seam: **EditTool execute** (real Tool + temp FS), same as existing
`test/tool/edit.test.ts`. Optional pure export tests are not required if Tool
tests cover behavior with independent expected file contents.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | One call with `edits: [A, B]` disjoint updates both regions | Schema rejects / no batch apply | File equals independently constructed expected string | single-edit via edits length 1 |
| 1b | Snapshot vs sequential: content `"foo"`; `edits: [{ oldString: "foo", newString: "bar" }, { oldString: "bar", newString: "baz" }]` | Sequential apply would succeed as `"baz"`; snapshot locate must not | Reject second edit not found (or batch not-found); file remains `"foo"` | INV-01 snapshot clause |
| 2 | Overlapping `edits` reject; file bytes unchanged | No overlap logic | Error mentions overlap; content identical | N/A |
| 3 | Ambiguous non-replaceAll rejects, including hybrid `x-y` + `x\u2013y` | Exact-only would accept one | Error multiple matches; no write | existing duplicate ascii test |
| 4 | Unique smart-quote or trailing-WS normalized match succeeds | Exact-only | File updated; untouched trailing spaces preserved when applicable | tab-indent still fails |
| 5 | `replaceAll` pure exact (incl. leading-line trailing spaces keep pad); hybrid en-dash elevates and replaces both | Schema move / exact-only replaceAll | Independent expected strings | rename use case |
| 6 | Legacy `{ filePath, oldString, newString }` still applies via fold | prepareArguments missing | Same file result as edits length 1 | resume/old prompts |
| 7 | Create via `edits: [{ oldString: "", newString }]` still works | — | File created | nested dirs, BOM |
| 8 | Empty `oldString` inside multi-edit (length>1) rejects | — | Error; no write | INV-06 |
| 9 | Not-found still may show closest for the failing edit index; never writes | — | Diagnostic only | closest suite |
| 10 | Wire schema: `ToolJsonSchema.fromSchema(Edit Parameters)` requires `filePath`+`edits`, forbids top-level oldString/newString/replaceAll; parameters.test parse accepts edits-only | Current schema is four top-level fields | parameters suite + snapshot | INV-09 |
| 11 | `oldString: "   "` or `"\t"` (non-create) rejects; file unchanged | No empty-after-normalize guard | Stable error; no hang | INV-14 |
| 12 | `bun typecheck` after TUI/ACP field migration | Top-level `props.input.replaceAll` breaks | Compiles | INV-15 |
| 13 | Mid-line normalized match: file `code(\u201Chello\u201D);  ` (trailing spaces on line), model oldString ASCII `"hello"` → disk result follows **preserve** (hand-written expected may strip trailing spaces on that touched line); `_syncInput.edits[0].oldString` is continuous curly-quote needle only (not whole line); do not assert continuous-replace full-file equality | R8 false equivalence | Independent disk + actualOld strings | INV-04 + INV-16 |
| 14 | Create + forced format that appends text: `_syncInput.edits[0].newString` equals final disk (mirror write `_formattedContent` pattern) | Edit lacks format input rewrite | Independent final content | INV-16 |
| 15 | Processor: legacy stream input `{filePath,oldString,newString}` + `_syncInput: {filePath,edits}` → persisted input is only `{filePath,edits}` (no top-level old/new); keys stripped; write `_formattedContent` still green | shallow merge leaves stale keys | Session/processor fixture | INV-16 |

Test independence rules:

- Expected file content is a hand-written string, not re-derived from applyEdits.
- Do not assert private helper call counts.
- Do not snapshot source text of edit-apply.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~340 | Apply module + sync + processor + execute + consumers; exclude pure imports/moves |
| Required Chinese explanatory comments `C` | `>= max(1, ceil(340 * 0.15)) = 51` | Hard gate |

Comment targets (non-obvious only):

- Why all edits match the original snapshot, not sequential intermediate content.
- Why batch elevates entirely to normalized space when any edit needs it.
- Why preserve-unchanged-lines exists (avoid rewriting trailing WS/unicode on untouched lines).
- Why `prepareArguments` must run before Schema decode (mixed schema failure mode).
- Why empty `oldString` is create-only for length-1 batches.
- Why `closestWindow` remains failure-only.
- Why tab/indent mismatches are intentionally outside the normalizer.
- Why `_syncInput` rewrites actual oldString after normalized match (model memory).
- Why create+format rewrites newString but surgical edit+format does not invent newString.
- Why heterogeneous replaceAll keeps model oldString.
- Test intention comments for normalized success vs nonliteral failure split.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | `packages/opencode` | Multi-edit, match domain, legacy fold, `_syncInput`, side effects |
| `bun test test/tool/parameters.test.ts` | `packages/opencode` | Decode + wire schema edits-only (INV-09) |
| `bun test test/tool/write.test.ts` | `packages/opencode` | `_formattedContent` regression (processor strip still ok) |
| Relevant processor/session test if slice 15 lives outside edit.test | `packages/opencode` | `_syncInput` merge |
| `bun typecheck` | `packages/opencode` | Types for Parameters / prepareArguments / consumers |
| Optional: `bun test test/tool/apply_patch.test.ts` | `packages/opencode` | Patch contract untouched |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | `edit-apply.ts` |
| Files modified | 11+ | tool + edit + processor + tests + display consumers |
| Files deleted | 0 | — |
| Production lines | ~380–500 | apply + sync + processor + consumers |
| Test lines | ~300–400 | multi-edit + domain + sync + wire schema |
| Generated lines | snapshot only | parameters snap |

## 20. Real Risks and Open Decisions

### Real risks (reachable)

| Risk | Mitigation |
| --- | --- |
| Normalized match can treat smart quotes / dashes as equal when content authors meant a distinction | Document in `edit.txt`; keep normalizer closed-set; preserve untouched lines; no open-ended scorer |
| Models may still send top-level oldString | prepareArguments fold; keep tests |
| Models send `edits` as JSON string | Pi handles; port parse-if-string (invalid JSON string → leave field; schema rejects if edits missing) |
| Multi-edit + replaceAll overlap surprises | Explicit overlap error asking merge |
| Prior R9 tests expect all nonliteral failures | Split suite: normalizer-covered classes become success tests; tab/indent/escape/anchor remain fail |
| Line-ending strategy change to LF-match workspace | Existing CRLF tests must still pass after restore |
| ACP / TUI typed field migration | R6 §15 lists required files; minimum `edits[0]` / `edits[]` key reads for typecheck and non-throw; full multi-edit rich diffs still non-goal. |
| Empty-after-normalize needle | INV-14 reject before expand; document in `edit.txt`. |

### Open Decisions Requiring the User

None for R4 if the following defaults are accepted (assumed approved by the
verbatim request unless the user overrides before implementation):

1. Progressive exact→normalized is **always on** for Edit (no `matchMode`).
2. Patch/apply_patch matching remains exact-only.
3. Public schema is **edits-only**; legacy single fields are silent compatibility.
4. Full multi-edit rich ACP/TUI diffs remain non-goals; **minimum** type-safe
   `edits[0]` (and pending count of `edits[]` fields) is in scope so
   `bun typecheck` passes (INV-15).
5. Whole-file line-ending restore after LF workspace is accepted (Pi-aligned);
   mixed LF/CRLF files may unify to the detected dominant ending.
6. Whitespace-only non-create `oldString` rejects (INV-14); not create, not replace.

### Rejected Speculation

- Port Pi TUI live preview.
- Share normalized success with Patch.
- Add Levenshtein/token fuzzy success.
- Drop `replaceAll` because Pi lacks it.
- Keep dual model-visible fields `oldString` and `edits` (Pi #2639 anti-pattern).

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence (OpenCode + cited Pi paths).
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round (multi-edit **and**
  normalized match **and** legacy fold **and** non-goals).
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback inventory, ownership, tests, code quality,
  and the 15 percent Chinese explanatory-comment plan.
- Verify this plan does not reopen Patch success matching without evidence.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 occurrence domain self-contradictory; B-02 INV-09 wire schema untested | legacy both-present narrowing; TUI stats; closest index; newString not normalized; E estimate | BLOCK | adversarial-auditor task `ses_07e3db4b6ffeVHxk5TccWJQ6XQ` |
| 2 | R2 | yes | B-01 replaceAll expansion/map-back under-specified when probe does not elevate | ACP/TUI top-level field consumers; dual-send note; edits JSON-string errors | BLOCK | adversarial-auditor task `ses_07e39356cffe0MHCGndR2DjYdO` |
| 3 | R3 | yes | B-01 replaceAll still allowed normalized spans on raw base when counts agree | ACP/TUI consumers only in risk table; whole-file line ending; elevation predicate redundancy | BLOCK | adversarial-auditor task `ses_07e356532ffeR56Lih77ZRaT50` |
| 4 | R4 | yes | B-01 INV-01 snapshot clause lacked sequential-sensitive fixture | ACP/TUI display debt; whitespace-only oldString; replace collapse at impl audit | BLOCK | adversarial-auditor task `ses_07e31a4a8ffeO4fkX11qX68SZ8` |
| 5 | R5 | yes | B-01 empty-after-normalize needle; B-02 typecheck-breaking TUI consumers omitted from file plan | ACP runtime degradation; dead `replace` disposition; E estimate | BLOCK | adversarial-auditor task `ses_07e2d7099ffeFcpLKKUiSOySCx` |
| 6 | R6 | yes | No blocking findings (pre–input-sync requirement) | edits JSON-string slice; closest ownership; packages/ui fallback | APPROVE (superseded by R7 user addition) | adversarial-auditor task `ses_07e26ee44ffeRf3XbrIzQbmpSJ` |
| 7 | R7 | yes | B-01 actualOld line-block expands needle; B-02 shallow merge leaves legacy top-level fields | ui display; heterogeneous replaceAll | BLOCK | adversarial-auditor task `ses_07e10c942ffeJYbho11DwpVtmm` |
| 8 | R8 | yes | B-01 continuous actualOld full-file equivalence conflicts with preserve apply | ui display; forward wording; replace disposition | BLOCK | adversarial-auditor task `ses_07e0647f7ffeh0jJdT7hlKm3ys` |
| 9 | R9 | yes | No blocking findings | §3 table pollution (now cleaned); packages/ui display fallback; INV-16 preamble shorthand; heterogeneous replaceAll history limit | APPROVE | adversarial-auditor task `ses_07dfdc31dffeBtupV2pkQw79fH` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/tool/edit-apply.ts` | **add** — 唯一 applyEdits/replace/normalize 主路径 |
| `packages/opencode/src/tool/edit.ts` | **modify** — Parameters=`filePath`+`edits[]`；prepareEditArguments；execute 用 applyEdits；`_syncInput` |
| `packages/opencode/src/tool/edit.txt` | **modify** — multi-edit / normalize / replaceAll 文档 |
| `packages/opencode/src/tool/tool.ts` | **modify** — prepareArguments 钩子（decode 前） |
| `packages/opencode/src/tool/registry.ts` | **modify** — 透传 prepareArguments |
| `packages/opencode/src/session/processor.ts` | **modify** — `_syncInput` 整参数面替换；strip 临时字段 |
| `packages/opencode/src/acp/agent.ts` | **modify** — edits[0]/legacy 双形态 diff 展示 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | **modify** — replaceAll badge 读 edits[] |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | **modify** — 同上 |
| `packages/opencode/test/tool/edit.test.ts` | **modify** — multi-edit / snapshot / hybrid / syncInput / overlap |
| `packages/opencode/test/tool/parameters.test.ts` | **modify** — edits wire schema |
| `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` | **modify** — edit JSON Schema snapshot |

`git diff --stat`（不含无关 generated）：约 +405 / -142 于 11 个已跟踪文件 + 新 edit-apply.ts。

### Red-Green Test Evidence

- Seam：EditTool execute + parameters Schema（与计划一致）
- 新增/扩展用例：multi disjoint、snapshot 拒绝、hybrid reject/replaceAll、preserve 行尾空白、empty-normalize、smart-quote `_syncInput`、create+format `_syncInput`、processor resolveCompletedToolInput、overlap 拒绝
- 既有 exact / replaceAll / CRLF / BOM / blind-edit / closest 回归保持绿
- 命令：`cd packages/opencode && bun test test/tool/edit.test.ts` → 43 pass（含新片）

### Verification Commands and Results

| Command | Directory | Result |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | packages/opencode | 43 pass |
| `bun test test/tool/parameters.test.ts` | packages/opencode | pass（snapshot 更新） |
| `bun test test/tool/write.test.ts` | packages/opencode | pass（`_formattedContent` 未破坏） |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

Not a bug-fix loop; feature capability proven by multi-edit / normalized / syncInput behavioral tests above.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| exact locate + reverse apply | primary | preserved as default |
| normalize elevation + preserve | primary-contract branch | added |
| replace() thin wrapper | compatibility API | re-exports applyEdits([one]) |
| prepareArguments legacy fold | input compatibility | pre-decode only |
| `_syncInput` / `_formattedContent` | ground-truth history | processor channels |
| closestWindow | diagnostic | failure only |
| sequential multi-apply | forbidden | rejected by snapshot tests |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 827 | 独立审计 recount：edit-apply + 实质 diff；排除 blank/import/snapshot |
| Qualifying Chinese comment lines `C` | 128 | 独立审计 recount：邻近 invariant/边界/测试意图中文注释 |
| Ratio `C / E` | 0.155 | >= 0.15 |
| Required minimum `C` | 125 | `ceil(827 * 0.15) = 125` |

### Remaining Unverified Items

- packages/ui message-part legacy fallback 未改（计划 non-blocking display debt）
- processor 真值回写以 `resolveCompletedToolInput` 契约单测覆盖；未跑完整 session E2E 写库

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | B-01 contracted fixtures missing | pending-tool-input; stale comments | BLOCK | ses_07dd5c310ffeP6KHSVxNE4fXx6 |
| 2 | R9 | yes | B-01 joint preserve/history fixture | pad replaceAll lock; multi-empty weak | BLOCK | ses_07dcadbcfffeFSTLcV6BpQr59d |
| 3 | R9 | yes | B-01 Chinese comment gate (E=827 C=112 need 125) | pending-tool; stale comments | BLOCK | ses_07dbee680ffe93f7CArdC2O6kZ |
| 4 | R9 | yes | No blocking findings | builder E/C drift; pending-tool-input; stale nonliteral comment | APPROVE | ses_07db62000ffesxE1s8H9j9ikp9 |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

---

## Appendix A — Pi algorithm reference (evidence, not implementation authority)

### A.1 Multi-edit apply (edit-diff.ts:295-365)

1. Reject empty `oldText`.
2. Map LF-normalized edits.
3. Probe whether any edit needs fuzzy; if yes, work in normalized content.
4. For each edit: find, count occurrences, reject duplicates.
5. Sort by index; reject overlaps.
6. Apply reverse; if fuzzy, preserve unchanged original line blocks.
7. Reject no-op.

### A.2 Normalizer (edit-diff.ts:33-53)

NFKC → per-line trimEnd → smart quotes → dashes → special spaces.

### A.3 Preserve lines (edit-diff.ts:121-170)

Group replacements by touched line ranges on normalized base; copy untouched
original lines; rewrite only touched groups from normalized base with
replacements applied.

### A.4 Schema lesson (CHANGELOG 0.63.2)

`edits[]` only on the public shape; legacy folded pre-validation.

## Appendix B — OpenCode naming & contract sketch for implementers

```ts
// tool/edit-apply.ts (conceptual)
export type EditReplacement = {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export type ApplyEditsResult = {
  contentNew: string
  usedNormalized: boolean
  /** Ground-truth edits; each oldString is continuous baseLF needle (map, not line-block). */
  syncEdits: EditReplacement[]
}

export function applyEdits(content: string, edits: EditReplacement[]): ApplyEditsResult
```

Errors (English, stable phrases for tests):

- `Could not find oldString` / `Could not find edits[i].oldString`
- `Found multiple matches`
- `edits[i] and edits[j] overlap`
- `oldString must not be empty` (when multi)
- `No changes to apply`

`edit.txt` must state:

- Prefer one call with multiple `edits` for disjoint regions in one file.
- Each `oldString` matches the original file, not post-edit content.
- Do not emit overlapping edits; merge nearby changes.
- Matching tries exact unique literal first, then a conservative normalized form
  (trailing line whitespace and common unicode quote/dash/space variants).
- Uniqueness and `replaceAll` both count under that same normalized-aware domain
  (e.g. ASCII hyphen and en-dash siblings count as multiples).
- Indent/tab differences and escape artifacts still fail; re-read and copy exact text.
- `replaceAll` is explicit multi-occurrence authorization per edit item.
- Create/overwrite: single edit with empty `oldString` only (raw empty string).
- Whitespace-only `oldString` is not create and will fail normalization guard.
- If both `edits` and legacy top-level `oldString`/`newString` are sent, `edits` wins.
- Successful normalized matches may rewrite the recorded `oldString` in tool history
  to the actual file text that was replaced (ground truth for later turns).

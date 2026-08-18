# Canonical Implementation Plan: Tool Edit/Write 行尾保真、回写溯源与真实缩进展示

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 用户会话原文（2026-08-18，Session GOAL）
>
> Implementation allowed: no
>
> Last updated: 2026-08-18

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 下面需要完整完成Fix-A(必做，替代原 Fix-2a 的单一切断)：write/edit-create 的 overwrite 继承磁盘行尾
> Fix-B(必做，按你的“覆写才记录”设计)：syncInput 修订
> Fix-C(必做)：trimDiff 删除公共缩进剥离
> Fix-D(必做，否则 Fix-A 被抵消)：formatter 后行尾还原
> 这四个相应修正，同时整体修正保持修改生产代码文件数在8个以内，修改生产代码行数在600行以内，保持精准修改甜点级别修改，避免过度扩大修改面，同时避免测试红测

此前同一用户对 Fix-B 的补充约束：

> 这个真值回写确实理论来说,如果能给一个包含一个原数据,也就是写上长度以及它的SHA-256会更好。但我觉得这种的话,理论来说是它被覆盖了,就是被覆写了,它才进行相应的这个长度以及SHA-256等等的一个展示会更好一点。

此前同一用户对 Fix-C 的补充约束：

> 这个公共前导缩进不要进行相应的剥掉,就是尽量是按照模型相应的这个输入输出等等内容,这种来进行相应的显示等等内容。

实施期间同一用户新增 affected-interface 检查要求：

> 注意applypatch类似的路径检查是否需要修改
> 即编辑、创建

## 2. Explicit Non-Goals

- 不固定 Project 或仓库的 EOL；不修改 `.gitattributes`、`core.autocrlf` 或配置 Schema。
- 不修改 `read` Tool。当前 read 向模型展示逻辑行；本修复在写盘 owner 内保留既有磁盘行尾。
- 不改变 `apply_patch` parser、chunk matcher、diff、Permission、per-file atomicity、move/delete 语义；仅把已证实同类缺口的 add-overwrite 与 existing update/move formatter 行尾纳入。
- 不修改非 create `applyEdits` 匹配、唯一性、overlap、replaceAll、BOM、Permission、Mutation、LSP、事件发布或 Snapshot 语义。
- 不持久化完整 raw Tool JSON。仅在 `_syncInput` 实际把提交的 `oldString` 改写为磁盘真值时记录原数据长度与 SHA-256，控制 DB/上下文体积。
- 不新增 Tool 参数字段，不改变 `edit` / `write` 的模型可见 Parameters Schema。
- 不改变 first-seen `detectLineEnding` 策略；Pi 与 Codex 对照均使用 first-seen/preferred-ending。
- 不新增 fallback、开关或第二套写盘实现。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Tool、Session、Message、Project 术语；Windows/PowerShell CRLF preservation 是 SMARK fork 的 load-bearing delta。 |
| 根 `AGENTS.md` | 精准修改、避免 `any`、tests/typecheck 必须在 `packages/opencode` 运行。 |
| `packages/opencode/AGENTS.md` | Effect 组合与模块边界；文件系统操作继续使用既有 Effect `AppFileSystem`。 |
| `packages/opencode/test/AGENTS.md` | Tool 行为通过 `testEffect`/`TestInstance` seam 验证。 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence、单一 primary path、无 fallback、forward/reverse traceability、15% 中文注释门禁。 |
| `docs/adr/` | 无 Tool 编辑/行尾相关 ADR；不新增 ADR，因为改动局限于现有 Tool 文件写盘合同。 |
| Pi `packages/agent/src/harness/tools/{read,edit,write,edit-diff}.ts` | 对照：edit 在 LF 域匹配并恢复原行尾；read 保留 CR 字节，write 原样。Pi 的 read/write 信息合同与 opencode 不同，不能只照抄 write。 |
| Codex `codex-rs/apply-patch/src/text_file.rs` | 对照：模型提交逻辑行；未触碰行保留原 ending，新增行使用 existing preferred ending。证明“行尾是已有文件属性”是一条 coherent primary contract。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/edit.ts` | create/overwrite 原样写、non-create 行尾恢复、formatter 后重读、`_syncInput`、diff/output、`trimDiff` owner。 | observed |
| `packages/opencode/src/tool/edit-apply.ts` | `syncEdits.actualOld` producer；异构 normalized replaceAll 在 representational fallback 前拥有唯一 mismatch 事实。 | observed |
| `packages/opencode/src/tool/write.ts` | overwrite 原样写、formatter 后重读与 `_formattedContent` producer。 | observed |
| `packages/opencode/src/tool/apply_patch.ts` | add 可覆写 existing file；update/move 从 existing source 派生；统一 formatter loop 只恢复 BOM。 | observed |
| `packages/opencode/src/tool/tool.ts` | public Tool wrapper 将 output 与顶层 string metadata 的 CRLF 规范化为 LF；processor 消费的是逻辑行视图。 | observed / contracted compatibility |
| `packages/opencode/src/session/processor.ts` | `_syncInput`/`_formattedContent` consumer；临时 truth metadata strip 与 completed Message 持久化 owner。 | observed |
| `packages/opencode/src/session/message-v2.ts` | completed Tool metadata 是开放 Record，可持久化 provenance，无需 Tool Schema 变更；pending raw 不进入 completed state。 | observed |
| `packages/opencode/src/util/line-ending.ts` | 双侧 LF normalization、first-seen file ending、write-back conversion 的既有 owner。 | observed |
| `packages/opencode/src/util/bom.ts` | formatter 后 BOM 同步只处理 BOM，不恢复行尾。 | observed |
| `packages/opencode/src/format/{index,formatter}.ts` | formatter 是正式可配置外部 writer；wrapper 不约束 formatter 行尾。 | observed / reachable |
| `packages/opencode/src/tool/file-mutation-coordinator.ts` | proposal bytes/version 同源、formatter 位于 commit lock；修复必须继续在同一 critical section 内完成。 | observed |
| `packages/opencode/test/tool/edit.test.ts` | EditTool execute seam、CRLF matrix、normalized `_syncInput`、create formatter、output budget fixtures。 | observed |
| `packages/opencode/test/tool/write.test.ts` | WriteTool execute seam、CRLF-only diff、BOM、formatter `_formattedContent` fixtures。 | observed |
| `packages/opencode/test/tool/apply_patch.test.ts` | existing CRLF update、add-overwrite、move 与真实 Tool execute seam。 | observed |
| `docs/plans/edit-identical-noop-tolerance.md` | 已验证合同：output/metadata.diff 使用 post-formatter 真值、warning 尾部预算、`_syncInput` parameter-face replacement。 | contracted compatibility |
| `D:\Temp\opencode\eol-tools-red.test.ts` | 临时 red-capable Tool execute harness；2026-08-18 实跑 5/5 fail。 | observed |
| `D:\Temp\opencode\eol-tools-red.test.ts -t "apply_patch"` | R5 四条真实 Tool signal；add-overwrite、formatter update/add/move 实跑 0 pass / 4 fail。 | observed |
| Session DB `ses_ff74d9063ffeOTYPsadCxfVXjn` | 184 edit、18 失败；真实拼接与 trimDiff 显示误报调查背景。 | observed |

## 5. Current Behavior

```text
模型/read 逻辑行 -> write/edit-create 参数
  -> Mutation.read 得到 existing raw bytes
  -> write/edit-create 直接写参数文本（未继承 existing ending）
  -> format.file 可再次重写磁盘
  -> Bom.syncFile 只恢复 BOM，不恢复 ending
  -> post-formatter diff/metadata

non-create edit:
模型 old/new -> 双侧 LF normalize -> applyEdits
  -> 恢复 proposal 的 file-level ending -> write -> formatter
  -> Bom.syncFile 只恢复 BOM，formatter 仍可翻转 ending
  -> syncEdits.actualOld 转回 CRLF/CR 形态后 `_syncInput` 整表覆盖 state.input

所有 edit/write/apply_patch diff -> trimDiff
  -> 删除 hunk 内公共前导缩进 -> 模型看到比磁盘更浅的缩进

apply_patch:
  Add File existing -> snapshot 只用于 conflict，patch LF 内容原样覆写
  Update/Move existing -> Patch owner 初次保留 source ending
  -> 统一 formatter loop -> Bom.syncFile(BOM only) -> formatter 可翻转 ending

Tool wrapper:
  ExecuteResult -> sanitizeVisibleText(top-level string metadata)
  -> `_formattedContent` 以 LF logical text 进入 processor；磁盘物理 CRLF 不直接穿过该边界
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| existing CRLF/CR file + LF `write.content` | read 对 CR/LF 透明；LLM 普遍提交 LF | Schema 只保证 string | WriteTool overwrite 原样写，整文件变 LF | WriteTool | observed by red harness / reachable in Session evidence |
| existing CRLF/CR file + `edit` create/overwrite | Edit parameters | Schema 只保证 string | create branch 原样写，整文件变 LF | EditTool create branch | observed by red harness |
| formatter 把 existing ending 改为另一 ending | Project formatter command | 只保证可执行，不保证行尾 | Tool write -> formatter -> syncFile(BOM only) | 调用 formatter 的 Tool commit section | reachable；临时 red harness 已观察 mixed separator |
| apply_patch Add File 覆写 existing CRLF | Patch input + existing snapshot | Add File 允许 existing path | processHunkGroup(add) -> LF newContent -> commit write | ApplyPatchTool add owner | observed by R4 red harness |
| apply_patch Update/Move existing + formatter | Patch input + formatter | Patch 初次写回保留 source ending；formatter 无 EOL 保证 | commit write -> format.file -> syncFile(BOM only) | ApplyPatchTool formatter loop | observed update by R4 red harness；move shares same loop |
| exact edit input | LLM | oldString unique | `syncEdits.oldString === delivered LF oldString` | EditTool history truth | observed |
| normalized edit input（智能引号等） | LLM | `normalizeForMatch` 可唯一定位 | `syncEdits.oldString !== delivered LF oldString`，当前静默覆盖 | EditTool + processor truth sync | observed by existing normalized test |
| deeply indented hunk with no column-zero content line | edit/write/apply_patch diff | diff library preserves raw indentation | trimDiff removes hunk-wide minimum | `trimDiff` renderer | observed by red harness and Session transcript |
| new file create/write | LLM | 无 existing ending | keep submitted ending; formatter result remains authoritative | Tool create path | contracted existing behavior |
| public `_formattedContent` | WriteTool result + Tool wrapper | wrapper sanitizes top-level strings to LF | sanitizeResult -> processor truth consumer | Tool visible-text boundary | observed by targeted probe；existing compatibility |

Speculative rows are intentionally absent.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | overwrite 已有文件时，模型/patch 提交的是逻辑行内容；write、edit-create 与 apply_patch add-overwrite 最终保持 proposal 的 file-level LF/CRLF/CR 风格。 | user Fix-A + apply_patch follow-up；Pi/Codex comparison；line-ending owner | Edit/apply_patch update matrix exists；overwrite paths missing |
| INV-02 | new file 没有 existing ending，继续保留提交/formatter 产生的 ending。 | user non-invasive constraint；existing behavior | write new-file tests；edit create tests |
| INV-03 | formatter 不得把 write/edit/apply_patch 对 existing file 的 ending 翻转；其内容格式化仍须保留，BOM 仍须恢复。 | user Fix-D + apply_patch follow-up；formatter is external writer | formatter tests exist but no ending assertion |
| INV-04 | edit history 正常路径保持提交的 LF logical form；只有进入实际 replacement/write 的条目中，任一 normalized match slice 与 delivered LF oldString 不同时才算 truth rewrite。异构 `replaceAll` 必须记录；identical 跳写条目必须排除。 | user Fix-B；Pi history comparison；existing INV-16 | identical normalized skip + hybrid replaceAll tests |
| INV-05 | truth rewrite 时持久化每条原提交 oldString 的 UTF-8 byte length 与完整 SHA-256；模型可见 output 在既有 limits 内展示尽可能多的完整 fingerprint 并明确省略数。正常路径不附加 provenance/warning。 | user “覆写才展示”；existing output-limit contract | missing |
| INV-06 | diff 必须保留源文本前导缩进；不再为紧凑展示改写 diff 内容。 | user Fix-C；Session false-positive evidence | missing |
| INV-07 | Tool 参数 Schema、Permission、Mutation atomicity、BOM、LSP、events、post-formatter diff single truth 均不变。 | user minimal-scope requirement + existing contracts | existing suites |
| INV-08 | Tool wrapper 继续把模型/processor 可见的顶层 string metadata 规范化为 LF；物理 EOL 只由文件 owner 恢复，不穿透可见文本 sanitizer。 | existing Tool compatibility；user non-invasive logical-line model | sanitizer behavior + processor tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 write | `write.ts` sets `contentNew = next.text` and writes it verbatim although proposal has an existing ending. | WriteTool overwrite | red harness `write overwrite preserves existing CRLF` fails |
| INV-01 edit-create | `edit.ts` create branch sets `contentNew = next.text` for both missing and existing files. | EditTool create/overwrite | red harness `edit create-overwrite preserves existing CRLF` fails |
| INV-03 | formatter runs after initial ending conversion; `Bom.syncFile` restores only BOM. | Tool commit formatter boundary | red harness formatter case fails |
| INV-01 apply_patch add | `processHunkGroup(add)` 保留 snapshot version 却丢弃 existing text EOL，随后直接写 patch LF。 | ApplyPatchTool add proposal | R4 red harness add-overwrite fails |
| INV-03 apply_patch | shared commit loop runs formatter and only `Bom.syncFile`; existing update/move ending is not restored. | ApplyPatchTool formatter boundary | R4 red harness update formatter fails |
| INV-04/05 mismatch | `actualOldFromRanges` 在 normalized `replaceAll` 的实际切片异构时返回 `modelOld`；仅比较 `syncEdits.oldString` 会丢失 mismatch。反之，若对全部 located slice 标 mismatch，又会把 identical skip 误报为 rewrite。 | `edit-apply.ts` match truth producer + EditTool decision | current code 348-373、470-489；hybrid replaceAll + normalized identical tests；R1/R2 audit B-01 |
| INV-05 output limit | edits[] 无数量上限；每条 mismatch 在既有预算完成后追加完整 SHA-256 warning 会突破 Tool limits。 | EditTool output assembler | current code 362-433；existing output-limit test；R2 audit B-02 |
| INV-06 | `trimDiff` calculates minimum indentation across all content lines and removes it. | shared Tool diff renderer | `bun D:/Temp/opencode/eol-trim-red.ts` observed stripped output |

Red-capable feedback loop already executed:

```text
Command: bun test D:/Temp/opencode/eol-tools-red.test.ts
Working directory: packages/opencode
Observed: 0 pass / 5 fail
Symptoms: write CRLF overwrite -> LF; edit-create CRLF overwrite -> LF;
formatter result remains LF; edit output removes 8-space indent; provenance absent.
```

R5 affected-interface feedback loop:

```text
Command: bun test D:/Temp/opencode/eol-tools-red.test.ts -t "apply_patch"
Working directory: packages/opencode
Observed: 0 pass / 4 fail
Symptoms: Add File overwrite CRLF -> LF；Update/Add/Move formatter CRLF -> LF.
```

Minimized one-function signal:

```text
Command: bun D:/Temp/opencode/eol-trim-red.ts
Observed: trimDiff("-    old/+    next") returns "-old/+next" and throws.
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| existing ending selection | `line-ending.ts` + proposal-owning Tool | edit/write promise to update a file | proposal contains raw text before permission; Tool knows create vs overwrite | Model/read must not implement host line-ending policy |
| formatter ending restoration | calling Tool commit section | final disk preserves existing-file attributes | each Tool invokes formatter after its own proposal write | Format service must stay content-formatter agnostic；caller alone knows existing/new ownership |
| apply_patch ending ownership | `apply_patch.ts` proposal + shared commit loop | add-overwrite/update/move existing files retain proposal/source ending | this Tool owns snapshot state and invokes formatter inside its own commit | Patch parser owns chunks, not physical file attributes；Format remains caller-agnostic |
| normalized mismatch production | `applyEdits` | matcher owns actual normalized slices before representational fallback | only this seam can compare every actual slice with modelOld, including heterogeneous replaceAll | EditTool sees only collapsed `syncEdits.oldString` |
| truth rewrite fingerprint | `EditTool.execute` | Edit owns delivered edits and consumes mismatch indices | only this seam has model-facing edit indexes, output and metadata | processor must not reconstruct edit semantics |
| provenance persistence | existing processor `completeToolCall` pass-through | completed Tool metadata is durable audit record | `stripToolTruthMetadata` removes only underscore truth fields and already preserves public metadata | no processor production change is required |
| visible metadata LF boundary | existing `Tool.wrap` sanitizer | top-level string metadata is safe logical text | processor already consumes this public Tool result | file writers must not bypass sanitizer to expose CR bytes |
| diff fidelity | `trimDiff` | model-facing diff mirrors actual patch | shared function currently mutates indentation | TUI/Message must not reverse-engineer stripped whitespace |

## 10. Single Approved Primary-Path Design

```text
proposal raw text
  -> if existing: detect its file-level ending
  -> normalize submitted logical content and convert to that ending
  -> write under existing Mutation commit
  -> run formatter
  -> if existing: re-read formatted text, convert it back to proposal ending,
     write only when conversion changes bytes, restore BOM, expose final text
  -> generate unchanged post-formatter diff/metadata from final disk text

apply_patch FileChange
  -> add: if snapshot existing, capture ending and convert patch logical lines before write
  -> update/move: capture ending from existing source; keep Patch owner's derived content
  -> shared commit write -> formatter -> if ending exists, restore it inside the same lock
  -> new add has no ending and remains patch-authored

edit apply result
  -> applyEdits compares actual matched slices only for entries entering write ranges
     before heterogeneous replaceAll falls back to a representable sync oldString
  -> return normalizedMismatchIndices beside syncEdits
  -> sync input remains LF logical truth
  -> on mismatch only: metadata stores every original UTF-8 byte length + SHA-256
  -> output tail budget shows complete fingerprints until full, then omission marker
  -> processor's existing metadata pass-through persists conditional provenance

Tool wrapper
  -> sanitize top-level string metadata to LF as today
  -> `_formattedContent` remains processor logical text even when final disk is CRLF

diff
  -> return createTwoFilesPatch output unchanged
```

Design details:

1. Use existing `detectLineEnding`, `normalizeLineEndings`, `convertToLineEnding`, `Bom`, and Mutation critical section. No parallel serializer or writer.
2. Fix-A: `write` and edit create branches convert submitted text to the proposal ending only when the proposal is an existing file. Missing-file behavior is untouched.
3. Fix-D: after a formatter reports execution, read formatted text, convert to the original ending for existing files, restore BOM, and make `contentNew`/`finalSource` represent the final disk truth. Formatter content changes survive; only separator encoding is restored.
   ApplyPatchTool performs the same restoration in its existing per-change formatter loop using one optional `FileChange.ending`: add-overwrite gets it from the existing snapshot；update/move get it from the source；new add/delete have none. This is one file-attribute path, not another writer.
4. Fix-B producer: `actualOldFromRanges` returns both the representable `oldString` and a mismatch boolean computed as `slices.some(slice => slice !== modelOld)`. `applyEdits` adds an index only when `edit.oldString !== edit.newString`, so the entry contributes replacement ranges. Heterogeneous normalized `replaceAll` retains mismatch before representational fallback；normalized identical skip remains submission-shaped and produces no mismatch.
5. Fix-B consumer contract: normal entries persist LF `{oldString,newString}` with no provenance. Every mismatch index creates exactly one stable `inputProvenance.rewrites[]` item:
   `{ editIndex: number, original: { byteLength: number, sha256: string } }`.
   `byteLength` and SHA-256 use the UTF-8 bytes of the delivered LF `oldString`; SHA-256 is full lower-case 64 hex. Output uses a stable tail section:
   `Warning: normalized oldString truth rewrites were recorded:` followed by compact lines
   `- edits[i]: original=N UTF-8 bytes sha256=H`.
   The original string itself is never printed. All items always remain in metadata. The output section shares the existing 2048-byte/10-line warning reserve with the no-op warning. Starting from the success-line bytes/lines, its assembler caps itself by both that reserve and the remaining `truncate.limits()` capacity, reserves the omission marker first, then appends only complete fingerprint lines that fit. If not all entries fit it emits
   `- ... K more rewrite fingerprint(s) stored in metadata.inputProvenance`.
   Diff continues to consume only the pre-tail budget；the LSP-fit calculation subtracts the assembled warning bytes/lines before appending LSP or its omission notice. Thus every appended section is covered before final output is returned.
6. `inputProvenance` is a public metadata key, not underscore truth metadata. The existing processor consumes `_syncInput`, strips only underscore truth fields, and automatically persists/projections provenance; processor production code remains unchanged. No Message schema change is required because metadata is already a Record.
7. WriteTool keeps internal `finalSource` equal to final disk text, while existing `Tool.wrap` sanitizes top-level `_formattedContent` to LF before processor consumption. No sanitizer or processor change is planned；tests assert CRLF on disk and LF in public metadata.
8. Fix-C: `trimDiff` becomes identity. Keeping the exported name minimizes call-site churn across edit/write/apply_patch.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| existing-file LF/CRLF/CR conversion | proposed | supported-domain branch | yes | primary | add |
| missing-file verbatim creation | current | supported-domain branch | yes | primary | preserve |
| formatter content + ending restoration | proposed | supported-domain branch | yes | primary | add |
| apply_patch add existing ending conversion | proposed | supported-domain branch | yes | primary | add |
| apply_patch update/move formatter restoration | proposed | supported-domain branch | yes | primary | add in existing shared loop |
| normalized actualOld truth rewrite（含 heterogeneous replaceAll，不含 identical skip） | current + diagnostic | supported-domain branch + diagnostic | yes | one mismatch branch | preserve + observe |
| provenance/bounded warning on actual write mismatch | proposed | diagnostic | no independent success | one branch / no fallback | add |
| Tool visible-text LF sanitization | current compatibility | contracted pass-through | yes | shared wrapper | preserve unchanged |

No fallback or alternate success path is proposed.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `trimDiff` common-indent rewrite | compact diff display | violates source-fidelity requirement and caused false fixes | collapse function to identity in `edit.ts` |
| unconditional disk-ending conversion in `_syncInput` | replay convenience | mixes physical encoding into model logical history; new conditional provenance preserves exceptional rewrite evidence | replace map in `edit.ts` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| Fix-A / INV-01 | WriteTool existing proposal -> converted write | `src/tool/write.ts` | write CRLF/CR overwrite with LF input preserves original ending |
| Fix-A / INV-01/02 | EditTool create branch existing vs missing | `src/tool/edit.ts` | edit-create overwrite CRLF preserves; new-file LF remains LF |
| Fix-D / INV-03 | edit/write formatter commit -> re-read -> ending restore | `edit.ts`, `write.ts` | deterministic formatter flips to LF, final existing file remains CRLF and formatted content persists |
| apply_patch follow-up / INV-01/03 | add existing snapshot -> converted write；add/update/move shared formatter -> ending restore | `apply_patch.ts` | add-overwrite CRLF preserves；formatter-sensitive add/update/move each restore CRLF and keep formatted text；move source is deleted |
| Fix-B / INV-04/05 | mismatch producer -> `_syncInput` + provenance -> completed metadata | `edit-apply.ts`, `edit.ts`；processor 既有 pass-through 零改动 | exact/identical path no provenance; smart-quote/hybrid replaceAll record length/hash; multi-rewrite output is bounded with omission count; processor behavior test locks persistence |
| Fix-C / INV-06 | shared trimDiff | `edit.ts` | deeply-indented hunk output retains exact spaces; direct helper assertion |
| INV-08 | internal final disk text -> existing Tool string sanitizer -> processor LF | no production change in `tool.ts` | write formatter test asserts CRLF disk and LF `_formattedContent` |
| INV-07 | existing full Tool paths | no semantic expansion | existing edit/write/apply_patch regressions + typecheck |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| existing overwrite ending conversion | INV-01 | red Tool harness; read hides physical ending | current write/create write `next.text` verbatim |
| post-formatter ending restore | INV-03 | formatter is external writer; red formatter harness | Bom.syncFile only restores BOM |
| apply_patch `FileChange.ending` | INV-01/03 | user follow-up + R5 0/4 red harness | add snapshot state is currently ignored for content EOL；shared formatter loop has no source ending fact |
| normalized mismatch indices limited to real replacements | INV-04/05 | R1/R2 audit B-01 + reachable hybrid replaceAll/identical tests | collapsed `syncEdits.oldString` cannot represent heterogeneous actual slices，while located identical slices are not writes |
| conditional rewrite provenance | INV-04/05 | user requirement; raw absent from completed state | `_syncInput` is stripped and no durable fingerprint exists |
| bounded fingerprint warning section | INV-05/07 | R2 audit B-02 + unbounded edits Schema + existing limits test | per-rewrite append after budgeting can exceed output contract |
| SHA-256 at Edit truth seam | INV-05 | user explicitly requires SHA-256/length | existing `Hash.fast` is SHA-1 and unsuitable; Node crypto SHA-256 is established in package |
| identity trimDiff | INV-06 | user explicit requirement + false-positive trace | current helper mutates every consumer diff |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/edit.ts` | modify | Fix-A create-overwrite, Fix-D formatter restoration, Fix-B LF sync/provenance/bounded warning, Fix-C identity trimDiff | +75 / -35 |
| `packages/opencode/src/tool/edit-apply.ts` | modify | preserve normalized mismatch fact before heterogeneous replaceAll representational fallback | +16 / -8 |
| `packages/opencode/src/tool/write.ts` | modify | Fix-A existing overwrite conversion, Fix-D formatter restoration/final truth | +30 / -8 |
| `packages/opencode/src/tool/apply_patch.ts` | modify | capture existing add/update/move ending, convert add-overwrite, restore after formatter in shared commit | +30 / -8 |
| `packages/opencode/test/tool/edit.test.ts` | modify | create/formatter/diff/provenance/processor behavior slices | +100 / -10 |
| `packages/opencode/test/tool/write.test.ts` | modify | existing ending and formatter preservation slices | +75 / -15 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | add-overwrite plus formatter-sensitive add/update/move ending slices | +90 / -5 |

Production files: 4 ≤ 8. Estimated production changed lines: <260 ≤ 600.

## 16. TDD Behavior Slices

Agreed seams are existing public Tool execute results plus the exported processor truth-consumer function already tested in `test/tool/edit.test.ts`.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Write overwrite CRLF file using LF content preserves CRLF | writes `next.text` verbatim | convert existing overwrite content to proposal ending | Fix-A write |
| 2 | Edit create-overwrite preserves CRLF; new create unchanged | create branch ignores `existed` for ending | conditional conversion for existing only | Fix-A edit-create + INV-02 |
| 3 | dedicated test formatter converts every CRLF/CR separator to LF, but cannot leave write/edit existing CRLF file as LF；public `_formattedContent` remains LF logical text | syncFile only handles BOM；Tool sanitizer intentionally normalizes top-level strings | restore proposal ending inside commit；preserve sanitizer | Fix-D + INV-08 |
| 4 | apply_patch Add File overwrite preserves existing CRLF；new Add remains patch-authored LF | add snapshot EOL is discarded | optional FileChange ending converts only existing add | apply_patch follow-up + INV-02 |
| 5 | existing CRLF apply_patch Add File overwrite经过 LF formatter 后仍为 CRLF并保留 formatter 文本 | add and shared formatter are distinct write boundaries | restore FileChange ending at the actual add target | R4 audit B-01 add branch |
| 6 | apply_patch Update formatter cannot flip CRLF and still keeps formatter text | shared loop restores only BOM | restore FileChange ending after formatter | apply_patch follow-up + Fix-D |
| 7 | CRLF source move 经 LF formatter 后 destination 保持 source CRLF、保留 formatter 文本且 source 删除 | move writes a different target path | restore the same source ending at `movePath` inside shared loop | R4 audit B-01 move branch |
| 8 | normalized oldString rewrite yields stable provenance/warning; exact path does not | current sync is silent | producer returns mismatch index, hash only mismatch | Fix-B low-noise contract |
| 9 | hybrid normalized `replaceAll` with one literal and one en-dash slice still reports rewrite | producer currently folds heterogeneous slices back to modelOld | retain mismatch fact before representational fallback | audit B-01 / Fix-B completeness |
| 10 | normalized identical no-op remains submission-shaped and emits no provenance/warning | naive slice comparison misclassifies it | mismatch producer excludes entries skipped from replacement ranges | R2 audit B-01 |
| 11 | many normalized rewrites persist all metadata, output complete fingerprints up to the tail budget, emit an omission marker, and remain within injected limits | unbounded per-item warning exceeds limits | bounded warning assembler reserves actual tail size | R2 audit B-02 |
| 12 | processor persists public provenance and strips only temporary truth keys | current pass-through untested for this key | lock existing pass-through, no production change | Fix-B DB evidence |
| 13 | deeply indented diff retains spaces | trimDiff removes min indent | identity return | Fix-C all diff consumers |

Each new behavior slice is red before implementation. The temporary harness demonstrated original slices 1-3, 8 and 13；R5's targeted command demonstrated slices 4-7 at 0/4. Slice 10 extends an existing identical-normalized regression with new absence assertions；slice 12 locks an existing pass-through contract and is green before production changes.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 220-310 | Include substantive production and test lines；exclude imports, blank lines, formatter-only churn and pure deletions |
| Required Chinese explanatory comments `C` | 33-47 | `ceil(E * 0.15)`; target 40-52 qualifying lines |

Planned nearby comment subjects:

- model logical-line view versus existing file physical-ending invariant;
- formatter content authority versus ending attribute restoration;
- why conversion stays inside Mutation commit;
- why new files are not coerced;
- why apply_patch add existing differs from new add and why update/move share one ending fact;
- why Tool sanitizer keeps processor metadata LF while disk preserves physical EOL;
- why provenance compares LF logical strings and records only mismatch;
- hash/length disclosure boundary (no original content in output);
- why full provenance stays in metadata while model-visible fingerprints obey the existing tail budget;
- `_syncInput` temporary truth versus durable provenance;
- trimDiff identity rationale (source fidelity over compactness);
- tests explain existing-file versus new-file and formatter boundary intent.

Comments that merely restate assignments, imports or control flow do not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | `packages/opencode` | edit-create, formatter, sync/provenance, diff fidelity and existing edit contracts |
| `bun test test/tool/write.test.ts` | `packages/opencode` | write overwrite/new/create, BOM, formatter and metadata truth contracts |
| `bun test test/tool/apply_patch.test.ts` | `packages/opencode` | add-overwrite/update formatter EOL plus shared identity trimDiff and existing patch/move contracts |
| `bun test D:/Temp/opencode/eol-tools-red.test.ts` | `packages/opencode` | original five symptoms plus R5 apply_patch add-overwrite and formatter-sensitive add/update/move signals become green |
| `bun typecheck` | `packages/opencode` | package type integrity |
| `git diff --check -- <goal paths>` | repository root | whitespace defects absent; unrelated worktree excluded |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 plan | canonical artifact only |
| Files modified | 7 | 4 production + 3 tests |
| Files deleted | 0 | no fallback/workaround modules |
| Production lines | <260 changed, hard cap 600 | localized edit-apply/edit/write/apply_patch seams |
| Test lines | 220-320 | thirteen vertical behavior slices in existing files |
| Generated lines | 0 | no schema generation |

## 20. Real Risks and Open Decisions

### Real Risks

- Formatter may intentionally use a configured EOL; user Fix-D explicitly chooses existing-file ending preservation over formatter EOL changes. Tests lock this precedence.
- internal `finalSource`/`contentNew` must reflect restored disk text；public `_formattedContent` and revised `_syncInput` remain LF logical text at their established Message boundary.
- apply_patch move shares update's existing source ending and shared formatter loop；the repair must not reinterpret destination EOL or change move ownership.
- Provenance hash must use UTF-8 bytes and full 64-hex SHA-256. JS character length is insufficient for CJK/astral input; `byteLength` records the same UTF-8 byte domain.
- heterogeneous normalized `replaceAll` may not have one representable actualOld; provenance therefore keys on the producer's mismatch fact, while syncInput preserves its existing modelOld representation.
- normalized identical entries locate successfully but do not write or change history truth; mismatch production must remain after the identical skip decision.
- fingerprint output is bounded independently of full metadata; omission is explicit and does not discard DB forensic evidence.
- `trimDiff` identity increases output bytes. Existing edit output budget already truncates diff before reserved warning/LSP tail; write/apply_patch use wrapper limits. No new unbounded source is introduced.
- Unrelated dirty worktree files exist; implementation and commit must include only goal paths and must stop if a goal path gains unrelated edits.

### Open Decisions Requiring the User

None. The user has explicitly selected Fix-A through Fix-D and rejected forced repository EOL.

### Rejected Speculation

- Persisting full raw tool JSON: rejected because the user requested conditional length/hash and completed raw persistence would duplicate large inputs.
- Changing read to expose CR bytes: Pi uses this model, but opencode already uses logical-line read semantics and Fix-A/D close the resulting write responsibility.
- Changing first-seen ending detection to majority voting: rejected because Pi/Codex use first-seen and no observed mixed-ending failure requires a new policy.
- Changing `Tool.wrap` sanitizer to preserve CRLF metadata: rejected because the user asked for non-invasive logical model I/O and the wrapper's top-level string LF contract is established；physical EOL belongs to file owners.
- Applying destination EOL to apply_patch move: rejected because move content derives from the existing source；destination overwrite is ownership replacement, not a second file-content proposal.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 `replaceAll` 归一化覆写会漏记 Fix-B provenance | formatter fixture 应真实翻转 separator；稳定字段级合同需补充 | BLOCK | `ses_fedefb4bfffeNrrJcHWzo0QS61` |
| 2 | R2 | yes | B-01 normalized identical no-op 被误报；B-02 多 rewrite warning 可突破 output limits | R1 replaceAll 与 formatter fixture 已修正 | BLOCK | `ses_fedefb4bfffeNrrJcHWzo0QS61` |
| 3 | R3 | yes | No blocking findings. | bounded warning 的 bytes/lines 合成与实际 E/C 须在实现审计复核 | APPROVE | `ses_fedefb4bfffeNrrJcHWzo0QS61` |
| 4 | R4 | yes | B-01 apply_patch 的 add/move formatter 行尾合同缺少敏感测试 | FileChange.ending 主路径正确；move source ending owner 正确 | BLOCK | `ses_fedefb4bfffeNrrJcHWzo0QS61` |
| 5 | R5 | yes | No blocking findings. | Verification 表中原始 feedback-loop 描述仍写“R4 apply_patch add/update signals”，而 R5 实际记录的是 add-overwrite 以及 formatter-sensitive add/update/move 共四条信号。命令覆盖完整，属于非阻塞记录文字滞后。<br>实现审计仍需核对 `FileChange.ending` 对 add、update、move 使用同一恢复逻辑，并确认恢复写盘继续位于 Mutation commit lock 内。<br>bounded provenance warning 与 15% 中文解释性注释要求必须按实际 diff 独立复算。 | APPROVE | `ses_fedefb4bfffeNrrJcHWzo0QS61` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Implementation completed against approved R5. No Tool parameter/schema,
processor, sanitizer, parser, matcher, Permission, or configuration surface was
expanded.

### Actual Files and Diff

- Production: `edit.ts`, `edit-apply.ts`, `write.ts`, `apply_patch.ts`.
- Tests: `edit.test.ts`, `write.test.ts`, `apply_patch.test.ts`.
- Actual production diff: 4 files, 224 additions / 66 deletions; below the 8-file
  and 600 changed-production-line hard limits.
- Responsibilities: proposal EOL ownership, post-formatter restoration,
  normalized mismatch truth, conditional provenance/bounded output, and shared
  diff identity only.

### Red-Green Test Evidence

- write/edit create existing CRLF assertions failed on LF disk, then passed after
  proposal-ending conversion.
- formatter-sensitive write/edit assertions failed on LF disk, then passed while
  retaining formatter content and LF public metadata.
- R5 apply_patch harness was 0/4 for add initial write and formatter add/update/move;
  repository tests now pass all actual targets and source deletion.
- smart-quote provenance was `undefined`, then passed with stable UTF-8
  `byteLength`/SHA-256; exact and identical paths remain absent.
- heterogeneous replaceAll now retains mismatch before representational fallback.
- 14-rewrite test now preserves full metadata and emits bounded output with an
  omission marker and no-op warning.
- `trimDiff` direct red signal stripped eight spaces; identity now passes.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test --timeout 30000 test/tool/edit.test.ts` | `packages/opencode` | 83 pass, 0 fail, 4065 expect() |
| `bun test --timeout 30000 test/tool/write.test.ts` | `packages/opencode` | 25 pass, 0 fail, 52 expect() |
| `bun test --timeout 30000 test/tool/apply_patch.test.ts` | `packages/opencode` | 53 pass, 0 fail, 152 expect() |
| `bun test --timeout 30000 D:/Temp/opencode/eol-tools-red.test.ts` | `packages/opencode` | 9 pass, 0 fail, 11 expect() |
| `bun typecheck` | `packages/opencode` | pass |
| `bunx prettier --check <7 goal TS files>` | repository root | not a release gate; independent audit found six target files have pre-existing untouched style differences, while the cleaned diff contains no unrelated formatter-only hunks |
| `git diff --check -- <goal paths>` | repository root | pass |

The default 5-second Bun timeout caused two existing apply_patch integration
tests to time out on this Windows/Effect environment. Both passed independently,
and the full suite passed with the package script's declared 30-second timeout.
After implementation-audit round 1, unrelated formatter-only hunks were removed
from the three cited files. The complete edit/write/apply_patch suites, original
feedback loop, typecheck, and diff check were rerun with the same passing results.

### Original Feedback-Loop Result

The 9-case temporary Tool execute harness passed write/edit EOL, apply_patch
add/update/move, indentation, and conditional provenance. Its expected field and
warning text were updated to approved R5 (`byteLength`, bounded warning); it is
outside the repository and not part of the commit.

### Actual Secondary and Replacement Path Inventory

- Existing-file conversion and formatter restoration are supported-domain
  branches in the existing Mutation commit, not alternate writers.
- Missing-file creation remains patch/model-authored with no inferred Project EOL.
- `FileChange.ending` is one shared apply_patch fact for add/update/move.
- Provenance/warning is conditional diagnostic output only; it does not change
  replacement success and remains within the approved output budget.
- Existing Tool LF sanitizer and processor pass-through are unchanged.
- No fallback, retry, feature switch, new parser, matcher, or processor branch.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 404 | Added non-blank substantive production/test lines; imports, blank lines, formatter-only and pure deletions excluded |
| Qualifying Chinese comment lines `C` | 74 | Independent audit count; adjacent rationale for EOL ownership, formatter boundary, normalized truth, output budget, move target, or test intent |
| Ratio `C / E` | 18.32% | `74 / 404` |
| Required minimum `C` | 61 | `ceil(404 * 0.15)` |

### Remaining Unverified Items

- Historical completed Message rows cannot reveal pre-repair raw Tool JSON; the
  conditional fingerprint applies to future normalized rewrites.
- This Windows host requires the package's 30-second timeout for the full
  apply_patch integration suite; no assertion failures remain.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | B-01 Unrelated formatting churn violates the approved precision scope and repository quality gate | Plan arithmetic is stale.<br>The implementation audit record is still empty.<br>Verification was not independently rerun in this audit. | BLOCK | `ses_fecb067f0ffeh4oBRvXkSSdF7l` |
| 2 | R5 | yes | No blocking findings. | Implementation Evidence 中的 Prettier 记录不准确。<br>中文注释统计存在一行差异。 | APPROVE | `ses_fecb067f0ffeh4oBRvXkSSdF7l` |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

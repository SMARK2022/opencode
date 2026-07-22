# Canonical Implementation Plan: Apply Patch Original-File Ordered Edits

> Status: verified
>
> Revision: R8
>
> Approved revision: R8
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL 2026-07-22 (verbatim below)
>
> Implementation allowed: complete; no further material changes without revision
>
> Last updated: 2026-07-23

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 克制但完整的甜点级别修改opencode的applypatch功能，让其能够仿照pi一样默认逻辑能适当鲁棒化的进行修改段段排序以及统一应用：PI
> 始终原始文件
> 成功
> exact + fuzzy normalize
> 全局唯一强制
> 找完后按位置排序应用，这样整体主逻辑可以得到增强且整体内容不会过于冗杂。我希望整体修改文件数量在6个以内，整体修改量最好在800行以内的生产代码，避免增加“试验性”这种逻辑，所有的逻辑改动都要生产可用且不需要增加启用/关闭的逻辑，确保安全性和可维护性。

> 目标终态：`<verified-implementation-and-commit>`

Subsequent explicit user constraints (verbatim):

> 你不能说顺序不重要,因为你这样的话会导致模型完全地胡乱输出。你不能暗示它质量不重要。同时,如果你要修改,请你精准检查PI是如何设计的,它的prompt是如何写的。如果你要修改,你的修改的量应该是逐词、逐词或者逐个短语进行修改。同时条数不能够发生剧烈变动。你当前的变动已经超过整体内容本身的5%,请注意,对于txt或者对于prompt组装而言,整体修改内容不能超过5%。

> 请你确保你的逻辑并不会造成任何潜在可能原本能够修改的内容,发生了不能修改的问题。也就是,你的修改不能导致具体匹配以及相应替换逻辑的退化以及失败。也就是你的内容是以提高成功率而非降低成功率为优先,同时要保证修改精准准确。同时能够满足相应的修改完后,根据事实内容修改old string的机制来进行修改,而不能胡乱修改一通。

## 2. Explicit Non-Goals

- 不新增 feature flag、config、experimental 开关，或“兼容旧顺序语义”的第二套成功路径。
- 不重写 apply_patch 解析语法、权限、Mutation coordinator、LSP、diff 展示、per-file atomicity。
- 不把 fuzzy 提升成第二套独立 matcher 算法实现；fuzzy 只作为同一 locate 契约内 exact 失败后的递进规范化匹配。
- 不把 PI 的整文件 fuzzy 归一化写回策略原样复制为第二套 apply 引擎；只在匹配定位上吸收 “exact → normalize” 与 “全对原文定位 / 全局唯一 / 排序应用”。
- 不修改 Edit tool；本任务 owner 是 Patch apply。
- 不改变 diagnostic-only `closestWindow` 的相似度阈值与 “不写盘” 边界；只允许因主路径语义变化而更新依赖旧 cursor 失败的诊断测试期望。
- 不新增跨文件重排、并行 hunk 合并、或自动补丁重写。
- `apply_patch.txt` 不宣传“顺序不重要”、不鼓励模型依赖 fuzzy/自动排序；模型仍被要求提供精确、唯一、不重叠、基于已读事实的 old lines。
- prompt 保持 HEAD 原文不变（0%）；runtime robustness 不进入模型指令，避免降低 old lines 质量。
- fuzzy normalize 不采用 Codex 的双侧 trim，不忽略前导缩进。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Tool / Patch / Message 词汇；Patch 是 Tool 执行结果的 owner，不是 Session 层补偿。 |
| `packages/opencode/AGENTS.md` | package-local typecheck/test 必须在 `packages/opencode` 运行。 |
| `docs/plans/edit-apply-patch-match-recovery.md` (verified R9) | 既有成功契约：整行 exact 优先、唯一 literal substring、禁止把 trim/Unicode 伪装成 exact 成功、诊断不进入 write path。本任务在用户明确要求下 **有意识地** 扩展 fuzzy 成功域，但仍保持 “一条 locate 契约、不写盘诊断”。 |
| `.temp/pi/.../edit-diff.ts` (reference only) | 用户点名的目标语义：edits 对 original 定位、唯一、不重叠、按位置排序后 reverse apply。 |
| `.temp/pi/.../edit.ts:295-303` | PI prompt 强调 precise/exact/unique/non-overlapping/original-file/merge-nearby，从不告诉模型“顺序无所谓”或鼓励 fuzzy。 |
| `.temp/codex/.../apply-patch` (reference only) | Codex 仍用 forward `line_index`，乱序同样失败；其 fuzzy 是 seek 递进，不是乱序修复。 |
| Session evidence `ses_077111bdeffesdZELwWeeYx1vf` | 真实 GPT 多 chunk 乱序导致 `unavailable to the current patch step`（events.ts / plan.md）。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/patch/index.ts` `applyChunks` / `deriveNewContentsFromChunks` | 主路径：chunk 循环、`cursorOffset` 只前进、working copy 增量替换 | observed |
| `packages/opencode/src/patch/match.ts` `locateExact` | 成功匹配：整行优先 + 唯一 substring；cursor 起搜 | observed |
| `packages/opencode/src/tool/apply_patch.ts` | Tool 仅调用 `Patch.deriveNewContentsFromChunks`；owner 在 Patch | observed |
| `packages/opencode/src/tool/apply_patch.txt` | 模型指令：exact 优先、substring 唯一；未描述“可乱序” | contracted |
| `packages/opencode/test/patch/patch.test.ts` | 字面子串、歧义拒绝、禁止 rematch generated、pure insertion、context | observed |
| `packages/opencode/test/tool/apply_patch.test.ts` | cursor 前 candidate / consumed candidate 的失败与诊断 | observed |
| Red harness: out-of-order `-e` then `-b` on `a\nb\n...\ne\nf\n` | 当前失败并输出 `unavailable ... line 2` | observed |
| Session DB fail parts `prt_f8a21c0ed001...` / `prt_f89be3080001...` | 生产 Session 同类乱序失败 | observed |
| PI `applyEditsToNormalizedContent` | 对 original 全量定位、唯一、overlap、排序应用 | contracted (user-requested model) |
| PI `normalizeForFuzzyMatch` | `NFKC` + 每行 `trimEnd` + Unicode 引号/横线/特殊空格归一化；不 trim 前导缩进 | observed |
| `packages/opencode/src/tool/edit-apply.ts` `normalizeForMatch` | 仓库已有导出的 PI-equivalent normalization contract；Patch 可只读复用规则，不修改 Edit owner、不复制 NFKC/trim/punctuation 集合 | observed / existing shared contract |
| `packages/opencode/src/tool/edit-apply.ts` `normalizeWithMap` | composed/decomposed NFKC 的 fallback map 可把 `A\u030A` 起点错误映到 combining mark；R8 明确不复用 | observed rejection evidence |
| Codex `compute_replacements` | 乱序仍失败；仅在全部 locate 成功后 sort apply | observed |
| Prompt baseline measurement | HEAD 原文 1618 chars；R3 计划变更 distance 0 = 0%；line delta 0 | observed |
| Current regression run | draft implementation unit `42 pass`; Tool integration `43 pass / 3 fail`，三处均为旧 fuzzy-reject 期望 | observed |
| `apply_patch.ts:77-82` + repeated Update File tests | 同文件多个 entry 当前逐次把上一 entry 输出作为下一 entry 输入 | observed |
| `Patch.applyHunksToFiles` / `applyPatch` / `maybeParseApplyPatchVerified` | direct apply 逐 hunk 读写；verified 同 key 后 entry 覆盖前 entry 结果 | observed |

## 5. Current Behavior

```text
Tool apply_patch
  -> parsePatch
  -> per Update File entry: deriveNewContentsFromChunks(path, chunks, workingText)
       -> applyChunks:
            cursorOffset = 0
            for chunk in patch order:
              optional change_context: locateExact(..., cursorOffset) then advance
              if pure insertion: defer append
              else locateExact(old_lines, cursorOffset)
                   on found: mutate working copy; cursor = after replacement
                   on not-found/ambiguous: throw (withCandidate diagnostic on not-found)
            append pure insertions
  -> Mutation commit / LSP / UI
```

Observable defect: 同一文件多个独立 chunk 时，若模型先写文件后方修改、再写前方修改，即使 old block 在 **原文件** 唯一存在，也会因 `cursorOffset` 已越过目标而失败，并诊断：

```text
Exact requested text exists at this location in the original file
but is unavailable to the current patch step.
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 多 chunk Update File，chunk 顺序 ≠ 文件顺序，各 old 唯一且不重叠 | LLM `apply_patch` | parsePatch 保留 chunk 数组顺序 | Tool → deriveNewContentsFromChunks → applyChunks | Patch | observed |
| 同一调用、同一文件多个 `*** Update File` entry | LLM `apply_patch` | groupHunks 聚合同 canonical source | Tool group → 当前逐 entry working copy | ApplyPatchTool + Patch | observed |
| 多 chunk 顺序正确、同文件多处替换 | LLM | 同左 | 同左 | Patch | observed |
| 同行多处唯一 substring 替换 | LLM | 同左 | 同左 | Patch | observed |
| 两 chunk 目标同一或重叠 span（如两次 `-alpha` 仅一处） | LLM | 无上游去重 | 同左 | Patch | observed |
| chunk2 依赖 chunk1 生成文本（`-alpha`→`generated` 再改 `generated`） | LLM | 无 | 同左 | Patch | observed / contracted reject under PI semantics |
| `@@ change_context` + old block | LLM | context 字符串 | locateExact on context | Patch | observed |
| 重复 whole-line context + context 后唯一 old block | LLM | context 不保证唯一 | context first eligible → old locate | Patch | reachable / existing success domain |
| pure insertion（空 old_lines） | LLM | 无 | defer EOF append | Patch | observed |
| 行尾空白/常见 Unicode 标点与文件不完全字节相等 | LLM | Tool 输入非信任 | locate 成功域 | Patch | contracted (user fuzzy requirement) + reachable |
| 唯一 proper substring 仅在 NFKC/Unicode 标点/特殊空格后与 old block 等价 | LLM；parser 不保证 old_lines 对齐整行 | 公开 Patch 已支持 literal proper substring | Tool → derive → locator | Patch | contracted + observed producer |
| normalized occurrence 边界落在一个 NFKC grapheme 展开内部 | LLM/raw file 无 normalization 保证 | 不存在对应 old block 的连续 raw 子串 | same locator | Patch | reachable safety reject |
| 前导缩进不同 | LLM | Tool 输入非信任 | exact/normalize 均失败 | Patch | observed; PI 不放宽 |
| 诊断 closestWindow | 匹配失败 | 只读 persisted text | withCandidate | Patch diagnostic | observed |

Speculative 不纳入：自动改写模型 patch、跨文件 chunk 重排、模糊分数阈值配置化。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 同一次 apply_patch 调用内，同一 canonical 文件的全部 update entries/chunks，对调用开始时的 **原始文件** 定位；互不重叠的改动无论 section/chunk 顺序如何，一次成功。 | User PI requirement; Session failures; red harness | 当前无（red） |
| INV-02 | 每个 non-empty old block 在 context-scoped 的**有效候选层级**必须全局唯一；exact whole-line 与 normalized-equivalent whole-line 合并计数，多候选 → 明确失败；无 exact whole-line 时，exact literal substring 与 normalized whole-line 进入后备层级并同样强制唯一。 | User 全局唯一强制; PI normalized countOccurrences; established exact-line priority | substring ambiguous；需新增 exact+normalized ambiguity |
| INV-03 | 重叠或嵌套的 old spans → 失败，不写盘。 | PI overlap; dual-alpha Session pattern | consumed candidate 类 |
| INV-04 | 成功匹配顺序：exact（整行唯一 → 唯一 literal substring）→ fuzzy normalize 递进；fuzzy 不得成为独立第二 write 算法。 | User exact+fuzzy; R9 单契约精神 | 部分 exact 测试需保留；fuzzy 由新测试定义 |
| INV-05 | 匹配与替换只基于 **原始文件** 定位结果；不得把前序 chunk 的生成文本当作后续 old 候选。 | PI original-file; existing rematch tests | `does not rematch text introduced by an earlier chunk` |
| INV-06 | pure insertion 仍在所有 replacement 成功后按 patch 顺序追加 EOF；`@@ context` 保留既有 first eligible exact whole-line / unique substring 下界语义，不受 old-block 全局唯一收窄。 | existing pure insertion/context tests | patch.test.ts insertion/context |
| INV-07 | 失败保持文件原子性；诊断仍只读 persisted 原文且不写盘。 | apply_patch atomicity; closestWindow | apply_patch tests |
| INV-08 | 无 enable/disable 开关；默认生产路径唯一。 | User | N/A |
| INV-09 | prompt 保持 HEAD 原文，仍要求精确 old lines，不暗示乱序/fuzzy 可依赖；编辑距离 0%。 | Latest user constraint; PI prompt | `git diff -- apply_patch.txt` empty |
| INV-10 | 除 “全局唯一强制” 明确要求废止的歧义 first-hit 外，所有既有成功行为必须保持成功；本变更只能扩展有效成功域。 | Latest user constraint | full patch/tool regression suites |
| INV-11 | ApplyPatchTool、Patch direct apply、verified preview 对同一 patch 的 same-file update entries 必须产生相同 original-only 内容或相同拒绝，不得 consumer 分叉。 | Exported consumers + one semantic owner | consumer parity tests |
| INV-12 | 唯一 exact whole-line 命中必须保留既有成功；同一字面若仅嵌在另一条更长行内，低层 proper substring 不得把该整行命中改判 ambiguous；其它 normalized-equivalent **whole-line** 仍参与 INV-02 唯一性。 | User “不能导致原本能够修改的内容不能修改”; Session chunk 16 line 366 + nested line 247; R9 exact-line-first contract | 新增 Session-shaped tier regression |
| INV-13 | 无 exact whole-line 时，唯一 PI-normalized proper substring 必须通过完整 grapheme NFKC 视图映射回 original 的连续 raw grapheme span，仅替换该 span；同一行未提交的前后缀和行尾字节保持逐字不变，多处 normalized occurrence 明确失败。 | User exact+fuzzy normalize + no regression; PI full-text `indexOf`; public literal substring contract | 新增 owner + Tool normalized-substring tests |
| INV-14 | normalized match 的 start/end 若不能同时落在 raw grapheme boundary，则不得产生写 span；禁止把 normalized UTF-16 offset 直接当 raw offset，或只消费 combining mark/半个 compatibility grapheme。 | User 精准 old string; R7 B-01; `A\u030A` reproduction | 新增 composed/decomposed + expansion boundary tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `applyChunks` 在 chunk 循环中用前进 `cursorOffset` 限制后续 `locateExact`，使位于 cursor 之前的唯一原文变为 not-found | `packages/opencode/src/patch/index.ts` `applyChunks` | Red: out-of-order e/b 失败且诊断 “exists … unavailable”; Session events.ts chunk17 after chunk16 |
| INV-02 (whole-line) | `locateExact` 整行分支返回 **第一个** 命中，不统计 uniqueness | `match.ts` `locateExact` | 源码：`for ... matchesAt` 首次 return；substring 才有 ambiguous |
| INV-04 fuzzy | 成功路径在 exact 失败后直接 not-found；trailing whitespace / Unicode 被现测明确拒绝 | `match.ts` + `apply_patch.test.ts` | 源码 + 测试 |
| INV-01 cross-entry | `processHunkGroup` 逐 entry 调用 Patch，并把上一 entry `working` 传入下一 entry | `tool/apply_patch.ts` + repeated move tests | 可消费本次调用生成文本，违反 original-only |
| INV-02 normalized uniqueness | exact 命中可提前成功，不检查其它 normalized-equivalent whole-line | current matcher + PI countOccurrences | ASCII exact + smart-quote candidate 可误写 |
| INV-06 context regression | old-block uniqueness 若直接复用到 context，会把重复 context 的既有 first-hit 成功改为 ambiguous | current context call + public grammar | reachable normal shape |
| INV-11 direct/verified consumers | direct apply 逐 hunk 写盘并重读；verified 对同 resolved key 覆盖前一完整结果 | exported interfaces + tests | generated-text 可成功或前一修改静默丢失 |
| INV-12 R5 plan drift | R5 把全部 exact literal occurrence 与 whole-line window 放入单一清单；唯一 exact whole-line 会被另一更长行内的低层 substring 否决 | `match.ts` R5 working diff / `replay-events-patch.ts` | Session chunk 16：line 366 column 1 exact whole-line，line 247 column 5 仅为 nested literal；R5 isolated replay 误报 ambiguous |
| INV-13 R6 plan gap | R6 仅枚举 normalized whole-line；parser 接受的 proper substring 若只有 Unicode/NFKC 差异仍返回 not-found | `match.ts` locator / PI `fuzzyFindText` / focused differential loop | OpenCode `FAIL Failed to find expected lines`; PI `{found:true,index:7,usedFuzzyMatch:true}` on `prefix He said “hello” suffix` |
| INV-14 R7 map flaw | R7 计划复用 Edit `normalizeWithMap`，其 fallback scanner 用 `end - 1` 记录 normalized 字符起点 | `tool/edit-apply.ts:323-343`; R7 audit | original `A\u030A tail`, old `Å` 会映到 raw combining mark，错误结果 `AX tail` 而非 `X tail` |

### Red-capable feedback loop

Command (package dir `packages/opencode`):

```bash
bun -e 'import { parsePatch, deriveNewContentsFromChunks } from "./src/patch/index.ts"
const original = "a\nb\nc\nd\ne\nf\n"
const patch = `*** Begin Patch\n*** Update File: multi.txt\n@@\n-e\n+E\n@@\n-b\n+B\n*** End Patch`
const h = parsePatch(patch).hunks[0]
try { console.log("SUCCESS", deriveNewContentsFromChunks("multi.txt", h.type==="update"?h.chunks:[], original).content) }
catch (e) { console.log("FAIL", e instanceof Error ? e.message : e) }'
```

Observed result (2026-07-22):

```text
FAIL Failed to find expected lines in multi.txt.

Closest match at line 2:
Exact requested text exists at this location in the original file but is unavailable to the current patch step.
```

User-visible symptom captured: 原文有唯一 `b`，但因先改 `e` 推进 cursor 而失败。  
Minimized: 两 chunk、两行、无 context、无 EOF。

R6 drift signal（系统缓存、未写工作区）：

```text
incident_chunk_16_literal_locations=[{"line":247,"column":5,...},{"line":366,"column":1,...}]
incident_chunk_16_isolated=fails:Found multiple matches for expected lines in events.ts.
incident_chunk_17_literal_locations=[{"line":251,"column":5,...}]
incident_chunk_17_isolated=passes
```

该结果不是新的模型错误：chunk 16 在旧 matcher 有一个唯一 exact whole-line，因 R5 把 lower-tier nested substring 提前升格为同层候选才发生退化。R6 必须修 candidate-tier owner，不能加 Session 特判或失败后 fallback。

R7 normalized-substring red signal（package dir `packages/opencode`，PI differential 在 `.temp/pi`）：

```text
OpenCode: FAIL Failed to find expected lines in fuzzy-substring.txt.
PI: {"found":true,"index":7,"matchLength":15,"usedFuzzyMatch":true,...}
```

最小输入只有一行、一个 old block 和一处 smart-quote 差异：`prefix He said “hello” suffix` / `He said "hello"`。缺口属于同一 Patch locator 的 supported domain，不授权第二 matcher 或 normalized whole-file writeback。

Root cause is **not** “模型错误到不可执行”，而是 Patch owner 将 **集合式独立替换** 实现成 **顺序脚本 + forward cursor**。  
PI 语义修复第一分歧：定位全部对 original，再按位置统一应用。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 同文件全部 entry/chunk 聚合 | 每个拥有完整 patch proposal 的 consumer → Patch | 一个 source proposal 在一次 Patch owner 调用中派生 | Tool/Direct/Verified 各自拥有 path resolution/group 边界 | matcher 不拥有 filesystem/canonical grouping |
| 多 chunk 定位/唯一/重叠/排序应用 | `Patch.deriveNewContentsFromChunks` / `applyChunks` | 给定原始文本与聚合 chunks → 新内容或 failure | 所有同文件 replacements 进入此入口 | Tool 不复制 matcher |
| exact + fuzzy locate | `patch/match.ts` | 在内容上唯一定位 pattern | 已有 locateExact/closestWindow | 禁止在 tool 再写一套 |
| normalize contract | existing `tool/edit-apply.ts` `normalizeForMatch` | Patch 只读复用 PI-equivalent 输出规则 | 不修改 Edit 行为 | 避免第二份 NFKC/trim/punctuation 规则 |
| normalized→raw boundary | `patch/match.ts` private normalized view | 按行 trimEnd 后以 `Intl.Segmenter(..., grapheme)` 遍历 raw grapheme；用 NUL sentinel 调用共享 `normalizeForMatch`，避免 interior whitespace 被单段 trimEnd，记录 normalized boundary→raw boundary | locator 拥有 candidate 坐标 | 现有 Edit map 已被 composed-NFKC 反例证伪，不能承载 Patch 精准 raw span |
| context locate | `patch/match.ts` dedicated context contract | first eligible exact whole-line，后备 unique literal substring | 保留现有成功域 | 不能复用 old-block normalized/global-unique 收窄 |
| 模型说明 | `apply_patch.txt` | 维持 HEAD 精确匹配指令 | 模型输入面 | runtime robustness 不应降低输出质量 |
| 行为测试 | `test/patch/patch.test.ts` + `test/tool/apply_patch.test.ts` | 公共 seam：deriveNewContentsFromChunks / tool execute | 现有组织 | 不测 private helper 名 |

## 10. Single Approved Primary-Path Design

```text
same-file Update File entries
  -> each consumer groups same-source compatible update entries before any write/result publication:
       ApplyPatchTool: existing canonical HunkGroup + move ownership
       applyHunksToFiles/applyPatch: AppFileSystem.resolve canonical source group, preserve first operation position
       maybeParseApplyPatchVerified: AppFileSystem.resolve(resolved source) group before changes Map
  -> validate repeated move destinations using each consumer's existing path semantics
  -> flatten all entry chunks in original patch order
  -> one deriveNewContentsFromChunks(original file, flattened chunks)
input flattened chunks + original lines/text
  -> for each chunk:
       if change_context:
         locate context on ORIGINAL with existing context contract:
         first eligible exact whole-line; otherwise unique exact literal substring
       if old_lines empty:
         record pure insertion (ordered list); continue
       locate old_lines on ORIGINAL from offset 0 (or after context end if context present):
         inventory exact whole-line windows first
         if one or more exact whole-line windows exist:
           combine them with all normalized-equivalent whole-line windows, deduplicated by line span
           require exactly one whole-line candidate; lower-tier proper substrings are ineligible
         otherwise:
           build one PI-normalized original view in Patch:
             trimEnd per raw line, segment retained text by grapheme;
               normalize each complete grapheme as normalizeForMatch(grapheme + NUL) minus the unchanged NUL sentinel
             record only normalized offsets at raw grapheme boundaries; assert the resulting view equals normalizeForMatch(original)
           inventory exact literal substring occurrences plus all normalized old-block occurrences
           classify a normalized occurrence aligned to a complete normalized line window as line identity;
             otherwise require both normalized boundaries in the grapheme map and map to one continuous original substring span
           deduplicate normalized identity when it maps to the same exact occurrence
           require exactly one fallback-tier candidate identity across exact/normalized occurrences
         selected identity:
           exact whole-line-aligned span -> line replacement
           exact proper substring span -> substring replacement
           normalized-only whole-line window -> line replacement
           normalized proper substring raw grapheme span -> substring replacement
         fail: zero / multiple candidates in the active tier
         EOF marker may prioritize only after the same active-tier global inventory proves uniqueness;
         it never bypasses exact/normalized ambiguity
       record replacement span {start,end,kind,new_lines}
  -> if any two replacement spans overlap: fail (no write)
  -> sort replacements by start ascending
  -> apply reverse on a copy of original (line splice for whole-line kind; literal range for substring kind)
  -> append pure insertions in patch order at EOF
  -> existing BOM / trailing newline / unified_diff owners unchanged
```

Why this repairs first divergence:

- 去掉 inter-chunk forward cursor 作为成功必要条件；乱序唯一 chunk 可定位。
- 全局唯一 + 重叠拒绝替代 “猜第一处 / 静默覆盖”。
- exact 优先保持 R9 字面子串与周围文本保留；fuzzy 仅在同一 locate 函数的 active tier 内递进，normalized proper substring 必须先映回连续 raw span，不能扩大到整行或改写外围文本。
- R6 让 exact whole-line 保持既有优先层级；nested proper substring 只有在没有 exact whole-line 时才成为候选，不用 fallback 也避免 R5 对 Session 旧成功域的退化。
- R8 在同一 fallback tier 补齐 PI 的 normalized proper substring；Patch 的 grapheme boundary view 只负责候选坐标，选中的 raw span 仍进入唯一的 overlap/sort/reverse apply。
- 不复制 PI “重写整条 touched line 的 normalized 文本”：Patch 用 raw span 写回，保证 proper substring 外围原文字节不被 normalization 顺带改变。
- `Intl.Segmenter` 已由 Bun runtime 和仓库生产代码使用；完整 grapheme normalization 覆盖 composed/decomposed NFKC，不能切进 expansion 内部。
- 生成文本仍不可被后续 old 命中（全部对 original 定位）。
- pure insertion / context 校验保留既有契约形状。
- prompt 继续使用 HEAD 的 exact old-lines 质量要求，不暴露 runtime 的乱序/fuzzy 容错能力。
- prompt 不再修改；HEAD 原文已经要求 exact old lines，0% 是最精准且不会误导模型的方案。
- 原本成功的 unique exact whole-line、unique exact substring、ordered multi-chunk、CRLF、delete、pure insertion、context、same-line compose 均须保持成功；唯一预期收窄是用户明确要求的全局唯一拒绝多命中 first-hit。
- 同文件 repeated entries 不再共享增量 working copy；它们只保留 move declaration 聚合，全部 chunks 一次送入 Patch owner。
- direct apply 与 verified preview 同样先聚合 repeated update entries；不得逐 hunk 写盘/Map 覆盖。
- old-block uniqueness 与 context selection 是两个真实接口契约：前者按 normalized domain 全局唯一，后者保留 first eligible context 来约束 old block 下界。

**Explicit product semantic change** (user-authorized, not fallback):

| Before | After |
| --- | --- |
| chunk 必须按文件从上到下；回头失败 | 独立唯一 chunk 任意顺序成功 |
| whole-line 取首个命中 | whole-line 多命中 → ambiguous |
| trailing-whitespace/Unicode 成功被拒绝 | exact 失败后允许 unique PI-normalized whole-line 或可映射 proper-substring 成功；leading indentation 仍失败 |
| 依赖前序生成文本的第二 chunk 失败 | 仍失败（对 original 找不到） |
| 第二个同文件 Update File entry 可消费第一个 entry 生成文本 | 失败；同文件全部 entries 对调用开始时 original 定位 |
| exact 候选旁存在 normalized-equivalent 候选 | 失败；PI normalized uniqueness 不允许提前 exact 成功 |
| 重复 whole-line context 后有唯一 old block | 保持成功；context 不采用 old-block 全局唯一 |
| 唯一 exact whole-line 的字面还嵌在另一更长行内 | 保持 exact whole-line 成功；低层 proper substring 不参与该 active tier |
| 唯一 normalized proper substring | 映射回 original 连续 span 并仅替换该 span；前后缀逐字保留 |

No dual path: 不保留 “旧 cursor 模式” 开关。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| exact whole-line unique locate | current/proposed | primary-contract first tier | yes | keep | preserve + strengthen same-tier uniqueness |
| exact unique substring locate | current/proposed | primary-contract fallback tier, only without exact whole-line | yes | keep | preserve established priority |
| PI-normalized whole-line locate | proposed | primary-contract branch (same locate contract, ordered attempt) | yes | add under INV-04 | add |
| PI-normalized proper-substring locate | proposed | same primary locator fallback tier | yes | add under INV-13/14 | add; not a second matcher/apply path |
| grapheme-aligned normalized view | proposed private locator representation | supported-domain coordinate mapping | no independent success decision | add | one view, no failure-triggered matcher |
| existing `normalizeWithMap` | current Edit helper | proven unsuitable for Patch raw-span contract | no | reject reuse | leave Edit owner unchanged |
| inter-chunk forward cursor gating | current | superseded sequential script | yes/no mixed | remove from success | delete |
| pure insertion EOF append | current | primary-contract branch | yes | keep | preserve |
| change_context unique locate | current | primary-contract branch | gate only | keep | preserve; bounds old locate start after context line when present |
| change_context first eligible whole-line | current/proposed | primary-contract branch | gate only | keep | preserve existing success domain |
| overlap / multi-hit reject | proposed/current partial | primary-contract reject | no | keep/extend | preserve/extend |
| closestWindow diagnostic | current | diagnostic | no | keep | preserve |
| second apply engine / flag / Codex line_index dual mode | proposed-forbidden | forbidden fallback | yes | zero | reject |
| same-file entry incremental working copy | current | superseded success path | yes | remove | flatten before one Patch call |
| direct apply per-hunk read/write | current | superseded success path | yes | remove for same-file updates | group before write |
| verified same-key full-result overwrite | current | correctness defect | no (drops prior edit) | remove | group before changes.set |

Secondary diagnostic/reject ratio remains inside primary contract rejects + one diagnostic renderer; no alternate success algorithm.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `cursorOffset` 只前进导致的 “exists but unavailable” 失败类 | Codex 顺序脚本语义 | PI 集合编辑语义下该失败类对 **独立唯一** chunk 不应出现 | `applyChunks` |
| 模型侧拆多次 apply_patch 规避乱序 | 工具契约过严 | 一次调用即可 | 行为变化后自然减少；无代码 workaround 可删 |
| Session 诊断文案依赖 cursor 不可达 | 解释顺序失败 | 乱序成功后主要保留给真正 not-found/overlap | 测试期望更新，非第二算法 |
| `processHunkGroup` entry 间 incremental `working` | 支持 repeated update sections | 违反一次调用 original-only；flatten 可保留相同 move 结果 | `tool/apply_patch.ts:73-97` |
| direct apply 逐 hunk 更新 / verified Map 覆盖 | 历史 consumer 各自处理 parser hunks | 与 Tool 语义分叉；同一 grouped derivation 取代 | `patch/index.ts` consumer loops |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 乱序唯一 chunk 成功 | applyChunks original locate + sort apply | `patch/index.ts` | patch.test: out-of-order multi chunk → final content |
| INV-01 跨 repeated entries original-only | group flatten → one derive | `tool/apply_patch.ts` | cross-entry out-of-order success；cross-entry generated-text reject |
| INV-02 全局唯一 | locateExact unique whole-line + substring | `patch/match.ts` | patch.test: duplicate whole-line ambiguous |
| INV-02 normalized 唯一 | unified candidate inventory | `patch/match.ts` | one exact + one smart-quote normalized candidate → ambiguous |
| INV-12 exact-line tier 不退化 | tiered candidate inventory | `patch/match.ts` | Session-shaped exact whole-line + nested same literal → exact line succeeds |
| INV-13 normalized proper substring | grapheme normalized view → same candidate inventory | `patch/match.ts` imports only normalize contract | smart-quote/NFKC mid-line success with exact surrounding bytes; duplicate normalized substring ambiguous |
| INV-14 raw boundary precision | grapheme boundary map | `patch/match.ts` | decomposed `A\u030A` matched by `Å` yields `X tail`; partial compatibility expansion is rejected |
| INV-03 重叠拒绝 | span overlap check | `patch/index.ts` | patch.test / apply_patch: dual alpha fails atomic |
| INV-04 exact→fuzzy | ordered attempts in locate | `patch/match.ts` | patch.test: trim/unicode unique whole-line succeeds; exact still preferred when both possible |
| INV-05 不匹配生成文本 | all locates on original | `patch/index.ts` | keep `does not rematch text introduced...` |
| INV-06 pure insertion / context | deferred insert + context locate | `patch/index.ts` | keep insertion/context tests |
| INV-07 原子失败 | unchanged throw before write | tool layer | apply_patch dual-alpha 文件未变 |
| INV-08 无开关 | 默认路径 | no config | code inventory |
| 模型质量契约 | HEAD 指令文本 | `apply_patch.txt` 不修改 | `git diff` empty / 0% |
| 删除 forward-cursor 失败假设 | 测试重写 | `apply_patch.test.ts` | 原 cursor-before tests → 乱序成功；consumed → overlap/ambiguous |
| INV-09 prompt 0% 且不鼓励乱序 | 保持 HEAD | `apply_patch.txt` no diff | `git diff` empty |
| INV-10 无既有成功退化 | exact/ordered/context/CRLF/delete/insertion paths | `match.ts` + `index.ts` | 完整 patch + tool regression suites |
| INV-06 context 不退化 | dedicated context locator | `match.ts` + `index.ts` | repeated whole-line context + unique old succeeds |
| INV-11 consumer parity | proposal grouping → same derive | `patch/index.ts` + `tool/apply_patch.ts` | Tool/direct/verified repeated entries yield same content or rejection |
| INV-01/11 canonical alias parity | `AppFileSystem.resolve` source identity in all consumers | `patch/index.ts` + `tool/apply_patch.ts` | real path + symlink alias entries unify for Tool/direct/verified |
| INV-02 EOF uniqueness | common candidate inventory before EOF preference | `match.ts` | duplicate complete old block with one EOF occurrence → ambiguous and unchanged |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 全 chunk 对 original 定位 | INV-01/05 | PI; Session; red | 现逻辑用 working+cursor |
| 同文件 entries flatten | INV-01/05 | reachable repeated entries | 现 Tool entry 间 incremental working |
| direct/verified proposal grouping | INV-01/05/11 | exported consumers | 现逐写/覆盖不能复用 Tool-only group |
| canonical source identity in every consumer | INV-01/11 | AppFileSystem.resolve contract + alias tests | lexical/path.resolve grouping cannot identify symlink aliases |
| EOF preference after uniqueness | INV-02 | supported EOF branch | positional preference cannot bypass global uniqueness |
| 定位后按 start 排序 reverse apply | INV-01 | PI | 现逻辑边定位边 mutate |
| whole-line 全局唯一 | INV-02 | user 全局唯一 | 现整行取 first |
| span overlap reject | INV-03 | PI; dual-alpha | 现靠 cursor/消费偶发失败，错误类型不稳定 |
| PI-normalized whole-line pass | INV-04 | user fuzzy + PI source | 现 exact-only 成功域 + 测拒绝 |
| authoritative tiered normalized candidate inventory | INV-02/04/10/12 | PI normalize + existing exact-line-first + Session replay | 单一 flat inventory 会误伤 nested substring；旧 exact-first 又无法排除 normalized-equivalent whole-line |
| grapheme normalized→raw boundary view | INV-04/10/13/14 | R7 map counterexample; proper substring producer; PI full-text matcher; existing Bun `Intl.Segmenter` use | normalized offset 长度可能因 NFKC 改变；现有 map 已证伪，locator 必须拥有可验证的 raw candidate 坐标 |
| dedicated context locator | INV-06/10 | existing context behavior | old-block uniqueness 不能承载 first eligible context 契约 |
| apply_patch.txt unchanged | INV-09 | latest user + PI prompt | 不需要宣传 runtime 容错；0% 最小且精准 |
| 删除 inter-chunk cursor success gate | INV-01 | red | cursor 即第一分歧 |

无 “可选兼容模式”“第二 parser”“自动重排 patch 文本再 parse” 等概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | modify | locate：exact-line active tier；唯一 literal/normalized substring fallback tier；共享 normalize contract + private grapheme raw map | +90–150 prod |
| `packages/opencode/src/patch/index.ts` | modify | `applyChunks` collect→unique/overlap→sort→reverse apply；direct apply/verified 按 source 聚合 repeated updates；保留其它 operation 顺序 | +90–160 / −40–80 net |
| `packages/opencode/src/tool/apply_patch.ts` | modify | 同 canonical source 的 update entries flatten 成一次 derive；保留 repeated move destination validation | +10–25 / −10–20 |
| `packages/opencode/src/tool/apply_patch.txt` | no change | 恢复/保持 HEAD；0% 修改，不宣传乱序/fuzzy | 0 |
| `packages/opencode/test/patch/patch.test.ts` | modify | 乱序、唯一/重叠、whole-line tier、whole-line/proper-substring fuzzy、consumer parity | +250–350 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | 乱序/原子性/aliases/repeated entries + normalized proper-substring Tool integration | +80–130 |
| `docs/plans/apply-patch-original-ordered-edits.md` | add | 本 canonical plan | plan only |

实际变更文件：3 production TS + 2 tests + 1 plan = 6；prompt 不计入 diff。生产代码目标 ≪800 行。

## 16. TDD Behavior Slices

Seam: **`Patch.deriveNewContentsFromChunks`**（主）；**`apply_patch` tool execute**（集成原子性/诊断）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 乱序 `-e` 后 `-b` 得到 `a\nB\nc\nd\nE\nf\n` | cursor 越过 b | original locate + sort apply | INV-01 |
| 2 | 同行两 substring 乱序仍组成正确结果 | 可能顺序依赖 | original spans + reverse apply | same-line compose |
| 3 | 两处相同 whole-line old → ambiguous 失败 | 现取 first | unique whole-line | INV-02 |
| 4 | 两 chunk 同 span（两次 alpha）失败且文件不变 | 现 unavailable 文案 | overlap/ambiguous reject | INV-03/07 |
| 5 | 唯一 whole-line 仅行尾空白/Unicode 标点差 → 成功替换整行；前导缩进差仍失败 | 现全部 not-found | PI normalize after exact | INV-04/10 |
| 6 | exact 字面子串仍优先于 fuzzy（`  CDEFG  ` / `CDEFG` → 保留两侧空格） | 若 fuzzy 抢先会吃掉空格 | exact 先于 fuzzy | R9 周围文本 |
| 7 | 不 rematch 生成文本；pure insertion；substring context | 应保持 | 定位仅 original；insert/context 不变 | INV-05/06 |
| 8 | 两个有 `@@` context 的独立 chunk 乱序仍成功 | shared cursor 失败 | 每 chunk context 对 original 独立定位 | auditor R1 note / INV-01/06 |
| 9 | 完整旧成功域回归：ordered multi-hunk、same-line、CRLF、deletion、pure insertion、context、substring | 不允许退化 | unchanged outcomes | INV-10 |
| 10 | 两个同文件 Update File entries 乱序仍成功 | entry incremental working/cursor | group flatten + one derive | INV-01 |
| 11 | entry2 oldText 仅由 entry1 生成 → 整包失败且文件不变 | 现可成功 | all entries locate original | INV-05/07 |
| 12 | exact ASCII 行 + normalized-equivalent smart-quote 行 → ambiguous | exact 现提前成功 | unified normalized uniqueness | INV-02/04 |
| 13 | 重复 whole-line context + 唯一 old block → 仍成功 | naive global context uniqueness 会退化 | context first eligible contract | INV-06/10 |
| 14 | `Patch.applyPatch` repeated entries 乱序统一成功；generated dependency 整包拒绝 | 当前逐 hunk 写/重读 | direct proposal grouping | INV-01/05/11 |
| 15 | verified preview repeated entries 保留两个修改；generated dependency CorrectnessError | 当前 Map 覆盖/分叉 | resolved-source grouping | INV-01/05/11 |
| 16 | PI normalization 字面矩阵：NFKC fullwidth、NBSP/special space、smart punctuation、space-vs-tab trimEnd 成功；leading indentation mismatch 失败 | 实现可漏分支 | fixed literals per transform | INV-04/10 |
| 17 | real path + symlink alias repeated entries：Tool/direct/verified 产生同一统一结果或相同 generated-text rejection | lexical grouping 分叉 | canonical source identity | INV-01/11 |
| 18 | 完整 old block 出现两次且一处位于 EOF anchor → ambiguous、文件不变 | EOF fast path 可猜末项 | global inventory before EOF preference | INV-02/07 |
| 19 | Session-shaped 唯一 exact whole-line + 另一更长行内同 literal → 保持整行成功；若另一行只 normalized-equivalent whole-line → ambiguous | R5 flat inventory 把 lower-tier substring 升格造成退化 | one locator 内的 exact-line active tier + normalized line uniqueness | INV-02/10/12 |
| 20 | `prefix He said “hello” suffix` 用 `He said "hello"` 成功且只得 `prefix fixed suffix`；NFKC/multiline 边界同样保留；两处 normalized proper substring → ambiguous | R6 whole-line-only fuzzy 返回 not-found | grapheme normalized view → raw candidate → common reverse apply | INV-02/04/10/13 |
| 21 | 同一 normalized proper-substring patch 通过 ApplyPatchTool 得到固定完整文件结果 | owner-only 测试无法发现 Tool adapter 分叉 | Tool 仍只调用 Patch derive owner | INV-11/13 |
| 22 | original `A\u030A tail`、old `Å`、new `X` → `X tail`；ligature/fullwidth 仅在 match 边界覆盖完整 raw grapheme 时成功，切入 expansion 时失败 | R7 复用 map 会产生 `AX tail` | grapheme start/end boundary gate | INV-10/13/14 |

Expected values are fixed literals, not recomputed production algorithms.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 540–580 | 含当前 R5 working diff 与 R8 新 slice；排除 import-only/空行/纯格式 |
| Required Chinese explanatory comments `C` | ≥ ceil(E×0.15) ≈ 81–87 | 贴近定位顺序、唯一/重叠、original-only、normalized raw-map 边界 |

Must explain nearby:

- 为何 locate 全部对 original，禁止 inter-chunk cursor 成功门闸。
- 为何 whole-line 与 substring 均强制唯一。
- 为何 normalized candidate 必须参与 exact 成功前的统一唯一性证明。
- 重叠检测防止双写同一 span。
- exact whole-line 优先层级与 normalized proper-substring fallback tier 的边界。
- normalized offset 必须经 grapheme boundary map 回到 raw span，不能把 NFKC 后长度直接当原文 offset。
- 为何 context 保留 first eligible 契约，不能复用 old-block 全局唯一。
- 为何同文件 repeated entries 必须在 Tool group 边界 flatten。
- pure insertion 仍延后 EOF 的原因。
- 测试意图：乱序成功 vs 重叠失败 vs 不匹配生成文本。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| Red mini harness (Section 8) | `packages/opencode` | 修复前 FAIL / 修复后 SUCCESS `a\nB\n...\nE\nf\n` |
| `bun test test/patch/patch.test.ts` | `packages/opencode` | unit seam |
| `bun test test/tool/apply_patch.test.ts` | `packages/opencode` | tool integration + atomicity |
| `bun typecheck` | `packages/opencode` | types |
| Optional: session-shaped patch replay in `/var/folders/.../T/opencode` only | temp | 不写仓库 |
| `git diff -- packages/opencode/src/tool/apply_patch.txt` | repo root | empty，prompt 0% |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 (plan) | 新 canonical plan |
| Files modified | 5 | match + index + apply_patch.ts + 2 tests；prompt 不改 |
| Files deleted | 0 | — |
| Production lines | ≤250 | 甜点级；目标远低于 800 |
| Test lines | ≤450 | R5 已实现 consumer/alias 矩阵；R8 仅补 candidate-tier、normalized proper-substring 与 raw-boundary regressions |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Class | Mitigation |
| --- | --- | --- |
| 依赖生成文本的顺序 patch 将继续失败 | contracted change | 文档与测试固定；符合 PI/用户 |
| whole-line 唯一性比旧 “first hit” 更严 | contracted | ambiguous 错误引导加 context |
| PI-normalized match 可能改错“看起来像”的 span | reachable | exact-line tier 优先；fallback tier 全局唯一；normalized offset 映回连续 raw span；不 trim 前导缩进 |
| 既有 cursor 诊断测试失效 | observed | 改为乱序成功/重叠失败断言 |
| prompt 宣传 runtime 容错会降低模型质量 | observed/latest user | 恢复并保持 HEAD；0% |
| whole-line duplicate 旧 first-hit 会从成功变失败 | contracted exception | 用户原始 “全局唯一强制” 明确要求；其余既有成功域必须零退化 |
| naive uniqueness 误伤 context | reachable | context 独立 contract + regression test |
| repeated entries 形成第二增量路径 | observed | flatten all same-file chunks before one derive |
| direct/verified consumer 继续分叉 | observed | 各 proposal consumer 在首次 write/Map set 前 group，再复用 derive owner |
| normalization 分支未被行为锁定 | contracted | NFKC/special-space/punctuation/trimEnd/leading-indent literal matrix |
| lexical source grouping 漏掉 symlink alias | reachable | 所有 consumer 统一 `AppFileSystem.resolve` canonical key；alias parity tests |
| EOF preference 绕过 uniqueness | reachable/contracted | 先完成全局候选唯一性，再允许唯一 EOF 候选定位 |
| exact-line tier 与 PI raw substring count 不完全相同 | contracted compatibility | 用户明确禁止原有成功退化；只排除 lower-tier nested substring，normalized-equivalent whole-line 仍全局计数 |

### Open Decisions Requiring the User

None for R8：用户已明确选择“开启新周期（推荐）”；R8 已吸收新周期 R7 审计的 composed-NFKC raw-boundary finding，仍未授权未经审计的实现或提交。

### Rejected Speculation

- 保留 Codex forward cursor 作为 fallback。
- feature flag 切换旧语义。
- 自动重写 patch 文本再解析。
- 相似度打分 substring / 模糊阈值配置。
- Edit tool 同步改造（非本需求 owner）。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair (first divergence in `applyChunks` cursor), fallback absence, ownership, tests, code quality, and the 15% Chinese explanatory-comment plan.
- Verify no dual success path / enable flag.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | (1) 重叠失败文案未钉死，实现应用明确 reject 而非 cursor unavailable 文案；(2) fuzzy normalize 应落成同一 locate 契约内的一次/有序规范化；(3) 建议补 context 消歧乱序成功切片；(4) 勿把 EOF 优先命中写成强保证除非修 parse | APPROVE | task ses_075911e02ffeGI0leadI85n3HX |
| 2 | R2 | yes | B-01 同文件 repeated entries 仍增量消费 generated；B-02 exact 提前成功跳过 normalized-equivalent uniqueness；B-03 old-block uniqueness 误伤重复 context 既有成功域 | Prompt 计划本身满足 <5%，但工作树 draft 非实现证据；实际 E/C 待 implementation audit | BLOCK | task ses_0755e20e8ffezdmjL8rsfSzXtD |
| 3 | R3 | yes | B-01 direct apply / verified Patch consumers 未统一 repeated entries；B-02 PI NFKC / special spaces 分支缺敏感测试 | None | BLOCK | task ses_075561a83ffefnlU8ovSj6dzej |
| 4 | R4 | yes | B-01 direct/verified 仅 lexical path grouping，未统一 symlink canonical identity；B-02 EOF preference 缺 global-uniqueness 敏感测试 | None | BLOCK | task ses_0754e2ef0ffeWda3gygHYDTfHp |
| 5 | R5 | yes | No blocking findings. | (1) 修正 line 237 与 prompt 0% 的旧措辞；(2) actual E/C 待 implementation audit；(3) 当前 partial diff 不属于 plan approval | APPROVE | task ses_0754308b0ffe45iCKFHNlrYFsP |
| 6 | R6 | yes | B-01 fuzzy normalize 被收窄为整行匹配，未覆盖 PI 的完整文本匹配契约 | None | BLOCK | task ses_0751a1f07ffeEtNVA5i6jo5R2W |

### Plan Audit Cycle 2 Record

User-authorized new planning/audit cycle after the first cycle exhausted six rounds.

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01 现有 normalized→raw map 会在合法 NFKC 组合字符上定位错误的原文跨度 | None | BLOCK | task ses_074f4c694ffe2UzXE9bsKWH2Va |
| 2 | R8 | yes | No blocking findings. | None | APPROVE | task ses_074edbd62ffenHtO73IOgdeYoF |

### Independent auditor verdict (verbatim summary fields)

```text
No blocking findings.
APPROVE
```

R1 approval 已因后续实质设计修订失效；R5 approval 也已因真实 Session replay 发现的 exact-line 成功域退化而失效。

### R5 independent auditor verdict

```text
No blocking findings.
APPROVE
```

Approval applies only to canonical plan revision R5. Implementation may proceed only on this exact revision.

R5 approval is superseded by R6/R7/R8. R8 requires a new full-scope plan audit before any further production or test change.

### R6 independent auditor verdict

```text
Blocking finding B-01: fuzzy normalize 被收窄为整行匹配，未覆盖 PI 的完整文本匹配契约。
Release verdict: BLOCK
```

R6 is not approved. Its first-cycle six-round limit was exhausted; the user subsequently authorized a new planning/audit cycle, now represented by R8.

### R7 independent auditor verdict

```text
Blocking finding B-01: 现有 normalized→raw map 会在合法 NFKC 组合字符上定位错误的原文跨度。
Release verdict: BLOCK
```

R7 is not approved. R8 replaces its invalid existing-map premise with a Patch-owned grapheme-boundary representation.

### R8 independent auditor verdict

```text
No blocking findings.
APPROVE
```

Approval applies only to canonical plan revision R8. Implementation may proceed only on this exact revision.

## 23. Implementation Evidence

Frozen for full-scope implementation audit on 2026-07-23 against approved revision R8.

### Actual Files and Diff

| File | Actual responsibility | Diff |
| --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | exact-line active tier；exact/normalized fallback inventory；grapheme-aligned normalized raw view；dedicated context locator | +194 / −23 |
| `packages/opencode/src/patch/index.ts` | original-only collect；span overlap reject；sort/reverse apply；direct/verified canonical grouping | +119 / −48 |
| `packages/opencode/src/tool/apply_patch.ts` | canonical source group flatten → one Patch derive；move destination validation 保留 | +12 / −14 |
| `packages/opencode/test/patch/patch.test.ts` | owner、direct、verified、alias、NFKC raw-boundary 行为矩阵 | +395 / −23 |
| `packages/opencode/test/tool/apply_patch.test.ts` | Tool atomicity、乱序、repeated entries、alias、normalized substring integration | +122 / −44 |
| `docs/plans/apply-patch-original-ordered-edits.md` | sole canonical plan、全部 plan/implementation audit record | added |

- Actual changed files: 3 production TS + 2 tests + 1 plan = 6.
- Production net lines: `(119−48) + (194−23) + (12−14) = 240`，满足 R8 `≤250`，远低于用户偏好上限 800。
- Test net lines: `(395−23) + (122−44) = 450`，满足 R8 `≤450`。
- `packages/opencode/src/tool/apply_patch.txt`: no diff，prompt edit distance 0%。
- No dependency、config、feature flag、migration、generated file、new public setting。

### Red-Green Test Evidence

| Slice | Red evidence | Green evidence |
| --- | --- | --- |
| Original out-of-order `e → b` | baseline `FAIL ... unavailable ... line 2` | mini loop `SUCCESS "a\nB\nc\nd\nE\nf\n"` |
| verified repeated entries | received `ALPHA\nmiddle\nomega` instead of both edits | targeted verified test `1 pass`；full Patch suite green |
| exact whole-line + nested literal | `Found multiple matches ... nested-literal.txt` | targeted `1 pass`；Session chunk 16 isolated passes |
| unique normalized proper substring | `Failed to find expected lines ... normalized-substring.txt` | targeted `1 pass`；Tool integration green |
| normalized grapheme raw span | fixture correction exposed accidental exact `ffi` in `suffix`; corrected load-bearing fixture then matrix green | decomposed `A\u030A` → `X tail`、full ligature success、partial expansion reject |
| safe exact + unsafe normalized occurrence | red returned successful `X and ﬁ` | targeted test green with explicit multiple-match rejection |
| direct/verified canonical grouping | verified overwrite red；generated dependency was previously consumable | direct/verified/Tool repeated-entry and symlink tests green |

All tests use public seams and fixed literal expected values; no private-helper or source-text assertions。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/patch/patch.test.ts` | `packages/opencode` | `57 pass, 0 fail, 112 expect()` |
| `bun test test/tool/apply_patch.test.ts` | `packages/opencode` | `50 pass, 0 fail, 147 expect()` |
| `bun typecheck` | `packages/opencode` | pass (`tsgo --noEmit`) |
| mini original-order `bun -e ...deriveNewContentsFromChunks...` | `packages/opencode` | `SUCCESS "a\nB\nc\nd\nE\nf\n"` |
| `bun /var/folders/.../T/opencode/replay-events-patch.ts` | `packages/opencode` | original incident chunks 16→17 pass；full patch reaches independent chunk 20 ambiguity |
| `git diff -- packages/opencode/src/tool/apply_patch.txt` | repository root | empty |
| `git diff --check -- <six goal paths>` | repository root | pass / no output |

### Original Feedback-Loop Result

- Recorded production symptom: chunk 16 advanced the forward cursor to working line 378；chunk 17 old block existed at original line 251 but returned `unavailable to the current patch step`。
- Current database replay: `incident_chunks_16_then_17=passes`；chunk 16 and chunk 17 each also pass isolated under R8。
- Current full 21-chunk replay reaches prefix 20 before rejecting. Chunk 20 old block is only `"}"` and has many original occurrences，so INV-02 correctly reports `Found multiple matches`；the old cursor-unavailable symptom no longer reproduces。
- Minimized feedback loop is green with the exact fixed result `a\nB\nc\nd\nE\nf\n`。

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Success? | Verdict |
| --- | --- | --- | --- |
| exact whole-line active tier | supported primary-contract branch | yes | keep；same-tier normalized uniqueness enforced |
| exact literal substring fallback tier | supported primary-contract branch | yes | keep；surrounding raw text preserved |
| PI-normalized whole-line | supported branch in same locator | yes | keep；leading indentation remains sensitive |
| PI-normalized proper substring | supported branch in same locator | yes | keep；must map complete raw grapheme boundaries |
| grapheme normalized view | coordinate representation only | no independent success | keep；view mismatch/unsafe boundary cannot write |
| context locator | navigation gate | no replacement itself | keep separate first-eligible contract |
| pure insertion | ordered EOF branch | yes | keep；deferred until all replacement validation passes |
| overlap / ambiguity / unsafe boundary | primary-contract reject | no | keep；no partial write |
| `closestWindow` | diagnostic-only | no | unchanged；never enters success |
| forward cursor / incremental same-file working | superseded path | no longer available | removed/collapsed |
| feature flag / old compatibility / catch-and-success | forbidden fallback | no | absent |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 647 | substantive added/modified nonblank TS production/test code；排除 import-only、空行、comment、formatter-only、plan prose、系统缓存脚本 |
| Required `ceil(E×0.15)` | 98 | `ceil(647×0.15)=98` |
| Qualifying Chinese comment lines `C` | 115 | 邻近 original-only、candidate tier、raw boundary、canonical grouping、atomicity 和行为测试意图 |
| Ratio | 17.77% | `115 / 647`，高于 15% gate |
| Representative comments | `match.ts:46,74,124,141`; `index.ts:345`; `apply_patch.ts:41`; `patch.test.ts:313,352,383,674,781` | 解释 immutable original、exact-line tier、NFKC unsafe ownership、normalized uniqueness、proposal identity 与 public-seam test sensitivity |

### Path Verdicts

- One semantic owner: `Patch.deriveNewContentsFromChunks` / locator / `applyChunks`；Tool 不复制 matcher。
- One write route: all replacements resolve on original，validate，sort，reverse apply once；no retry/fallback。
- All three proposal consumers group same canonical source before write/publication and call the same derive owner。
- Normalization rules reuse existing `normalizeForMatch`; Patch owns only the grapheme-to-raw candidate-coordinate representation。
- Prompt remains exact/unique-oriented and does not tell the model order or quality is unimportant。
- Superseded forward cursor and same-file incremental generated-text success paths are absent。

### Remaining Risks / Unverified Items

- Independent full-scope implementation audit completed with `No blocking findings` / `APPROVE`。
- The original 21-chunk Session payload cannot fully apply under the user-requested global uniqueness contract because chunk 20 is the bare old block `"}"`; this is an explicit contracted rejection, not an ordering regression。
- No remote push、external mutation、or repository commit has occurred。

## 24. Implementation Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R8 | yes | No blocking findings. | NB-01 `locateExact` 顶部注释仍描述旧的 whole-line-only fuzzy 范围；注释漂移，不影响执行结果、测试敏感性或 primary-path 唯一性 | APPROVE | task ses_074ddae5bffe3krjrjeZxHHL5c |

### Independent implementation auditor verdict

```text
No blocking findings.
Code quality: PASS
Chinese explanatory-comment gate: PASS (E=647, C=115, required=98, ratio=17.77%)
Release verdict: APPROVE
```

Approval applies only to canonical plan revision R8, the six-file changed scope, and the exact frozen implementation diff audited in task `ses_074ddae5bffe3krjrjeZxHHL5c`.

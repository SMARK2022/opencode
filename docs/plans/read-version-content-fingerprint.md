# Canonical Implementation Plan: Read Version Gate Content Fingerprint

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source:
>
> 1. 原始：详细检查 harness 是否已有哈希逻辑；评估相对 mtime 的有效性与迁移必要性；必要时给完整事先方案；当时不改代码。
> 2. R2 增量（2026-07-21）：按先前建议继续优化；审计更严；整体克制；尽量少改或极少改工具 schema，不做大规模数据迁移；若需字段则避免冗余。
>
> Implementation allowed: no (verified)
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority. R1 is superseded by R2; R1 audit approval does
not authorize R2.

## 1. Verbatim Requirement

> 重复读取抑制的收益与风险……版本判断使用 size + modifiedMs……这里没有内容 hash……会被错误识别成相同版本……更稳妥的做法是为已读取范围或整文件生成快速内容 hash。至少对即将修改的文件计算 hash。……请你详细完整检查……是否有相应的哈希计算的相关逻辑……衡量其有效性以及是否必要性。同时,如果有必要的话,那请你给出完整的事先方案,请注意不要进行任何代码的修改当前。

R2 增量原文：

> 适当按照我先的建议,继续优化一下方案,同时你让相应的审计员相对harsh一点,与此同时尽量保持整体方案克制,尽量较少或者极少更改工具的各种schema,也就是不要进行大规模的数据迁移等等操作。或者即使迁移的话,请保证相应字段不会过于冗余。因此请你重新适当修改并审计一下。

## 2. Explicit Non-Goals

- 本 revision 不修改 production / tests / config / migration / generated files（计划阶段）。
- **不做** DB schema 迁移、**不做** 历史 part 回填 job、**不做** SDK/OpenAPI 再生。
- **不改** read 工具 LLM-visible `parameters` Schema（`filePath`/`offset`/`limit` 不变）。
- **不改** `edit` / `write` / `task` / `compaction` 生产行为与 schema。
- **不改** `read-outline` 缓存键（导航残差可接受；避免多文件联动）。
- 不引入整文件 SHA 必做路径；不用 hash-only 替换 size/mtime。
- 不解决行级脏区、stub 文案语气、shell 旁路 visibleReads、`MAX_BYTES` 放宽。
- 不在 edit 路径新增 hash metadata 字段（disk exact match 已是写前内容校验；见 §10）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` / `packages/opencode/AGENTS.md` | package-local test/typecheck；Effect + FileSystem；中文注释预算 |
| `.opencode/policy/first-principles-engineering.md` | 单主路径、无 fallback、证据边界、根因修复 |
| `docs/read-stub-mechanism-forensic-report.md` | A4/E1 弱版本键；Fix 2 head fingerprint |
| Style Guide | 内联优先；少抽 helper；不 preemptive 抽象 |
| R2 user constraint | schema 克制、无大规模迁移、字段不冗余 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/read.ts` | suppress 主路径；`ReadMetadata` 内部类型；`readSample` 已存在 | observed |
| `packages/opencode/src/tool/read-outline.ts` | 同弱键缓存；R2 明确不改 | observed |
| `packages/opencode/src/session/compaction.ts` | size+mtime current/stale；R2 不改 | observed |
| `packages/opencode/src/tool/task.ts` | 依赖 read 门控；R2 不改 | observed |
| `packages/opencode/src/tool/edit.ts` | blind-touch + disk exact match；无版本键字段 | observed |
| `packages/opencode/src/tool/tool.ts` | tool metadata 为自由 `M`，非 Drizzle/SDK 契约 | observed |
| `packages/opencode/test/tool/read.test.ts` | 有 mtime/size 变更测试；无等长+utimes 碰撞测试 | observed |
| `packages/core/src/util/hash.ts` | `Hash.fast(string \| Buffer)` → sha1 hex | observed |
| `packages/core/src/util/encode.ts` | `checksum` 吃 string 且空内容 `undefined`；不适合空文件 | observed |
| `docs/read-stub-mechanism-forensic-report.md` | A4 机制可达；生产库难直接观测 | observed |
| SDK `types.gen.ts` grep | 无 `ReadMetadata` 公开 schema 依赖 | observed |

## 5. Current Behavior

```text
model read(file, offset, limit)
  -> fs.stat -> size + modifiedMs
  -> readSample(head 4096)   // mime/binary only today
  -> lines() requested range
  -> collectVisibleReads (non-stub, non-compacted, same canonicalPath)
  -> sameVersion := size ∧ modifiedMs
  -> same/covered/high-overlap => stub; else content
  -> persist tool-part metadata.read { size, modifiedMs, start, end, stub, ... }
```

Version consumers today:

```text
read.ts: findReadStub / findOverlapNote / computeUnreadRanges   <- only path that suppresses model-visible content
read-outline.ts: process-local cache (not durable schema)
compaction.ts: handoff evidence current|stale (does not suppress live read)
task.ts: ranges only; stale deferred to child read gate
edit.ts: does not use version key
```

No content identity in sameVersion. No DB column for read metadata.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 正常 edit 后 size/mtime 变 | edit/write/OS | 通常 mtime 更新 | 二次 read 返回内容 | `read.ts` | observed |
| 等长改内容 + 同 ms mtime | 外部工具 / 极快写 / 保时间戳拷贝 | 无内容身份 | 错误 suppress | `read.ts` | reachable |
| 历史 part 无 `fp` | 旧会话 | 字段可缺 | 须 fail-open 重读 | `read.ts` | reachable |
| head 不变、中部等长改 | formatter 等 | head sample 漏检 | 残差 | `read.ts` | reachable residual |
| tool metadata 自由形状 | Tool runtime | 非 DB schema | 可选键前向兼容 | `tool/tool.ts` | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 仅当可见上下文中存在**同一文件版本**的非 stub read 时才可 suppress 真实内容 | `findReadStub` | same-range / covered / high-overlap |
| INV-02 | 当 **head-sample 内容身份** 已相对可见历史变化时，不得 suppress 并声称可安全复用旧可见区间 | A4 + sample path | partial: size/mtime change only |
| INV-03 | sameVersion 不得仅由 size+mtime 构成 | user + forensic | missing equal-size+utimes red |
| INV-04 | 历史证据缺 `fp` 时不得 suppress（incomplete proof → 返回内容） | compaction incomplete-proof spirit | missing |
| INV-05 | 不得强制全文件 hash I/O；复用已有 `readSample` | SAMPLE_BYTES path | N/A |
| INV-06 | stub / overlap / unread 三处 sameVersion 判定一致 | `read.ts:261-263` | existing range tests |
| INV-07 | **schema 克制**：不改 LLM parameters、DB、SDK；持久增量至多一个短可选 metadata 键；无回填迁移 | R2 user requirement | N/A |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 / INV-03 | `sameVersion` 在 `size∧modifiedMs` 处把 stat 元数据当成内容身份 | `packages/opencode/src/tool/read.ts` `findReadStub` / `findOverlapNote` / `computeUnreadRanges` | `read.ts:230,244,270`；sample 已读未参与版本键 `613` |

Root cause: version identity under-specified at the suppress gate only.

Not root cause: edit match failures; outline stale nav; compaction handoff labels; model same-range retry UX.

Red-capable signal (implementation phase):

```bash
# packages/opencode
bun test test/tool/read.test.ts
```

New red: equal-length rewrite + `utimes` restore → second same-range read must emit new content, not stub.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Why not elsewhere |
| --- | --- | --- | --- | --- |
| Suppress version identity | `tool/read` | only suppress when same version still visible | sole suppress owner | edit/compaction do not suppress live reads |
| Optional durable proof on tool part | `tool/read` metadata | free-form `metadata.read` | `collectVisibleReads` already reads this bag | not a Drizzle table |
| Hash primitive | `@opencode-ai/core/util/hash` `Hash.fast` | sync sha1 hex over bytes | already accepts Buffer | do not reimplement |
| Edit write safety | `tool/edit` | disk exact match | already content-checked at write | no new hash schema on edit |

## 10. Single Approved Primary-Path Design

### 10.1 Restraint doctrine (R2)

| Layer | Change? | Reason |
| --- | --- | --- |
| LLM tool parameters Schema | **no** | 模型 API 不变 |
| DB / migration | **no** | 无表结构依赖 |
| SDK / OpenAPI | **no** | 无公开 ReadMetadata 契约 |
| compaction / task / edit / outline | **no** | 非 suppress 根因；避免扩散 |
| tool-part `metadata.read` | **yes, minimal** | 唯一需要跨 turn 比对历史版本的证据袋 |
| 历史回填 | **no** | 缺 `fp` → 重读；自然前向填充 |

Why any durable field is still required: suppress 比对的是“历史可见 read”与“当前文件”。历史侧若不存内容身份，仅靠当前再算 hash 无法知道历史内容是否仍成立。进程内缓存在会话消息重建后不可靠。因此 **一个可选短字段** 是最小充分增量，不是大规模迁移。

### 10.2 Primary path

```text
read(file)
  -> stat: size, modifiedMs
  -> sample = readSample(head, SAMPLE_BYTES)   // already paid
  -> fp = Hash.fast(Buffer.from(sample))      // empty file: Hash.fast(empty Buffer)
  -> current metadata includes optional fp (always written on this code path for non-binary text after sample)
  -> isSameFileVersion(a, b) :=
       a.size == b.size
       AND a.modifiedMs == b.modifiedMs
       AND typeof a.fp == "string" && a.fp.length > 0
       AND typeof b.fp == "string" && b.fp.length > 0
       AND a.fp == b.fp
  -> findReadStub / findOverlapNote / computeUnreadRanges all use isSameFileVersion
  -> missing historical fp => not same version => return real content (INV-04)
  -> stubs still never become coverage sources (stub:true skipped in collectVisibleReads)
```

### 10.3 Fingerprint algorithm (locked)

```text
fp := Hash.fast(Buffer.from(sampleBytes))
```

- Module: `packages/core/src/util/hash.ts` existing `Hash.fast`
- Empty file: `sample` is empty `Uint8Array` → digest of empty buffer (always defined string)
- **Do not** use `encode.checksum` (string-only; empty → `undefined`)
- **Do not** dual-algorithm fallback
- **Do not** truncate in R2 (full sha1 hex 40 chars; single field, no parallel digests). Storage cost is one string on tool parts already carrying path/ranges; not a DB column.

### 10.4 Metadata shape (non-redundant)

Internal `ReadMetadata` gains **one** optional field:

```ts
fp?: string  // head-sample content identity; optional for parse of old parts
```

Rules:

| Rule | Choice |
| --- | --- |
| Field name | `fp`（短；避免 `contentFingerprint` 冗长） |
| Required for `isReadMetadata` parse | **no**（旧 part 仍可收集） |
| Required for suppress sameVersion | **yes both sides** |
| Written on new non-stub text reads | **yes** |
| Written on stub results | optional; stubs already excluded from coverage |
| Backfill / migration job | **none** |
| Parallel fields (etag, inode, fullHash, …) | **forbidden** |

`size` + `modifiedMs` 保留：廉价短路 + 人类可读 `modified` 展示 + 既有测试语义。`fp` 不复制它们的职责。

### 10.5 “至少对即将修改的文件计算 hash”

Restrained mapping（不扩 edit schema）:

1. 模型在 edit 前按既有 blind-edit 规则必须先 read → 新 read 路径会写入 `fp` 并强化 suppress 正确性。
2. edit 写盘时已用 **整文件内容** exact match `oldString`；这是比 head-sample 更强的写前校验，且 **零新字段**。
3. 因此 R2 **不**在 edit metadata 再挂 hash（避免双 schema、双真相）。

### 10.6 Explicitly out of R2 production scope

- `read-outline.ts` cache key
- `compaction.ts` evidence strength
- `task.ts` inspected-files
- stub 文案降级 / consecutive demotion

Residual accepted: outline nav 在 A4 下可能旧；compaction handoff 仍可能把弱键标 current；**不** suppress 模型当轮可见内容。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Success? | Disposition |
| --- | --- | --- | --- | --- |
| size∧mtime sameVersion | current | incomplete primary | suppress | supersede |
| size∧mtime∧fp sameVersion | proposed | primary | suppress iff all match | **approve** |
| missing fp → content return | proposed | primary-contract branch | content | **approve** |
| missing fp → size∧mtime suppress | temptation | forbidden fallback | weak suppress | **reject** |
| full-file hash every read | alt | over-design | yes | **reject** |
| hash-only drop mtime | alt | over-design | yes | **reject** |
| edit-side hash metadata | alt | schema expansion | yes | **reject** (disk match suffices) |
| outline/compaction fingerprint | alt | scope creep | partial | **reject R2** |
| DB migration / backfill | alt | migration | n/a | **reject** |
| multi-field identity bag | alt | redundant schema | yes | **reject** |

## 12. Workaround Deletion and Replacement

| Item | Why existed | Superseded by | Where |
| --- | --- | --- | --- |
| 三处复制的 size∧mtime 过滤 | 本地写法 | 单一 `isSameFileVersion` | `read.ts` |
| “size+mtime 即内容身份” 的隐含假设 | 历史简化 | `fp` 参与 sameVersion | version gate only |

## 13. Forward Traceability

| Requirement / invariant | Production path | File/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | isSameFileVersion before stub | `read.ts` | existing same-range/covered still stub when file unchanged |
| INV-02 (head-sample) | fp mismatch → content | `read.ts` | equal-size + utimes + head-changing rewrite → content |
| INV-03 | fp in sameVersion | `read.ts` | same as above |
| INV-04 | missing fp → content | `read.ts` | synthetic history without `fp` → content |
| INV-05 | Hash.fast(sample) only | `read.ts` | no second full-file read on normal text path |
| INV-06 | one helper | `read.ts` | high-overlap + unread regressions |
| INV-07 schema 克制 | only optional `fp` on metadata.read | `read.ts` only | assert no parameters/DB/SDK files in change set |
| 检查既有 hash 逻辑 | inventory | plan §4/App A | investigation complete (no code) |
| 必要性/有效性 | hybrid key | plan §20 | plan + audit |
| 即将修改文件的内容校验 | pre-edit read + edit exact match | no new edit field | existing blind-edit + match behavior retained |

## 14. Reverse Traceability

| Concept | Maps to | Evidence | Why existing cannot carry |
| --- | --- | --- | --- |
| optional `fp` | INV-02/03/07 | only content-identity gap | size+mtime collision class |
| `Hash.fast(sample)` | INV-05 | sample already paid | no second I/O subsystem |
| `isSameFileVersion` | INV-06 | three filters | drift risk |
| missing-fp content path | INV-04 | incomplete proof | weak-key fallback reopens A4 for old parts |
| skip outline/compaction | INV-07 + non-goals | non-suppress residual | avoids schema/behavior fan-out |
| skip edit hash field | “即将修改” + INV-07 | edit exact match | second content identity store redundant |
| full-file SHA / multi-point sample | none required | residual accepted | cost / scope |

## 15. File-Level Change Plan

| File | Change | Responsibility | Expected delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/read.ts` | modify | compute `fp`; optional metadata; `isSameFileVersion`; wire three filters | ~+35 / -12 |
| `packages/opencode/test/tool/read.test.ts` | modify | utimes collision; missing-fp; still-stub unchanged; metadata has `fp` | ~+70 |
| all other packages | **none** | schema/migration restraint | 0 |

## 16. TDD Behavior Slices

Public seam: `tool/read` → `output` + `metadata.read`.

| Order | Red behavior | Why fails now | Green | Protects |
| --- | --- | --- | --- | --- |
| 1 | equal-length rewrite + restore mtime; head bytes change; second same-range read shows new content | size∧mtime sameVersion | fp differs → content | INV-02/03 |
| 2 | history metadata size/mtime match, no `fp`; second read returns content | would stub | incomplete proof | INV-04 |
| 3 | unchanged file; second same-range still stubs; first non-stub metadata has non-empty `fp` | savings + write-path | full match | INV-01/07 |
| 4 | covered / high-overlap / size-or-mtime change regressions | helper risk | preserve | INV-01/06 |

Notes: real `utimes`; independent expected = new file text; no private helper assertions; no production algorithm copy in tests.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed lines `E` | production ~30 + material test lines counted at implementation audit | exclude pure formatting |
| Required `C` | `max(1, ceil(E * 0.15))` recalculated on actual `E` | hard gate |

Must-comment (Chinese, near site):

1. 版本键 = size + mtime + head-sample `fp`，非全文件完备
2. 缺 `fp` = 证明不足 → 重读，禁止弱键 suppress
3. `fp` 复用 `readSample`，避免额外 I/O
4. 仅可选 metadata 键、无 DB/参数 schema 迁移
5. 三处过滤必须共用同一判定
6. 测试：等长 + utimes 碰撞意图

## 18. Verification

| Command | Cwd | Proves |
| --- | --- | --- |
| `bun test test/tool/read.test.ts` | `packages/opencode` | version/stub behavior |
| `bun typecheck` | `packages/opencode` | types |
| `git diff --name-only` review | repo root | only read.ts + read.test.ts (implementation) |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 |  |
| Files modified | 2 | read + test only |
| Files deleted | 0 |  |
| Production lines | ~35 | minimal |
| Test lines | ~70 | three new cases + asserts |
| Generated / migration | 0 | INV-07 |

## 20. Real Risks and Open Decisions

### Real risks

| Risk | Severity | Handling |
| --- | --- | --- |
| head-only residual (mid-file equal-size same-mtime, head stable) | medium residual | accepted in R2; documented; not full-file claim |
| old sessions re-read until `fp` appears | low | intentional; temporary tokens |
| stub wording still hard “latest” | medium UX | out of scope |
| outline/compaction remain weak-key | low for live suppress | accepted residual |

### Open Decisions Requiring the User

**None for R2.** Closed by R2 constraint + R1 defaults:

| Topic | Locked choice |
| --- | --- |
| compaction | out of scope |
| algorithm | `Hash.fast(Buffer.from(sample))` |
| sample shape | head-only SAMPLE_BYTES |
| schema | optional `fp` only; no migration |
| outline | out of scope |
| edit hash field | out of scope |

### Necessity verdict

| Question | Verdict |
| --- | --- |
| 已有 read 内容 hash？ | **否** |
| 可复用原语？ | **是** `Hash.fast` |
| 仅 mtime/size 够？ | **不够**（INV-03） |
| 紧急事故？ | **否** |
| 要不要做？ | **要做正确性硬化，但必须克制** |
| 迁移形态 | **前向可选 `fp`；无回填；无 DB** |
| 字段冗余 | **单键 `fp`；不平行叠 etag/inode/fullHash** |

### Rejected Speculation

- 全文件 SHA / head+mid+tail 作为 R2 放行条件
- edit 再挂 hash metadata
- inode 替代
- 缺 `fp` 时回退 size∧mtime suppress
- “必须 DB 迁移才能加字段”

## 21. Audit Contract

Independent auditor must:

- Read this exact file and both requirement layers (original + R2 restraint).
- Reconstruct from repository evidence; treat builder chat as untrusted.
- Apply **harsh** full-scope standards: under/over-design, fallback, ownership, schema creep, migration creep, residual honesty (INV-02 head-sample wording), Chinese-comment plan.
- Prefer blocking findings for: dual algorithms, open decisions that leave implementers free to expand schema, missing fail-open, outline/compaction/edit scope creep if reintroduced, redundant fields, DB/SDK claims without evidence.
- Require evidence for every blocking finding.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | algorithm not locked; INV-02 absolute; E estimate; outline wording; open decisions | APPROVE | adversarial-auditor ses_07e3aec19ffeb99AVNUAiY7bQI |
| 2 | R2 | yes | No blocking findings. | N-01 App B overstates A4 closure (head-stable residual). N-02 stub fp write optional vs current.fp before findReadStub. N-03 INV-05 hard as pure behavioral test. N-04 size/mtime “cheap short-circuit” is predicate-only. N-05 inventory sufficient not exhaustive outside tools. N-06 edit is oldString match not whole-file hash. | APPROVE | adversarial-auditor ses_07e34edc4ffeFhAihpMG3BrbPZ |

### Independent plan audit verdict (verbatim, Round 1 / R1)

```text
No blocking findings.
APPROVE
```

R1 approval is **void for implementation** after R2 supersession.

### Independent plan audit verdict (verbatim, Round 2 / R2)

```text
No blocking findings.
```

```text
APPROVE
```

- Exact audited artifact: `docs/plans/read-version-content-fingerprint.md` Revision **R2** only
- Mode: plan / harsh / full-scope
- Invocation: adversarial-auditor `ses_07e34edc4ffeFhAihpMG3BrbPZ`
- Implementation is allowed only for R2 after this clean verdict is recorded

Non-blocking findings (verbatim themes from auditor Round 2; administrative record only):

1. N-01 Appendix B slightly overstates A4 closure — prefer “partially addresses A4 when head sample differs; residual remains when head is stable”
2. N-02 Stub `fp` write rule slightly inconsistent — put `fp` on `current` before `findReadStub`
3. N-03 INV-05 full-file read absence hard as pure behavioral test — prefer code-review/diff constraint
4. N-04 “廉价短路” is weak as I/O claim — sample always runs
5. N-05 inventory sufficient but not exhaustive outside tools
6. N-06 edit “整文件 exact match” slightly overstated — substring match after full-file read, not stored whole-file hash

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/tool/read.ts` | `fp` + `isSameFileVersion` + wire three filters + `Hash.fast(sample)` |
| `packages/opencode/test/tool/read.test.ts` | 3 new behavioral tests (utimes equal-size, missing-fp, fp+still-stub) |
| all other files | unchanged (schema/migration restraint) |

`git diff --stat` (implementation): `read.ts` +~25/-5; `read.test.ts` +~70.

### Red-Green Test Evidence

| Slice | Red | Green |
| --- | --- | --- |
| equal-size + utimes head change | failed: still stubbed with size∧mtime | pass: returns `<content>` with `1: XXX` |
| history lacks `fp` | failed: still stubbed | pass: returns content |
| writes `fp` + still stubs | failed: `fp` undefined | pass: non-empty `fp` + same-range stub |

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/tool/read.test.ts -t "equal-size rewrite\|lacks fp\|writes non-empty fp"` (pre-impl) | `packages/opencode` | 3 fail (intended red) |
| `bun test test/tool/read.test.ts` | `packages/opencode` | **67 pass, 0 fail** |
| `bun typecheck` | `packages/opencode` | **pass** |

### Original Feedback-Loop Result

Not a production-db-reproduced incident loop; behavioral signal is the utimes equal-size red case above (plan §8).

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Present? |
| --- | --- | --- |
| size∧mtime∧fp sameVersion | primary | yes |
| missing fp → content | primary incomplete-proof branch | yes |
| missing fp → size∧mtime suppress | forbidden fallback | **absent** |
| full-file hash / edit hash field / outline-compaction fan-out / DB migration | rejected | **absent** |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~72 | exclude import-only `Hash` import; count production logic + material test lines |
| Qualifying Chinese comment lines `C` | 11 | near-site: version key, missing-fp fail-open, sample reuse, empty-file digest, schema restraint, test intents |
| Ratio `C / E` | ~0.153 |  |
| Required minimum `C` | `max(1, ceil(72 * 0.15)) = 11` | meets gate |

Representative Chinese comments:

- `// 版本键 = size + mtime + head-sample fp（非全文件完备）。三处 filter 必须共用此判定。`
- `// 缺 fp = 证明不足 → 不得 suppress，禁止回退 size+mtime 弱键。`
- `// fp 复用已读 head sample，零额外 I/O；在 findReadStub 前写入 current 以便双侧比对。`
- `// 等长改写 + utimes 锁死 mtime：size/mtime 无法区分版本，必须靠 head-sample fp 失效 suppress。`
- `// 历史 read 缺 fp：证明不足，禁止回退到 size+mtime 弱键 suppress。`

### Remaining Unverified Items

- Head-stable mid-file equal-size same-mtime residual (accepted R2).
- outline/compaction still size+mtime only (out of R2 scope).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings. | N-01 stale size+mtime stub-copy comment; N-02 utimes test does not pin modifiedMs; N-03 head-stable residual; N-04 unrelated dirty worktree | APPROVE | adversarial-auditor ses_07e12bb35ffefPp75y160KTkEB |

### Independent implementation audit verdict (verbatim, Round 1 / R2)

```text
No blocking findings.
```

```text
APPROVE
```

- Exact audited revision: plan R2
- Exact audited implementation: `packages/opencode/src/tool/read.ts` + `packages/opencode/test/tool/read.test.ts`
- Mode: implementation / full-scope
- Invocation: adversarial-auditor `ses_07e12bb35ffefPp75y160KTkEB`
- Verification reproduced: `bun test test/tool/read.test.ts` 67 pass; `bun typecheck` EXIT 0
- Chinese gate independent recount: E=68, C=11, required 11, pass
- Post-audit non-material fix: N-01 comment at renderReadStub updated to isSameFileVersion wording

## Appendix A: Current Hash Inventory (investigation)

| Location | What it hashes | Used by read version gate? |
| --- | --- | --- |
| `packages/core/src/util/encode.ts` `hash` | SHA-256 string | no |
| `packages/core/src/util/encode.ts` `checksum` / `sampledChecksum` | FNV-like; empty → undefined | no (unsuitable) |
| `packages/core/src/util/hash.ts` `Hash.fast` | sha1 hex over string\|Buffer | **no today; R2 target** |
| `packages/opencode/src/tool/bash-compress.ts` | compression rolling hash | no |
| `packages/opencode/src/tool/websearch.ts` | session split | no |
| `packages/opencode/src/tool/read.ts` | none | n/a |

## Appendix B: Benefit / Risk of status-quo suppress

**Benefits keep:** token savings; compacted/stub exclusion; normal size/mtime invalidation.

**Risk address in R2:** equal-size + mtime collision false sameVersion at suppress gate.

## Appendix C: R1 → R2 delta

| Topic | R1 | R2 |
| --- | --- | --- |
| Scope files | read + outline (+ optional compaction) | **read.ts + tests only** |
| Field name | `contentFingerprint` | **`fp`** |
| Algorithm | open preference | **locked Hash.fast** |
| INV-02 | “content changed” absolute | **head-sample identity** |
| Open decisions | three open | **all locked** |
| Schema doctrine | implicit | **INV-07 explicit: no DB/SDK/params/migration** |
| Edit hash | unmapped | **mapped to existing exact match; no new field** |
| Approval | R1 APPROVE | **cleared; needs R2 audit** |

## Appendix D: Migration sequence (only after R2 APPROVE)

1. Red tests (utimes collision, missing-fp, still-stub).
2. `fp` compute + `isSameFileVersion` + wire filters in `read.ts` only.
3. Green + typecheck.
4. Confirm diff file set ⊆ `{read.ts, read.test.ts}`.
5. Implementation audit.

No production code is modified by this plan revision.

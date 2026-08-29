# Canonical Implementation Plan: 工具元数据 diff 体量与生成性能修复（tool-diff bounding）

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户 GOAL 原文（见 §1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-30

本文件是本任务的唯一实施规范。聊天摘要、被取代的 revision、以及本文件之外的
builder 论述都不构成实施授权。

R2 变更摘要（相对 R1，来源：round-1 审计 B-01…B-04、N-01…N-04）：计数权威改为
hunk 门控扫描并撤回等值主张（B-01）；write metadata 携带计数且摘要摄入优先工具
报告值（B-02）；门B 计数口径钉死为裁剪后中段行数（B-03）；文件口径改为严格总数
≤6——全部测试切片并入单一既有测试文件（B-04）；red-loop 证据措辞修正（N-01）、
`mergeFileDiff` 命名与行号修正（N-02）、binary 标记补 sha256 对（N-04）。

R3 变更摘要（实施期发现的事实，policy Phase 9）：“hunk 门控”的标记识别定为
`"@@"` 前缀而非 R2 文本的 `"@@ "`：既有契约 fixture（summary-tool-diff.test.ts:140）
使用裸 `@@` 头，且 R2 批准的探针未覆盖该形状（详见 §10）；聚合界的适用点明确为
首见 push 与归并两处（§16 切片 4 的批准语义本就要求单条 5MB 摄入被界住，R2 §10
文字只写了拼接路径，属文字歧义修正）；§18 全量套件以定向回归集替代（用户指示
原文引用）。实施已在 R2 批准下完成，R3 仅记录事实与修正文字，无新增实现。

## 1. Verbatim Requirement

> 然后与此同时你也再完整检查一下这个代码。你看一看，理论来说，如果我们不进行过多的这种行
> 为性的这种侵入性的修改，如何能够，就是你觉得更符合我们整体 OpenCode 的这种行为设计，使
> 得这个 hardness 的稳定性在不降低的情况下又能够极大地避免这类就是大规模数据直接进入数
> 据库等等的这种行为。然后同时也降低这种对于用户的体感的这种干扰，比如说你最好不要增加
> 这种类似于让用户进行选择是否允许的这种操作。这种操作本身会干扰正常的任务执行。所以对
> 于一个好的执行器应当是自己静默的，然后同时它又能够完整准确地符合我们整体仓库设计等等
> 内容来执行相应的修改等等一些内容。同时整体降低相应的不必要计算开销以及入库内容，同时
> 又要保证一些相对合理（中小文件二进制或者正常代码等可编辑文件）的文件的审计。整体修改
> 文件数不超过六个文件，代码行数不超过八百行，完整准确解决相应的diff过量或者diff生成大
> 量消耗性能问题，同时保持结果准确性以及合理性。注意不引入新的红测。

配套背景（同一对话中的用户立场，作为解释性依据，不扩大范围）：

- delete 分支把被删文件全文写入 diff 的**意图**（可核查、可逆、可审计）被用户确认保留；
  需要修的是"无界"，不是"记录"这个行为本身。
- 按大小触发冷冻结被用户明确否决：冻结不解决"脏数据入库"。
- 二进制检测若用"不可打印比例"类启发式被用户否决；字符硬上限直接截断丢内容也被否决。

**文件数口径（R2 钉死）**："整体修改文件数不超过六个文件"按**触碰文件总数**执行
（含测试文件）。见 §15/§19：总数 6 = 生产 5 + 测试 1。

## 2. Explicit Non-Goals

- 不改变任何工具的**变更执行语义**：edit/write/apply_patch 对文件的读、匹配、写入、
  formatter、BOM/EOL 处理一字不动。本任务只改"元数据 diff 的生成与表示"。
- 不改变 revert/unrevert 机制（git snapshot checkout；已核实不消费 diff 文本，
  revert.ts:129-132、snapshot/index.ts:387-399）。
- 不新增任何 ask()/用户选择/配置项/迁移/schema。
- 不处理 tool output 截断（truncate.ts 已有通道）、不处理 attachment、不动
  ctx.ask metadata 的字段形状（TUI/权限预览消费者不变；write metadata 新增
  additions/deletions 数值字段不属于 schema 变更——metadata 为自由 Record）。
- 不清理存量 DB 巨行（用户已完成数据修复，本次验证过）。
- 不做 `metadata.diff` 与 `files[].patch` 的去重 schema 变更（两者在有界后 ≤ 数百 KB，
  保持形状零风险；记入 §20 非阻塞遗留）。
- 不给 write.ts 的 `metadata._formattedContent`（processor 消费后 strip，不入库）加界。
- 不处理 `file/index.ts:548-560` 的 `structuredPatch(context: Infinity)`（read 输出
  通道、无 metadata 入库后果、pre-existing；round-1 审计 N-03 记录为相邻 seam）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Snapshot=git patch 工作树检查点（2MB cap 先例）；Revert=经 Snapshot 的文件恢复；Tool=对 tool Context 执行的 capability；词汇必须沿用 |
| `packages/opencode/AGENTS.md`（含 test/、db guide） | 模块形状（自导出）、Effect 规则、测试不得从 repo root 跑、`bun typecheck` 从包目录跑 |
| `.opencode/policy/first-principles-engineering.md` | 单一权威路径、禁 fallback、责任归属、证据分级 |
| `snapshot/index.ts:680-731` | git 路径 binary/tooLarge 的既有先例：`additions: binary ? 0 : …`、`patch: row.binary \|\| tooLarge ? "" : …` —— 本任务使工具 metadata 路径与该语义对齐 |
| `tool/truncate.ts` | 工具 output 的有界先例（MAX_LINES/MAX_BYTES）；本任务对 metadata diff 建立同类的有界语义，但因 §8 的性能观测，不采用 sidecar 方案 |
| `tool/file-mutation-coordinator.ts` | 工具层唯一文件读取 seam；证明 diff 输入全部经过工具内文本，不需要新读取点 |
| `plugin/vscode-bridge.ts:325-339`（packages/opencode/src/） | hunk 门控 patch 计数扫描的仓库内先例（正确处理 hunk 内 `+++`/`---` 内容行）—— countPatchStats 迁移修复的实现依据（B-01） |
| 事故证据（用户 DB，2026-08-27，已修复） | 407MB 单 part 行（apply_patch 删除 ~200MB×2 ELF 二进制）、216MB user message 行（summary.diffs 累加）、`autoReview.error: "Out of memory"`、后续 5 次 prompt 0-token 死亡 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/tool/apply_patch.ts`（全文 490 行） | 三个 diff 生成点 :67/:114/:146；countDiff 双遍 :156-164；totalDiff :287；files[].patch :298-306；ctx.ask :310-319 | observed |
| `src/tool/edit.ts`（diff 相关 :195-420、trimDiff :570-573） | 三个生成点 :201/:302/:380；diffLines 计数第二遍 :390-395；filediff/metadata 形状 :396-409；output 已有预算纪律 :419-444 | observed |
| `src/tool/write.ts`（全文 210 行） | 三个生成点 :72/:126/:137；metadata {filepath, diff} 形状 :198-203 | observed |
| `src/session/summary-cache.ts`（:86-209、:788-803） | `mergeFileDiff`（:86 定义，:104 拼接）逐轮无界累加；collectToolDiffs 摄入 :116-183（:164-178 file/files/diff+filepath 三分支，diff 分支 :173-178 现以 countPatchStats 重扫描）；私有 countPatchStats :788-797 对 `+++"/"---` 前缀行全局跳过（无 hunk 门控） | observed |
| `src/session/revert.ts`（:60-179） | revert 只消费 file 清单 + patch part hash；计数累加 :141-142 | observed |
| `src/session/summary.ts`（全文） | summarize→computeDiff→user message summary.diffs 写入链 | observed |
| `src/tool/truncate.ts`（全文） | sidecar/output 有界先例；最终未采用 sidecar 的对照 | observed |
| `src/tool/file-mutation-coordinator.ts`（全文） | read/decode 唯一 seam；utf-8 decode 产生替换字符而非 U+0000（round-1 审计确认 UTF-16 不误触发门A） | observed |
| `src/snapshot/index.ts`（:680-731） | git binary/tooLarge 先例 | observed |
| `src/plugin/vscode-bridge.ts:325-339` | hunk 门控计数先例（round-3 N-09/实施审计 I-04 路径更正） | observed |
| `test/tool/apply_patch.test.ts`、`test/tool/edit.test.ts`、`test/tool/write.test.ts`、`test/session/summary-tool-diff.test.ts`、`test/session/revert-compact.test.ts` | 既有测试 seam 与回归面 | observed |
| 事故 DB 取证（本对话） | 407MB part / 216MB message / autoReview OOM / 5×0-token prompt | observed |
| §8 red-loop 回路 | 三条 RED 切片 + 139s 性能观测；机制（二次方 Myers、二进制无界 patch、聚合透传）已由 round-1 审计独立探针复核确认；具体数值由实施期 §18 重建回路产生（N-01 措辞） | observed（机制）/ 待实施期复跑（数值） |
| round-1 审计探针（`D:\Temp\opencode\audit-diff-probe.ts`，审计方持有） | PROBE1：现状 countPatchStats 对 `-- comment` 删除行计数 0（精确应为 1）；PROBE2：中段 1000/2000/4000/8000 行 → 560/1970/8219/29808 ms（二次方）；PROBE3：512KB 二进制 delete patchLen=526,480 | observed（审计方独立复现） |

## 5. Current Behavior

```text
模型 tool call（input 有界：patchText/edits/content 由模型输出，受 provider 输出上限约束）
  -> Tool.execute（apply_patch / edit / write）
     -> Mutation.read（单次读盘，decode 为 UTF-8 文本）
     -> diff 生成：createTwoFilesPatch(旧全文, 新全文)   <-- 无界的第一个转换点
        · apply_patch: FileChange.diff + countDiff(diffLines 第二遍全量)
        · edit:       预览 diff + 出口 diff + diffLines 计数第二遍
        · write:      预览 diff + 出口 metadataDiff（metadata 不带计数）
     -> ctx.ask(metadata: {diff, files[].patch, …})  -> 权限预览 + autoReview
     -> ExecuteResult.metadata（apply_patch 内 totalDiff 第二份拷贝）
  -> processor 持久化 part 行（metadata 全量入库）
  -> SummaryCache.collectToolDiffs 摄入 metadata
     · files[]/filediff 分支：读取工具报告的计数
     · write 的 {diff, filepath} 分支：countPatchStats(diff) 重扫描
     -> mergeFileDiff 按文件逐轮拼接 patch（(current)+(item)，无界累加）
     -> user message summary.diffs（入库）+ session_diffs 镜像 + Bus 广播
  -> 后续每次 prompt：读回并物化这些巨型字符串 -> JSC 堆耗尽
```

事故实例（2026-08-27，session `ses_05d28b468ffet146EjFFXLGrhD`）：apply_patch 删除
两个 Linux ELF 二进制（deletions 290,254 行），metadata.diff ≈191MB +
files[].patch ≈215MB = 407MB 单 part 行；summary.diffs 累加出 216MB user message
行；autoReview 在 stringify 该 metadata 时 `Out of memory`；此后该 session 每次
prompt 均在 provider 请求前 OOM 死亡（2 aborted + 3 running、0 tokens）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 文本文件，中小规模编辑（常态） | 模型 edit/write/apply_patch | 模型输出有界 | 每次工具调用 | 工具 diff 生成 | observed（既有测试全绿） |
| 变更行自身以 `--`/`++` 开头（SQL/Lua/Haskell 注释、YAML `---`、markdown 分隔线） | 日常代码内容 | 无 | diff 正文行 `---`/`+++` 与 unified 文件头同形 | 计数权威（countPatchStats 迁移后） | observed（PROBE1：现状扫描器漏计） |
| 二进制文件 delete/update（NUL 字节内容） | 模型 apply_patch delete（事故实测） | 无 | Mutation.read → decode（NUL→\u0000）→ 全文进 diff | 工具 diff 生成 | observed（407MB 事故 + PROBE3） |
| 大文本整体重写 | 模型 write/edit（minified bundle、生成物、lockfile） | 模型输出上限（~MB 级） | createTwoFilesPatch 全量 Myers | 工具 diff 生成 | observed（PROBE2 二次方增长；原回路 640KB >139s） |
| 存量/未来的巨型 tool metadata 进入摘要聚合 | part.state.metadata | 无界（本修复前） | collectToolDiffs → mergeFileDiff 拼接 → summary.diffs | SummaryCache | observed（216MB 行 + 原回路 slice 3 机制经审计复核） |
| 同一文件跨多轮反复编辑 | 长 session 常态 | 单轮 patch 有界（修复后） | mergeFileDiff 逐轮拼接 | SummaryCache | reachable |

Speculative（不入生产逻辑）：恶意构造的耗尽攻击、UTF-32 混淆、未来工具。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 工具元数据 diff（metadata.diff、files[].patch、ask metadata）体积有上界（数量级：数百 KB），任何文件内容不得整段入库 | observed：407MB 行；PROBE3 | 无（本任务补） |
| INV-02 | 正常文本编辑的行级 diff 与 additions/deletions 语义逐字节不变（审计保真），含 `--`/`++` 前缀变更行 | 用户需求"保持结果准确性"；既有 apply/edit/write 测试；PROBE1 | apply_patch/edit/write 既有测试 + 本任务守护切片 |
| INV-03 | diff 生成计算成本对输入体量有界：不得对超限输入运行 Myers 全量行比较 | observed：PROBE2 二次方；事故 1h54m | 无（本任务补） |
| INV-04 | revert/unrevert 行为不变（diff 文本不参与机械恢复） | revert.ts:129-132 只用 file 清单 + snapshot hash | revert-compact.test.ts |
| INV-05 | SummaryCache 聚合产物（summary.diffs、session_diffs 镜像、Bus payload）体积有界，计数保持精确——三工具口径一致，write 路径不得退化为 0/0 | observed：216MB 行；round-1 审计 B-02 链条 | summary-tool-diff.test.ts（既有）+ 本任务摄入切片 |
| INV-06 | 全程静默：不新增 ask()/用户选择/配置/迁移/schema | 用户需求原文 | 现有权限测试不受影响 |
| INV-07 | 二进制内容不以行级 diff 文本进入元数据；以"标记 + 度量 + sha256 身份对"记录（与 snapshot git 路径 binary 语义一致，计数 0/0） | 用户需求"中小文件二进制的审计"（见 §10 解释）+ snapshot:688 先例；407MB 事故即 binary 行 diff | 无（本任务补） |
| INV-08 | 计数口径单一且精确：正常路径计数 = 变更行数（与现状 diffLines 口径一致，经 hunk 门控扫描从生成的 patch 单遍推导并以独立字面量切片验证，包括 `--`/`++` 前缀行）；门B rewrite 计数 = **裁剪后中段**行数（与"变更行"口径连续）；门A 二进制 = 0/0；write 摄入优先工具报告计数 | R2 重写（撤回 R1 的"扫描器天然等值"主张——PROBE1 证伪）；revert.ts:141-142 消费计数 | 本任务切片 + 既有计数测试 |

## 8. First Divergence and Root Cause

**Red-capable feedback loop（已实际运行；机制经 round-1 审计独立探针复核）**

命令（外部沙箱，repo 零改动：`D:\Temp\opencode\<file>` 测试文件 + repo 根
node_modules junction；实施期按同内容重建）：

```text
workdir: packages/opencode
bun test <red-loop 沙箱文件>   （实施期重建；见 §18 最后一行）
```

原始观测（当前代码，全部 RED；数值由实施期重建回路再次产生）：

```text
slice 1  apply_patch binary delete（512KB 全字节值文件）
  diffLen=712,966  filePatchLens=[528,645]  askDiffLen=528,646
  expect max < 65,536 → Received: 712,966            (RED)
slice 2  write 整体重写（~640KB 文本，公共头尾 + 8000 行差异中段）
  diff 生成 >139s，超出 30s 测试预算超时              (RED，性能症状活体观测)
slice 3  SummaryCache.collectToolDiffs 摄入 5MB legacy patch
  aggregate=5,242,881  expect < 1,048,576 → RED       (RED)
```

round-1 审计独立探针（审计方自持脚本，针对仓库 `diff@8.0.2`）：

```text
PROBE1 exact(diffLines) del=1 vs 现状 countPatchStats del=0（"-- comment" 删除行）
PROBE2 midLines=1000/2000/4000/8000 → 560/1970/8219/29808 ms（二次方 Myers）
PROBE3 binary 512KB delete → patchLen=526,480 in 3ms（二进制全文直入 patch）
```

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/03 | `createTwoFilesPatch(旧全文, 新全文)` 在三工具的元数据 diff 生成点无任何分级：二进制不识别、超限输入照跑 Myers、产物无界直入 ask + metadata | 工具层 diff 生成（当前分散于 apply_patch.ts:67/114/146、edit.ts:201/302/380、write.ts:72/126/137，无单一 owner） | PROBE2/PROBE3；407MB 事故 |
| INV-05（界） | `mergeFileDiff` 的 `patch: (current)+(item)` 逐轮无界拼接，且对 legacy 巨型 metadata 无摄入界 | `summary-cache.ts:86-112`（拼接在 :104） | 216MB 行；slice 3 机制 |
| INV-08（write 计数） | write metadata 不携带计数，摄入端从 patch 文本重扫描推导——对有界标记表示必然退化为 0/0 | `write.ts:198-203` + `summary-cache.ts:173-178` | round-1 审计 B-02 链条（代码推演，门B 首次触发即达） |

下游症状（autoReview OOM、prompt 期 JSC 堆耗尽、DB 膨胀）均非根因，随生成端
修复传导消失。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 元数据 diff 的有界生成（binary/超限/正常三分）与计数推导 | 新 `src/tool/file-diff.ts`（唯一 seam） | `renderFileDiff(filePath, oldText, newText) -> {patch, additions, deletions}` | 三个工具的消费点完全同构；diff 字符串语义（含计数）需要单一权威 | 各工具自持会复制三分逻辑三遍（正是现状的无界根源）；Snapshot 的 git diffFull 是另一数据源（git numstat），不接管工具内文本 |
| unified patch 文本统计（+/- 行计数） | `file-diff.ts` 导出 `countPatchStats`（自 summary-cache.ts:788 迁移并修复为 hunk 门控） | 同一函数服务工具计数与 shell-diff 摄入计数 | patch 字符串语义的所有者 | summary-cache 只是消费者（:176 现状已在此计数 shell diff）；vscode-bridge 有同构 hunk 门控实现但属 IDE 桥接自有 diff，不导出、不通用 |
| 摘要聚合体积界 | `SummaryCache.mergeFileDiff`（:86-112） | 聚合产物有界、计数精确 | 聚合数据的 owner；legacy 巨 metadata 只有此摄入点 | 工具端修复不追溯已入库数据（INV-05 需摄入界） |
| write 摄入计数优先级 | `collectToolDiffs` 的 diff/filepath 分支（:173-178） | metadata 显式携带 additions/deletions 时优先，缺失时回退 hunk 门控扫描 | write metadata 形状 owner（write.ts）已在改动集；摄入端同文件 | — |
| 二进制判定 | `renderFileDiff` 内（输入文本前 8192 字符含 U+0000） | git `buffer_is_binary` 同规则 | 判定只服务 diff 表示选择；不改变任何文件操作 | Mutation.read 不需要扩展（decode 后文本即判据；coordinator 职责注释明确拒绝吸收文本语义） |

## 10. Single Approved Primary-Path Design

一个权威语义路径：**在唯一的 diff 生成 seam 上做三分表示，聚合端补摄入界，计数
单一权威且显式携带**。

```text
Tool.execute
  -> renderFileDiff(filePath, oldText, newText)      [src/tool/file-diff.ts，纯同步]
     ├─ 门A 二进制：old/new 前 8192 字符含 U+0000
     │    patch = binary 标记（见下），additions = deletions = 0
     ├─ 门B 超限中段：按行裁剪公共前/后缀后，(oldMid+newMid) > 64 KiB chars
     │    patch = rewrite 标记（见下）
     │    additions = newMid 行数 K，deletions = oldMid 行数 N   [中段口径，见 INV-08]
     │    （O(n) 行计数与 sha256，不跑 Myers）
     └─ 正常路径：createTwoFilesPatch(旧全文, 新全文)（jsdiff 内部同款前后缀剪枝）
          patch 体积由门B数学保证 ≤ ~4×64 KiB（中段 + hunk 上下文开销）
          additions/deletions = countPatchStats(patch)（单遍；现状第二遍 diffLines 删除）
  -> FileChange/ask/metadata 形状不变，内容有界
  -> write metadata 额外携带 additions/deletions（数值字段；供摄入端优先读取）
SummaryCache.mergeFileDiff
  -> 首见 push 与逐轮拼接两处均受摄入界：结果 > 1 MiB 时 patch 降级为
     "[aggregated patch elided: N chars, +a/-d]"，计数继续精确累加（不变）；
     首见同样受限是 §16 切片 4 批准语义（单条 5MB legacy 摄入即需被界住）
SummaryCache.collectToolDiffs（diff/filepath 分支）
  -> metadata 显式 additions/deletions 存在时优先；否则 countPatchStats(patch)
```

**countPatchStats 迁移即修复（B-01）**：迁移到 file-diff.ts 时改为 hunk 门控——
只在首个以 `"@@"` 开头的行之后开始计数，其后的 `+`/`-` 前缀行即内容行（unified
格式的文件头只出现在首个 hunk 之前，因此 hunk 内的 `--- comment`/`+++ x` 内容行
被正确计入；仓库先例 plugin/vscode-bridge.ts:325-339 同构）。标记按 `"@@"` 前缀
而非 `"@@ "` 识别（R3）：仓库内合法 hunk 头有三形——unified `"@@ -a +b @@"`、
既有摘要契约 fixture 的裸 `"@@"`（summary-tool-diff.test.ts:140，R2 批准探针未覆
盖该形状，实施期现有测试转红发现）、以及 rewrite 标记的 `"@@ rewrite @@"`；unified
正文行总以 `+`/`-`/空格开头，不会误触。`\ No newline` 行与标记格式行
（`Index:`/`===`/`old:`/`new:`/`sha256`）不以 `+`/`-` 开头，天然不计数。该修复
同时纠正现状 shell-diff 摄入对 `--`/`++` 前缀行的既有漏计（PROBE1）——同一权威
的单点修复，非 scope 扩张。

为什么修复第一分歧：门A 消灭"二进制全文进元数据"（407MB 事故类）；门B 同时消灭
"超限输入跑 Myers"（PROBE2 二次方、事故 1h54m）与"重写产物无界"（INV-01+INV-03
同一门槛：行级 diff 产物体积 ≈ 差异中段体积，界住中段即同时界住计算与产物）；
正常路径零行为变化（INV-02：小/中文本的局部编辑走原算法、原输出，计数口径经
PROBE1 类输入的守护切片锁定）。门B 的 O(n) 前后缀裁剪同时是 jsdiff 自身的前置
步骤，正常路径不重复承担成本。

用户否决项的落点：不用"不可打印比例"（门A 用 git 同款 NUL 规则，确定性）；不用
"截断丢内容"（超限表示是**换表示**而非裁剪：精确中段行数 + 全文件字符数与双向
sha256 + 工作树/git 对象仍持有完整内容，审计事实不丢失）；不做冷冻结（入库执法
点只在生成/摄入 seam）。

"中小文件二进制的审计"解释（INV-07）：二进制行级 diff 本身不可读、无人工审计价
值，且正是 407MB 事故的直接构成物；有界后的审计记录 = 变更事实（changed 标记）+
度量（字符数）+ 内容身份（sha256 对）+ 工作树与 git snapshot 的原始内容。正常
代码文件（用户举例的另一类）保留完整行级 diff 不变。

标记格式（确定性、可机器识别；R2：binary 补 sha256 对、rewrite 计数钉死中段口径）：

```text
Index: <filePath>
===================================================================
Binary file <filePath> changed: <M> -> <L> chars
old sha256: <oldHash>
new sha256: <newHash>
(binary content not diffed)
```

```text
Index: <filePath>
===================================================================
--- <filePath>  (whole-file rewrite: line diff skipped, delta > 65536 chars)
+++ <filePath>
@@ rewrite @@
old: <N> mid lines, <M> file chars, sha256 <oldHash>   [N = 裁剪后旧中段行数]
new: <K> mid lines, <L> file chars, sha256 <newHash>   [K = 裁剪后新中段行数]
```

行数与 chars/sha256 的作用域在标记行内自述（`mid lines` / `file chars`）：
chars 与 sha256 为**全文件**身份（内容可追溯），行数为**中段**口径（与现状
"变更行"计数语义连续，INV-08）。

常量（file-diff.ts 顶部，中文注释说明依据）：`BINARY_SCAN_CHARS = 8192`（git
`buffer_is_binary` 窗口同值）、`MAX_DIFF_MIDDLE_CHARS = 64 * 1024`（PROBE2 实测
二次方增长，64KB 界保证 Myers 亚秒级且 patch ≤ ~256KB 量级）、
`MAX_MERGED_PATCH_CHARS = 1024 * 1024`（摘要聚合界；用户已修复的 216MB 行证明累加
无界的可达性）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 正常行级 diff（createTwoFilesPatch + hunk 门控 countPatchStats） | 当前（计数迁移） | primary-contract branch | yes | 主路径（现状语义） | preserve |
| 二进制标记表示 | proposed | primary-contract branch（二进制是工具支持域的成员：delete/add 二进制文件为 observed 输入） | yes（表示降级，非成功降级——文件操作照常成功） | 1/3 新分支 | preserve |
| rewrite 标记表示 | proposed | primary-contract branch（大重写为 observed 输入） | yes（同上） | 1/3 新分支 | preserve |
| mergeFileDiff 聚合降级标记 | proposed | primary-contract branch（聚合界是 SummaryCache 接口义务 INV-05） | yes | 1 分支 | preserve |
| 摄入端显式计数优先（write） | proposed | primary-contract branch（消除表示与摄入的口径分裂，INV-05/08） | yes | 1 分支 | preserve |
| snapshot diffFull 的 git binary/tooLarge | 当前 | 既有独立数据源（git） | yes | 不变 | preserve（不合并——数据源不同） |
| sidecar 外置（Truncate.write） | **rejected** | 门B 下无承载场景：中段 ≤64KB 时产物已有界，>64KB 时根本不生成行级 diff | — | 0 | reject |
| 按大小冷冻结 | **rejected** | 用户原文否决（"本质上没有解决这个入库问题"） | — | 0 | reject |
| 二进制比例启发式 | **rejected** | 用户原文否决（"这种东西你如果这样设置也不是特别好"） | — | 0 | reject |

无新增 fallback：表示分支是**支持输入域成员的确定性分派**（按输入性质，不按前一
路径的失败），均产出同一契约的 `{patch, additions, deletions}`。决策面：新增分支
4 + 聚合 1 + 摄入优先 1，全部为 primary-contract 分支，diagnostic 占比 0%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `countDiff`（apply_patch.ts:156-164，diffLines 第二遍全量） | 与 diff 生成分离的计数 | hunk 门控 countPatchStats 单遍推导，口径一致（INV-08 守护切片证明） | 删除函数与三处调用 |
| edit.ts:390-395 diffLines 计数第二遍 | 同上 | 同上 | 删除循环，改用 renderFileDiff 返回值 |
| summary-cache.ts:788-797 无门控 countPatchStats | shell-diff 摄入计数（对 `--`/`++` 前缀行既有漏计，PROBE1） | 迁移到 file-diff.ts 并修复为 hunk 门控，成为唯一权威并导出 | 从 summary-cache 删除，file-diff 导出 |
| （保留）`trimDiff`（edit.ts:570，恒等函数） | 文档化意图 | edit.test.ts:291 有行为测试锁定恒等语义；本任务不消费它也不删除（避免无关测试改动） | preserve |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 元数据有界 | 门A+门B 表示 | file-diff.ts + 三工具接线 | 切片 1（binary）、切片 2（rewrite） |
| INV-02 正常语义不变（含 `--`/`++` 行） | 正常路径原算法 + hunk 门控计数 | 三工具接线不动正常分支；countPatchStats 门控 | 既有 apply/edit/write 测试全绿 + 守护切片 5/6 |
| INV-03 计算有界 | 门B 跳过 Myers | file-diff.ts | 切片 2 在测试预算内完成（当前超时） |
| INV-04 revert 不变 | 不触碰 | 无 | revert-compact.test.ts 全绿 |
| INV-05 聚合有界 + 三工具计数一致 | merge 降级标记 + write 计数显式化 | summary-cache.ts + write.ts | 切片 3（聚合界）、切片 7（write 摄入计数） |
| INV-06 静默 | 无 ask/配置/迁移 | 无 | 既有权限测试不变 |
| INV-07 二进制表示 | 门A | file-diff.ts | 切片 1（标记 + sha256 对 + 0/0 计数） |
| INV-08 计数口径单一精确 | hunk 门控 + 中段口径 + 摄入优先 | file-diff.ts + summary-cache.ts | 切片 4（中段 N/K 字面量）、切片 6（`--` 前缀守护）、切片 7 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `src/tool/file-diff.ts`（renderFileDiff + countPatchStats） | INV-01/02/03/07/08 | 407MB 事故、PROBE1/2/3 | 现状三工具各自内联 createTwoFilesPatch，无任何分级点；snapshot diffFull 是 git 数据源不能接管工具内文本 |
| hunk 门控计数（plugin/vscode-bridge.ts 同构） | INV-02/08 | PROBE1（现状扫描器漏计 `--` 行） | 无门控扫描器对支持域不精确；计数的单一权威要求单遍从生成产物推导（INV-08），避免双口径漂移 |
| 门A NUL-8192 二进制判定 | INV-07 | 用户否决比例启发式；git buffer_is_binary 为生态标准；snapshot:688 先例 | 无既有工具侧判定存在 |
| 门B 前后缀裁剪 + 64KiB 中段界 | INV-01/03 | PROBE2 二次方实测；事故 1h54m | jsdiff 无前置预算 API；inline 上限单独存在时产物仍可能巨大且计算仍无界 |
| rewrite 标记（中段行数 + 全文件 sha256 对） | INV-01/07/08 | 用户要求审计保留 + 否决截断；round-1 B-03 钉死口径 | 既有路径要么全文入库（事故）要么无表示 |
| write metadata additions/deletions + 摄入优先 | INV-05/08 | round-1 B-02 链条（write 摄入重扫描对标记必然 0/0） | 现状 write metadata 不带计数，摄入端无从优先 |
| mergeFileDiff 1MiB 聚合界 | INV-05 | 216MB 行 observed | 工具端修复不追溯已入库 legacy metadata |
| 常量三枚 | INV-01/03/05 | 上述实测 | — |
| （不引入）sidecar/配置/schema/ask | — | 用户否决或 §2 非目标 | — |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/file-diff.ts` | add | renderFileDiff 三分表示 + hunk 门控 countPatchStats（迁移并修复）+ 三常量 | +~160 |
| `packages/opencode/src/tool/apply_patch.ts` | modify | 三个生成点改调 renderFileDiff；删 countDiff 及调用；counts 用返回值 | ~-25/+20 |
| `packages/opencode/src/tool/edit.ts` | modify | 三个生成点改调；删 :390-395 计数循环 | ~-20/+15 |
| `packages/opencode/src/tool/write.ts` | modify | 三个生成点改调；metadata 携带 additions/deletions | ~-12/+12 |
| `packages/opencode/src/session/summary-cache.ts` | modify | mergeFileDiff 聚合界；diff/filepath 分支计数优先级；countPatchStats 改 import | ~-8/+16 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify（测试，唯一测试文件——B-04 口径） | 全部新切片宿主：binary delete、write 大重写（import WriteTool）、edit 大中段（import EditTool）、`--` 前缀守护、write 摄入计数（import SummaryCache）、聚合界、正常路径回归 | +~200 |

触碰文件总数 = **6**（生产 5 + 测试 1），满足"整体修改文件数不超过六个文件"的
严格总数口径。write/edit/summary 的切片寄居 apply_patch.test.ts 属 seam 混搭
（各自仍经真实公共 seam：tool.execute / collectToolDiffs 断言），为满足文件数契约
的显式取舍，文件内以 describe 块分组。

## 16. TDD Behavior Slices

Seam（预先确认）：工具公共 `execute`（断言 ExecuteResult.metadata 与 ctx.ask
metadata）+ `SummaryCache.collectToolDiffs` 公共函数。全部使用独立期望值（固定
字面量行数/标记串），不复现实现逻辑。宿主统一为 `test/tool/apply_patch.test.ts`
（B-04）。

| Order | 类型 | Red/guard 行为 | Why current code fails（红）或为何守护 | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- | --- |
| 1 | 红 | apply_patch 删除 512KB 二进制（含 NUL）：metadata.diff、files[].patch、ask diff 均 < 64 KiB 且含 "Binary file" 标记与 sha256 行，counts 0/0 | 全文进 diff（PROBE3：526,480） | 门A | — |
| 2 | 红 | write 整体重写 ~640KB 文本（公共头尾 + >64KiB 中段）：metadata.diff < 64 KiB 含 "whole-file rewrite" 标记与中段行数字面量，metadata.additions/deletions === 中段 K/N 字面量，且测试在预算内完成 | 当前 >139s 超时 + 巨 diff（PROBE2） | 门B + write 计数显式化 | — |
| 3 | 红 | edit 大中段（公共前后缀 + >64KiB 差异中段）：filediff.patch 为 rewrite 标记，additions/deletions === 中段 N/K 字面量 | 当前全文行 diff + 第二遍计数 | 门B + 中段口径 | — |
| 4 | 红 | collectToolDiffs 摄入 5MB legacy patch：聚合 patch ≤ 1 MiB 降级标记，计数 1/2 保留 | 当前原样透传 | 聚合界 | — |
| 5 | 守护 | apply_patch 正常小文本 delete：patch 逐行含原文，counts 与现状一致（既有期望值） | 现状绿；锁定正常路径零漂移 | 不变 | INV-02 |
| 6 | 守护 | edit 修改含 `-- comment`（SQL 风格）与 `+++ x` 行的文件：additions/deletions 精确等于独立手算字面量 | 现状绿（diffLines 精确）；防止计数权威迁移引入 PROBE1 回归 | hunk 门控 | INV-02/08 |
| 7 | 守护 | write 大重写后 collectToolDiffs(metadata) 的计数 === 中段字面量（非 0/0） | 现状近似正确（扫描巨 patch）；防止标记表示 + 摄入重扫描退化为 0/0（B-02） | 摄入优先 | INV-05/08 |
| 8 | 守护 | edit/write 正常小编辑：diff 与计数与现状一致 | 现状绿 | 不变 | INV-02 |

"不引入新的红测"约束的落点：切片 1-4 实施后必须全绿；切片 5-8 与全部既有测试
保持绿。红态只存在于实施过程内部（red→green），最终仓库无红。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~260 | 生产五行净变化（file-diff ~160 + 接线 ~100），排除 import/纯移动 |
| Required Chinese explanatory comments `C` | ≥ 39 | `ceil(260 × 0.15) = 39` |

需就近中文注释的锚点：三常量依据（git 窗口、PROBE2 二次方、216MB 事故）；门A 与
snapshot:688 语义对齐；门B 前后缀裁剪与 jsdiff 内部剪枝的一致性、为何同时界住计
算与产物；门B 中段计数口径（与变更行语义连续，全文件 sha 为身份）；rewrite/binary
标记格式的消费者（TUI 文本渲染、summary 摄入 countPatchStats 天然跳过标记行）；
hunk 门控计数的 unified 格式依据（文件头只在首个 @@ 前，vscode-bridge 先例）；
计数等值守护切片的意图（PROBE1 教训）；merge 聚合界的 legacy 免疫动机；摄入端
显式计数优先的理由（B-02：标记行无可扫描 +/- 正文）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/apply_patch.test.ts` | packages/opencode | 切片 1-8（宿主文件）+ 既有回归 |
| `bun test test/tool/edit.test.ts` | packages/opencode | INV-02 既有回归 + trimDiff 恒等测试 |
| `bun test test/tool/write.test.ts` | packages/opencode | INV-02 既有回归 |
| `bun test test/session/summary-tool-diff.test.ts` | packages/opencode | 既有摄入测试 |
| `bun test test/session/revert-compact.test.ts` | packages/opencode | INV-04 |
| `bun test test/storage/cold.test.ts` | packages/opencode | filediff 聚合生产者/冷存储消费面（实施期补充发现） |
| ~~`bun test`（全量）~~ R3：按用户指示以定向回归集替代全量——用户原话：
"全量test很慢，请避免这种行为"（2026-08-30）；受影响面的定向清单见上行与 §23 |
| `bun typecheck` | packages/opencode | 类型安全 |
| red-loop 沙箱复跑（§8 命令，实施期按 §8 记录重建同内容沙箱） | packages/opencode | 原始症状回路转绿（三切片期望值 < 界限） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1（file-diff.ts） | 唯一新 seam |
| Files modified | 5（生产 4 + 测试 1） | 三工具 + summary-cache + 唯一测试宿主 |
| Files deleted | 0 | — |
| Production lines | ~260 | 含注释 |
| Test lines | ~200 | 单一宿主文件追加 |
| Generated lines | 0 | — |
| 总触碰文件 | **6** | 严格总数口径（用户契约逐字） |

## 20. Real Risks and Open Decisions

### Real Risks（observed/contracted/reachable）

- R1 标记串的隐藏消费者：metadata.diff 以纯文本被 TUI/权限预览渲染（消费面以文本
  展示为主，标记可读性优于二进制乱码）；round-1 审计 N-02 确认 `pending-tool-input.ts`
  解析模型 patchText 原文、`vscode-bridge.ts` 解析自有 notebook diff，均不消费工
  具 metadata diff——标记串无解析器破坏面。summary 摄入端经切片 7 锁定。reachable，
  测试覆盖。
- R2 计数口径漂移：hunk 门控迁移与门B 中段口径由切片 4/6/7 的独立字面量锁定
  （PROBE1 教训）。reachable。
- R3 前后缀裁剪的行语义（无尾换行/CRLF）与 jsdiff 内部不完全一致时，门B 中段估计
  偏保守（只会更早触发标记，不会放行超限）——方向安全，注释说明。reachable。
- R4 全部切片寄居 apply_patch.test.ts 的长期可维护性成本（seam 混搭）——为满足
  文件数契约的显式取舍，describe 分组缓解。contracted（用户契约优先）。
- R5（接受，round-2 N-05）门A 下"创建含 NUL 内容的新文件"时，摄入端
  `inferStatus(0,0)="modified"` 与今天的 "added" 漂移——仅限该帘见输入；0/0 为
  INV-07 与 snapshot:688 对齐的既定计数语义，状态推断是未触碰的既有下游逻辑，
  实施注释记录接受。

### Open Decisions Requiring the User

（无——R1 的 D1 已按 round-1 B-04 裁定解决：严格总数口径，合并测试宿主。）

### Rejected Speculation

- "中小二进制嵌入 DB 以保审计"——正是事故构成物，且行级二进制 diff 无人工审计价
  值；已由 sha256+度量+工作树/git 内容取代（见 §10 解释）。
- "给 reviewer/transcript 再加防线"——生成端有界后 reviewer 输入自然有界；现有
  fallback_user 降级链保留即可（重复上游保证违反 policy）。
- "对未来未知工具做通用拦截"——无 producer 证据。
- UTF-16 误判门A——decode 产生替换字符而非 U+0000，不触发（round-1 审计确认）。
- 多文件 apply_patch 的 totalDiff = nfiles×每文件界 极端放大——受模型输出实际上限
  约束，无观测路径（round-1 审计拒绝为阻断项）。

## 21. Audit Contract

独立审计人必须：

- 阅读本文件与本任务原始需求原文。
- 从仓库证据重建行为，将 builder 摘要视为不可信。
- 每轮按完整原始范围审计。
- 每个 blocking finding 必须附证据。
- 同时检查 under-design 与 over-design。
- 检查根因修复、fallback、责任归属、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01（countPatchStats 无门控漏计 `--`/`++` 内容行，违反 INV-02/08）、B-02（write 有界表示经摄入重扫描退化为 0/0，违反 INV-05/08）、B-03（门B rewrite 计数 N/K 口径未定义：中段 vs 全文件）、B-04（触碰文件 9 > 用户契约 6，无授权引用） | N-01（red-loop 工件缺失，机制已由审计探针独立复核）、N-02（mergeFileDiff 命名与行号偏差；R1 消费面判断核实成立）、N-03（file/index.ts structuredPatch 相邻 seam 记录）、N-04（binary 标记缺 sha256，叙事不一致） | 阻断 (BLOCK) | ses_fb0c86f79ffeRWBjr9r65ZPRzZ |
| 2 | R2 | yes | 无阻塞性发现。R1 处置复核：B-01 已修复（hunk 门控迁移 + 切片 6 守护 + INV-08 重写；审计探针 7 例对抗验证 gated === exact）；B-02 已修复（write metadata 计数显式化 + 摄入优先 + 切片 7；扫描路径仅保留给已入库遗留行——具持久化数据消费者的合法兼容）；B-03 已修复（N/K 钉死裁剪后中段口径，切片 4 字面量）；B-04 已修复（严格总数口径 6 = 生产 5 + 测试 1，§1 钉死）。审计方独立验证：hunk 门控计数器探针 7/7 与 diffLines 等值、naive 扫描器漏计如预期；测试宿主可行性（apply_patch.test.ts 挂载 write/edit/SummaryCache 切片）按其套件确认 | N-05（门A 创建含 NUL 新文件的 inferStatus(0,0)="modified" 角落漂移——仅限该帘见输入，0/0 为 INV-07 既定语义，状态推断属未触碰的既有下游逻辑；处置：注释记录接受）、N-06（先例路径应为 packages/opencode/src/plugin/vscode-bridge.ts:325-339）、N-07（rewrite 标记行标签需消除 mid/file 作用域歧义）、N-08（§14 一处理由措辞过强） | 批准 (APPROVE) — 仅限 R2 版本 | ses_fb0c86f79ffeRWBjr9r65ZPRzZ |
| 3 | R3 | yes | 无阻塞性发现。R3 三项变更独立验证：（1）`"@@"` 前缀门控必要性 observed（契约 fixture 裸 `@@` 头期望 2/1，按 R2 字面实现则 0/0 使既有绿测转红）、安全性确认（unified 正文行不以 `"@@"` 开头，round-2 探针 7 例 + 构造推理）；（2）首见 push 摄入界属实的 R2 文字缺陷闭合（round-2 审计未捕获该不一致，实现双点均有界且计数精确保留）；（3）§18 定向回归替代全量已记录用户原话引用；审计方另独立实跑 snapshot-tool-race + file-mutation-concurrency（11 pass/0 fail）与 apply_patch + summary-tool-diff（67 pass/0 fail，与 §23 精确一致），并枚举确认 prompt/compaction/processor-effect 对 computeDiff 打桩不受影响、patch.test.ts 属未触碰模块 | N-09（§3/§4 先例路径未更正——本轮已处置）、N-10（§23 微小计数漂移：file-diff.ts 实际 116 行；E/C 须由 §24 实施审计独立重算） | 批准 (APPROVE) — 仅限 R3 版本；实施完成仍须等待 §24 全范围实施审计，此前不得转 verified/complete | ses_fb0c86f79ffeRWBjr9r65ZPRzZ |

R2 处置记录：B-01 → §10 hunk 门控迁移修复 + 切片 6 守护 + INV-08 重写；B-02 →
write metadata 计数显式化 + 摄入优先 + 切片 7；B-03 → 中段口径钉死 + 切片 4 字面
量；B-04 → 严格总数口径 6 文件 + 唯一测试宿主；N-01/02/04 → §4/§8/§9/§10 相应修
正。按 policy，实质性修订已升版 R2 并清空批准，等待全范围重审。

Round-2 后非阻塞记录性修正（policy：不清空批准、不触发重审）：N-05 → §20 R5 记
录接受；N-06 → §3/§4/§9 先例路径更正为 `packages/opencode/src/plugin/vscode-bridge.ts:325-339`；
N-07 → §10 标记行标签改为内联自述（`<N> mid lines, <M> file chars`）；N-08 → §14
理由措辞更正为计数单一权威。

R3 处置记录（policy Phase 9，实施期发现的事实）：实施在 R2 批准下进行；发现
（1）countPatchStats 的 hunk 标记需按 `"@@"` 前缀识别（既有契约 fixture
summary-tool-diff.test.ts:140 使用裸 `@@` 头，R2 §10 文字与批准探针均基于
`"@@ "`，按字面实现会使该现有测试转红）；（2）聚合界需覆盖首见 push（§16 切片 4
的批准语义，R2 §10 只描述了拼接路径）；（3）用户指示避免全量测试。以上已写入
R3（升版、清空批准、待全范围重审）；无其他实现偏差。

## 23. Implementation Evidence

### Actual Files and Diff

| File | Status | numstat（+/-） |
| --- | --- | --- |
| `packages/opencode/src/tool/file-diff.ts` | 新增（唯一 seam：三分表示 + hunk 门控 countPatchStats + 三常量） | 新文件 116 行 |
| `packages/opencode/src/tool/apply_patch.ts` | 三生成点改调 renderFileDiff；countDiff 删除 | +14/-30 |
| `packages/opencode/src/tool/edit.ts` | 三生成点改调；:390-395 第二遍计数循环删除 | +11/-36 |
| `packages/opencode/src/tool/write.ts` | 三生成点改调；metadata 携带 additions/deletions | +21/-20 |
| `packages/opencode/src/session/summary-cache.ts` | 首见+归并双摄入界；显式计数优先；countPatchStats 迁出 | +28/-14 |
| `packages/opencode/test/tool/apply_patch.test.ts` | 八切片宿主（describe 分组） | +244/-0 |

触碰总数 = 6（生产 5 + 测试 1），符合 §1 严格总数口径。

### Red-Green Test Evidence

| 切片 | 红（当前码实测） | 绿（实现后） |
| --- | --- | --- |
| 1 binary delete | max=712,963 > 65,536 | 全部 < 64KiB，含 "Binary file" 标记与 sha256 行，counts 0/0，文件确实被删 |
| 2 write 大重写 | 30s 预算超时（实际 ~50s，PROBE2 二次方） | 86ms，diff=508 chars，中段行数 8000/8000，落盘内容正确 |
| 3 edit 大中段 | 无 rewrite 标记（全文 diff） | 标记 + deletions/additions === 2000/2000 中段字面量 |
| 4 聚合界 | aggregate=5,242,881 > 1,048,576 | 47 chars 降级标记，计数 1/2 保留 |
| 6 `--`/`++` 守护 | 初版字面量误写为 2/2；红跑后按行级 LCS 修正为 1/1（公共行 bravo 被匹配），现状绿 → 实现后仍绿 | 1/1，含 "+++ added line" 正文 |
| 7 write 摄入计数 | additions=0（B-02 的 0/0 退化实测复现） | 8000/8000（显式优先） |
| 5/8 正常路径守护 | 现状绿基线 | 实现后绿（patch 逐字保留 + 计数一致） |

### Verification Commands and Results

| 命令（workdir: packages/opencode） | 结果 |
| --- | --- |
| `bun test test/tool/apply_patch.test.ts` | 61 pass / 0 fail（含八切片 + 全部既有回归） |
| `bun test test/tool/edit.test.ts` | 87 pass / 0 fail（含 trimDiff 恒等测试） |
| `bun test test/tool/write.test.ts` | 25 pass / 0 fail |
| `bun test test/session/summary-tool-diff.test.ts` | 6 pass / 0 fail |
| `bun test test/session/revert-compact.test.ts` | 16 pass / 0 fail |
| `bun test test/storage/cold.test.ts` | 42 pass / 0 fail |
| `bun typecheck` | 通过（tsgo --noEmit 无输出） |
| 全量 `bun test` | 按用户指示未采用（"全量test很慢，请避免这种行为"），以受影响面定向清单替代 |

### Original Feedback-Loop Result

§8 外部沙箱回路（同内容重建后复跑，workdir packages/opencode）：

```text
apply_patch binary delete: 712,963 -> diffLen=378 / files=[377] / ask=378，147ms
write 整体重写（~640KB）:  >139s+MB 级 diff -> 86ms，diffLen=508
summary 聚合（5MB legacy）: 5,242,881 -> 47
3 pass / 0 fail
```

### Actual Secondary and Replacement Path Inventory

全部为 primary-contract 分支（确定性输入分派，无 fallback/alternate success）：
normal（createTwoFilesPatch + hunk 门控计数）；binary 标记（0/0）；rewrite 标记
（中段计数）；首见+归并双聚合界；摄入端显式计数优先（扫描仅服务已入库遗留行，
具持久化数据消费者的合法兼容）。diagnostic 面占比 0%。删除的 workaround：
countDiff、edit 第二遍计数循环、summary-cache 无门控 countPatchStats（迁移即修复）。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 323（实施审计独立重算，policy 口径：仅新增/修改行） | 生产 125（file-diff 75、write 17、summary-cache 16、apply_patch 10、edit 7）+ 测试 198；排除空行/import/纯注释行。builder 自算的 416 含 92 行删除（workaround 淘汰），两口径均过门禁（I-02 记录差异） |
| Qualifying Chinese comment lines `C` | 64 | file-diff 25、summary-cache 10、测试 20、tools 9；审计方手工筛检确认全部为决策点注释 |
| Ratio `C / E` | 19.8% | 64/323（builder 口径 15.4%，均达标） |
| Required minimum `C` | 49 | `ceil(323 × 0.15) = 49`，达标 |

代表性注释：file-diff.ts 三常量依据（git 窗口/二次方实测/216MB 事故）、门A 与
snapshot:688 语义对齐、门B 同时界住计算与产物的推导、标记行内 mid/file 作用域自
述、hunk 门控的 unified 格式依据与裸 `@@` 契约形状、summary-cache 摄入界的 legacy
免疫动机、write 显式计数的 B-02 理由、切片内的独立字面量推导说明。

### Remaining Unverified Items

- 全量测试套件未运行（用户指示避免；受影响面定向清单全绿，见上表）。
- `D:\Temp\opencode` 下本任务沙箱残留（red-loop 沙箱/junction/cold.log/full-suite.log）
  待用户授权后清理（删除操作需用户确认）。
- 嵌入真实 TUI/权限预览的端到端渲染未单独验证（标记串为纯文本，消费面以文本展示
  为主；round-1 N-02 已核无解析器破坏面）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3（approved） | yes | 无阻塞性发现。逐 hunk 映射 R3：renderFileDiff 三路分发 + `"@@"` 门控 countPatchStats = §10；九个生成点全部改接且输入相同（正常路径 patch 逐字节一致，门控计数经探针等价含裸 `@@` 契约形状）；countDiff 与 edit 第二遍循环删除 = §12；write metadata 计数与持久化 diff 同源 + 摄入优先 typeof-number 守卫 = §10（B-02）；boundMergedPatch 双点应用且计数保留 = §10/§16 切片 4；naive 扫描器删除并留迁移理由注释 = §12。测试纯增加（+244/-0），商定 seam + 独立字面量，无断言弱化；红侧历史由审计方 round-1 探针独立确立。审计方亲自重跑全部 §18 命令（apply_patch 61 ✓、edit 87 ✓、write 25 ✓、summary-tool-diff 6 ✓、revert-compact 16 ✓、cold 42 ✓、typecheck ✓）+ 原始回路（binary 382 chars/132ms、rewrite 505 chars/66ms、aggregate 47，3 pass）+ 额外面（snapshot-tool-race + file-mutation-concurrency 11 pass）。E/C 独立重算 E=323、C=64、19.8%（要求 ≥15%/下限 10%，达标）。预算 6 文件 +434/-100 ≤ 800 | I-01（cold.test 与其他文件同进程捆绑调用时因跨文件全局 DB 状态泄漏失败——本 diff 无因果路径，隔离运行 42/42，§18 契约为逐文件；建议未来基建关注）、I-02（E/C 口径差异：builder 416 含删除行 vs policy 323，均过门禁）、I-03（trimDiff 生产零调用者，保留为 §12 批准处置，后续清理候选）、I-04（§3/§4 旧路径残留——本轮已更正）、I-05（file-diff.ts 116 行，已更正） | 批准 (APPROVE) — R3 实际 diff（六文件，+434/-100）；行政后续留用户决定：D:\Temp\opencode 沙箱残留清理需明确确认；I-01 捆绑调用异常与 I-03 trimDiff 清理属本任务文件预算外的后续任务 | ses_fb0c86f79ffeRWBjr9r65ZPRzZ |

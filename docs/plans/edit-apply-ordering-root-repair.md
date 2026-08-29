# Canonical Implementation Plan: edit/apply_patch 多块编辑排序不变量根因修复

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户会话 GOAL 原始需求（见第 1 节逐字引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-29

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与本文件之外的 builder
说明都不是实施授权。

## 1. Verbatim Requirement

> 将受影响的 Edit 以及 Apply Patch 等相关内容的排序机制设置为原位排序，也就是在具体编辑实施之前，将编辑段的内容进行相应的排序，同时完整详细调研全面的 Edit 的相关内容的一些由于顺序或者原子先后性等问题导致的飘移或编辑混乱等等错误问题并进行相应修正。与此同时修正数量，也就是修改的文件数，生产代码不超过四个文件，修改行数不超过800行。同时也要检查 edit 是否会有相应的，譬如 old string 和 new string 里面的一些，由于不同的缩进啊等等导致的一个编辑的结果不符合 input 的一种内容。譬如说 input 里面写的是一个缩进，output 写的是一个缩进，然后出来的结果，就是实际的文件是两个缩进，那么出来的结果也应该是两个缩进，因为它这个缩进段其实没有变，它只是改了从第一个缩进之后的那一个缩进及后面内容，所以这种应该是不变的。与此同时，譬如说输入 input 是一个缩进，output 是没有缩进，那理论来说结果应当是移去了一个缩进，所以类似于这种情况，请你检查是否会有相应的问题导致其这些内容的编辑是出现错误。与此同时，也需要完整检查相应的测试文件，保证测试文件内容不会出现新的或者引入新的红测。也就是说，原有的测试内容不要让其变成实质上出现问题的一个错误。也就是如果测试过时了，你需要更新测试；如果生产代码有问题，你需要更新生产代码。

补充的用户顺序不变量陈述（同会话原文）：

> 每一个边界段只是进行原子性的一个替换，那么先替换A再替换B再替换C，和先替换B再替换A再替换C，理论来说应该是同样的一个性质。

目标终态：`<verified-implementation-and-commit>`。

## 2. Explicit Non-Goals

- 不修改 `apply_patch` / `patch/index.ts` 的定位与排序语义：已逐行核实其
  `applyChunks` 为正确的原位排序 → 重叠检查 → 排序后逆序应用
  （packages/opencode/src/patch/index.ts:408-426），本任务仅验证、不改动。
- 不扩大归一化匹配集（`normalizeForMatch` 的封闭集合保持不变；tab↔空格缩进
  仍必须失败并要求 re-read）。
- 不修改 `applyReplacementsPreservingUnchangedLines` 的内部排序：它是该函数
  自身契约的一部分（与 pi 参照实现一致），不是待删除的 workaround。
- 不处理 `.temp/API` 内层 git 暂存区中已冻结的损坏中间版（用户侧运维动作）。
- 不重建 `F:\include\CLI\opencode.exe`（构建/发布动作，见第 20 节开放说明）。
- 不引入新的匹配算法、fallback 或重新定位式（re-locate）apply。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | 测试不得从仓库根运行；typecheck 用 `bun typecheck` 从包目录跑；`dev` 为默认分支；风格规则（避免 `any`、避免不必要解构等） |
| `packages/opencode/AGENTS.md` | 测试从 `packages/opencode` 运行；Effect 服务与测试 fixture 约定（`it.instance`、`TestInstance`） |
| `packages/opencode/test/AGENTS.md` | `tmpdir`/`testEffect` fixture、`it.instance` 用法、禁止 fixed-sleep 反模式 |
| `CONTEXT.md` | Tool 定义位于 `src/tool/`；领域词汇（Tool/Session/Message）与 `[local-smark]` 标注约定 |
| `.opencode/policy/first-principles-engineering.md` | 单一权威语义路径、禁止 fallback、责任归属、E/C 中文注释门禁 |
| `src/tool/edit-apply.ts` 文件头不变量清单 | 该文件是 edit 文本替换的唯一语义 owner；INV 列表是本计划的对齐基线 |
| pi 参照实现 `.temp/thirdparty/pi/packages/agent/src/harness/tools/edit-diff.ts` | edits[] 批量替换 + 保守归一化的移植来源；其 342/356 行的排序不变量是被移植时丢失的参照语义（仅作证据引用，不修改该目录） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/edit-apply.ts`（全文，git 状态 = bb242c1c40，未修改） | 缺陷所在：508 行副本排序 vs 523 行 exact 分支未排序套用；146 行 preserve 内部排序 | observed |
| `packages/opencode/src/tool/edit.ts`（全文） | 唯一 applyEdits 消费方；baseLF/editsLF 归一化、Mutation commit、_syncInput 均与排序无耦合 | observed |
| `packages/opencode/src/patch/index.ts` 330-589 行 | apply_patch 的 `applyChunks` 排序/重叠/逆序应用已正确，排除出范围 | observed |
| `packages/opencode/src/patch/match.ts`（import 面） | 仅复用 `normalizeForMatch`，无 apply 顺序耦合 | observed |
| `packages/opencode/test/tool/edit.test.ts`（结构 + 1513-1632 行 multi-edit 块 + helpers 180-201 行） | 回归测试落点；现有 multi-edit 测试全部升序提交，解释缺陷为何未被捕获 | observed |
| `packages/opencode/test/patch/patch.test.ts`、`test/tool/apply_patch.test.ts`（运行基线） | 110 pass / 0 fail，确认 apply_patch 面无需改动且为绿基线 | observed |
| `bun test test/tool/edit.test.ts` 基线 | 83 pass / 0 fail 绿基线 | observed |
| 红色回路（第 8 节命令） | 当前工作区复现：降序提交 → 错位拼接输出 | observed |
| 缩进语义探针 A–D（第 7 节 INV-05） | 四项语义当前全部正确，无需生产修改 | observed |
| pi `edit-diff.ts` 301-363、107-116 行 | 参照实现：342 行原位排序 → 356 行同一数组交 exact apply；docstring 声明 reverse-order 不变量 | observed |
| 事故取证（opencode.db part 表 ses_1762e23a2f 2026-08-29 13:03:19 调用 + 输出 diff + `.temp/API` 内层 git index 冻结副本 2124 行拼接） | 生产环境真实损坏样本：4 块编辑乱序提交，三处中线拼接 | observed |
| 运行二进制 `F:\include\CLI\opencode.exe` 内嵌 bundle 反汇编（`applyEdits`/`wo`/`W1`） | 运行版本与源码同缺陷，排除"运行旧版"解释 | observed |
| 用户 GOAL 原文 | 排序机制、文件/行数上限、缩进语义检查、测试不引入红测 | contracted |

## 5. Current Behavior

edit Tool 的多块替换主路径（全部环节已在当前工作区逐行核实）：

```text
模型 edits[](任意提交顺序)
  -> EditTool.execute (tool/edit.ts)
     -> Mutation.read 快照 + baseLF/editsLF 行尾归一
     -> applyEdits(baseLF, editsLF)  [tool/edit-apply.ts，唯一语义 owner]
         1. 空 needle / 归一化空 needle 拒绝
         2. 整批 elevation 判定（任一条 exact 失败或计数分歧 -> 归一化空间）
         3. 同一 pre-edit replacementBase 上逐条 locate + 唯一性
         4. range 枚举（exact/normalized；replaceAll 展开多区间；
            identical 条目跳写不进 allRanges）—— allRanges 按 edits 提交顺序 push
         5. 重叠检查：在一次性副本 [...allRanges].sort(...) 上做（508 行）
         6. apply：normalized ? preserve(content, base, allRanges)
                     : applyReplacements(base, allRanges)   （523 行，未排序）
     -> convertToLineEnding -> Mutation.commit 写盘 -> formatter -> diff/事件
```

`applyReplacements`（121-131 行）按数组**逆序**遍历切串——该"从高偏移写到低偏移"
的正确性前提是数组已按 `matchIndex` 升序排列。preserve 分支（134-169 行）内部
先自行排序（146 行）故安全；exact 分支直接消费提交顺序数组。

apply_patch 路径（对照）：`applyChunks` 在 408 行对 replacements **原位排序**，
410-420 行重叠检查与 424 行 `[...replacements].reverse()` 应用共用该排序——
pi 式不变量在此路径已成立。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| edits[] 按非升序位置提交（含降序、交错） | 模型经 EditTool 参数 | 仅要求互不重叠、各自唯一 | 任意一次多块 edit 调用 | tool/edit-apply.ts | observed（事故 + 红色回路） |
| replaceAll 展开区间与其他 edit 区间交错 | replaceAll 枚举 | 同一快照定位、区间互不重叠 | replaceAll + 伴随 edit 混合提交 | tool/edit-apply.ts | reachable（合成复现 observed） |
| 归一化 elevation 批次（智能引号/行尾空白漂移） | 模型 oldString 漂移 | 封闭归一化集 | preserve 分支（内部已排序，现状正确） | tool/edit-apply.ts | reachable |
| 中线锚点 + 深缩进上下文（用户缩进场景） | 模型 oldString | 字面子串语义 | exact/preserve 分支 | tool/edit-apply.ts | reachable（探针正确） |
| apply_patch update chunks 乱序 | 模型 patch 文本 | applyChunks 集合式定位 | patch/index.ts（现状正确） | patch/index.ts | reachable（已由 110 项测试覆盖） |

Speculative 行（如恶意构造的重复提交）不进入本表，不得驱动生产逻辑。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 顺序不变性：同一组互不重叠 edits 的最终文件内容与提交顺序无关（用户原文陈述的不变量） | contracted（用户原文）+ pi 参照契约 | 无 |
| INV-02 | 锚点精确性：每个替换必须精确落在其锚定原文区间上；非重叠区间不得产生错位拼接（中线粘接/残尾） | observed（事故 2124 行拼接、红色回路输出） | 无 |
| INV-03 | 同一 pre-edit 快照定位；顺序依赖条带必须失败而非静默成功 | 模块文件头不变量清单 | 已覆盖（"rejects sequential-dependent edits against original snapshot"） |
| INV-04 | 重叠拒绝、唯一性拒绝、空 needle/归一化空 needle 拒绝在 apply 前完成，失败零写盘 | 模块不变量 INV-06/07/12 | 已覆盖（edit.test.ts 83 项中多项） |
| INV-05 | 字面缩进语义：oldString→newString 为逐字节替换；未触碰前缀（含缩进、行尾空白）字节保真；oldString 有缩进→newString 无缩进即移除该缩进。用户场景：未变的缩进段必须原样保留 | contracted（用户原文）+ observed（探针 A–D 全部正确） | 无（本次以测试锁定） |
| INV-06 | apply_patch update chunks 集合式定位 + 原位排序 + 逆序应用（验证性 invariant，本任务不改其代码） | observed（patch/index.ts:408-426 + 110 项测试） | 已覆盖（patch/apply_patch 测试套） |

## 8. First Divergence and Root Cause

**红色回路**（当前工作区已运行，确定性、秒级、agent-runnable）：

```bash
bun -e "const m = await import('file:///F:/ML/PythonAIProject/Claude-Code/opencode/packages/opencode/src/tool/edit-apply.ts'); const r = m.applyEdits('A = 1 \nB = 2\ndef target():\n    pass \nC = 3\n', [{oldString:'def target():\n    pass', newString:'def target():\n    return 1'}, {oldString:'A = 1', newString:'A = 111'}], 't.py'); console.log(r.contentNew);"
```

- 现状输出（RED）：`A = 111 \nB = def target():\n    return 1ss \nC = 3\n`
  —— `B = ` + newString + 残尾 `ss `，与生产事故（`.temp/API/leak_scanner.py`
  三处中线拼接）同构。
- 修复后预期（GREEN）：`A = 111 \nB = 2\ndef target():\n    return 1 \nC = 3\n`

最小化已达成：两个互不重叠、各自唯一的编辑 + 变长 newString + 降序提交，
每个元素都是承载性的（去掉任一条件即不再变红：升序提交绿、等长替换绿、
单编辑绿）。

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `applyEdits` 将按提交顺序 push 的 `allRanges` 未排序即交给 `applyReplacements`（edit-apply.ts:523）；该函数逆序遍历假设升序输入，低偏移变长替换先应用即令后续记录偏移整体过期，在下一次切串时切入非锚点文本。508 行的重叠检查排的是一次性副本，排序结果从未进入 apply | `packages/opencode/src/tool/edit-apply.ts` 的 `applyEdits`（edit 文本替换唯一语义 owner） | 红色回路（observed）+ pi 参照 342/356 行对照（原位排序后同数组 apply，无此缺陷）+ 事故 DB 取证 + exe 反汇编同构 |
| INV-05 | 无 divergence：exact 分支逐字替换、preserve 分支仅 trimEnd 触碰行行尾、前导缩进从不进入归一化集 | 同上（无需修改） | 探针 A–D 四项 observed 正确 |

下游症状（历史损坏、暂存区冻结坏版本）不是根因，不进入修复面。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 多块替换的坐标排序不变量 | `applyEdits`（edit-apply.ts） | 同一快照定位出的区间集合在写回前必须构成"升序 + 两两不相交"，且检查与应用共用同一份排序 | 它是 edit 文本替换的唯一语义 owner（文件头声明），是唯一同时知道"全部区间 + apply 方向假设"的位置 | `applyReplacements` 是私有切串 helper，其"升序输入"前置条件由调用方保证；在 helper 内再排序属下游重复上游保证（policy 禁止） |
| apply_patch 的 chunk 排序 | `applyChunks`（patch/index.ts） | 已成立（408 行原位排序） | 独立 owner，语义已正确 | 本次不动 |
| 缩进/字面替换语义 | `applyEdits` 两分支 | 逐字替换 + 未触碰字节保真 | 现状已满足 | 无需修改，仅测试锁定 |

## 10. Single Approved Primary-Path Design

在重叠检查处把副本排序改为**原位排序**，使重叠检查与两个 apply 分支共用同一
份排序结果（对齐 pi 参照 342/356 行与 patch/index.ts:408 既有模式）：

```text
edits[] -> 空needle拒绝 -> 整批elevation判定 -> 同快照locate+唯一性
        -> range枚举(含replaceAll展开, identical跳写)
        -> allRanges 原位按 matchIndex 升序排序      [修复点]
        -> 重叠检查(在同一数组上)                    [语义不变]
        -> normalized ? preserve(content, base, allRanges)
                     : applyReplacements(base, allRanges)   [现消费已排序数组]
```

具体 diff（edit-apply.ts 507-517 区域）：

- 删除 `const sorted = [...allRanges].sort(...)` 副本；
- 改为 `allRanges.sort((a, b) => a.matchIndex - b.matchIndex)`；
- 后续重叠检查循环引用 `allRanges`（4 处标识符随动）；
- exact/preserve 两个 apply 调用行不变（本就传 `allRanges`，语义由"传入数组
  已排序"而修正）；
- 模块不变量清单 INV-12 与 `applyReplacements` 的注释补排序前置条件说明。

为什么该路线修复第一 divergence：排序是 reverse apply 坐标有效性的承重墙。
排序后逆序遍历严格从高偏移写到低偏移，每次替换只动尾部，所有待应用低偏移
区间在未触碰前缀中保持坐标有效——与用户陈述的顺序无关性（INV-01）及 pi 的
docstring 契约（"applied in reverse order so offsets remain stable"）一致。
归一化分支、replaceAll 展开、identical 跳写、错误文案（`edits[i]` 归属由
`editIndex` 字段携带，与数组顺序无关）语义均不变。

明确排除的形态：不在 `applyReplacements` 内部防御性排序（owner 已保证）；
不引入逐条重新定位式 apply（会创造第二套匹配语义并违反同快照不变量）；
不改动 preserve 内部排序（该函数自身契约 + pi 对齐）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| exact 分支 `applyReplacements` | 现有 | primary-contract branch | yes | 主路径（本次修复） | preserve |
| 归一化分支 `applyReplacementsPreservingUnchangedLines` | 现有 | primary-contract branch | yes | 主路径（现状正确） | preserve |
| `closestWindow` 失败诊断 | 现有 | diagnostic | no | 仅失败文案 | preserve |
| apply_patch `applyChunks` | 现有 | 独立 owner 的 primary | yes | 非本任务面 | preserve（不改） |
| identical 条目跳写 | 现有 | primary-contract branch | no-op | 已有测试 | preserve |
| 逐条 re-locate apply / helper 内防御排序 | 不存在 | forbidden fallback / 重复责任 | — | 0 | reject |

新增替代成功路径数：0。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `[...allRanges].sort(...)` 一次性副本（edit-apply.ts:508） | 移植 pi 时为不改动收集顺序而排了副本给重叠检查用，恰好丢失 pi 的"同数组"不变量 | 原位排序使检查与 apply 共用一份真值，副本无存在必要 | collapse：原地替换为 `allRanges.sort(...)` |

preserve 分支内部排序不是 workaround（独立函数契约 + pi 对齐），保留。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 顺序不变性（用户原文） | applyEdits 原位排序 | edit-apply.ts:507-517 | edit.test.ts 新 slice 1（乱序按位置应用）+ slice 3（两种提交顺序同输出） |
| INV-02 锚点精确性 | 同上 | 同上 | slice 1（断言精确期望字节）+ slice 2（replaceAll 交错） |
| INV-05 缩进/字面语义 | 现有 exact/preserve 分支（不改） | 无生产改动 | slice 4（未触碰前缀保真 + 缩进移除字面语义 + 归一化分支缩进语义） |
| INV-03/04 既有语义不被破坏 | 不变 | 无 | 既有 83 项 edit 测试全绿回归 |
| INV-06 apply_patch 不回归 | 不变 | 无 | 既有 110 项 patch/apply_patch 测试全绿回归 |
| 用户上限（≤4 生产文件、≤800 行） | 见第 19 节 diff 预算 | 1 生产文件 / 1 测试文件 | 预算表审计 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `allRanges` 原位排序（含replaceAll展开区间） | INV-01、INV-02 | 红色回路 + 事故取证 + pi:342 对照 | 现有副本排序结果不进入 apply；applyReplacements 的升序前提在 exact 分支恒不成立（除偶合升序提交） |
| INV-12 注释与 applyReplacements 前置条件注释（中文） | 政策 C 门禁 + 模块不变量清单 | `.opencode/policy/first-principles-engineering.md` | 排序承重墙此前无文字记载，防止未来"清理冗余"式回退 |

无其他新增生产概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/edit-apply.ts` | modify | 副本排序改原位排序；重叠检查引用同一数组；INV-12 注释补排序不变量；applyReplacements 注释补升序前置条件 | 约 +10/−6（含注释） |
| `packages/opencode/test/tool/edit.test.ts` | modify | "multi-edit and normalized match" describe 内新增 4 个 it.instance 切片（乱序、replaceAll 交错、顺序不变性、缩进语义锁定） | 约 +85 |

生产文件数 1（≤4 ✓）；总修改行数约 100（≤800 ✓）。

## 16. TDD Behavior Slices

统一 seam：`EditTool` 经 `it.instance` + `run`/`fail`/`put`/`load` helpers
（edit.test.ts:180-201 既有 fixture），.txt 文件无 formatter 干扰。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 文件 `A = 1␠\nB = 2\ndef target():\n    pass␠\nC = 3\n`，edits 降序提交 `[target块→变长替换, A = 1→A = 111]`，断言输出精确等于 `A = 111␠\nB = 2\ndef target():\n    return 1␠\nC = 3\n` | exact 分支逆序遍历提交序数组：先应用低偏移变长替换使高偏移记录失效 → 中线拼接 | 排序后逆序写回，输出与逐字替换语义一致 | 事故形态（乱序+变长）永久锁死 |
| 2 | 文件 `old A\nline1\nMID TARGET\nline2\nold B\nend\n`，edits `[MID TARGET→变长, old→OLDISH(replaceAll)]`（首区间看似升序、全局非升序），断言精确期望串 | replaceAll 第二展开区间落在先提交 edit 之后，数组非全局升序 → 同根因 | 全局位置排序后交错区间正确套用 | replaceAll 交错盲区锁死 |
| 3 | 同一组 3 个互不重叠 edits（中间含变长），以两种相反顺序分别应用到同内容两文件，断言两文件字节相同 | 现状降序那份产生拼接，两份不等 | 两种顺序输出一致（用户不变量原文） | INV-01 顺序不变性 |
| 4 | 缩进语义锁定（现状绿，防回退）：(a) `        head tail\n` 编辑 `tail→TAIL` 断言 8 空格前缀原样；(b) `    def f():\n        pass\n` 编辑 `    def f():→def f():` 断言缩进按字面移除；(c) 归一化分支：`        say “x”\n` 编辑 `        say "x"→            say "x"`（ASCII 引号触发归一化匹配）断言缩进按 newString 字面增加 | 现状不失败（锁定性切片，无 red 阶段；若实现中发现任何一项变红即暴露新缺陷，按第 20 节处理） | — | INV-05 用户缩进场景三形态 |

切片 1/2/3 在实现前运行必须红（当前已用回路证实同根因），实现后转绿；
切片 4 实现前后均绿。所有期望值为独立手算字节（非复述实现）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E`（生产） | 约 5 | 删副本排序 1 行、增原位排序 1 行、4 处循环标识符随动；排除注释/空行 |
| Required Chinese explanatory comments `C`（生产） | ≥ max(1, ceil(5×0.15)) = 1，计划 3 处 | 见下 |

计划的生产注释点（均在修改点邻近）：

1. 排序处不变量注释：说明"排序是 reverse apply 坐标有效性的承重墙；重叠检查
   与 apply 分支必须共用同一份排序结果"，并指出与 preserve 内部排序、
   patch/index.ts applyChunks、pi 参照的同构约定。
2. 模块不变量清单 INV-12 行：补"range 先原位排序再 reverse apply（顺序不变性）"。
3. `applyReplacements` 注释：补前置条件"调用方必须传入按 matchIndex 升序的
   区间数组"。

测试切片按仓库既有风格各配中文意图注释（不计入生产 C，但遵循同风格）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | `packages/opencode` | 既有 83 项全绿 + 新 4 切片红转绿（切片 4 恒绿） |
| `bun test test/patch/patch.test.ts test/tool/apply_patch.test.ts` | `packages/opencode` | apply_patch 面无回归（110 项） |
| `bun typecheck` | `packages/opencode` | 类型安全 |
| 第 8 节红色回路命令 | 任意 | 修复后输出精确期望串（GREEN） |

（测试遵守"不得从仓库根运行"守卫，全部从 packages/opencode 执行。）

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 无新文件 |
| Files modified（生产） | 1（edit-apply.ts） | 根因唯一 owner |
| Files modified（测试） | 1（edit.test.ts） | 唯一回归 seam |
| Files deleted | 0 | — |
| Production lines | 约 16（含注释） | 单点根因修复 |
| Test lines | 约 85 | 4 个行为切片 |
| Generated lines | 0 | 无 |

用户上限核对：生产文件 1 ≤ 4 ✓；总行数约 100 ≤ 800 ✓。

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无（修复路线唯一且最小；无产品/政策抉择）。

### Real Risks

- 某些既有测试若断言了提交顺序敏感的输出将变红：当前 83 项中未发现（multi-edit
  测试均为升序）；验证命令会暴露，处理原则为"生产正确优先，过时测试更新"
  （用户原文授权）。
- 运行中的 `F:\include\CLI\opencode.exe`（8/27 构建，内嵌同缺陷 bundle）需在
  合并后重建，修复才会到达运行时二进制——构建/发布不在本计划代码范围内，
  作为运维后续项记录（非 blocker）。

### Rejected Speculation

- "`applyReplacements` 内部防御性排序"——rejected：下游重复上游保证，owner
  已建立不变量（policy 禁止重复责任）。
- "逐条 re-locate 式 apply"——rejected：创造第二套匹配语义，违反同快照定位
  不变量（INV-03）与单一路径门禁。
- "修改 patch/index.ts 对齐"——rejected：该路径已正确，触碰属无证据扩张。
- "缩进语义修复"——rejected：探针 A–D 四项均正确，无缺陷证据；仅以测试锁定。
- "乱序输入直接报错拒绝"——rejected：pi 参照与用户不变量均要求顺序无关成功，
  拒绝会把可正确处理的合法输入误杀，且不修复坐标失效根因。

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

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | 3（行数估算口径备注；可选补充两个单编辑消费方测试套；红色回路命令为 POSIX 引号写法） | No blocking findings — APPROVE | ses_fb344d868ffeb3McXUS1U3QjVi |

Any substantive revision invalidates earlier approval.

<details><summary>Verbatim independent audit verdict (Round 1, revision R1)</summary>

# Plan Audit — `docs/plans/edit-apply-ordering-root-repair.md` (Revision R1)

## Blocking findings

No blocking findings.

## Non-blocking findings

1. **Line-estimate bookkeeping variance (non-blocking record note).** Section 15 records `约 +10/−6（含注释）`, Section 19 records `约 16` production lines, Section 17 records `E ≈ 5`. The three are mutually consistent once comment/blank exclusions are applied (16 touched = 10 added + 6 removed; E excludes comments), and all preserve the hard minimum against the user's ≤4-file / ≤800-line cap (actual plan: 1 production file, ~16 lines). Per policy, arithmetic drift that preserves the minimum is non-blocking.
2. **Verification surface could additionally list the two single-edit consumer suites.** `test/session/prompt.test.ts` and `test/tool/file-mutation-concurrency.test.ts` invoke the edit tool with edits arrays (lines 5533/5708 and 241/252 respectively), but only with single-element arrays, on which the proposed sort is a behavioral no-op — they cannot regress from this fix. Adding them to Section 18's command list would be belt-and-suspenders, not a correctness requirement.
3. **Section 8's red-loop command is written in POSIX quoting.** On this Windows/pwsh host it required adaptation to execute. Trivial; I reproduced it successfully (see below).

## Rejected speculation

- **"`applyReplacementsPreservingUnchangedLines` still copy-sorts (line 146), violating the user's 原位排序 mechanism."** Rejected: the user-prescribed mechanism — sort the edit segments before application — is implemented at the pipeline level (`allRanges` in `applyEdits`), which is the position every apply branch consumes. The preserve function is independently exported, must not assume pre-sorted input, has its own documented contract, and matches the pi reference structure exactly. After the fix its internal sort is idempotent on already-sorted input; forcing it in-place has zero behavioral consequence and no reachable defect.
- **"apply_patch EOF insertions are order-dependent (patch/index.ts:433)."** Rejected: pure insertions carry no position anchor other than EOF; patch-document order is the only defined order for their relative sequence, and they are not the position-anchored atomic replacements the user's invariant (A/B/C replacement order-independence) governs. The replacement path (line 408 in-place sort → 410-420 overlap → 424 reverse apply) satisfies the invariant; 110 passing tests cover the surface.
- **"Trailing-whitespace loss on touched lines under normalized elevation violates INV-05."** Rejected: pre-existing, documented module contract (file-header INV list item 4; a dedicated passing test locks untouched-line byte preservation). The user's indentation scenarios concern leading indentation, which I probed directly (below) and found byte-faithful in both branches. The plan neither introduces nor worsens the touched-line behavior.

## Requirement and traceability coverage

Independently verified against repository evidence, not builder claims:

- **Requirement quoted verbatim, no narrowing** — both the main requirement and the supplementary order-independence invariant appear as exact quotes (plan §1). ✓
- **The defect is real and observed.** I reproduced the red loop on the current worktree: output `"A = 111 \nB = def target():\n    return 1ss \nC = 3\n"` — byte-identical to the plan's recorded RED, including the mid-line splice. Root cause confirmed by direct source read: `edit-apply.ts:508` sorts a one-shot copy `[...allRanges].sort(...)` used only for the overlap check, while line 523 passes the **unsorted** `allRanges` to `applyReplacements`, whose reverse iteration (lines 121-131) presupposes ascending `matchIndex`. A low-offset length-changing replacement invalidates all subsequent recorded offsets. ✓
- **First divergence, owner, and route are correct.** The in-place sort at the overlap-check site is exactly where the check and both apply branches can share one sorted truth. I verified non-overlap (`previous.end ≤ current.start`) guarantees reverse-apply offset validity — the fix is sound, not just plausible. ✓
- **Cross-checks all hold:** pi reference sorts in place at `edit-diff.ts:342` and applies the same array at 356 (the invariant the port dropped); `patch/index.ts:408` already sorts in place (plan's non-goal is evidence-based, not scope-dodging); preserve branch internally sorts (line 146) and is unaffected; `applyEdits` has exactly one production consumer (`edit.ts:275` — other `applyEdits` grep hits are jsonc-parser, unrelated), and `syncEdits`/`normalizedMismatchIndices`/provenance/diff are all keyed per-edit-index or derived from final content, so sorting `allRanges` cannot disturb them. ✓
- **Indentation half of the requirement independently probed, not trusted:** untouched-prefix preservation, literal indent removal, normalized-branch literal indent increase, and the user's two-indent scenario all produce correct bytes today (`usedNormalized` flags as expected). The plan's INV-05 "no divergence — lock with tests only" conclusion is confirmed by my own probes; slice 4's expectations match my observed outputs. ✓
- **Test-regression claim verified:** every multi-edit array in `edit.test.ts` submits ascending positions (checked all 26 `edits: [` occurrences); failure-mode tests reject in the locate phase before any sorting. No other test file exercises multi-edit ordering. Baselines reproduced: edit 83 pass / 0 fail; patch + apply_patch 110 pass / 0 fail. ✓
- **TDD slices are genuinely red-capable:** slice 1 verified by reproduction; slice 2 verified analytically (replaceAll expansion yields `[{12},{0},{29}]` — not globally ascending, same root cause); slice 3 encodes the user's supplementary invariant directly; slice 4 is honestly labeled as a lock (always-green), consistent with my probes. Expected values are hand-computed literals independent of implementation. ✓
- **Budget compliance:** 1 production file (~16 lines) + 1 test file (~85 lines) — within ≤4 production files / ≤800 lines under any reading. ✓
- **Metadata consistent:** Status `audit-required`, Revision R1, approved none, implementation allowed no — correct pre-approval state; scope/revision arithmetic consistent.

## Primary-path and fallback verdict

One authoritative semantic path per responsibility. The plan repairs the single owning module (`applyEdits`) at the first divergence, collapses the one-shot copy-sort workaround it supersedes (§12), adds zero alternate success paths (§11: net 0), and explicitly rejects the two fallback-shaped alternatives (defensive sort inside the private helper — duplicated upstream responsibility; per-edit re-locate apply — second matching semantics violating the same-snapshot invariant). The apply_patch path is correctly classified as an independent already-correct owner, verified by my direct read of `applyChunks`. No fallback, no hidden disabling, no responsibility leak.

## Chinese-comment plan verdict (plan mode)

`E ≈ 5` production lines; required minimum `C = max(1, ceil(5 × 0.15)) = 1`; the plan commits 3 qualifying comment sites at the decision points (sort-invariant rationale, INV-12 list entry, `applyReplacements` ascending-precondition) plus per-slice Chinese intent comments in tests. Meets the 15 percent implementation target with margin; comments are placed at the decisions they explain, not bulked elsewhere.

## Release verdict

**APPROVE** — plan revision R1 only. No blocking findings; every hard gate (root-cause repair at the owner, single primary path, evidence-backed non-goals, forward/reverse traceability, red-capable TDD slices, concrete verification commands with correct working directories, budget compliance, comment plan) passes on independently reproduced evidence. The approval applies to this exact revision; any substantive change requires a new full-scope audit.

</details>

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/opencode/src/tool/edit-apply.ts`：+10/−6。副本排序改原位排序（重叠检查与两个 apply 分支共用同一数组），INV-12 与 applyReplacements 前置条件注释补齐。
- `packages/opencode/test/tool/edit.test.ts`：+97/−0。"multi-edit and normalized match" 内新增 4 个 it.instance 切片。

### Red-Green Test Evidence

Red（修复前，逐个捕获）：

- slice 1 `applies out-of-order edits by match position`：fail，实际输出含拼接 `B = def target():\n    return 1ss `（与计划第 8 节 RED 逐字节一致）。
- slice 2 `applies interleaved replaceAll ranges by global position`：fail，实际输出含拼接 `linMID REPLACED WITH LONGER TEXTGET`。
- slice 3 `submission order does not change multi-edit result`：fail，降序份输出 `two REPLACED LOmid R\nmid TARGETfive REPLACED MUCH LONGERe HEAD`，与升序份不等。

Green（修复后）：`bun test test/tool/edit.test.ts -t "multi-edit and normalized match"` → 16 pass / 0 fail（含 4 新切片；slice 4 为恒绿锁定）。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts test/patch/patch.test.ts test/tool/apply_patch.test.ts` | packages/opencode | 197 pass / 0 fail / 4336 expect |
| `bun typecheck` | packages/opencode | exit 0（tsgo --noEmit 无输出） |
| `bun test test/tool/file-mutation-concurrency.test.ts` | packages/opencode | 10 pass / 0 fail |
| `bun test test/session/prompt.test.ts` | packages/opencode | 110 tests：19 fail / 14 skip / 76 pass——均为 ~5000ms fixture 超时（Session 循环/快照/压缩基础设施类，如 "static loop returns assistant text through local provider" 超时报 "timed out after 5000ms"），非断言失败。既有性证据：该套件仅两处 edits 数组（行 5533/5708）均为单元素 identical no-op，本 diff 对其行为恒等（单元素数组排序为恒等变换）；19 个失败项均不触及 edit 工具。属本机环境性既有红测，非本次引入 |

### Original Feedback-Loop Result

计划第 8 节红色回路命令复能：输出 `"A = 111 \nB = 2\ndef target():\n    return 1 \nC = 3\n"`，与手算期望逐字节一致（GREEN）。

### Actual Secondary and Replacement Path Inventory

与计划第 11 节一致，无新增替代成功路径：exact/preserve 两分支为 primary-contract branch；closestWindow 为 diagnostic；apply_patch 为独立正确 owner（未改）；identical 跳写为既有分支（未改）。被取代 workaround（副本排序）已删除。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 88 | 生产 4（排序行+3 标识符行，排除 6 行注释）；测试 84（排除 9 行注释与空行） |
| Qualifying Chinese comment lines `C` | 15 | 生产 6（排序不变量 4 + INV-12 1 + 前置条件 1）+ 测试意图 9 |
| Ratio `C / E` | 0.17 | ≥ 0.15 |
| Required minimum `C` | 14 | `max(1, ceil(88 × 0.15))` |

### Remaining Unverified Items

- `F:\include\CLI\opencode.exe` 重建（运维后续，非代码面；见第 20 节）。
- prompt.test.ts 的 19 项环境超时红测归属本机 fixture 问题，未在本任务内修复（超出用户范围：与 edit 排序无因果，修复面属 Session 循环 fixture）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | 3（§10 "4 处标识符"实为 3 处的算术口径备注；prompt.test.ts 19 项环境超时经独立验证与本 diff 因果无关；exe 重建为已披露运维后续） | No blocking findings — APPROVE | ses_fb32137f9ffeB9DF2eilLgYrT7 |

<details><summary>Verbatim independent implementation audit verdict (Round 1, plan revision R1)</summary>

# 实施审计 — `docs/plans/edit-apply-ordering-root-repair.md` (已批准 R1) + 工作树差异 (Working-tree Diff)

**审计范围**：原始需求（逐字，两个不变量陈述），计划 R1（当前头部：Revision R1 / Approved R1 / implementation-audit-required），完整差异 `packages/opencode/src/tool/edit-apply.ts` (+10/−6) 和 `packages/opencode/test/tool/edit.test.ts` (+97/−0)，以及所有消费者链（`edit.ts:275` 是 `applyEdits` 的唯一生产消费者；jsonc-parser 的 `applyEdits` 命中与其无关；`allRanges` 是函数局部变量）。

## 阻塞性发现 (Blocking findings)

```text
无阻塞性发现。
```

## 非阻塞性发现 (Non-blocking findings)

1. **计划 §10 与差异之间的算术记录差异。** §10 预测有“4 处标识符随动”，但重叠循环中重命名的标识符是 3 个（`sorted.length` → `allRanges.length`，`sorted[i-1]` → `allRanges[i-1]`，`sorted[i]` → `allRanges[i]`）。语义上完全一致；在用户的上限（1 个生产文件，总计 107 行差异，生产代码 +10/−6）下，任何解释都不会导致预算超标。
2. **§23 的 prompt.test.ts 环境红点（19 个超时）与本次差异在因果上无关，已验证而非默认信任。** 会话测试中仅有的两个 `edits:` 数组（prompt.test.ts:5533, 5708）是单元素相同无操作（no-ops）；file-mutation-concurrency.test.ts:241/252/557 和 parameters.test.ts 同样是单元素或仅模式（schema-only）。一个 ≤1 个范围的数组使得排序成为一个恒等变换，因此差异在这些套件中在行为上是不产生任何影响（inert）的。我将 file-mutation-concurrency 本身作为直接证据运行：10 通过 / 0 失败。这些超时是预先存在的本地夹具（fixture）基础设施故障，已正确披露为未解决的范围外后续事项。
3. **`F:\include\CLI\opencode.exe` 重建**仍然是计划 §20/§23 中记录的运维后续事项；交付的源修复是正确的，二进制文件过期已如实记录。

## 拒绝的投机性主张 (Rejected speculation)

- **“排序突变 `allRanges` 可能会干扰 `syncEdits`/provenance/错误文本。”** 已拒绝：`syncEdits` 和 `normalizedMismatchIndices` 在第 437-506 行的每个编辑循环中、在第 512 行排序之前，以提交顺序构建；`editIndex` 字段仅用于提供重叠错误文本，且旧代码已经从排序后的副本中报告了成对文本 —— 诊断结果未改变。排序后 `allRanges` 的唯一消费者是重叠门（overlap gate）和两个应用调用。
- **“`applyReplacements` 中的防御性排序仍然是必要的。”** 已拒绝：它拥有的契约现在已在调用处（第 122 行前提条件注释）和所有调用点（排序后的 `allRanges`；保留分支在编辑-apply.ts:147 处的组内部排序）中建立。添加它将重复上游保证，这正是计划 §20 所拒绝的。
- **“相同的 `matchIndex` 关系依赖于排序稳定性。”** 已拒绝：两个具有相同锚点的范围必然在拒绝门（rejection gate）处重叠（空针已被拒绝，因此每个 `matchLength ≥ 1`）；`replaceAll` 扩展在构造上是严格递增的。`Array.prototype.sort` 的稳定性在这里是不可达的。
- **“保留分支的复制排序（第 147 行）本身违反了‘原位’机制。”** 已拒绝（在计划第 1 轮中已被拒绝，现重新验证）：它是一个具有自己已记录契约的导出函数，不能假设输入已排序；其在预先排序输入上的幂等性没有可到达的缺陷。

## 需求与可追溯性覆盖率 (Requirement and traceability coverage)

独立于存储库证据进行验证，而非根据 §23 的声明：

- **排序机制（原位排序，在应用前对编辑段进行排序）：** 差异完全按照计划 §10 的规定，在重叠门处就地实现了 `allRanges.sort((a,b) => a.matchIndex - b.matchIndex)`（编辑-apply.ts:508-521）；两个应用分支（第 525-527 行）现在都使用该排序后的数组。Apply_patch 被验证为已正确的独立所有者（我阅读了补丁/index.ts:408-426：就地排序 → 重叠检查 → 反向应用；文件未改动）——不修改它的决定是基于证据的。
- **顺序/原子性漂移调查（根因）：** 我自己复现了 HEAD（修复前）模块的红点（RED），通过 `git show HEAD:` 提取到 `D:\Temp\opencode`：输出 `"A = 111 \nB = def target():\n    return 1ss \nC = 3\n"` —— 与计划 §8 记录的中间行拼接完全一致。固定模块产生手工计算的 GREEN。**超出计划的要求**：我直接对用户的补充不变量进行了模糊测试 —— 5 个编辑的 120 个排列（包括一个扩展范围与其它编辑交错的 `replaceAll`，加长和缩短替换）全部产生字节相同的输出；0 个顺序依赖的结果。INV-01 成立。
- **预算（≤4 个生产文件，≤800 行）：** 1 个生产文件，+10/−6 生产代码，总计 107 次插入 + 6 次删除。✓
- **缩进语义检查：** INV-05 保持为“无差异，锁定测试” —— 由套件中通过的 slice 4（中间行前缀字节保真、字面量去缩进、归一化分支字面量重新缩进）确认；测试文件总共 87 个通过 / 0 失败。
- **无新增红测试：** edit.test.ts 87 通过 / 0 失败 / 4072 expect；patch.test.ts + apply_patch.test.ts 110 通过 / 0 失败 / 264 expect（= §23 的 197/4336，精确）；file-mutation-concurrency 10 通过 / 0 失败；`bun typecheck` 退出状态 0。测试文件差异纯粹是增加性的（+97/−0）；没有削弱任何内容。
- **差异 ↔ 计划映射：** 生产块 = §10 的精确编辑清单；四个新测试 = §16 slice 1-4 逐字（相同的夹具，相同的期望字面量，通过 `it.instance` + `run`/`put`/`load` 的约定接缝，期望值是独立于实现的手写字面量；slice 3 同时断言跨顺序相等和明确的期望字符串，因此不可能是循环的）。实现决策仅存在于聊天记录之外。TDD 红点能力已独立确认（见上文 HEAD 复现）。

## 主路径和回退判定 (Primary-path and fallback verdict)

单一权威语义路径。此修复将一次性复制排序的解决方法（`[...allRanges].sort(...)`，已删除）替换为所有三个消费者（重叠检查、精确应用、保留应用）共享的一个就地排序 —— 镜像了 pi 引用和 `applyChunks` 已建立的模式。没有添加新的分支、回退、替代成功路径或责任泄漏；排序位于唯一拥有“所有范围 + 应用方向假设”的模块中，且 `applyReplacements` 的升序前提条件已作为注释契约记录，而不是进行防御性复制。保留了分支的内部排序作为其自己的导出契约。失败路径（定位、唯一性、重叠、无操作门）保持原子性：都在任何写入之前抛出异常。

## 代码质量和中文注释判定 (Code quality and Chinese-comment verdict)

风格合规：没有 `any`，没有引入新的解构/else 模式，测试遵循 `it.instance`/`Effect.gen` 约定，注释位于其解释的决策处。根据实际差异重新计算了 E/C（独立于 §23 的算术，该算术结果是一致的）：

- **E = 88** — 生产环境 4（排序行 + 3 个标识符重命名的循环行；排除了 6 行添加/修改的注释），测试 84（97 添加 − 9 行注释 − 4 空行）。
- **C = 15** — 生产环境 6（4 行排序不变量基本原理 + INV-12 清单项 + `applyReplacements` 前提条件），测试 9（行为 slice 意图注释）。全部合格：它们解释了不变量、前提条件、根本原因和测试意图；没有重述标识符或控制流。
- **比例 C/E = 15/88 ≈ 0.170** — 超过了 0.10 的阻断下限和 0.15 的实施目标（所需最小值 `max(1, ceil(88×0.15)) = 14 ≤ 15`）。仅生产环境：6/4 = 1.5。没有 E/C 阻断点。

## 发布判定 (Release verdict)

**批准** — 仅针对此确切差异，对照已批准的计划修订版 R1。每项硬性门控在独立重现的证据上均通过：在第一分歧的所有者处进行根本原因修复，验证了顺序不变性（120/120 排列相同），行为锁定测试在约定接缝处观察到修复，所有接触到的套件均为绿色（green），类型检查（typecheck）干净，预算得到尊重，取代的解决方法已删除，注释门控满足。计划 §24 的第一轮实施记录可以按原样填写此裁定；剩余的 prompt.test.ts 环境超时和 exe 重建是记录在案的非代码后续事项，不影响本次发布。

</details>

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

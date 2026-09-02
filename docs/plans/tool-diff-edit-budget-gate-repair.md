# Canonical Implementation Plan: 工具 diff 门控按真实成本重定向 + 标记格式合法化

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户 2026-09-03 会话（§1 含控制性原文逐字引用）
>
> Implementation allowed: yes
>
> Last updated: 2026-09-03

本文件是本任务的唯一实施规范。聊天摘要、历史修订与 builder 理论都不是实施依据。

## 1. Verbatim Requirement

控制性需求原文（GOAL 原文，逐字）：

"当前需要优化整体，本应该合法的 DIFF由于修改的行数跨越的间隔比较大，而导致直接认为非法的问题。整体而言，修改的文件数，生产文件数不超过四个文件，整体生产代码修改行数不超过四百行，保持整体简洁优秀的实现，避免增加额外多的冗余逻辑，或者说又修改 schema，或者修改相应的数据库储存格式等等内容，避免降低兼容性，同时使得整体的设计思想符合整体仓库的一个设置。不要引入其他额外的不合适的视觉标记等等内容，保持简洁。我要的就是最终我们的，比如修改跨越了两千行的两段内容，正常地渲染相应的 DIFF并展示。同时过长的，比如二进制或过长文件的过大文件删除，应当做相应的文控处理。最终应当对相关范围进行完整检查避免出现任何红测"

同会话设计约束原话（逐字）：
用户在看到 Edit 卡片把一次真实 `+21/-1`（2 处小改、相距 ~1100 行）的编辑渲染成
`whole-file rewrite` 标记 + TUI 红色 `Error parsing diff` 之后，要求：

1. 结合数据库完整内容给出设计思想与完整修改方案。
2. 不接受"限制编辑量"式方案：真实大改（如删文件）是合法输入，标记只是渲染表示的降级优化，语义不得受限。
3. 按"中段基本没有成本"的真实成本模型进行优化：小改大文件必须得到真实行级 diff。
4. 不做 TUI 侧标记特判/消红字之类的补丁：把生成端逻辑理顺，消费者零特判。
5. 整体改动要简单，逻辑更顺，不要叠床架屋。

## 2. Explicit Non-Goals

- 不改 edit/write/apply_patch 的工具语义与文件落盘行为（表示层修复）。
- 不在 TUI / 权限预览 / 摄入端新增任何标记格式特判（生产者输出合法化后自然消失）。
- 不动 `MAX_MERGED_PATCH_CHARS`（1 MiB 摘要摄入界）与 SummaryCache 归并规则。
- 不追改已入库历史行（legacy 巨 metadata 仍由既有摄入界免疫）。
- 不改 snapshot/vcs/file 的 git 系 diff 数据源（独立数据源，语义不合并）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/plans/tool-diff-bounding-performance-repair.md`（已批准并实施） | 前置设计：三分表示（binary/超限/正常）+ 64KiB 中段界 + 计数单一权威。本计划修订其门B 判据与标记格式，其余承诺全部继承 |
| `packages/opencode/AGENTS.md` | 测试从包目录运行；Effect/module 约定 |
| `CONTEXT.md` | Snapshot 与工具 diff 是两套数据源；Revert 走 git patch，不受本 seam 影响 |
| `AGENTS.md`（根） | 默认分支 dev；bun 工作流 |
| jsdiff 版本现状 | 服务端 `node_modules/diff@8.0.2`（工具生成 seam）；TUI 侧 `thirdparty/opentui/node_modules/diff@9.0.0`（Diff renderable 的 parsePatch） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/file-diff.ts`（全文 116 行） | 唯一 diff 生成 seam；门B `oldMid+newMid chars > 64KiB` 在 Myers 之前跳过；标记正文行无前缀 | observed |
| `node_modules/diff/libesm/diff/base.js:34-137`（diff@8 源码） | `options.maxEditLength` 原生支持：同步路径 `while (editLength <= maxEditLength ...)`，预算耗尽**无 return → undefined**；对角剪枝（:47-64）使"小 D 大文件"为快路径；`options.timeout` 亦存在但非确定 | observed |
| `node_modules/diff/libesm/diff/line.js:36-38` | `diffLines(old, new, options)` 直通 base.diff，选项透传 | observed |
| `thirdparty/opentui/node_modules/diff/libesm/patch/parse.js:37,444,478`（diff@9） | hunk 头识别 `^@@\s`；正文行必须以 空格/`+`/`-`/`\` 开头，否则 `throw 'Hunk at line N contained invalid line <line>'`——与用户所见红字逐字吻合（N=5、line=`old: 1093 mid lines...`） | observed |
| `thirdparty/opentui/packages/core/src/renderables/Diff.ts:153-175,310-365` | TUI Diff renderable：parsePatch 抛错 → `buildErrorView` = 红字横幅 + 原文降级渲染——即用户看到的画面 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:929-977` | Edit 卡片把 `metadata.diff` 无差别喂 `<diff>` renderable（split/unified） | observed |
| `packages/opencode/src/session/summary-cache.ts:87-129,161-201` | 摄入端：显式 additions/deletions 优先，`countPatchStats(diff)` 文本重扫只服务已入库遗留行（遗留行早于标记存在，永不包含标记）→ 标记格式变化对计数零影响 | observed |
| `packages/opencode/src/session/prompt.ts:254-331` | 压缩/摘要 prompt 消费 `metadata.diff`/`filediff`：标记保持紧凑即满足；小改得到真实小 diff 同样紧凑 | observed |
| `packages/opencode/src/tool/edit.ts:296-306,365-384` | ask metadata `{filepath, diff}`（权限预览）与成功后 `renderFileDiff` → `filediff{patch,additions,deletions}` 双出口共用同一 seam | observed |
| `packages/opencode/test/tool/apply_patch.test.ts:1280-1377` | 现有钉死面：write 大重写（中段 8000 行）与 edit 大中段（中段 2000 行）出标记、计数 = 中段行数字面量、`diff < 64*1024` | observed |
| 用户终端粘贴 + SQLite 查询（`C:/Users/Lenovo/.local/share/opencode/opencode.db`，只读） | 卡片 part `prt_062db5305001x1yKDdI6uvYjp1`：`edits[2]`（203ch/5L→611ch/12L；154ch/3L→897ch/16L），`metadata.diff` 644 字符标记；同会话 16:02:43 的 2 行小改正常出 939 字符 unified diff；全库 edit parts=14524、rewrite 标记=39、binary 标记=8 | observed |
| `git diff --numstat` + HEAD sha256 比对 | 真实变更 `+21/-1`，3 hunk（~91、~1182、~1198 行）；卡片 old sha256 === HEAD 版本哈希 `6a4a0c9e...`（该 edit 是会话首改） | observed |

## 5. Current Behavior

```text
edit/write/apply_patch execute
  -> renderFileDiff(filePath, oldText, newText)        [src/tool/file-diff.ts]
     ├─ 门A binary（前 8192 字符含 U+0000）→ binaryMarker（无 hunk → TUI Diff renderable 静默渲染为空）
     ├─ 门B：trimCommonLines 裁公共前后缀后
     │    oldMid+newMid join chars > 64 KiB → rewriteMarker，未跑任何 diff
     └─ 否则 createTwoFilesPatch + countPatchStats
  -> {patch, additions, deletions} 写入 ask/metadata/filediff
  -> TUI Edit 卡片 <diff> renderable：diff@9 parsePatch 严格解析
```

症状链（本次事故）：2 处小改相距 ~1100 行 → 公共前后缀仅 549 行 → 中段含 ~1085 行
未变更行，chars ≈ 134K > 64KiB → 门B 误判"超限"→ 标记正文行（`old:`/`new:`）无
`+`/`-`/空格前缀 → parse.js:478 抛错 → 红字 + 原文降级渲染；计数同时失真
（additions=1113 / deletions=1093，真实 +21/-1）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 小改大文件（首末变更跨度 > 32KiB chars，D ≤ 预算） | edit/write/apply_patch 对任意大小文本 | 归一化行尾文本 | 本次事故（DB part 已证） | file-diff.ts | observed |
| 真实大重写/删文件（D > 预算） | 同上 | 同上 | 事故原文（407MB/139s）、既有测试 fixture（D=4000/16000） | file-diff.ts | observed |
| 巨行小改（D 小但单行 > ~32KiB chars，patch 超 64KiB） | bundle/minified JSON 等 | 同上 | 门B 现口径同样标记（span>64KiB） | file-diff.ts | reachable |
| 二进制（含 U+0000） | 既有 | 门A | 既有测试 | file-diff.ts | observed |
| legacy 已入库巨 metadata | DB 历史 | 摄入界 | summary-cache 遗留扫描分支 | summary-cache.ts | observed（不在本任务改动面） |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 元数据 patch 有界（≤ 64 KiB chars） | 407MB 事故；前置计划 INV-01 | apply_patch.test.ts:1301 |
| INV-02 | 预算内可计算、可表示的编辑产出**真实行级 unified diff**，判据是真实计算成本与产物体积，不是输入中段体积猜测 | 本次事故（D=36、真实 patch ~1.5KB 被误标）；用户要求 | 无（本计划新增，红切片） |
| INV-03 | additions/deletions 单一权威且反映真实变更行；标记路径计数 = 中段行数（此时中段≈真实变更） | 前置计划 INV-08；apply_patch.test.ts:1305/1373 | apply_patch.test.ts:1305,1373 |
| INV-04 | 降级标记本身是**合法 unified diff**（任意 parsePatch 消费者可解析，计数重扫 0/0） | TUI 红字事故（parse.js:478 抛错）；file-diff.ts:100 注释"天然不计数"承诺需在新格式下保持 | 无（本计划新增，红切片） |
| INV-05 | 摘要摄入界（1 MiB merged cap）与显式计数优先级不动 | 前置计划 INV-05；summary-cache.ts:87-129 | summary-tool-diff.test.ts |
| INV-06 | diff 生成单一 seam（renderFileDiff）不变，三工具共用 | 前置计划 §9 | apply_patch.test.ts 既有三工具切片 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `file-diff.ts:85` 门B 在跑 Myers 之前以 `(oldMid+newMid) chars > 64KiB` 判定"超限"——该量既不是计算成本（jsdiff@8 对角剪枝下小 D 大文件是快路径，base.js:47-64 注释明示 O(n+d)）也不是产物体积（真实 patch ~1.5KB），是无关代理变量 | `renderFileDiff` 门B | DB part prt_062db5305001：D=36/真实 +21/-1 被标记；28 秒后同文件 D=2 正常出 diff |
| INV-04 | `file-diff.ts:68-76` rewriteMarker 正文行（`old:`/`new:`）不以 空格/`+`/`-`/`\` 开头，`@@ rewrite @@` 无 range 数字（oldStart=NaN 隐患） | `rewriteMarker` | parse.js:478 throw 逐字复现用户红字；binaryMarker 无 hunk → Diff renderable 空渲染 |
| INV-03（症状） | 标记计数 = 中段行数（1113/1093），在误杀场景虚高 | 门B 下游症状，随 INV-02 修复消失 | DB 记录 vs git numstat |

红反馈回路：`bun test test/tool/apply_patch.test.ts`（packages/opencode 目录）新增切片 1
（§16）今日红：构造 1662 行 fixture、两处小改相距 ~1100 行，期望真实 unified diff，
现状产出 `whole-file rewrite` 标记。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| diff 可行性判据（计算预算 + 产物界） | `file-diff.ts` `renderFileDiff` | 同一 `{patch, additions, deletions}` 契约 | 唯一生成 seam；判据即生成成本本身 | TUI/摄入端只消费字符串，不承担表示选择 |
| 标记格式合法性 | `file-diff.ts` 标记构造 | 标记 = 合法 unified diff 最小 hunk | 生产者对自己的输出格式负责 | 消费者特判 = 责任泄漏（用户明确否决） |
| 计数口径 | 不变（renderFileDiff 单一推导；摄入端显式优先） | 同前 | 前置计划 §9 已钉死 | — |

## 10. Single Approved Primary-Path Design

一个权威语义路径：**把门B 的"事前猜测"换成"带预算的真实计算 + 对最终产物的直接
度量"；降级标记合法化为最小 unified hunk。**

```text
renderFileDiff(filePath, oldText, newText)            [纯同步，签名不变]
  ├─ 门A binary 不变 → binaryMarker（格式升级为合法 hunk，见下）
  ├─ 预算探测：changes = diffLines(oldText, newText, { maxEditLength: MAX_DIFF_EDIT_LINES })
  │    changes === undefined（编辑距离超预算：真实大改/删文件）→ rewriteMarker
  ├─ patch = createTwoFilesPatch(filePath, filePath, oldText, newText)   [探测成功 ⇒ 本次
  │    计算必然在预算内完成；输出格式与现状逐字节一致]
  └─ patch.length > MAX_DIFF_PATCH_CHARS（巨行：D 小但产物超界）→ rewriteMarker
       否则 → { patch, ...countPatchStats(patch) }     [正常路径与现状零漂移]
```

**为什么这是理顺而不是加补丁**：成本模型是 O((N+M)+D²) 级（diff@8 带对角剪枝），
计算成本由**编辑距离 D** 驱动、产物体积由 **patch 字符数** 驱动；两个量都无法在跑之前
用输入特征猜准，所以正确姿势是带着预算真跑一次（jsdiff 原生能力，非新造机制），
预算耗尽/产物超界才降级。原 64KiB 数字保留，但语义从"输入中段猜测"（误杀源）换到
"对最终产物的直接度量"（精确量）。

**对用户否决项的澄清**：`maxEditLength` 不是对"能改多少"的限制——编辑在 diff 生成前
已经落盘；它只是渲染/审计表示的计算预算。真实大改（删文件、整体重写）在预算内跑不完
→ 立即得到与今天完全相同的标记表示（用户原话"那只是我们渲染的时候可能有一个优化"），
语义零变化。TUI 零改动、零特判：标记合法化后 `parsePatch` 正常解析，红字自然消失。

标记格式（两个标记同构，正文行加空格前缀成为 context 行，hunk 头带合法 range——
parse.js:478 不再触发，计数重扫保持 0/0）：

```text
Index: <filePath>
===================================================================
--- <filePath>  (whole-file rewrite: line diff skipped, exceeds diff budget)
+++ <filePath>
@@ -1,2 +1,2 @@
 old: <N> mid lines, <M> file chars, sha256 <oldHash>
 new: <K> mid lines, <L> file chars, sha256 <newHash>
```

```text
Index: <filePath>
===================================================================
--- <filePath>
+++ <filePath>
@@ -1,4 +1,4 @@
 Binary file <filePath> changed: <M> -> <L> chars
 old sha256: <oldHash>
 new sha256: <newHash>
 (binary content not diffed)
```

R2 修正（B-01）：binary 标记正文行保留现状的大写 `Binary file <filePath> changed:`
措辞（仅加空格前缀成为 context 行）——`apply_patch.test.ts:1247` 钉死
`toContain("Binary file")`，小写化会确定性击穿该绿测。

常量（顶部中文注释说明成本模型依据）：
`MAX_DIFF_EDIT_LINES = 2000`（计算预算：探测在 D≤2000 内必完成；既有测试 fixture
D=4000/16000 仍走标记，构造兼容；abort 路径工作量 ≈ O((N+M)+K²)，切片 5 以事故
fixture 实测 <1s 钉死）；`MAX_DIFF_PATCH_CHARS = 64 * 1024`（产物界：替换原
`MAX_DIFF_MIDDLE_CHARS` 的对外承诺，对均匀行长文件与旧门界几乎重合，见 §20）。

TUI 渲染效果（R2 依审计 NB-1 校正）：unified 视图只渲染 hunk 正文行
（`buildUnifiedView` 不渲染 `Index:`/`===`/`---`/`+++` 文件头），即带行号 1/2 的
2 行灰色 context 行（binary 为 4 行）；split 视图两侧灰行；无红字、无 NaN
（hunk range 为真实数字）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 正常行级 diff（探测 + createTwoFilesPatch + countPatchStats） | 修订 | primary-contract branch | yes | 主路径 | preserve |
| rewrite 标记（编辑距离超预算） | 修订（判据+格式） | primary-contract branch（表示降级，非成功降级；大重写为 observed 输入） | yes | 1/3 分支 | preserve |
| rewrite 标记（产物超 64KiB） | proposed | primary-contract branch（巨行为 observed-reachable 输入，旧门同判） | yes | 1 分支 | preserve |
| binary 标记 | 修订（格式合法化） | primary-contract branch | yes | 1/3 分支 | preserve |
| summary 摄入界/显式计数优先 | 当前 | 既有兼容（不动） | yes | 0 | preserve |
| diff@8 `timeout` 选项 | 存在 | 非确定墙钟界 | — | 0 | reject（非确定性，无已证需求；记录为非阻塞注记） |
| TUI 侧标记识别/文本渲染 | proposed（用户否决） | 消费者特判 = 责任泄漏 | — | 0 | reject |
| 对编辑量设限（把 maxEditLength 当作编辑约束） | — | 语义越界 | — | 0 | reject |

无 fallback：探测就是主路径计算本身（带预算），不是失败后另起一条成功路径；标记分支
是支持输入域成员的确定性表示分派，与前置计划 §11 同构。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 门B 中段体积预判（trimCommonLines chars > 64KiB 跳过 Myers） | 防二次方 Myers 事故 | 成本模型纠正：真实驱动是编辑距离与产物体积；预算探测 + 产物直测双界取代 | file-diff.ts:84-87 收敛为 marker 计数用途（trimCommonLines 保留，仅服务标记的 N/K 计数） |
| 标记裸正文行 + 无 range 的 `@@ rewrite @@` | 当时假设消费面按纯文本展示（前置计划 §验收残留自认） | 合法 hunk 后任意 unified 消费者零特判 | file-diff.ts:64-80 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-02 小改大文件出真实 diff | 探测通过 + createTwoFilesPatch | file-diff.ts 门B 重写 | 切片 1（红） |
| INV-02 反向：真实大改仍标记 | 探测 abort → rewriteMarker | 同上 | 既有 apply_patch.test.ts:1349（保持绿） |
| INV-02 巨行产物界 | patch.length 直测 → rewriteMarker | 同上 | 切片 3 |
| INV-04 标记可解析 | 标记 = 合法 hunk + context 行（binary 保留大写 `Binary file` 措辞，:1247 钉死子串不变） | file-diff.ts 标记构造 | 切片 2（红：parsePatch 现状抛错）；既有 :1229 binary 切片保持绿 |
| INV-04 计数重扫 0/0 | context 行不以 +/- 开头 | 同上 | 切片 2 断言 countPatchStats(marker)===0/0 |
| INV-01 patch ≤ 64KiB | 产物直测（比旧 ~4×64KiB 更紧） | 同上 | 既有 :1301（保持绿） |
| INV-03 计数真实/中段口径 | 正常路径 countPatchStats 不变；标记路径中段计数不变 | 不动 | 既有 :1305/:1373（保持绿） |
| INV-05/06 | 不动 | 不动 | 既有 summary-tool-diff / 三工具切片 |
| 性能界不回退 | abort 工作量 O((N+M)+K²) | 常量 + 注释 | 切片 5（事故 fixture 实测 <1s） |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| diffLines maxEditLength 探测 | INV-02 | base.js:35-36,131 源码；事故 D=36 被误杀 | 中段体积是无关代理变量，猜测无法区分 D=36 与 D=8000 |
| patch.length 产物直测 | INV-01/02 | 巨行 reachable（minified 一行 500KB：D=1，产物无界） | 编辑距离界不住单行长度 |
| 标记 context 行 + 合法 range | INV-04 | parse.js:37/444/478 源码；用户红字逐字复现 | 裸行必然触发 strict 解析抛错；无 range 有 NaN 隐患 |
| MAX_DIFF_EDIT_LINES=2000 | INV-02+性能界 | 既有 fixture D=4000 需仍标记；事故 8000 行 30s 外推 | — |
| binary 标记同构合法化 | INV-04 | parsePatch 无 hunk → 0 patches → 空渲染（Diff.ts:186 早退） | 同族缺陷，同 seam 一次修齐 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/file-diff.ts` | modify | 门B 重写（探测 + 产物直测）、标记格式合法化、常量更替与中文注释 | ~+45/−20 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | 新增切片 1/2/3/5（红→绿）+ 标记断言扩展 | ~+75 |
| `packages/opencode/test/tool/edit.test.ts` | modify | 切片 4：edit 双出口（ask 与 filediff）同串合法（可选并入 apply_patch.test） | ~+25 |
| `docs/plans/tool-diff-edit-budget-gate-repair.md` | add | 本计划 | — |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 1662 行 fixture（~40ch/行），两处小改分别位于 ~91 与 ~1182 行（镜像事故）：metadata diff 含 `@@ -` hunk、不含 `whole-file rewrite`，计数 = 独立期望字面量（如 +9/-1） | 门B 中段 chars>64KiB 误判 → 标记 | 探测通过出真实 diff | INV-02 主断言 |
| 2 | parsePatch(rewrite 标记) 与 parsePatch(binary 标记) 不抛错、恰 1 hunk、hunk 行数与正文一致（rewrite 2/2，binary 4/4）；countPatchStats(两标记)===0/0 | 裸 `old:` 行触发 parse.js:478；binary 无 hunk | 标记合法 hunk + context 行 | INV-04 |
| 3 | 2 行 × 35KB 巨行文件两行全改：出标记、含 `old: 2 mid lines`、计数 2/2 | 现状也标记（本切片为边界守护，非红）——防新门只看 D 放行巨产物 | patch.length 直测 | INV-01 在新门下的连续性 |
| 4 | edit 工具双出口（ask.metadata.diff 与 metadata.filediff.patch）各自等于 renderFileDiff 对其自身输入的输出且可 parsePatch；不要求两出口字节相等（formatter 可能往 commit 后内容上变更，R5 语义） | 同切片 2 根因 | 生产者单 seam 保证 | INV-06 |
| 5 | 事故 fixture（中段 8000 行重写、640KB 全重写）在预算内完成且 <1s、出标记 | —（性能守护，非红） | abort 路径 O((N+M)+K²) 实测 | 事故不回退 |
| 6 | 既有 :1229/:1288/:1349 三切片保持绿（binary `Binary file` 子串、D=16000/4000 仍标记、计数 = 中段字面量、`diff<64*1024`） | — | K=2000 < 4000 保证；binary 标记保留大写措辞（B-01 修正） | INV-03/04/01 兼容 |

运行目录：`packages/opencode`（根目录有 do-not-run-tests-from-root 守卫）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| E | ~45 | file-diff.ts 门B + 标记 + 常量（测试注释不计入生产 E） |
| C | ≥ 7 | ceil(45×0.15)=7 |

需中文注释钉死：① 成本模型（O((N+M)+D²)、对角剪枝、为何探测即主路径非 fallback）；
② `MAX_DIFF_EDIT_LINES=2000` 依据（fixture 兼容 + 事故外推 + 切片 5 实测）；
③ `MAX_DIFF_PATCH_CHARS` 语义从输入中段换到产物直测的原因（误杀事故 DB 证据指针）；
④ 标记 context 行前缀与合法 range 的消费面依据（parse.js strict 行为）；
⑤ trimCommonLines 职责收缩为标记计数；⑥ 探测成功 ⇒ createTwoFilesPatch 必然同预算
完成的确定性论证；⑦ binary 标记同构化的原因（空渲染缺陷）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/apply_patch.test.ts` | packages/opencode | 切片 1/2/3/5/6 + 既有界不回退 |
| `bun test test/tool/edit.test.ts` | packages/opencode | 切片 4 + edit 既有行为 |
| `bun test test/tool/write.test.ts` | packages/opencode | write 路径继承 |
| `bun test test/session/summary-tool-diff.test.ts` | packages/opencode | 摄入计数/口径不漂移 |
| `bun typecheck` | packages/opencode | 类型安全 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | 本计划文档 |
| Files modified | 3 | 单 seam + 两个测试文件 |
| Files deleted | 0 | — |
| Production lines | ~45（净 +25） | 门B 重写 + 两标记格式 + 常量 |
| Test lines | ~100 | 5 个新切片 + 断言扩展 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

1. **K 取值**：默认 2000（兼容既有 fixture、事故外推 sub-second）。若希望"更多行数的
   真实大改也显示行级 diff"可上调（上限 < 4000，否则切片 6 现有 fixture 语义变化），
   代价是 abort 路径工作量按 K² 增长。
2. **标记视觉形态**：context 行（灰、中性、计数 0/0，本计划默认）vs `+old/-new`
   红绿身份对（更醒目但计数重扫变 1/1，需同步审计摄入断言）。默认不选后者。

### Real Risks

- 均匀行长文件的新旧真实域几乎重合（span≤64KiB ⇔ D≤K 且 patch≤64KiB 对 ~40-80ch
  行长同时成立/不成立）；短行（<16ch）高密度变更文件（生成 CSV 类）真实域较旧界收窄
  至 D≤2000——该形态在本仓库与 DB 39 例标记中未出现（observed 频率 0）。
- 探测 + 渲染双跑：成功路径计算 2×，两者同被 D≤K 界住，毫秒级；abort 路径只跑探测。
- ~~diff@8 与 diff@9 的 parsePatch 行为差异~~（R1 审计已独立消除：两树 hunk 头
  split 正则与 strict 抛错语句逐字一致，`--- <path> (note)` 头两版本均容忍，且
  `{maxEditLength}` 经 `DiffLinesOptionsAbortable` 重载类型检查通过）。

### Non-blocking（speculative，不驱动生产改动）

- jsdiff `timeout` 选项可作为未来墙钟硬界（非确定，当前无已证需求）。
- TUI 对标记的观感优化（图标/着色）属消费者自有 cosmetic，本计划不授权。

## 21. Audit Contract

审计输入：本文件路径、仓库根、`Audit mode: plan`。任何 blocking finding → 修订 +
版本递增 + 重新全范围审计（上限 6 轮）。

## 22. Audit Record

| Round | Verdict | Findings | 处置 |
| --- | --- | --- | --- |
| 1（R1） | BLOCK | B-01：§10 binary 标记新格式小写化 `Binary file`，确定性击穿 `apply_patch.test.ts:1247` 钉死断言，与“避免任何红测”需求及计划自身“既有切片保持绿”声明冲突；NB：unified 视图不渲染文件头（描述校正）、双版本 parsePatch 行为差异已独立验证消除 | R2 修订：binary 正文行保留大写 `Binary file <filePath> changed:` 措辞仅加空格前缀（:1229 切片保持绿，零测试改动）；§10 渲染描述校正；§20 双版本风险标记消除；切片 2/6 同步更新 |
| 2（R2） | APPROVE | "No blocking findings." / "**APPROVE** — canonical plan `docs/plans/tool-diff-edit-budget-gate-repair.md` Revision R2 (plan audit, round 2 of 6). B-01 is resolved exactly at the owning assertion (`apply_patch.test.ts:1247`) with zero test edits required, and the full-scope re-audit of every other region produced no blocking findings. Approval covers only R2 as written; any substantive change requires revision increment and a fresh full-scope audit before implementation." NB（记录性，不触发重审）：①§1 补控制性原文逐字引用；②切片 4 改为“各自等于 renderFileDiff 对其自身输入的输出”，不要求两出口字节相等；③产物界前向瞬时分配属线性有界可接受；④短行真实域收窄已披露为真实风险 | 行政性记录：置 Status: approved / Approved revision: R2 / Implementation allowed: yes；同批落实 NB①② 记录修正（非实质性，不递增版本） |

## 23. Implementation Evidence（R2）

### 变更文件

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `packages/opencode/src/tool/file-diff.ts` | production | 门B 重写（maxEditLength 探测 + 产物直测）、两标记合法化、常量更替（`MAX_DIFF_MIDDLE_CHARS` → `MAX_DIFF_EDIT_LINES` + `MAX_DIFF_PATCH_CHARS`）、中文注释 |
| `packages/opencode/test/tool/apply_patch.test.ts` | test | 新增 describe “tool diff gate budgets by real cost”：切片 1-5（切片 4 依 §15 可选项并入本文件） |
| `docs/plans/tool-diff-edit-budget-gate-repair.md` | docs | 本计划（含审计记录与实施证据） |

### Red-Green 证据

- 红（实施前，`bun test test/tool/apply_patch.test.ts -t "tool diff gate"`，packages/opencode）：
  3 fail / 2 pass——切片 1（含 `whole-file rewrite` 而非真实 diff）、切片 2（diff@8 `parse.js:107` 抛 `Hunk at line 5 contained invalid line old: 2000 mid lines...`，逐字复现用户红字）、切片 4（同一抛错）；切片 3/5 为边界/性能守护，红绿前均绿（harness 修正：`it.live` 需返回 Effect，属测试环境声明的 setup 噪声非行为红）。
- 绿（实施后，同命令）：5 pass / 0 fail。

### 验证命令与结果（均在 packages/opencode）

| 命令 | 结果 |
| --- | --- |
| `bun test test/tool/apply_patch.test.ts` | 66 pass / 0 fail（含既有 :1229 binary / :1288 write / :1349 edit 三切片保持绿，B-01 修正验证） |
| `bun test test/tool/edit.test.ts` | 87 pass / 0 fail |
| `bun test test/tool/write.test.ts` | 25 pass / 0 fail |
| `bun test test/session/summary-tool-diff.test.ts` | 6 pass / 0 fail（摄入计数/口径零漂移） |
| `bun typecheck` | 通过（tsgo --noEmit 无错误） |

### 实际路径面与 workaround 删除

- 主路径：预算探测（diffLines + maxEditLength）→ createTwoFilesPatch（成功路径产物与旧实现逐字节一致）→ 产物直测。无新增 fallback；探测即主计算。
- 删除的 workaround：门B 中段体积预判（`oldMid+newMid chars > 64KiB`）——`trimCommonLines` 职责收缩为标记计数口径；`MAX_DIFF_MIDDLE_CHARS` 常量删除（仓库内无外部 import 者，grep 验证）。
- 表示分支：binary 标记 / rewrite 标记（编辑距离超预算）/ rewrite 标记（产物超界）——均为支持输入域成员的 primary-contract 分支，与 §11 清单一致，决策面无新增。

### 实际 E/C

（依实现审计 NB-4 校正为实现审计方从实际 hunk 重算的口径；原 builder 估算 E_prod≈20/C_prod≈19 偏差属记录质量问题，比率门禁两种口径均通过。）

- E（生产，排除 import-only/注释）：约 17 行（常量 +2，binaryMarker +7，rewriteMarker +4，门控重写 +4）。
- E（测试）：约 110-120 行。
- C（中文注释，邻近修改点）：生产约 23 行（成本模型、K 值依据、产物界语义、标记合法化理由×2、trimCommonLines 职责收缩、探测确定性）；测试约 14 行（切片意图/独立推导依据/兼容承诺）。合计约 37，C/E ≈ 28% ≥ 15% 门禁 ✓，同时满足计划 §17 承诺的 C≥7。
- 用户预算验证：生产文件 1 个（≤4）✓，生产代码 ~17 行（≤400）✓，零 schema/DB/消费端改动 ✓。

### 未验证项

- 无。TUI 实际渲染（diff@9 parsePatch）未单独运行端到端 TUI，但切片 2 已在 diff@8 上验证标记可解析性，且 R1/R2 审计已独立确认两版本解析器同构（regex/throw 逐字一致，见 §20 已消除风险项）。

## 24. Implementation Audit Record

| Round | Verdict | Findings | 处置 |
| --- | --- | --- |
| 1（R2 实现） | APPROVE | "No blocking findings." / "**APPROVE** — implementation audit round 1 of 3 for canonical plan `docs/plans/tool-diff-edit-budget-gate-repair.md` Revision R2. The actual working-tree diff (2 files + the plan) maps hunk-for-hunk to the approved R2 design with no material decision living only in chat, no unauthorized fallback, no weakened assertion, and every §18 verification command independently reproduced green. Approval covers only this exact diff against R2; any substantive change requires a fresh full-scope audit." 审计方独立复跑全部验证：66/0、87/0、25/0、6/0、tsgo clean；NB：①成功路径双跑（同被 D≤2000 界住，质量注记）；②产物界前向瞬时分配（计划轮已接受）；③短行域收窄（已披露风险+用户开放决策）；④§23 E/C 算术偏差（本版已按审计重算口径校正）；拒绝的推测：jsdiff 版本漂移/timeout 硬界/恶意 filePath/TUI 端到端需求 | 行政性记录：置 Status: verified；依 NB④ 校正 §23 E/C 数字（非实质性，不清空 verdict）；invocation ref: task ses_f9cbe88c4ffenT00bXmJTWyCd9 |

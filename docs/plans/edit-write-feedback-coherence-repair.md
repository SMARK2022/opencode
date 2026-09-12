# Canonical Implementation Plan: Edit/Write 工具上下文一致性反馈修复

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户 GOAL 原始需求（2026-09-12，verbatim 见第 1 节）；证据基础 `docs/plans/edit-harness-reliability-investigation.md` R3/R4
>
> Implementation allowed: yes
>
> Last updated: 2026-09-12

本文是本任务唯一 implementation authority。调查台账 R1–R4、聊天摘要与旧审计不是实施授权。

R4 修订触发：实现审计第 2 轮 BLOCK（唯一阻断为合同纪律）——第 1 轮返工把 read.ts 的导出 seam 从批准文本的 collectVisibleReads 改为 visibleReadMeta、并删除 INV-04 的 input.filePath 回退，但计划设计节未同步。审计已核实 as-built 设计健全且原 R3 的回退规则对目录/媒体 read 本身有误计缺陷；R4 只做计划侧对齐（代码不再返工）：§9/§10/§13/§14/§15 记录 as-built seam 与「仅内容可见 read 锚定最后读取」的判定规则及其 legacy/媒体边界理由。

R3 修订触发：实施期间发现修改面内既有红测试 `apply_patch.test.ts:1542`（keeps the abort path sub-second for incident-scale rewrites）在本机改动前基线即失败（实测 2.7s > 1000ms）。用户原始需求含「既有红色也需要去解决」，该失败属于本任务范围，但 R2 未映射。根因实测：jsdiff `diffLines(maxEditLength=2000)` 的中止路径自身是 O(K²) 且每步分配路径对象（真实事故 fixture 纯探测 1280ms），预算门成本模型在慢机器上不成立。修复留在同一 owner（file-diff.ts）内：新增可证明的行多重集对称差下界预过滤，只在探测必然中止时跳过探测，决策语义零变化（见 §8/§10）。

R2 修订触发：R1 方案审计 B-01（blocking）——apply_patch 侧歧义候选必须由判定 owner（`src/patch/match.ts` 的 `locateExact`）产出并随 `ambiguous` 结果携带至抛出点，不得在抛出点用更弱域重扫。R2 同时吸收该轮 8 条非阻断更正（见 §22 审计记录）。

## 1. Verbatim Requirement

> 修复 edit/apply_patch/write 的上下文一致性缺口：①edit.txt/apply_patch.txt 克制新增醒目但不主导的文案——oldString 须以最近 read 为底叠加此后自身编辑返回的 diff，不得凭陈旧 read 转写；不匹配失败时若文件最后被自身写入晚于最后读取，附时效事实并引导使用作用后 diff（不诱导 re-read）。②歧义失败返回最小唯一扩展（候选行号+向上/下扩展建议，复用已枚举候选、受既有诊断预算约束、实现简洁不新增状态机），文案补「more than 3 lines」。③edit 失败且 oldString 不在已读页内时列出融合后的已读区间（复用 mergeRanges）。④write/apply_patch 成功 output 补 post-formatter diff 段（约 14KB/990 行预算，连续前缀裁剪），edit 的 C01 跳行截断一并校正。⑤同名异路径已读文件存在时简短提醒。⑥edit.txt 门禁条目劝导勿用 bash 输出作编辑依据。最终整体文件生产代码修改数不超过12个文件，修改行数不超过1200行。整体需要保证最终全部的修改面不会出现红测试，既有红色也需要去解决。

后续用户补充决策（verbatim 要点）：

> 「write 仅 formatter 改动时回显 delta」（write 全量回显 86% 为新建全文冗余被否证；只在 formatter 实际改变内容时回显差异段，持久化 formattedChanged 标志）。
>
> 「不强制最小上下文行数」；「失败的时候确实要返回一个最大重复段……按照那个高档的实现」；「实现尽量保证检查的速度……不要增加过多的冗余的状态机」。
>
> 「bash 的读取无法记入触痕，它本身这个内容不是很可信」——G06 不做文案分层，收敛为门禁条目劝导。

## 2. Explicit Non-Goals

- 不改变任何匹配成功域：`locateExact` 的候选枚举/唯一性规则、`findMatch`/`applyEdits`/`deriveNewContentsFromChunks` 的成功语义、PI normalization 集合、overlap 拒绝、all-or-nothing 语义全部保持不变。`ambiguous` 结果新增候选载荷只增加诊断信息，不改变何时歧义。
- 不强制最小上下文行数；不在任何失败文案中强制或诱导 re-read（用户明确）。
- 不解析 bash 命令；bash 读取永远不计入 edit 门禁触痕；不做「仅经 bash 见过」的文案分层（用户明确）。
- 不修复 H03（bash `getStableOutput` 空行删除）——正交缺陷，独立任务。
- 不改变 read 工具的 stub/分页/版本指纹行为；G03 只复用其可见性协议（`visibleReadMeta`）与 `mergeRanges`，不新增 read 语义。
- 不改变未读门禁的通过规则（write/edit 触痕仍算数）；不改 `_syncInput`/`_formattedContent` 真值回写契约。
- 不向上游 thirdparty/opencode-11720 移植；commit 仅在 verified 后按 GOAL 合同执行一次，不 push。
- 不新增配置项、feature flag、公共 API、迁移或 generated 文件。
- 不改变 apply_patch 的 `title` 相对今日的行为（今日 `title: output` 是成功行+文件列表+失败/LSP 段的完整串；新增 Changed 段只进 output，title 保持今日全部既有段落）；不改变 edit 成功 output 的 warning 段预算与保留规则。
- INV-05（已读区间）与 INV-09（同名提醒）只落 edit 失败路径；INV-04（时效事实）落 edit 与 apply_patch 失败路径。G05 证据集中在 edit 域，apply_patch 侧不扩展（R1 审计非阻断 4 的明确化）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Tool / Session / Message（MessageV2 part-based） | 反馈文案作用于 Tool 的 ExecuteResult.output；历史扫描基于 Session 的 Message/Part |
| `.opencode/policy/first-principles-engineering.md` | first-divergence 修复、禁止 fallback、双向 traceability |
| `docs/plans/edit-harness-reliability-investigation.md` R3 §11 / R4 §12 | 全部缺口（G01–G06）、桶分布、预算实测与用户逐项决策的唯一证据来源 |
| `packages/opencode/AGENTS.md` + `test/AGENTS.md` | package-local `bun test`/`bun typecheck`；testEffect/tmpdir fixture；不用 sleep 同步 |
| 上游 `thirdparty/opencode-11720` edit/write/apply_patch | 上游 output 均无 diff 段（台账 §12.8）；本任务是 fork 本地增强，无移植冲突 |
| `src/tool/edit-apply.ts` 模块头不变量速查（14 条） | 匹配域/诊断域分离：closest 与扩展提示只能出现在失败诊断，永不进入成功路径 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 台账 R3 §11.1–11.3（窗口 2026-09-05→09-12，2835 调用、465 错误、681 事件） | G01≈36%、G02=29%、G03≈10%、G04=33 事件、G05=45+、G06=39 条的全部量化证据 | observed |
| 台账 R3 §11.5 | CRLF/裸空行/同调用移动/跨 Session 写入者/matcher 吞文本均被否证 | observed |
| 台账 R4 §12.1–12.9 | 用户逐项决策与预算纪律（diff 实测：edit p50=1.5KB、apply_patch p50=2.4KB、write 86% 新建冗余） | contracted |
| `src/tool/edit.ts:120-161`（门禁）、`266-289`（mismatch 错误增强点）、`386-425`（Changed 段与 C01 跳行循环 `:410-419`） | G01/G03/G05 增强落点与 C01 缺陷现场 | observed |
| `src/tool/edit-apply.ts:204-261`（countOccurrences/exactLiteralCount/enumerate*，replaceAll=false 时 enumerate 只给首候选）、`401-538`（applyEdits 主路径 + EditApplyError.editIndex）、`451-462`（歧义抛出点） | edit 侧歧义计数域：usedNormalized 决定 countOccurrences（normalized split）与 exactLiteralCount（literal） | observed |
| `src/patch/index.ts:344-435`（applyChunks）、`376-385`（ambiguous/not-found 抛错）、`456-461`（withCandidate） | patch 侧抛出点持有 originalText、chunk.old_lines、chunk.change_context | observed |
| `src/patch/match.ts:10-13`（ExactResult）、`33-147`（locateExact 多层候选枚举与 ambiguous 三返回点）、`276-283`（诊断预算常量）、`645+`（closestWindow） | B-01 现场：ambiguous 变体无载荷，候选数组被丢弃；owner 必须产出候选 | observed |
| `src/tool/apply_patch.ts:236-303`（逐文件 proposal + hunkErrors）、`305-364`（Mutation.commit + formatter）、`392-462`（output/metadata 组装，`title: output`） | H02 现场；G01 patch 侧落点；title 钉死决策点 | observed |
| `src/tool/write.ts:120-204`（formatter 分支、`_formattedContent`、metadata.diff） | G04 现场 | observed |
| `src/tool/read.ts:187-299`（isReadMetadata/collectVisibleReads/mergeRanges 复用点/isSameFileVersion）、`740-836`（read metadata 发布） | G03 数据源 | observed |
| `src/tool/tool.ts:46-56`（Context.messages） | 历史扫描的合法数据源 | observed |
| `test/tool/edit.test.ts:117+`（ctxWithPriorRead）、`94-108`（itTruncated）、`:1152`（既有歧义前缀断言）、`test/tool/write.test.ts:45-61`（mockFormatLayer）、`test/tool/apply_patch.test.ts:269`（既有歧义断言） | 全部 TDD seam 已存在 | observed |

## 5. Current Behavior

```text
edit 失败路径:
model edits[] -> edit.ts gate(触痕检查) -> applyEdits(baseLF, editsLF)
  -> EditApplyError("Could not find..." / "Found N occurrences...")
  -> edit.ts catch: 仅 mismatch 追加 closestWindow 诊断 -> 错误回模型
edit 成功路径:
commit(+formatter) -> renderFileDiff(contentOld, contentNew) -> output "Changed:" + diff
  -> C01: edit.ts:410-419 预算循环用 continue 跳行，展示非连续前缀却报 "more lines omitted"

apply_patch 失败路径:
patchText -> parsePatch -> 逐文件 processHunkGroup -> deriveNewContentsFromChunks
  -> locateExact ambiguous（候选丢弃）-> "Found multiple matches for expected lines"（无候选行号）
  -> not-found -> withCandidate 附 closest 或 "No reliable nearby candidate"
  -> 全部失败: "apply_patch verification failed: all hunks failed."；部分失败: output 附失败文件
apply_patch 成功路径:
commit(+formatter 在锁内) -> output 仅文件列表+LSP；metadata.diff = formatter 前的 proposal diff（H02）

write 成功路径:
写盘 -> format.file -> 若改变内容则 _formattedContent 回写 input（重放真值）
  -> output 仅 "Wrote file successfully." + LSP；formatter 造成的 delta 对模型不可见（G04）
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| edit/apply_patch 不匹配失败且同文件最后写入晚于最后读取 | 模型工具调用 | ctx.messages 含 completed 工具 part 及 state.time | edit.ts catch / apply_patch 错误组装 | 各 Tool | observed（G01，246 事件） |
| 歧义失败（唯一性拒绝） | locateExact / applyEdits 计数 | 候选在 owner 内已枚举 | edit-apply.ts:455 / match.ts ambiguous 三返回点 | edit-apply / match.ts | observed（G02，199 事件） |
| 不匹配失败且存在同文件已读 read metadata | read 工具发布 metadata.read | visibleReadMeta 可见性协议（含 compacted/stub 过滤） | edit.ts catch（消费 visibleReadMeta） | edit + read（只读复用） | observed（G03，70+ 事件） |
| write 后 formatter 改变内容 | Format.Service.file | write.ts 已计算 formattedContent | write.ts output 组装 | write | observed（G04，33 事件） |
| 同名异路径已读文件存在 | read 工具 input.filePath | ctx.messages | edit.ts catch | edit | observed（G05，45+ 事件） |
| diff 超预算需裁切 | renderFileDiff | truncate.limits() | 三工具 output 组装 | file-diff（新增有界渲染 seam） | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 匹配成功域、唯一性规则、normalization 集合与 all-or-nothing 语义逐字节不变；`ambiguous` 只增诊断载荷 | 台账 §11.5 否证 matcher 缺陷 | edit.test.ts / apply_patch.test.ts 全量既有用例 |
| INV-02 | 失败诊断只陈述事实与可操作信息，不得诱导 re-read（用户明确禁止） | 用户决策 verbatim | 新增断言不新增祈使 re-read 文案 |
| INV-03 | 歧义失败必须给出候选行号与最小唯一扩展建议；候选由唯一性判定 owner 产出（patch 侧 locateExact 携带、edit 侧按抛出点同一计数域枚举）；扩展建议必须经同域唯一性核验后才展示 | G02；R1 审计 B-01 | 新增 |
| INV-04 | edit/apply_patch 不匹配失败且同文件最后写入晚于最后读取时，错误附时效事实并指向作用后 diff | G01；台账 §12.1 | 新增 |
| INV-05 | edit mismatch 且存在同文件已读区间时，错误附 mergeRanges 后的已读区间；只陈述事实 | G03；台账 §12.3 | 新增 |
| INV-06 | write 仅当 formatter 实际改变内容时 output 附差异段（基线：模型提交内容 EOL 归一化后 → 最终落盘内容）；未改变时 output 与现状一致；metadata 持久化 formattedChanged | G04；台账 §12.7-3 | 新增（mockFormatLayer） |
| INV-07 | apply_patch 成功 output 附 post-formatter diff 段（Changed:），metadata.diff 同步为 post-formatter 真值；部分失败报告语义与 title 不变 | H02 + G01 锚点；台账 §12.7-2 | 新增 |
| INV-08 | 三工具 diff 段统一连续前缀裁剪 + 显式省略计数；edit 现有跳行行为消除（C01） | C01；用户「连续前缀裁剪」 | 新增（itTruncated 小预算层） |
| INV-09 | 同名异路径已读文件存在时 edit mismatch 错误附一行提醒 | G05；台账 §12.5 | 新增 |
| INV-10 | edit.txt/apply_patch.txt 各新增克制文案；歧义文案补 more-than-3-lines；G06 劝导并入 edit.txt 门禁条目 | 用户 verbatim | 文案断言（轻量） |
| INV-11 | renderFileDiff 的预算决策在慢机器上亚秒完成；预过滤只在「探测必然中止」时跳过探测，标记/产物决策与现状逐字节一致 | 用户「既有红色也需要去解决」；本机基线红 | 既有红测试即回归（apply_patch.test.ts:1542） |

## 8. First Divergence and Root Cause

本任务主体是反馈质量增强；red 信号 = 各 TDD 切片在实现前失败（断言当前错误/output 不含新信息）。例外：INV-11 是既有红测试修复，red-capable loop 即 `bun test test/tool/apply_patch.test.ts -t "abort path sub-second"`，改动前基线实测 2.7s（失败），修复目标 <1000ms。

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-04 | 失败错误只说「找不到」，第一个丢失的事实是「你自己的写入晚于你的读取」 | edit.ts catch / apply_patch.ts 错误组装 | 台账 G01（132 source-then-overwritten + 114 not-visible-with-writers） |
| INV-03 | 歧义候选已枚举但在两处被丢弃：locateExact 的 ambiguous 无载荷（patch 侧）、edit-apply 抛出点只有计数（edit 侧） | match.ts `ExactResult` / edit-apply.ts:455 | R1 审计 B-01；G02 分布：0-行上下文 82、1 行 48 |
| INV-05 | read 已读区间 metadata 已发布，edit 失败时从未被用于对照 | edit.ts catch | G03：70/101 带分页标记 |
| INV-06 | write 已算出 formattedContent 并回写 input，output 组装点只写成功句 | write.ts output 组装 | G04：33 事件 |
| INV-07 | diff 在 proposal 阶段生成，formatter 在 commit 锁内改写后无人重算 | apply_patch.ts renderFileDiff 时机（H02） | 台账 §4 H02 |
| INV-08 | edit.ts:410-419 `continue` 使超预算行被跳过而后行仍进入 | edit.ts Changed 段循环 | C01 实现证据 |
| INV-11 | jsdiff `maxEditLength` 探测的中止成本是 O(K²)+路径分配（K=2000 时实测 1280ms），慢机器上越过测试的 1000ms 断言 | file-diff.ts renderFileDiff 的预算探测 seam | 本机基线实测（改前即红）；node_modules/diff/dist/diff.js:124-143 同步中止循环 |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 时效/已读/同名的判定数据 | `Tool.Context.messages`（既有） | 工具可见历史 | 只读消费，不新增生产者 | processor 不回传分析结果给工具 |
| 时效/已读/同名文案组装 | edit.ts catch 块 / apply_patch.ts 错误组装 | 失败错误的最终文本 owner | 错误文本在此诞生，文件身份在此已知 | edit-apply/patch 是纯函数匹配域，不持有 messages |
| patch 侧歧义候选 | match.ts：`locateExact` 的 `ambiguous` 结果携带候选行号（去重、排序、封顶 8） | 唯一性判定 owner 产出候选（B-01） | 多层候选域（exact whole-line/normalized whole-line/literal substring/normalized substring/unsafeNormalized）只有 owner 知道 | 抛出点重扫＝第二 matcher 或更弱域，均被禁止 |
| edit 侧歧义候选 | edit-apply.ts：在抛出点按同一计数域（usedNormalized ? countOccurrences 域 : exactLiteralCount 域）枚举全部命中偏移 | 抛出点的计数域即唯一性域 | 计数与候选同源，无域分歧 | — |
| 最小唯一扩展计算 | edit-apply.ts 新增私有域 helper（行域公共前缀/后缀 + 同域唯一性核验回调）；patch/index.ts 复用导入并注入 locateExact 核验 | 失败诊断增强，仅歧义路径调用 | 扩展的正确性依赖唯一性域，核验回调由各 owner 注入保证同域；helper 本身只做行级公共上下文计算 | match.ts 已 import edit-apply（normalizeForMatch），反向成环 |
| 有界 diff 段渲染（连续前缀+省略计数） | file-diff.ts 新增 `boundDiff` | diff 生产与有界展示同一 owner | 三工具共用，消除 edit 内联跳行循环（C01） | truncate.ts 是通用字节截断，不懂 diff 结构 |
| post-formatter diff 真值 | apply_patch.ts commit 段 | commit 锁内拥有最终内容 | formatter 结果只在锁内可见 | file-diff 只负责渲染 |
| formattedChanged 持久化 | write.ts metadata | metadata 是工具事实出口 | 与 _formattedContent 同一判定来源 | processor 只 strip/回写 |
| 已读区间数据复用 | read.ts 导出 `visibleReadMeta`（可见性协议的唯一 part 级判定）与 `canonicalReadPath`；collectVisibleReads/isReadMetadata 保持私有 | read metadata 的消费者协议 | 版本键与 metadata 结构由 read.ts 定义；compacted/stub 过滤只能在 owner 内唯一表达 | edit.ts 重新解析 XML 或复制过滤条件会让两侧对同一历史给出不同答案（实现审计 B-01 实证） |
| 预算探测的廉价下界预过滤 | file-diff.ts（renderFileDiff 内联） | 预算门决策的同一 owner | 只在「必然中止」时跳过探测，决策不变 | jsdiff 的 maxEditLength 中止路径自身昂贵，无法在其内部加速 |

## 10. Single Approved Primary-Path Design

一条主路径：**在失败文本诞生点与成功 output 组装点附加事实段**；匹配/成功域零改动。（R1 审计非阻断 1：这些增强是本次合同的 primary-path 行为本身——失败文案与成功 output 正是被修复对象——不是附属诊断；无 alternate success path。）

```text
失败增强（edit，edit.ts catch）:
applyEdits throw -> closestWindow（既有）
  -> [INV-04] 扫 ctx.messages（completed 工具 part；文件身份提取规则：
       read → 仅 visibleReadMeta 通过者（metadata.read.canonicalPath）；
       edit/write → input.filePath；apply_patch → metadata.files[].filePath）：
       同文件最后 completed 写入 > 最后 completed read
       -> 有先读："This file was modified by your own <tool> after your last read.
          Use the result of that call (its returned diff or formatted-changes section)
          as the current content."（工具感知措辞：write 未格式化时无 diff 段，
          真值是该次 write 的提交内容本身；edit/apply_patch 有 Changed 段。
          实际落盘文案以代码与测试钉死文本为准："Use the result returned by that call
          (its diff or formatted-changes section) as the current content."）
       -> 无先读（apply_patch 可达，无门禁）："This file was last modified by your own
          <tool> in this session and has not been read since."
  -> [INV-05] visibleReadMeta 逐 part 判定（同 canonicalPath、不按版本过滤——
       陈旧版本的已读区间仍有导航价值，且当前 edit 侧没有可构造的当前版本 ReadMetadata）
       -> mergeRanges -> 附 "Lines you have read in this file: 120-260, 400-512."
       （无已读则整句省略）
  -> [INV-09] 同 basename 异 canonicalPath 的已读文件存在
       -> 附一行 "You previously read a different file with the same name: <path>."

失败增强（apply_patch）：全失败错误与部分失败 output 的逐文件错误行，共用 INV-04 的
同一判定与文案；INV-05/INV-09 不适用（见 Non-Goals）。

歧义增强（INV-03）：
  edit（edit-apply.ts:455 抛出点前）:
    -> 按抛出点计数域枚举全部命中偏移 -> 行号（去重排序封顶 8）
    -> uniqueExtensionHint：行域内计算每个候选与其余候选的向上/向下公共上下文长度，
       得出逐候选最小去歧扩展；取全局最便宜者
    -> 核验：扩展后模式在抛出点同一计数函数（countOccurrences 或 exactLiteralCount）
       下唯一，才写入建议；否则只给候选行号
  patch（patch/index.ts:377 抛出点）:
    -> locateExact ambiguous 结果携带候选行号（owner 产出，封顶 8）
    -> uniqueExtensionHint 注入核验回调：扩展后 expected 块以同一 cursorOffset 过
       locateExact 唯一（owner 域，含 normalized/substring 层）
    -> 文案（两侧一致）："Matches at lines 121, 487. Including 2 more line(s) above
       (or 3 below) makes the match unique."
  预算：候选 ≤8、每方向扩展 ≤10 行、行域两两比较 O(candidates²×cap)；核验为同域
  单次计数/定位调用。这是用户「保证检查速度」决策下的固定 caps 收紧，有意不共享
  match.ts 的 4s/64MiB 诊断预算（更严、更简单；R1 审计非阻断 8 记录为有意偏离）。

成功 output 增强:
  write（INV-06）: formattedContent 存在 ->
    "Formatted changes:" + boundDiff(diff(normalize(提交内容) -> normalize(最终落盘)))
    + metadata.formattedChanged=true；formatter 未改变内容时 output 逐字节同现状
  apply_patch（INV-07）: commit 锁内已知最终内容（formatter 结果的 restore 计算点）
    -> 逐文件以最终内容重算 diff（未 formatter 的文件沿用 proposal diff）
    -> output 附 "Changed:" + boundDiff(汇总 diff)；metadata.diff = post-formatter 真值
    -> title 保持文件列表摘要不变；permission 预览 diff 保持 formatter 前（审批语义）
  edit（INV-08）: Changed: 段改经 boundDiff（C01 消除）
  boundDiff（INV-08）: 连续前缀 + "… (N more lines omitted)"；超硬顶（truncate.limits
    同量级）时完整 diff 经 Truncate.Service.write 落工件文件并附路径

预算探测预过滤（INV-11，file-diff.ts renderFileDiff 内联、探测之前）:
  行多重集对称差 |old\\new| + |new\\old| 是编辑距离 D 的下界（每次删除/插入各覆盖一侧，
  任何编辑脚本都受其约束；分词差异只让下界更松，不会更紧——strip 行尾后一致性更粗
  只会减少所需编辑数）。对称差 > K=MAX_DIFF_EDIT_LINES 时 jsdiff 探测必然中止，
  直接走 rewriteMarker，跳过 O(K²) 探测。成本 O(N) 哈希计数。对称差 ≤ K 时路径
  与现状完全一致（进入原探测）。证明与边界（split 分词 vs jsdiff 行分词、尾换行
  空 token 丢弃）在代码注释中给出。
```

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| closestWindow 诊断 | current | diagnostic | no | 既有 | preserve（不改） |
| 失败文案事实段（INV-03/04/05/09） | proposed | primary-contract repair（失败文本是被修复对象本身；不产生 success 等价物、不隐藏失败） | no | 变更主体之一 | 新增 |
| boundDiff / 成功 output diff 段（INV-06/07/08） | proposed | primary-contract branch（成功 output 的既有/新增信息段；不改变成功/失败分类） | no（同一成功结果） | 变更主体之一 | 新增 |
| match.ts ambiguous 载荷 | proposed | primary-contract 诊断数据传递（owner 产出，候选集合不变） | no | locateExact 返回类型扩展 | 新增 |
| 对称差下界预过滤（INV-11） | proposed | primary-contract 快速路径（只在探测必然中止时跳过探测，决策等价） | no | renderFileDiff 内联分支 | 新增 |

无新 alternate success path；无 fallback；无 catch-and-success。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| edit.ts Changed 段内联跳行循环（C01） | 逐行塞预算的局部实现 | boundDiff 统一连续前缀语义 | edit.ts:408-425 循环替换为 boundDiff 调用 |

无其他被取代的 workaround；`_syncInput`/`_formattedContent` 回写保留（重放真值职责不同）。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| ①文案（陈旧转写禁令） | 工具 description | edit.txt / apply_patch.txt 各 1 条 | description 含关键短语的轻量断言 |
| INV-04 时效事实 | edit.ts catch / apply_patch.ts 错误组装 | edit.ts、apply_patch.ts | edit.test.ts：read→edit 成功后旧 oldString 失败→含时效句；apply_patch.test.ts 同构（含无先读措辞分支） |
| INV-03 最小唯一扩展 | owner 候选产出 + uniqueExtensionHint | edit-apply.ts、match.ts、patch/index.ts | edit.test.ts 重复块歧义→含行号+扩展建议；apply_patch.test.ts 同构（含 normalized 域候选场景） |
| ②文案 more-than-3-lines | apply_patch.txt 第 35 行 / edit.txt 歧义条 | 两个 txt | 轻量断言 |
| INV-05 已读区间 | edit.ts catch + visibleReadMeta/mergeRanges | edit.ts、read.ts（导出） | edit.test.ts：分页 read metadata 后失败→含区间列表；compacted read 不计入 |
| INV-06 write 差异段 | write.ts output + metadata flag | write.ts | write.test.ts：mockFormatLayer→含 Formatted changes；默认层→无且 output 同现状 |
| INV-07 patch diff 段 | apply_patch.ts commit 后重算 + output | apply_patch.ts | apply_patch.test.ts：Changed: 存在；formatter 改动后 diff 反映最终内容；metadata.diff 一致；title 不变 |
| INV-08 连续前缀 | boundDiff + edit Changed 段接入 | file-diff.ts、edit.ts | edit.test.ts（itTruncated）：输出是真实 diff 前缀且省略计数正确 |
| INV-11 预过滤 | renderFileDiff 探测前下界检查 | file-diff.ts | 既有红测试转绿（apply_patch.test.ts:1542）；既有 diff 门控套件（同文件 §1408 describe）全绿证明决策不变 |
| INV-09 同名提醒 | edit.ts catch | edit.ts | edit.test.ts：读 original/x.patch 后改 current/x.patch 失败→含提醒 |
| ⑥门禁劝导文案 | edit.txt 门禁条目 | edit.txt | 轻量断言 |
| INV-01 既有行为不变 | 无改动 | — | 既有 edit/apply_patch/write/read 测试全绿 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| match.ts ambiguous 候选载荷 | INV-03 | R1 审计 B-01：owner 外的重扫要么第二 matcher 要么域更弱 | ExactResult.ambiguous 现无载荷，候选数组被丢弃 |
| edit 侧同域候选枚举（抛出点） | INV-03 | G02 | 现有点只有计数；enumerate* 在 replaceAll=false 时只给首候选 |
| uniqueExtensionHint（含同域核验回调注入） | INV-03 | G02 199 事件；用户选定高档实现 | closestWindow 只找「最相似」单点，不回答「加多少上下文才唯一」 |
| 时效判定扫描（含文件身份提取规则） | INV-04 | G01 246 事件 | 门禁只看「有无触痕」，不比较读写先后 |
| 已读区间提示 | INV-05 | G03 70 事件 | collectVisibleReads 是 read.ts 私有且不向失败诊断开放 |
| 同名提醒 | INV-09 | G05 45+ 事件 | 现无任何跨文件 basename 对照 |
| boundDiff | INV-08 | C01；apply_patch p99=20KB 超预算 | truncate.ts 通用截断不懂 diff 结构；edit 内联循环有跳行缺陷 |
| post-formatter diff 重算 | INV-07 | H02 + 台账 §12.7 实测 | proposal diff 在 formatter 前生成，commit 后无人重算 |
| formattedChanged flag | INV-06 | G04 33 事件；台账 §12.7-3 | _formattedContent 被 strip 不持久化，历史上不可测 |
| read.ts 导出 visibleReadMeta | INV-05 | G03 + 实现审计 B-01（compacted 过滤缺失实证） | 可见性协议的 part 级判定只能在 owner 内唯一表达；导出它而非 collectVisibleReads 让 edit 同时拿到 metadata 与 part 时间戳 |
| 对称差下界预过滤 | INV-11 | 本机基线红（2.7s）；jsdiff 中止路径实测 1280ms | jsdiff 无法在其 API 内提供更便宜的必然中止判定；下层过滤是同一决策的加速，不改变结果 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `src/tool/edit.txt` | modify | ①陈旧转写禁令（1 条）+ ⑥门禁劝导并入 + ②歧义条目补 more-than-3-lines | +4 |
| `src/tool/apply_patch.txt` | modify | ②第 35 行补 more-than-3-lines + ①陈旧转写禁令（1 条） | +3 |
| `src/tool/edit-apply.ts` | modify | 抛出点同域候选枚举 + uniqueExtensionHint（行域扩展计算 + 核验回调）+ 歧义错误文本 | +110 |
| `src/patch/match.ts` | modify | `ambiguous` 结果携带候选行号（owner 产出，去重排序封顶 8） | +30 |
| `src/patch/index.ts` | modify | ambiguous 抛出点接入 uniqueExtensionHint（注入 locateExact 核验） | +20 |
| `src/tool/edit.ts` | modify | catch 块三句事实增强（时效/已读区间/同名）；Changed 段接入 boundDiff | +110 |
| `src/tool/read.ts` | modify | 导出 visibleReadMeta 与 canonicalReadPath；collectVisibleReads 改经 visibleReadMeta 表达（对 read.ts 内部无行为变化） | +12 |
| `src/tool/file-diff.ts` | modify | 新增 boundDiff（连续前缀+省略计数+超限工件文件兜底）；renderFileDiff 探测前对称差下界预过滤（INV-11） | +75 |
| `src/tool/apply_patch.ts` | modify | commit 内记录最终内容、commit 后重算 diff、Changed 段、失败错误时效增强 | +85 |
| `src/tool/write.ts` | modify | formattedChanged echo（Formatted changes 段 + metadata flag） | +35 |
| `test/tool/edit.test.ts` | modify | INV-03/04/05/08/09 + 文案断言 | +180 |
| `test/tool/apply_patch.test.ts` | modify | INV-03/04/07 | +120 |
| `test/tool/write.test.ts` | modify | INV-06 | +45 |

生产代码 10 个文件、估计 ~450 行有效修改；测试 3 个文件 ~345 行。总量 < 12 文件 / 1200 行约束。

## 16. TDD Behavior Slices

统一 seam：Tool.execute 的公开 ExecuteResult.output / error（既有的 ctxWithPriorRead、itTruncated、mockFormatLayer、tmpdir fixture）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | edit 歧义失败错误含候选行号与经核验的扩展建议 | 当前错误只有 "Provide more context"；既有前缀断言（edit.test.ts:1152）保持 | 同域枚举 + uniqueExtensionHint 接入抛出点 | 既有歧义用例文案前缀不变 |
| 2 | apply_patch 歧义失败同上（含 normalized 域候选场景） | locateExact ambiguous 无载荷 | ambiguous 携带候选行号 + 核验回调 | patch 既有用例（apply_patch.test.ts:269 前缀保持） |
| 3 | edit 失败在「自写晚于自读」时含时效句 | 当前错误无此句 | ctx.messages 扫描 + 条件附加 | 无写入历史时错误与现状一致 |
| 4 | apply_patch 全失败错误含时效句（含无先读措辞分支） | 同上 | 同一判定逻辑复用 | 部分失败 output 语义不变 |
| 5 | edit 失败附已读区间列表 | 当前无 | visibleReadMeta 导出 + mergeRanges | 无已读 metadata 时省略该句 |
| 6 | edit 失败附同名异路径提醒 | 当前无 | basename 对照 | 无同名已读时省略 |
| 7 | write formatter 改内容时 output 含 Formatted changes 段且 metadata.formattedChanged=true | 当前 output 只有成功句 | 条件段 + flag | 未改动时 output 逐字节同现状 |
| 8 | apply_patch 成功 output 含 post-formatter Changed 段且 metadata.diff 一致、title 不变 | 当前无 Changed 段 | commit 后重算 + boundDiff | 文件列表/LSP 段/title 不变 |
| 9 | 小预算下 edit Changed 段为真实前缀+省略计数 | 当前跳行（C01） | boundDiff 接入 edit | 预算内输出逐字节同现状 |
| 10 | 事故规模重写的预算门亚秒完成 | jsdiff 探测 O(K²) 中止超 1000ms | 对称差下界预过滤跳过必然中止的探测 | 既有 diff 门控套件全绿（决策不变） |

每片先红后绿；测试只断言公开 output/error 文本与 metadata flag，不断言私有函数。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~480（生产，含 INV-11 预过滤 ~30）+345（测试）≈ 825；文案 txt 不计复杂逻辑 | 排除 import、既有行移动 |
| Required Chinese explanatory comments `C` | ≥ 124（ceil(825×0.15)） | 见下方点位 |

注释点位（解释为什么/不得破坏什么，不复述代码）：

- match.ts ambiguous 载荷：候选必须由 owner 产出（B-01 教训），封顶 8 的诊断预算理由。
- edit 侧同域枚举：计数域与唯一性域同源要求（usedNormalized 决定），enumerate* 首候选语义不可复用。
- uniqueExtensionHint：扩展上限的预算理由、核验回调必须同域（否则建议可能假唯一）、候选外不存在扩展命中的推理（扩展模式包含原模式）。
- 时效判定：判定方向、只看 completed、不诱导 re-read（用户决策）、无先读措辞分支的可达性（apply_patch 无门禁）。
- 已读区间：不按版本过滤的理由（陈旧版本仍有导航价值；当前侧无当前版本 ReadMetadata 可构造）。
- boundDiff：连续前缀不变量（C01 教训）、省略计数必须等于真实剩余行数、工件文件兜底与 bash 输出同模式。
- post-formatter 重算：metadata.diff 必须对齐落盘真值（H02）、permission 预览保持 formatter 前的审批语义、title 不变决定。
- formattedChanged：常态零成本理由（86% 新建冗余实测）、flag 持久化用途。
- 预过滤：下界证明（symDiff ≤ D）为何成立、为何只在严格大于 K 时跳过（决策等价性红线）。
- 测试：各切片锁定的是哪条用户可观察行为。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | packages/opencode | 切片 1/3/5/6/9 + 既有用例全绿 |
| `bun test test/tool/apply_patch.test.ts` | packages/opencode | 切片 2/4/8 + 既有用例全绿 |
| `bun test test/tool/write.test.ts` | packages/opencode | 切片 7 + 既有用例全绿 |
| `bun test test/tool/read.test.ts test/tool/truncation.test.ts` | packages/opencode | read 导出无行为变化、truncate 无回归 |
| `bun test test/patch`（match/index 既有套件） | packages/opencode | locateExact 返回类型扩展无回归 |
| `bun test test/tool` | packages/opencode | 修改面整体无红（含既有红色排查） |
| `bun typecheck` | packages/opencode | 类型零错误 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 无新模块 |
| Files modified | 13（10 生产 + 3 测试） | 第 15 节；生产 10 ≤ 用户约束 12 |
| Files deleted | 0 | — |
| Production lines | ~478 | 生产+测试 ~825 ≤ 1200 |
| Test lines | ~345 | 同上 |
| Generated lines | 0 | 不涉及 |

## 20. Real Risks and Open Decisions

- **时效判定的误报面**：自写后未读但本次失败其实与陈旧无关时，时效句仍真实（只陈述先后事实），不断言因果——文案措辞必须为事实句。
- **扩展建议的域一致性**：核验回调必须与抛出点同域（edit：countOccurrences/exactLiteralCount；patch：同 cursorOffset 的 locateExact），否则建议可能假唯一。已设计为注入式核验。
- **apply_patch metadata.diff 语义变化**：formatter 前→formatter 后。消费方为 snapshot/工具流归因与 prompt.ts（只要求真实 diff 行与计数），post-formatter 更贴近磁盘真值；permission 预览 diff 保持 formatter 前（审批语义）。
- **ctx.messages 扫描成本**：线性扫描且只在失败路径；无额外 IO。
- **预过滤边界正确性**：symDiff ≤ D 的证明依赖「strip 行尾后 token 一致性更粗 ⇒ 所需编辑数更少」；尾换行空 token 必须丢弃以对齐 jsdiff 行分词。错误方向只可能是下界偏松（保守），永不偏紧（否则会跳过本应成功的探测）。
- **Open decisions**：无。全部取舍已由用户在 R4 逐项敲定。

### Rejected Speculation

- CRLF 行尾作为失败主因——台账 §11.5 否证。
- hunk 裸空行解析缺陷——148 中仅 4，否证。
- matcher 吞掉现存文本——无证据（唯一钉死案为模型侧部分陈旧）。
- 跨 Session 写入者检测——0 命中，且超出 Session 边界，不实现。
- bash 读取计入触痕或文案分层——用户明确拒绝。
- write 全量 diff 回显——86% 新建冗余，否证。
- INV-05/INV-09 扩展到 apply_patch 失败路径——G05/G03 证据集中在 edit 域，需求 ③⑤ 未指明 apply_patch；apply_patch 侧 hunk 定位已有文件级粒度，不扩展。

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
| 1 | R1 | yes | B-01：apply_patch 侧歧义候选无法按合同产出——locateExact 的 ambiguous 结果丢弃候选（match.ts:10-13,142-146），抛出点重扫构成第二 matcher 或更弱域；最小方向：候选由 owner 携带至抛出点 | 8 条：§11 诊断面分类/估计不诚实；§10 write diff 基线含糊（应为提交内容→最终落盘）；§10 与 §17 版本过滤矛盾且 isSameFileVersion 不可执行；§10 apply_patch 复用范围与 §13/§15 不一致；apply_patch title: output 未钉死；INV-04 文件身份提取规则未写明；§4 match.ts:645+ 引用漂移（预算常量在 276-283）；固定 caps vs 4s/64MiB 应注明有意偏离 | BLOCK | ses_f6b72fbc1ffew0VQ404367P9o8 |

R4 边界裁定（read 侧「最后读取」的判定规则）：只认 visibleReadMeta 通过的内容可见 read。(a) legacy 历史 part（无 metadata.read 的旧记录）不锚定「最后读取」，此时文案为 "has not been read since"——跨版本 resume 的稀少边界，宁报未读也不冒称可见；(b) 目录/媒体 read（read.ts:625,673,684,704 无 metadata.read）不误计为文本读取。该规则替代 R3 文本中的 input.filePath 回退（回退会把目录/媒体 read 错计为「最后读取」，实现审计第 2 轮 B-01 证据 2 的核实结论）。

R2 处置：B-01 按最小方向修订（match.ts ambiguous 携带候选行号；edit 侧同域枚举；uniqueExtensionHint 注入同域核验回调）。非阻断全部吸收：§11 重分类为 primary-contract repair；§10 钉死 write 基线/已读区间版本规则/apply_patch title/文件身份提取与无先读措辞；§2 Non-Goals 明确 INV-05/09 仅 edit；§4 引用更正；§10 注明固定 caps 为有意收紧。

| 2 | R2 | yes | No blocking findings（B-01 解决已逐项源码核实：locateExact ambiguous 载荷、同域枚举、核验回调、无环导入、既有歧义测试前缀保持） | 2 条：①INV-04 引导句需工具感知；②§2 title 括注精度（R3 审计发现该轮 record correction 未实际落盘——与表头同批 edit 原子失败；已在 R3 批准时真实落入 §10/§2） | APPROVE | ses_f6b72fbc1ffew0VQ404367P9o8 |
| 3 | R3 | yes | No blocking findings（INV-11 下界证明经审计独立验证：symdiff ≤ D 成立、尾空 token 丢弃是关键、只在严格 >K 时跳过、决策等价非第二路径；红测试与本机基线失败均经源码/实测确认） | 3 条：①§19 行数算术漂移——record correction 已落入；②§11 缺 INV-11 预过滤行——record correction 已落入；③R2 轮次的 record correction 未落盘——本轮已真实补齐 §10/§2 | APPROVE | ses_f6b72fbc1ffew0VQ404367P9o8 |

## 23. Implementation Evidence

### Actual Files and Diff

13 文件修改、0 新增/删除：生产 10（patch/index.ts +36、patch/match.ts +53、tool/apply_patch.ts +72、tool/apply_patch.txt +3、tool/edit-apply.ts +153、tool/edit.ts +126、tool/edit.txt +5、tool/file-diff.ts +48、tool/read.ts +8、tool/write.ts +26），测试 3（apply_patch.test.ts +153、edit.test.ts +249、write.test.ts +26）。总 +970/-50。生产 ≤12 文件约束满足；总修改 ≤1200 行满足。

### Red-Green Test Evidence

| 切片 | 红（实现前） | 绿（实现后） |
| --- | --- | --- |
| 1 edit 歧义候选行号+扩展建议 | "reports candidate lines and minimal unique extension on ambiguity" / "degrades to candidate lines…" 失败（无新信息） | 通过 |
| 2 apply_patch 歧义（含 normalized 域） | "reports candidate lines and verified unique extension on ambiguity" 失败 | 通过 |
| 3 edit 时效句 | "notes own-write-after-read staleness on mismatch failure" 失败 | 通过（含「读取更新则不出现」控制组） |
| 4 apply_patch 时效句 | "notes own-write-after-read staleness on all-hunks failure" 失败 | 通过 |
| 5 已读区间列表 | "lists previously read line ranges on mismatch failure" 失败 | 通过 |
| 6 同名异路径提醒 | "notes a same-named read from a different path on mismatch failure" 失败 | 通过 |
| 7 write formatter 差异段 | "echoes the formatted delta…" 失败 | 通过（含未改动零变化控制组） |
| 8 apply_patch Changed 段 + post-formatter 真值 | "echoes the post-formatter diff…" / "reflects formatter results…" 失败 | 通过 |
| 9 C01 连续前缀 | "truncates the Changed diff as a strict prefix…" 失败（跳行出洞复现） | 通过 |
| 10 INV-11 预过滤 | 既有红 "keeps the abort path sub-second…" 改前基线 2.7s 失败 | 通过（同一命令） |
| 文案 | 两个 description 断言失败 | 通过 |

### Verification Commands and Results

| Command | 目录 | 结果 |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | packages/opencode | 94 pass / 0 fail |
| `bun test test/tool/apply_patch.test.ts` | packages/opencode | 70 pass / 0 fail（含既有红转绿） |
| `bun test test/tool/write.test.ts` | packages/opencode | 27 pass / 0 fail |
| `bun test test/tool`（全目录 25 文件） | packages/opencode | 731 pass / 0 fail |
| `bun test test/patch` | packages/opencode | 57 pass / 0 fail |
| `bun typecheck`（tsgo --noEmit） | packages/opencode | 零错误 |

### Original Feedback-Loop Result

INV-11：`bun test test/tool/apply_patch.test.ts -t "abort path sub-second"` 改前 2.7s 失败 → 改后 6.5s 内通过（含全文件其他用例）。反馈增强类切片的「原始症状」来自台账 §11 的数据库实证（不匹配/歧义/陈旧失败），red 由切片断言直接覆盖。

### Actual Secondary and Replacement Path Inventory

与 §11 一致：无新 alternate success path；ambiguous 载荷、uniqueExtensionHint、历史事实句均为失败诊断；boundDiff/Changed 段/Formatted changes 段为成功 output 的信息段；预过滤为决策等价快速路径。无 fallback、无 catch-and-success。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 747 | git diff 新增行排除空行、纯英文注释行、import 行（实现审计独立重算口径） |
| Qualifying Chinese comment lines `C` | 127 | 纯中文注释行 + 行尾中文注释 |
| Ratio `C / E` | 17.0% | |
| Required minimum `C` | 113 | ceil(747×0.15) |

代表性注释：edit-apply.ts（同域枚举红线、行对齐降级理由、核验失败必须丢弃建议）、match.ts（owner 产出候选载荷）、file-diff.ts（symDiff ≤ D 下界证明与尾空 token 丢弃的关键性）、edit.ts（不诱导 re-read 的用户决策、共享扫描 seam）、apply_patch.ts（审批看提案/模型看落盘的职责分离、win32 无反斜杠合同）。

### Remaining Unverified Items

- Linux/macOS 行为未在本机验证（测试含平台分支断言；改动无平台特定逻辑，win32 路径规则已覆盖）。
- 全仓库全量测试套件（`bun test` 全量）未运行——超出修改面验证范围（test/tool + test/patch 全绿）。
- 真实生产 formatter（prettier/gofmt）下的 write 差异段仅在 mock formatter 层验证（测试环境无真实 formatter 可用）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | B-01：scanFileTouchHistory 丢弃 read.ts 可见性协议（compacted 过滤缺失），且 collectVisibleReads 导出成死 import/死导出——已压缩读取会被误报为「已读」并抑制时效句；B-02：apply_patch.txt 措辞「three or more lines」偏离合同「more than 3 lines」且测试钉死偏离 | 4 条：两工具 diff 头路径形态不一致（apply_patch 相对/正斜杠，edit/write 绝对）；Changed 段预算不减已累积 output（wrapper 截断为最终边界）；§23 记录算术小出入（70→71 pass，E/C 口径）；canonicalReadPath 导出超出 §15 字面列举但属最小 seam 意图内 | BLOCK | ses_f6b72fbc1ffew0VQ404367P9o8 |

| 2 | R3 | yes | B-01（合同纪律）：第 1 轮返工改变了 read.ts 公共 seam（visibleReadMeta 替代 collectVisibleReads 导出）与 INV-04 判定规则（删除 input.filePath 回退），但计划设计节未同步——计划文本与已交付代码漂移。代码本身经全量复现健全，不需要代码返工；最小修正为计划侧对齐（R4）后重批 + 同一 diff 复审 | 4 条（延续项 + §23 记录算术 + fixture 结构重复观察） | BLOCK | ses_f6b72fbc1ffew0VQ404367P9o8 |
| 3 | R4 | yes | No blocking findings（R4 文本与已交付代码逐行一致；diff 与第 2 轮审计版本逐字节相同；E=747/C=127=17.0% 独立重算通过；验证复现：typecheck 零错误、edit/apply_patch/write/patch 251/251、test/tool 731/731） | 4 条记录级（均已在本轮记录时处理：§23 数字刷新、§24 轮次行补齐、残余 seam 名引用更正、§10 示例措辞与落盘文案对齐） | APPROVE | ses_f6b72fbc1ffew0VQ404367P9o8 |

第 1 轮返工记录（R3 不变，纯实施修正）：①read.ts 新增 `visibleReadMeta` 作为可见性协议的唯一 part 级判定（completed+未 compacted+非 stub+metadata.read 合法），collectVisibleReads 改经它表达；edit.ts 的 scanFileTouchHistory 全量改用它（readRanges/lastReadEnd/同名判定全部来自可见 read），collectVisibleReads/isReadMetadata 回滚为私有，edit.ts 只导入 canonicalReadPath/visibleReadMeta；新增红绿用例「does not count compacted reads as visible history」。②apply_patch.txt 改回合同措辞「more than 3 lines」，测试断言同步。返工后 edit 96/96、apply_patch 71/71、read 82/82、typecheck 零错误。

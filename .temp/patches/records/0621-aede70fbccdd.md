# 0621-aede70fbccdd Record

## 2026-11-02 v1.19.5 定向回归接续
- 终态七文件定向回归67过/2败之一为Native原歧义精确字符串断言未随本项候选行号增强更新；实际模型反馈正确追加`Matches at line 1.`，文件未写入。
- 仅在本项增加既有oracle接续hunk，精确锁定完整拒绝文案和真实同行候选提示；无放宽断言、删除用例或改写匹配算法，后缀统一重建复验。
- 最终 `typecheck-0662-2026-11-02T15-30-13-234Z` 累计662/662、30workspace通过；原失败case所在七文件完整重跑69 pass/0 fail/4547断言，精确消息、行号和不写盘断言均通过，命令与输出持久662。

## 当前共享编辑反馈接续（2026-11-01）
- 完整621–625新正审`ses_e69763852ffeEeCp1p0T3u0E4Z`、新逆审`ses_e69763803ffeRQwvAubGBuSVxT`均十份patch至EOF，本项及全批一致PASS/B0/G0；共享真实匹配/反馈、两代提交与formatter真值、原预算门经独立核对。整批保留Native无身份SSE冗余、既有冷页恢复及禁启动态/历史材料N，不为N返工；独立闭合625。
- 修后最终`typecheck-0621-2026-11-01T08-29-54-392Z.md`复用620应用1项，621/621、30workspace全passed、c5de1515…安装复用/两侧unchanged；本项必要26 pass/0 fail/271 expects。未新增测试文件，保全部source切片和原1000ms性能断言；独立结论留原621–625完整双审，不将单项自验当独立PASS。
- 三条检查cwd均为唯一宿主`packages/core`，各进程完整隔离环境采用0620本版模板（先清继承凭据/OPENCODE变量，再私有HOME/四XDG/config、内存DB、缓存临时目录、禁LSP下载/Watcher/模型fetch、关录音/E2E及hooks）。Core/V1两组生产输入与最终一致，最后仅修Native断言API，不重复跑或累加旧失败。
```text
bun test --timeout 10000 ../opencode/test/tool/edit.test.ts ../opencode/test/tool/apply_patch.test.ts ../opencode/test/tool/write.test.ts -t 'reports candidate lines and verified unique extension|notes own-write-after-read staleness|echoes the post-formatter diff|reflects formatter results in the echoed|description carries staleness|reports candidate lines and minimal unique extension|degrades to candidate lines|omits staleness note|lists previously read line ranges|does not count compacted reads|notes a same-named read|truncates the Changed diff|echoes the formatted delta|keeps output and metadata unchanged|keeps the abort path sub-second'
Isolated scope: D:/Temp/opencode/621-legacy-ce4268bdb7264df2b538142908ed4d5e
bun test v1.3.14 (0d9b296a)
 17 pass
 181 filtered out
 0 fail
 48 expect() calls
Ran 17 tests across 3 files. [6.25s]

bun test --timeout 10000 test/patch.test.ts
Isolated scope: D:/Temp/opencode/621-patch-15455bbe55484dcf82e87e24bd9b1f9d
bun test v1.3.14 (0d9b296a)
 7 pass
 0 fail
 40 expect() calls
Ran 7 tests across 1 file. [151.00ms]

bun test --timeout 10000 test/tool-edit.test.ts test/tool-apply-patch.test.ts -t 'diagnoses the failed Native edit from the shared DP span|applies valid files while reporting a failed later update'
Isolated scope: D:/Temp/opencode/621-native-final-2a49dac635d94affbd7ef8bb381539be
bun test v1.3.14 (0d9b296a)
 2 pass
 23 filtered out
 0 fail
 183 expect() calls
Ran 2 tests across 2 files. [2.61s]
```
- matcher副作用探针只用内存对象：`import { expect } from "bun:test"; const result = { type: "error", value: "Closest match at line 2\n\nown-write-note" }; console.log("before", typeof result.value, JSON.stringify(result)); expect(result).toMatchObject({ type: "error", value: expect.stringContaining("Closest match at line 2") }); console.log("after", typeof result.value, JSON.stringify(result));`，实际输出before string含完整note、after object且value={}。该事实解释首轮Native178断言中的旧matcher污染，不为此升级依赖或修改registry。

- 08:22:11正式621/621与30workspace全passed；V1新增切片及原1000ms事故门17/0/48、共享Patch7/0/40，Native Edit六组实际反馈通过。Native ApplyPatch旧`toMatchObject`会在Bun1.3.14把实际字符串改成asymmetric matcher，导致后续新断言读不到原文；纯内存探针确认before=string、after=object/{}。仅将该处旧断言改为等强的类型/原字符串检查，保候选、时效、原文隐私与零落盘断言，不修改生产路径或Bun依赖；待官方刷新重跑。
- 已扩既有Native Edit真实失败用例六组历史（区间融合/同名、pruned、stub、限幅、新读覆盖、自写ApplyPatch），均保零写盘断言；原生ApplyPatch既有部分失败用例补自写事实断言，未新增测试文件或删断言。手工嵌套hunk计数由只读numstat定位，已修59→48的长度笔误；该次仅结构失败，尚未进入物化或测试，不冒称运行结果。
- Native两工具现已接真实SessionStore历史与共享原话格式；Core85行纯模块只适配正式时钟/structured/applied目标及实际Read可见边界。既有Native成功formatter/diff及registry唯一结算保持，ApplyPatch单元fixture仅补调用方历史边界，不构造真实产品。`git apply --numstat`结构通过；正在扩既有Native错误用例覆盖真实leaf反馈，未新增测试文件、未启动程序。
- 已手改失败的六类真实前像并保全source行为：matcher/歧义诊断迁Core、boundMergedPatch原位保留、Read复用共享路径与可见性、ApplyPatch不退回旧无重写接口、两组历史fixture补totalExact。共享事实类型/原话格式迁Core供两代消费；V1扫描仍适配自己的metadata，不改变匹配、提交或权限顺序。尚未重新物化，正在完成Native历史接线与相邻fixture。
- 616–620已由全新正反审计闭合。官方`materialize-0625-2026-11-01T07-46-43-354Z.md`完整115行确认复用620、新增0、621首错、无625成态；五项只读预研已全部收齐，未提前实施622。
- 首次编辑前核对：Core仍是唯一matcher/diff owner，V1为facade；旧edit-apply路径、closestWindow导入、canonicalReadPath本地定义均已迁走，ApplyPatch仍保Delete+Add/Move与BOM/EOL/锁内formatter。修订重锚这些真实前像，保boundMergedPatch及全部source测试；Read fixture补现存totalExact合同。
- Native最终formatter回写及成功diff已有完整实现，不重复构建；缺口是两工具失败历史的时效/区间/同名异路径与source文案。将共享事实格式放Core、两代只适配各自真实消息形状；不新增历史缓存/回退数据源，不重建matcher或LSP。预算预过滤只在同一2000编辑距离下界严格超限时触发，原性能断言保持。

## 本轮复查（2026-10-20）
- 前批616–620已完整独立正反双审PASS。官方预应用625报告 `materialize-0625-2026-10-20T09-12-19-359Z.md` 实际620/625、reused620/applied0、停621、无625state；下文旧PASS和测试数字不用于本轮。
- 五项只读预研已完成，621完整反馈与预过滤意图已按实际620 owner核对：matcher/derive与renderFileDiff都已在Core，V1为facade。歧义候选及共享扩展计算下沉现有Core patch-match，V1 edit保留自己的计数域并复用计算/格式，不反向依赖应用包。
- 继续保留成功域/不可变原快照/错误传播与既有EOL/BOM、锁内formatter、审批proposal及最终diff分工。Read单一可见性抽取须保留compacted!==undefined和非空文件returned=0过滤；工具文案保留existing-file禁止空oldString的更强合同。测试原意均保留，优先调整既有用例；不会执行真实Edit/LSP生命周期或全量read套件。
- 602的原<1000ms断言保持，等待本项实际Core行多重集下界预过滤后重测；只在下界严格大于2000时跳过jsdiff，不改阈值或扩大成功域。当前进入主代理手改current阶段，未实施622或宣称本项通过。
- current已手工重锚：共享候选/扩展格式归Core patch-match，Core derive接同域建议；V1 edit-apply保留原计数/错误索引并导入共享诊断。boundDiff与多重集预过滤归Core file-diff，legacy仅转导出。Read保留compacted数值0和非空零行排除，edit文案不覆盖目标更强的现存文件非空匹配规则；source的反馈/formatter/测试及两个计划仍保留。只读hunk计数检查已通过，继续官方累计与类型验证，尚未宣布行为通过。
- 首次正式621已累计发布，`typecheck-0621-2026-10-20T09-37-43-519Z.md` 在CLI检查Core时发现新增诊断函数被零上下文插入位置放进locateExact末尾；已检查真实生成源码并改为与原结束上下文同一hunk，确保函数仍是顶层。没有手改state或调整物化脚本；旧结果只算累计成功，不算类型通过。
- 修后 `typecheck-0621-2026-10-20T09-40-54-731Z.md` 已621/621及30包类型通过；同宿主纯Core Patch 7/0/29。保留原D盘602反馈脚本、原输入和<1000ms阈值重跑，实际中止路径20ms通过，合法标记/显式计数/稀疏真实diff等断言也通过，不以升高测试阈值消除红测。
- 为执行source新增反馈切片而不触发真实LSP/formatter，仅补一个三文件共用的测试边界fixture，新增切片在LayerNode构建时替换外部服务；真实工具、mutation、文件与输出投影保持原实现，原有LSP测试层不改也不运行。apply_patch历史fixture改用真实Context/品牌ID，移除unknown双重强转。此测试适配尚待修后累计与行为检查，未推进622。
- 测试适配后正式 `typecheck-0621-2026-10-20T09-50-48-586Z.md` 再次621/621及30包类型通过，两侧unchanged=true。受控层的新source切片实际运行：apply_patch五项5/0/19、edit九项9/0/22、write两项2/0/4；没有运行旧真实LSP生命周期用例或完整read套件。结合Core纯Patch7/0/29及原602性能反馈，此项主要语义与本轮验证已闭合，正式独立放行仍属621–625整批双审。
- 621–625本轮全新独立正反双审闭合：升序ses_ea686b82bffe7cwOsxQdZ2IF8p、降序ses_ea686b7e3ffe1mA0MMyISSYw0O均逐项及整批PASS，无未关闭B/G。终态625累计30包通过，相关181/0/1032与原diff性能28ms；该项受控反馈切片含在18/0/58中。完整范围与N保存在D:/Temp/opencode/batch621-625-20261020-audit-verdicts.md，不追认旧历史报告。

## 结论
`PASS`（待批次双审确认）。编辑三工具（edit/write/apply_patch）上下文一致性反馈与 diff 预算门预过滤的完整目标适配，15 文件全部重锚落地。

## source 意图重建（逐 hunk）
original 167156B / 2401 行，15 文件：
1. **docs/plans/edit-harness-reliability-investigation.md**（新增）：11 项 INV 不变量调查报告（INV-01..11：盲改门禁、re-read 禁令、歧义诊断、时效事实句、已读区间、write 回显 diff、post-formatter 真值、连续前缀裁剪、同名异路径、description 合同、预算门）。
2. **docs/plans/edit-write-feedback-coherence-repair.md**（新增）：修复计划（C01 前缀截断洞、G01 链式陈旧、G04 write 回显分叉）。
3. **apply_patch.txt / edit.txt**：description 追加陈旧转写禁令（"Use the result returned by that call"）、bash 输出不认可、more-than-3-lines 诱导（INV-10 文案即合同）。
4. **patch/index.ts**：`withAmbiguityAdvice` 把 match.ts 歧义载荷（候选行号+`uniqueExtensionHint` 最小唯一扩展）拼进歧义失败消息；terminated=false 时无向下扩展空间。
5. **patch/match.ts**：`AmbiguityCandidates` 类型（lines/total/normalized）+ `ambiguityCandidates` 工厂 + `unsafeNormalizedOffsets` 数组化（unsafe normalized 命中收集 ownerStart 行号而非只计数，供 INV-03 诊断换算 1-based 行号）。
6. **apply_patch.ts**：`displayPath` 相对路径渲染（proposal 与 result 共用）；`finalContents` Map 在 commit 锁内记录 post-formatter 落盘真值；`resultFiles` 对齐落盘真值（permission 预览保持 proposal 语义）；title 不含 Changed 段；Changed 段给模型落盘锚点（G01 对冲）；INV-04 失败行附时效事实（与 edit 共享 seam）。
7. **edit-apply.ts**：INV-03 歧义失败诊断块——`AMBIGUITY_MAX_CANDIDATES=8` 封顶、`uniqueExtensionHint`（同域核验 verifyUnique 后才展示，mid-line/同行重复降级只报行号）、`formatAmbiguityHint`、`ambiguitySuffix`（edit 与 apply_patch 共享合同文案）；永不进入成功替换域。
8. **edit.ts**：`FileTouchHistory`/`scanFileTouchHistory`（共享判定源：lastReadEnd/lastWriteEnd/lastWriteTool，时间取 state.time.end，win32 大小写不敏感身份）；`formatStalenessNote`（INV-04 时效事实句，不诱导 re-read）；`mismatchHistoryNotes`（INV-05 已读区间+INV-09 同名异路径，复用 read.ts `visibleReadMeta` 可见性协议）；`boundDiff` 严格连续前缀截断（INV-08/C01）+超预算兜底写 truncation 工件。
9. **read.ts**：`visibleReadMeta` 导出——part 级可见性单一协议（completed、未 compacted、非 stub、metadata.read 合法）；`collectVisibleReads` 复用之（消除重复条件）。
10. **write.ts**：INV-06/G04 formatter 改变内容时回显「提交内容→最终落盘」差异段（`formattedContent`→`_formattedContent` 由 processor 消费后 strip）；`formattedChanged` 持久化事实标记。
11. **file-diff.ts**：`boundDiff`（逐字节前缀+真实 omitted 计数）；`exceedsEditBudgetByLineMultiset`——行多重集对称差下界预过滤（|old\new|+|new\old|>MAX_DIFF_EDIT_LINES 时必然中止，跳过 O(K²) jsdiff 探测，事故 fixture ~1280ms→O(N)）。
12. **edit.test.ts / apply_patch.test.ts / write.test.ts**：INV 合同测试全套（歧义行号+扩展建议、时效事实句、compacted 排除、前缀性质、post-formatter 回显、description 文案）；`HistoryEntry`/`ctxWithHistory` 多 part 历史 fixture；`itMidBudget` 中档预算层；`failWith` 助手。

## 三方比较与目标适配
- 上游 1.18.32：edit/write/apply_patch 均已迁移到 core 服务（FSUtil/FileSystem/Watcher/Truncate）与 `#NNN` 注释体系；测试层用 `LayerNode.compile`+`testEffect` 而非 `Layer.mergeAll`；`MessageV2` 品牌字段 `ModelV2.ID`/`ProviderV2.ID`（非裸 ModelID/ProviderID）；read metadata 为 `ReadRangeMeta`（canonicalPath 协议）。
- SMARK 侧全部语义（上述 11 项 INV + 预算门）在目标无对应实现 → 在正确 owner 完整重锚。
- 适配要点（fuzz+手工）：
  - `itMidBudget`/`itTruncated.write` mock 按目标 LayerNode 形态重写（原 Layer.mergeAll 形态在目标测试文件无 Bus/AppFileSystem 导入）。
  - `visibleReadMeta` 参数结构类型适配目标 `ToolPart`：`time.compacted` 为 number（时间戳）非 boolean；含 start/end 可选以通过弱类型检查。
  - `ctxWithHistory` fixture 的 `modelID/providerID` 用 `ModelV2.ID.make`/`ProviderV2.ID.make`；`compacted` 写 `entry.end`（number 语义）。
  - `apply_patch.ts` 的 `Truncate.Service` yield 落在 Effect.gen 体内（fuzz 曾误置于 Tool.define 参数间）；`let finalText` 落在 `if (edited)` 分支首行（fuzz 曾误置于 delete case）；edit 失败路径 `mismatchHistoryNotes` 接在 closest/no-candidate 三元之后。
  - `ctxWithPriorRead` 完整恢复目标既有 body（fuzz 曾被 mock 尾部覆盖），其与 itMidBudget 的孤儿重复体已清除。
  - edit.ts mismatch 诊断块按目标 :376 区域 closest 块形态对齐；read.ts visibleReadMeta 提取按目标 reverse 迭代/isReadRangeMeta 形态改写 collectVisibleReads 复用。

## current 完整性
- 终版 171004B / 2429 行；SHA-256 见 reports。逐 hunk 映射：2 个 plan 文档+2 个 txt verbatim 承载；11 个代码/测试文件按 0620-3b1fd6e09061 态 diff 重锚；适配说明段在头部。
- 无 source hunk 删除；无测试删除；3 个测试文件全部保留并适配（edit 97 用例含新增 INV 合同、apply_patch 74、write 27）。

## E/C
- E=913（排除 .md/preamble/空行；txt 计入），C=140 ≥ need 137。注释分布于：match.ts（unsafeNormalizedOffsets 输入合同）、index.ts（terminated 语义）、edit.ts（max 语义/时效句缺席条件）、read.ts（逆序扫描理由）、apply_patch.ts（诊断基线时点）等 128+12 处，均贴邻真实边界/invariant。

## 验证
- `bun .temp/patches/src/apply-cumulative.ts --typecheck 621`：passed 621/621，state provenance 基线 545f51d2，install 指纹复用（reused）。
- 行为测试（.test-workspace packages/opencode）：
  - `bun test test/tool/edit.test.ts` → 97 pass / 0 fail（4098 expect）。
  - `bun test test/tool/apply_patch.test.ts` → 74 pass / 0 fail（243 expect）。
  - `bun test test/tool/write.test.ts` → 27 pass / 0 fail（50 expect）。
  - `bun test test/tool/read.test.ts` → 85 pass / 0 fail（298 expect）。
  - 注释追加后复跑 edit+write → 124 pass / 0 fail。
- 修订史：4 轮 typecheck 修复（truncate yield 误置/finalText 误置/itMidBudget Layer.mergeAll→LayerNode/visibleReadMeta compacted number/fixture 品牌字段）；E/C 首轮 128<136 补 12 行至 140。

## 不一致与遗留
- 无未闭合项。itTruncated 注释曾有一处「兑底」用字误差，已修正为「兜底」并与 itMidBudget/currenct patch 同步重新生成、复验。

# 0621-aede70fbccdd Record

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

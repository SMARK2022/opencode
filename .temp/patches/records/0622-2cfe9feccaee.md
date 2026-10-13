# 0622-2cfe9feccaee Record

## 结论
`PASS`（待批次双审确认）。apply_patch Delete+Add 同文件顺序对折叠为覆写，3 文件全部重锚落地。

## source 意图重建（逐 hunk）
original 10678B / 179 行，3 文件 8 hunk：
1. **apply_patch.ts H1**：`HunkGroup` 增加 `rewrite?: boolean` 字段（折叠标记，供 processHunkGroup add 分支取真实旧基线）。
2. **H2**：add 分支 `oldContent` 在 rewrite 折叠对且文件真实存在时取 `Bom.split(Mutation.decode(snapshot)).text`（真实旧内容）而非空串——diff/审计可见完整替换；delete 未执行，旧内容不经 rewriteMarker 之外的路径丢失。
3. **H3**：execute 内 `rewritten: string[]` 折叠环——恰好 [Delete, Add] 顺序对（hunks.length===2 && first delete && second add）折叠为 `[second]`+`rewrite=true`；delete 永不执行、不进权限审批面（metadata.files 只见 add，precheck delete 提升不触发，与 write 覆写同构走 general 放行）；Add+Delete 倒序/三项及以上维持 Conflicting operations 拒绝。折叠先于 validateOwnership。
4. **H4**：成功 output 附提醒句（"Use *** Add File alone to rewrite a file"），位置在 `let output = Success...` 之后。
5. **apply_patch.txt H1**：Add File 条目补「fully rewrite an existing one in place」+「A rewrite never needs a *** Delete File first」。
6. **apply_patch.txt H2**：remember 列表新增覆写条目（"overwrites in place"+"Delete is redundant"）。
7. **test H1**：两个新合同测试——折叠覆写（内容/diff 基线/审批面只见 add/Note 提醒）与倒序+三项拒绝（Conflicting operations+文件未动）。
8. **test H2**：INV-10 description 断言扩展（"overwrites in place"/"Delete is redundant"）。

## 三方比较与目标适配
- 上游 1.18.32：apply_patch 已有 #518/#533 注释体系、Mutation/FSUtil 服务化、renderFileDiff(displayPath) 相对路径 seam（0621 引入）；无 Delete+Add 折叠能力。
- SMARK 语义在目标完全缺失 → 在正确 owner（groupHunks 后、validateOwnership 前的折叠环；processHunkGroup add 分支；output 汇总段）完整构建。
- 适配要点：fuzz 4 hunk 中 H4 曾误置于 `let output` 声明之前（TS 块级引用错误），手工移至声明后；H1-H3 与测试 H1/H2 落位正确（rewrite 字段 :42、oldContent :70-73、折叠环 :274-287、新测试 :451、断言 :526-528）。

## current 完整性
- 终版 11133B / 181 行。3 文件全部按 0621 态 diff 重锚；txt 两 hunk 语义逐字保留；无 source hunk 删除；新增 2 测试 + 2 断言完整保留。

## E/C
- E=90，C=14 = need 14（恰边界）。注释分布：折叠环 5 行（折叠意图/审批面语义/顺序对边界）、oldContent 2 行（旧基线理由）、Note 1 行、测试 5 行（折叠合同/断言理由）、txt 无中文注释。

## 验证
- `--typecheck 622`：passed 622/622，state provenance 基线 545f51d2，install reused。
- `bun test test/tool/apply_patch.test.ts` → 76 pass / 0 fail（256 expect，含 2 个新合同测试）。
- 修订史：1 轮手工修复（H4 Note 位置）。

## 不一致与遗留
- 无未闭合项。

## 逐 hunk 语义映射（双审 R1 补录）
- H1 `rewrite?: boolean`：折叠标记供 processHunkGroup add 分支取真实旧基线；不影响 update/delete 路径。
- H2 oldContent：`group.rewrite && snapshot.version.state === "file" ? Bom.split(Mutation.decode(snapshot)).text : ""`——diff/审计可见完整替换；delete 未执行故旧内容不经 rewriteMarker 之外的路径丢失。
- H3 折叠环：位于 groupHunks 之后、validateOwnership 之前；只认恰好 [Delete, Add] 顺序对（hunks.length===2 && first delete && second add）；Add+Delete 倒序/三项及以上维持 Conflicting operations 拒绝（测试 :481 锁定）；折叠后 hunks=[second]。
- H4 Note：位于 `let output = Success...` 声明之后（初版 fuzz 曾误置声明前导致引用错误，已修）；文案含 "Add File alone to rewrite a file"。
- txt：Add File 条目 "create a new file (or fully rewrite an existing one in place)" + "A rewrite never needs a *** Delete File first"；remember 列表覆写条目（"overwrites in place"/"Delete is redundant"）——INV-10 文案即合同。
- 测试：折叠覆写（内容/diff 基线/审批面只见 add/Note）+倒序与三项拒绝（文件未动）；description 断言扩展。

## 双审 R1 补录
- 携带修复：623 B-01 修订后 622 无需变更（其 diff 基准 0621 态不受影响）；重链后 apply_patch 测试基线不变。
- current 终版 11133B/181 行；E/C=90/14 恰边界合规（注释 8 生产+6 测试）。
- 行为验证：apply_patch.test 76 pass/0 fail（256 expect，含 2 新合同测试）+断言扩展。
## 证据定位（终态）
- states/v1.18.32/0622 态 apply_patch.ts:42 rewrite 字段、:70-73 真实旧基线、:274-287 折叠环、:468 Note；apply_patch.txt:11/:37。
- 与 624 交互：折叠产出 files:[add] 与 resultDiff，不经 filediff.patch 通道；PartView 仅裁 completed edit 的重复 filediff.patch——无冲突（逆向 auditor R1 独立核实）。
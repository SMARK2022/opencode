# 0622-2cfe9feccaee Record

## 当前两代覆写接续（2026-11-01）
- 完整621–625新正审`ses_e69763852ffeEeCp1p0T3u0E4Z`、新逆审`ses_e69763803ffeRQwvAubGBuSVxT`十份patch至EOF，一致本项及全批PASS/B0/G0。canonical精确配对、审批无delete、旧内容基线、Native Move/CAS/锁内formatter及失败语义独立核对，独立闭合625；不为整批N扩写。
- 正式`typecheck-0622-2026-11-01T08-41-55-587Z.md`：622/622、reused621/applied1、30workspace全passed、c5de1515…安装复用、两侧unchanged、保留五态。Native完整本文件12/0/137验证Move/CAS/审批前零读取、Add覆盖、canonical别名折叠、无remove、部分失败与中断；V1原两例及完整描述3/0/15。合计15/0/152，未将其与621重复用例相加；正式独立结论仍留621–625完整双审。
- 两条调用cwd为唯一宿主`packages/core`，均使用0620本版完整私有环境模板并先清继承凭据/OPENCODE变量；内存DB与受控formatter，无Git/HTTP/产品或LSP启动。完整命令及stdout：
```text
bun test --timeout 10000 test/tool-apply-patch.test.ts
Isolated scope: D:/Temp/opencode/622-native-da5d2719ff5a48e79cd5d99aa9890b04
bun test v1.3.14 (0d9b296a)
 12 pass
 0 fail
 137 expect() calls
Ran 12 tests across 1 file. [2.96s]

bun test --timeout 10000 ../opencode/test/tool/apply_patch.test.ts -t 'collapses a Delete\+Add pair|still rejects Add\+Delete|description carries staleness and context-size guidance'
Isolated scope: D:/Temp/opencode/622-legacy-beefc588dec54f9594fc656ba5787d8c
bun test v1.3.14 (0d9b296a)
 3 pass
 73 filtered out
 0 fail
 15 expect() calls
Ran 3 tests across 1 file. [4.64s]
```

- 已仅手改current完成Native实际owner接续：复用完整groups/destination检查后按原组首见顺序归一化，审批及准备均消费该计划；旧bytes/最终diff沿原snapshot与Mutation产物，不另读或分叉提交。原生新增case保remove不可调用、交错别名、批准前零正文读取及倒序/三项拒绝，既有Add覆写case保首段原断言、仅将配对结果改为单次Add和完整旧diff。原始V1八hunk及所有测试保持，尚待官方累计与必要验证。
- 621本版已累计、30workspace与必要26/0/271通过。`materialize-0622-2026-11-01T08-34-32-101Z.md`完整67行确认本项未应用；source179行/current323行及真实621两代ApplyPatch、共享Mutation、Native既有覆写/Move/审批前零读取测试已核对，五项只读预研已完成。
- 首次编辑前登记：旧Native适配基于create-only、缺Move且重复读取旧bytes，与实际目标不符。保留现有完整source/destination ownership、snapshot/CAS及锁内formatter路径，仅在授权前完整canonical组归一化恰好Delete→Add；批准面不见delete，真实成功后携rewrite事实和source原话提醒。独立Add仍覆盖已有文件，不恢复排他create，不改底层mutation或新建协调器。
- V1现有折叠方向与source一致，保八hunk及受控测试；Native旧二次delete/add断言调整为单次add与真实旧diff，同时保standalone覆盖、竞争、Move、部分成功/defect及中断。未手改state或执行产品，累计/本项验证待修后实际结果。

## 本轮复查（2026-10-20）
- 621已累计、30包类型与受控反馈/纯matcher/原性能断言通过。官方预应用622报告 `materialize-0622-2026-10-20T09-54-09-802Z.md` 停在测试中的旧it.instance前像，621/622；不是当前622已应用。
- 完整original/current、记录、实际621的V1与Core原生apply_patch、FileMutation与既有原生测试已核对。恰好canonical同文件[Delete,Add]应在批准面前归一化，旧内容进diff，不执行remove；其他冲突组合继续拒绝，多个Update仍沿原始快照聚合。
- V1使用621受控反馈测试层并保留既有Add覆写/EOL/BOM/锁内formatter；成功提醒只根据实际可提交的覆写提案。Core保留上游Add-alone排他create，显式配对才用已有writeIfUnchanged提交，批准后读旧bytes供diff和条件写共用；不修改底层create或引入新锁/协调器。原生提示须明确其Add-alone不同合同，不机械复制误导文案。
- 本轮仅主代理手改current/record；原生既有Add不覆盖、批准后竞态、部分成功和中断/清理断言保留。尚待修后累计与行为验证，不采用下文旧PASS。
- 已手改两代主路径：V1折叠意图不变，Note只追踪准备成功的覆写提案；Core按canonical完整组先归一化再授权，显式配对批准后读取原bytes，存在时用既有条件写、缺失时仍排他create，Applied仅增加可选事实标记供模型Note消费。新增一个原生既有fixture上的行为case覆盖交错别名配对、remove不可调用、真实旧diff、批准前零正文读取及反序/三项拒绝；源V1两case与描述断言保留并复用621受控服务。待官方累计验证。
- 正式 `typecheck-0622-2026-10-20T10-03-28-193Z.md`：622/622、reused621/applied1、30包类型通过、source/target unchanged均true。同安装宿主Core原生apply-patch完整九项既有+一个新增、纯Patch七项共17 pass/0 fail/79 assertions；V1源两项及扩展描述3/0/15（73 filtered）。原生Add-existing/批准后出现目标/部分成功/defect与中断提交合同均在实际套件中保持，未执行应用/LSP或daemon。正式独立结论留给621–625完整双审。
- 621–625全新独立升序ses_ea686b82bffe7cwOsxQdZ2IF8p、降序ses_ea686b7e3ffe1mA0MMyISSYw0O均逐项及整批PASS，无未关闭B/G。本项两代覆写/权限/条件写入/冲突语义在终态625相关181/0/1032及30包类型证据内再次覆盖；结论和保留N归档D:/Temp/opencode/batch621-625-20261020-audit-verdicts.md。

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

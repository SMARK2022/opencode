# Record: 0355-9bdaffcb2a1a（351-400 波审计后扩写版）

## Identity
- index: 0355；sha12: 9bdaffcb2a1a；parent: 20d6946a935e（=354）；subject: fix(permission): 修复 splitCommands bail 绕过 cautious 审查
- original: .temp/patches/original/0355-9bdaffcb2a1a.patch（451 行：docs 189 + precheck 双改动 + 5 测试）；current: .temp/patches/current/0355-9bdaffcb2a1a.patch（28936B；sha256=03c1cb9f9d495476e0c24958dfbb3283f91db67c603cf20bfd858d36421d7ebd）

## Source intent（逐 hunk 行为重建）
- shell 命令经 `splitCommands` 分段后逐段过 precheck 分类；原实现中段级解析遇不透明片段（opaque，如 `$(...)`/引号嵌套）即 bail 返回 raw 层短路结果，导致后随危险子命令绕过 cautious 审查（fail-open）。
- current 重构：segments/opaque/tainted 三态模型 + pushSegment 聚合；fd-merge（`2>&1` 等）良性跳过（原子消费、不毒化兄弟段）；tainted 残段不参与分类（不误判也不放行）；evaluateShell 调用点改 segments/opaque 聚合输出；cautiousRaw 注释同步。
- 安全语义：opaque 段不继承兄弟段分类；文件重定向目标仍走 general 路径；`task git -C /evil status` 类间接执行经 tainted 处理收紧为 cautious。
- invariant：任何无法证明安全的解析残段必须趋向更严格审查（fail-closed），绝不因解析失败放行。

## 三方比较
- 上游 v1.17.20：无 splitCommands 段级审查体系（SMARK permission 增强，全仓唯一 splitCommands 由 tool/shell.ts:27 消费）。
- 目标：raw 层短路面（precheck.ts:317-322）先于 split 执行，dangerous 捕获不变；本修复收窄的恰是 source 取证的 fail-open 面。
- docs 段（precheck-parser-fix-plan.md 189 行）verbatim 保留。

## V1/V2 owner 判定
- owner 在共享 permission precheck 分类器（V1/V2 工具管线共用同一 shell 分类器，无第二分类器）；SMARK 修复落在唯一正确 owner。

## 逐 hunk 映射（物化落点，states/0360+ 实测）
- precheck.ts:309-349（三态分段）、:334（splitCommands 新签名）、:513（evaluateShell 聚合调用点）、:338-339（fd-merge 跳过）；
- precheck.test.ts:815/:832/:844/:853/:866（5 个新测试：fd-merge cautious、残余片段不误判、文件重定向 general、opaque 不毒化兄弟段、未建模分隔符 general）+ 既有 `task git -C /evil status` 期望 general→cautious 收紧。

## E/C 与注释位置
- E≈100-125；C≈27-80（三态模型注释、fd-merge 原子消费与良性跳过理由、tainted 不分类的安全边界、重定向路径注释、各测试意图；`#355：` 前缀多行注释按去重思路合并计数，双向审计确认门禁通过）。阈值 ≥15 ✓。

## 物化与验证
- materialize 355 passed 355/355（typecheck-0355-…15-40 报告）；typecheck 全 workspace passed（0351 首装指纹 303af56d 复用合法）。
- 行为测试：5 新测试 + 收紧期望全绿（R13 会话实跑，precheck.test 85/85）。
- N 项说明：typecheck-0355 报告行 20 `Source repository unchanged: false` 为运行瞬间探测噪声——指纹覆盖父仓全部未排除文件（records/ 不在排除清单），审计/record 并发写入即可改变工作区指纹；manifest/original/current 哈希经双向审计员独立复核**未变**（replay 输入无漂移），后续 0360/0400 报告均恢复 true。

## 失败修订链
- 无功能性失败；R12/R13 期仅 docs 锚点与注释位置微调。

## 最终行为
- 段级解析失败不再绕过 cautious 审查（fail-closed 收紧）；5 测试 + 1 收紧期望锁定回归边界；docs 方案在案。

## 批次结语
- 批次 351-355：五项均无 B 级行为缺陷（双向审计一致），E/C 硬门全部独立复算通过；本批唯一阻塞为五份 record 低于契约长度（G-01~G-05），本扩写系列即修复。346-350 前批 seal 缺失（G-07）由 0350 record 侧闭合后统一补封。

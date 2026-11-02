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

## record 增补（2026-09-25，降级修复：恢复 ≥50 行 / ≥3000 字符门禁）

- 背景：本 record 在历史轮次被过度精简至门禁以下。本节在**保留原有全部内容不动**的前提下，依据 `original/`、`current/` 现文件与当前链状态补足记录完整性；未重写、未撤回既有内容。

### Source（original 现文件事实）
- 文件：`0355-9bdaffcb2a1a.patch`（存在，28743 B）
- Subject：(编码主题，见 original 文件头)
- 规模：3 个路径，diffstat 合计 +334 / −34
- 逐路径 diffstat（source 意图的完整文件面，重放审计按此清单核对）：
  - `docs/precheck-parser-fix-plan.md` +189 / −0
  - `packages/opencode/src/permission/precheck.ts` +77 / −34
  - `packages/opencode/test/permission/precheck.test.ts` +68 / −0

### Current 适配（current 现文件事实）
- 文件：`0355-9bdaffcb2a1a.patch`（存在，28936 B）
- 目标路径清单（owner 适配后的落点）：
  - `docs/precheck-parser-fix-plan.md` +189 / −0
  - `packages/opencode/src/permission/precheck.ts` +75 / −34
  - `packages/opencode/test/permission/precheck.test.ts` +68 / −0

### 链状态（v1.18.32 基线）
- index ≥188：v1.18.32 基线重验未开始；本 record 既有内容仍为 v1.17.x 时代验证记录，重验时将按批次补录
- 权威证据以 `.temp/patches/reports/v1.18.32/` 最新批次报告为准；本 record 既有验证节所引历史报告属于 v1.17.x 时代基线，保留作演进证据。

### 门禁自检
- 增补前行数 41 / 字符 2417；增补后见下（脚本复核输出）。
- E/C 与行为验证结论以所在批次双审独立复算为准，本节不重复申报数值。

## v1.18.32 基线重验（批次 354-358）

- materialize 358 通过（states/v1.18.32/0358-ddb68abdf40a）；typecheck 358 passed 358/358（31 workspace）。
- 行为测试（.test-workspace）：precheck 80 pass / 0 fail。

## 2026-10-17 累计复查

- 355 累计失败来自旧 V1 路径，实际分类器已迁移至 Core；将整套 splitter/evaluateShell/raw 注释修改转到共享 owner，保留现有测试入口及所有断言。
- 仅迁移所属路径，继续保持 fd-merge 原子消费、opaque/tainted 分段与既有 general 边界，不增加第二分类器。
- 最新355累计与30 workspace通过，precheck既有及新增用例包含在本轮226项通过的聚焦测试中。完整原始命令文本只交分类器，不启动shell或真实应用。

## 2026-10-26 原项复核
- 主代理完整读取original/current的189行历史方案、全部生产与五组测试hunks，并核对353前态Core evaluateShell/splitCommands及V1 re-export。current已落共享owner，保留原实现，不为风格或一般残隙重写。
- 本项修复干净兄弟段被opaque丢弃，以及fd-merge未原子消费的真实缺陷；opaque/tainted、动态变量、glob、文件重定向、单&与换行仍保持源general边界，非全量fail-closed。raw dangerous/cautious与现有包装器判定不动，不恢复旧记录暗示的额外加固。
- 354本轮165项行为验证已绿；本项下一步统一累计355与纯字符串precheck验证，未宣称本轮355已闭合。测试命令文本不会进入真实shell。
- 统一正式报告`typecheck-0355-2026-10-25T20-26-41-543Z.md`：355/355、reusedPrefix354、base0354-20d6946a935e、appliedThisRun1、30 workspace passed；frozen安装复用`56f628acec0337dadf9a5e400f45c8503010a286a2560e3c1658309185c4f614`，source/target unchanged，官方只保留355/354/353/352/350五态。
- 安全行为cwd：355唯一安装宿主`packages/core`。每命令独立`D:/Temp/opencode/check-355-<guid>` HOME/USERPROFILE/四XDG/explicit-config，清空继承OPENCODE与Provider/MCP/AWS/GitHub凭据；OPENCODE_DB=:memory:，TEMP/TMP/TMPDIR仅D:/Temp/opencode，RECORD/CHATGPT_VOICE_E2E/GITHUB_ACTIONS=false，禁LSP下载/文件watcher/模型fetch。
- 命令一：`bun test --timeout 30000 --only-failures test/session-runner-message.test.ts test/tool-read.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts test/file-mutation.test.ts test/session-compaction.test.ts ../opencode/test/tool/read.test.ts ../opencode/test/tool/edit.test.ts ../opencode/test/session/file-evidence.test.ts ../opencode/test/tool/task.inspected-files.test.ts ../opencode/test/permission/precheck.test.ts`。完整输出：`bun test v1.3.14 (0d9b296a); 265 pass; 0 fail; 1243 expect() calls; Ran 265 tests across 11 files. [39.02s]`。
- 命令二：`bun test --timeout 30000 --only-failures test/session-runner.test.ts --test-name-pattern 'executes and resumes canonical task sessions with durable results and scoped permissions|durably settles local tool failures before continuing'`。完整输出：`bun test v1.3.14 (0d9b296a); 2 pass; 93 filtered out; 0 fail; 51 expect() calls; Ran 2 tests across 1 file. [6.25s]`。只运行已核查fake-provider与内存Session；93为名称筛选，未改skip或断言换绿。
- 命令三为352纯显示宽度用例：完整命令与1/0/5输出在352本轮记录。三组合计268 pass/0 fail/1299断言；不启产品/TUI/daemon/MCP/录音设备、不执行被分类的危险命令文本。无新增Native安全分支，source既有general残隙与注释冗长记N。现交完整351–355全新正反独立双审，不先放行后项。
- 本轮新完整正审`ses_e8b3c92c8ffeY618HELKpK3vt0`、反审`ses_e8b3c9291ffe1bYxp7zIKqQ6jH`一致351–355全部PASS/B0/G0，355唯一共享分类器与实际两代权限消费者闭合。源general边界是接受的N，不升级成全面fail-closed或新增第二分类器。

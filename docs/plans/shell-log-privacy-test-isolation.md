# Canonical Implementation Plan: Shell Spawn-Log Privacy Test Sink Isolation

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 本轮用户原话，见 §1
>
> Implementation allowed: yes（实现已存在，见 §6 状态说明）
>
> Last updated: 2026-10-07

本文件是 CI 测试隔离修正的唯一 canonical plan，与 `docs/plans/windows-shell-native-fault-containment.md`（R7，已 verified 并提交于 60d410461f）相互独立；旧文档保持原样，不再修改。

R1方案审计：复用上轮通过审计员上下文`ses_eea2172ccffeWDS1TV7DBfV7Md`（用户规则：通过者不换），Audit mode: plan，Full scope: yes。Blocking findings原文：**No blocking findings.** Release verdict原文：**APPROVE — 仅批准当前 R1 方案。**（审计对象版本最后修改时间 2026-10-07 18:53:18）。五项non-blocking记录：§1应补齐第三条用户原话（预算约束）并映射numstat证据；§3“唯一未自持者”表述不精确（prompt.test.ts:1666-1677也读Log.file()但在integration shard且容错读取）；§5的E=5计数偏高（实际2个实质代码行+3注释行，比率反而更高）；builder宣称的运行结果未由审计复跑（计数已独立核验）；§6状态异常但如实披露。第一、二项已在下文修正（record correction，不触发重审）。

R1实现审计：全新上下文`ses_ee9fa708effeQ9m6A1tC71KaCp`，Audit mode: implementation，Full scope: yes。Blocking findings原文：**No blocking findings.** Release verdict原文：**APPROVE** — 放行当前实际 diff（`packages/opencode/test/tool/shell.test.ts` +5/−1）对 approved revision R1。审计员亲自复跑：red路线命令235 pass/0 fail/757断言/258.09s；shell+log 229 pass/0 fail/743断言/256.64s；opencode typecheck通过。E/C审计重算：E=2、C=3（150%）。四项non-blocking记录：§3将llm误列为runtime shard消费方（实为integration shard先例，已在下文修正）；red侧为只读审计未复跑（机制已从源码证明）；plan状态元数据approved→verified属记录员过渡；工作区既有无关改动（models-snapshot.js、sdks/vscode/.gitignore、两份暂存plan、thirdparty/opencode-11720/）均先于本项存在且与本项无关。放行不代表授权提交或推送。

## 1. Verbatim Requirement

> 不出所料，相应的内容发生了一个 test 的错误，你可以去检查一下。那目前而言，好像这个 test 的必过核心测试中的工具与基础模块的 Windows 的测试有问题，你可以全面完整去检查一下什么情况，尝试去进行按照完整的 workflow 去进行一次修正。

> 我都说过多少次了，你应当另当立项，另行立项，另行立项，你不应该修改我们之前那个Plan文件。

> 准确定位，精准定位当前测试红色的问题根因等等内容，判断到底是生产代码逻辑流程不规范不自然，不满足持续要求，还是测试内容对于相应的生产代码的逻辑过度地形式化地进行判断。在检查过后，需要完整按照完整的 workflow 流程进行立项处理并进行纠正，同时保证最终的内容不会再引入任何的新的 CI 红色测试。与此同时，适当避免进行全量的 test 的测试，因为本质上全量 test 可能时间会较长。整体生产代码或测试代码整体修改文件数不超过四个文件，同时所有代码的修改量本身不应超过四百行。注意不包括 Markdown 的报告。

边界：只修正确认的 CI 测试失败；旧 plan 文档不改动；生产代码不变；代码修改 ≤4 文件、≤400 行（Markdown 不计），避免全量测试。

预算对照（`git diff --numstat HEAD` 实际值）：代码修改仅 `packages/opencode/test/tool/shell.test.ts` 一个文件（+5/−1 物理行，其中实质代码行为 2 行 init/ensuring 调用，其余为注释与结构调整），远低于上限。

## 2. Evidence

- run `37601976937`（SMARK2022/opencode，commit 60d410461f）：`必过核心测试 / packages/opencode / Windows / 工具与基础模块`（`OPENCODE_TEST_SHARD=runtime`，test.yml:53-58）失败，其余 job 全绿。
- 失败用例：`tool.shell abort > keeps command secrets out of the added spawn failure log`，5083.89ms，错误 `spawn failure log was not persisted`（test/lib/effect.ts:145 的 pollWithTimeout 超时）。
- CI 时序交叉印证：lsp 用例（09:43:54）之后，mcp 等 service 日志直接出现在测试进程控制台输出（09:44:07 起），证明全局 writer 已被切为 stderr。
- 本地最小复现（两文件同进程、顺序与 shard 一致）：`bun test test/lsp/client.test.ts test/tool/shell.test.ts --timeout 60000`（packages/opencode）→ 234 pass / 1 fail，同一超时消息。此命令即本 plan 的 red-capable feedback loop。

## 3. Root Cause And Owner

- 生产者（唯一劫持点）：`test/lsp/client.test.ts:20-22` 的 `beforeEach` 调用 `Log.init({ print: true })` 且从不恢复；`log.ts:79-87` 的 print 分支把进程级 `write` 永久切为 `writeStderr` 并销毁文件流，`logpath` 保持旧值。该模式是全测试树中唯一的 `print: true`。
- 路径：runtime shard 将全部非 TUI/非集成测试文件按字典序交给单个 `bun test` 子进程执行（test-ci.ts:19,59,78）；`test/lsp/…` 排在 `test/tool/…` 之前。
- 受害者：隐私测试（shell.test.ts）读取进程全局共享的 `Log.file()` sink 却不拥有其生命周期；同进程先运行文件永久改写该 sink 后，`log.error("spawn failed", …)` 写入 stderr，文件轮询必然超时。生产侧 log 行为与日志内容均无缺陷；责任归该测试自身的 seam 选择。runtime shard 内其余 `Log.file()` 消费方（provider/bus/event-subscription 测试）均已自持 sink，本测试是该分片内唯一未自持者（llm.test.ts 属 integration shard，仅作修复先例引用）。（审计记录：integration shard 的 `prompt.test.ts:1666-1677` 也读 `Log.file()` 而未自持，但其进程内无 print:true 生产者且容错读取，行为不受影响。）
- **定性判定**（回答根因归属问题）：生产侧逻辑自然且符合其合同——`Log.init`/`Log.close` 是合法的进程级控制点，`log.error` 无条件走模块级 writer 是正确设计；不存在“生产流程不规范”问题。首次分歧在测试：隐私测试把“生产代码必然写入进程全局 sink”当成稳定前提来断言文件内容，是对共享全局态的过度形式化依赖；正确边界是测试自持 sink 后再断言。因此修复落在测试 seam 而非生产。lsp 的 print:true 泄漏是既有行为，不在本项修复（scope 不扩展）。

## 4. Single Fix Route（仅测试文件）

隐私测试在执行前取得 sink 所有权：`Log.init({ print: false, dev: false, level: "DEBUG" })` 在测试进程专属日志目录建立并截断一个全新的日期命名文件（dev:false 触发 truncate，天然排除同进程历史条目）；`Effect.ensuring` 中恢复 preload 合同 `Log.init({ print: false, dev: true, level: "DEBUG" })`（preload.ts:92-96），不影响后续文件。与 llm.test.ts:181-186、event-subscription.test.ts:699/843 的既有先例同型（省略其 Global.Path.log 重指派：日志目录已按进程隔离，独立 callID 进一步隔离条目）。

生产 diff 不变；六文件/1000 行上限不受影响（本次为测试文件）。

## 5. TDD And Verification Results

| 步骤 | 命令（packages/opencode） | 结果 |
| --- | --- | --- |
| red | `bun test test/lsp/client.test.ts test/tool/shell.test.ts --timeout 60000` | 修复前 234 pass / 1 fail，与 CI 同一条超时消息 |
| green | 同一命令 | 235 pass / 0 fail，757 断言，280.49s |
| 单文件回归 | `bun test test/tool/shell.test.ts --timeout 60000` | 223 pass / 735 断言，235.67s |
| 另一劫持形态回归 | `bun test test/tool/shell.test.ts test/util/log.test.ts --timeout 60000` | 229 pass / 743 断言，276.51s（util/log.test.ts 含 Log.close 用例） |
| 类型 | `bun typecheck`（packages/opencode） | 通过 |

首次全量回归时遇到一次既有间歇：`preserves Select-Object -First suffix [powershell]` 报 python exit 255（PowerShell Select-Object 提前关管道的已知竞态，先前实现审计已记录为非本次引入）；重跑 223/223 通过，隐私用例在三次运行中全部通过。

E/C 实际（审计重算口径）：本项 diff 含 2 个实质代码行（init 与 ensuring 调用）与 3 条中文说明（sink 所有权、dev:false 隔离语义、恢复义务）；E=2、C=3，比率远超 15% 门槛。

## 6. 状态说明

实现已存在于工作区并全部验证通过：它最初在旧 plan 的 R8 段落下获得方案批准（审计 `ses_eea2172ccffeWDS1TV7DBfV7Md`，No blocking findings / APPROVE）后实施；用户随后要求另行立项，故内容迁至本独立文档，旧文档恢复为已提交状态。本 plan 的方案与实现均待按独立文档重新审计。

## 7. Audit Contract

- 方案审计：完整审计本文件的证据、根因、owner、修复路线与验证计划。
- 实现审计：完整审计 shell.test.ts 的实际 diff 与本 plan 全部声明。
- 每轮一名审计员；上一轮未通过时下一轮使用全新上下文；通过后记录原文 verdict。

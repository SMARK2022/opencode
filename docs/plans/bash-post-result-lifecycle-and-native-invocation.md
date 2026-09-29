# Canonical Implementation Plan: Bash 最终输出后的长尾挂起

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户原文，见 §1
>
> Implementation allowed: completed; further material changes require a new approved revision
>
> Last updated: 2026-09-29
>
> Repository baseline: `378033d16a`

本文件是本任务唯一实施规格。`D:/Temp/opencode` 中的分类、实验及研究备忘录仅作证据。本文承接最新用户纠正，以“最终结果已打印，调用持续数分钟至数小时，直到用户终止或超时”为主问题。此前 Git 审批加速建议在本任务中撤销。

R4 阅读规则：§1 保留主代理校正后的完整用户原文；§2–§21 保留 R2 设计与调查基线；§22–§24 的 R1/R2 审计原文和实现记录完整保留；§25 保留 R3 设计及当时的证据边界。**§26 是当前 R4 的完整实施规格增量与全范围评估，发生冲突以 §1 用户需求及 §26 为准。** R4同时修复普通Shell角色泄漏和销毁后的streaming worker复活，并保留R2累计生命周期修复。已确认缺陷均有owner、可失败反馈与具体交付设计；不可重建的历史阶段显式映射验证限制，不推测已修复。当前audit-required仅表示等待独立全范围计划审计，Approved revision=none、Implementation allowed=no；旧APPROVE不继承，不代表最新目标已实现。

## 1. Verbatim Requirement

原 R2 实施要求（原文保留；当前 R4 本轮仅规划，不修改生产、测试或配置）：

> 不进行提示词的修改，因为你加的内容本质上模型难以理解且容易诱导模型提高复杂度。同时请注意测试断言要符合逻辑自然，避免过多增大不必要的或者为了断言而进行的不必要断言；同时整体生产代码修改数在5个文件以内，在800行生产代码修改以内，期间不要使用question因为用户不在这里

> 注意不要因为审计而增加不必要的复杂度，适当battle；或者调整现有逻辑而不是扩充新逻辑新分支，避免增加复杂度

原实施目标终态：`verified-implementation`；最新澄清下仍未达到。全程不调用question；保留完整原始需求，后续只能按当前修订获得完整独立批准后的Harness主路径实施。生产最多5文件、800变更行，提示词及其组装全部保持原样。审计材料仅由独立auditor加载，primary记录verdict。

> 完整检查相应逻辑，理论上git相关命令本身确实审批，审批本身的耗时不计入；那需要关心的主要是全部完整的内容，看看相应的harness或者prompt（极度克制，如果动的最少最好）需要作何修改能够解决相应的完整问题；类似于这种python的啊，还有相应的包装啊，还有等等内容；全量完整检查，并给出完整准确的修改方案，同时你要写出具体修改方法。同时请注意修改不得违背用户fork的本身的意图，也就是不能以缩短时间来规避掉用户本身期望的审批啊等等的一些流程

> 按照我的理解，不是这种问题，这种属于几秒钟的一个延迟，我说的是那种命令实际上已经运行完了，但是相应的bash卡住不返回，然后用户手动结束这种？你可以看看，我看过很多的命令的输出部分已经输出完整了，且也运行到了最终的探针，然后bash迟迟不返回

> 最终直到用户等的不耐烦了然后终止了，或者bash超时返回了；一般而言bash运行事件是长尾分布，你可以完整检查检查，理论上相应的bash可以看到相应的超时时间过长或者运行时间都几十分钟这种

> 理论上我很少做超长规模的任务

沿用同任务最初的接口约束原文：

> 我们目前的内容是一个非这种交互式的，就是一种等待 Bash 命令运行之后，它才会返回给主 Agent 的一个机制。也就是说我们没有打算去增加那些，比如在调用命令之后返回一个可交互的 Bash，允许命令进行等待时或者不等待时的一些操作。

最新澄清（用户原文）：

> 我再次声明，我最终的目的并不是让错误或者超时及时抛出。我要的是从根源上就解决这个超时，不该有的超时问题。就譬如说理论上，一个程序或者说一个命令，它已经正常运行完了，同时甚至都已经运行到了最后一个字符嘛。本身而言，这个程序它应该已经去结束了。但是这个 Bash 相应的这么一个工具，它没有正常地去进行相应的返回啊等等机制。那当前而言，你的修改，我不知道它是不是集中在这个错误抛出阶段。那如果集中在这个地方，本身而言修改的方式和修改的方向本身不适合我的这个修改的目标。当然你这些修改是合理的，但是你最终仍然可能没有达到我的一个目的。那与此同时请注意，你也不得以一些其他的这种启发式的方式来分析命令有没有结束。因为本身而言，命令有没有结束应当是一个确定性的、准确性的一个东西。你也不得说，长时间命令不输出，那我们就把它结束掉，这本身是不合理的。所以请你全面检查到底什么情况。那本身而言，按照我的理解，你就譬如说之前模型去调用了一些，比如说 Conda 去运行 Python 啊等等的命令，那本身都已经，命令都已经执行完了，管道都应该已经结束掉了，但是它依然还存在，这本身是不合理的，请你检查。那本身你不得说当前只能保证到这一步。你也不得说这个什么输出 consumer 的这个读取失败，什么及时交付错误。请注意交付错误并不是目的，解决错误才是真正的目的。也就是说，让错误根本就不再发生，也就是解决错误的这个代码生产源。但是解决的方式不得以这个 try catch 的，或者等等的方式，就最好不要以这种方式来进行处理，而是你就找到真正错误的根源。比如说某一行的时序啊等等有问题，或者说某一行这个机制处理不完善，导致相应的这个出现了一条错误路径。所以请检查。那本身我不认为这是完成的。

当前用户续查指令：

> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

本轮文档工作的分工是仅修订 canonical，由主代理复核后安排独立全范围审计；这是执行安排，不是新增用户需求或实施授权。

## 2. Explicit Non-Goals

- 审批规则、Git 风险分类、reviewer 模型/预算/重试、缓存键、外部目录门禁及其先于执行的顺序保持原样；审批时长独立于执行预算。
- 保留一个同步 Bash、现有五字段 schema、配置的 shell、原始命令、UTF-8/退出码/输出压缩及 UI/模型输出隔离。
- 正常完成继续等待真实进程结果及完整输出；不根据 `PASS`、JSON、最终探针文字或安静时段猜测完成。
- 不自动改写 Python/循环/Start-Process，不新增后台 ID、轮询 API、隐式脚本文件、额外 native launcher 或捕获备用路径。
- 本轮实施纯Harness修复直至verified；所有模型可见提示、字段说明及prompt组装保持原样，R1的P1/P2/P3全部撤销。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| 根 `AGENTS.md`、`packages/opencode/AGENTS.md`、`packages/opencode/test/AGENTS.md` | 最小正确变更、Effect scope、package 内测试/typecheck、有因果排序的 fixture |
| `CONTEXT.md` | Tool/Permission/Session 职责独立；core 为共享适配层 |
| `docs/adr/README.md` 与现有 ADR 目录 | 当前没有另一套 Shell 完成合同 |
| `docs/plans/shell-native-script-fidelity-and-model-success.md` R9 verified | 原生命令保真；移除 Python 改写；提示词逐次批准；单 Bash；其他工具合同保留 |
| `.opencode/policy/first-principles-engineering.md` | 主路径根修、零新增 fallback、双向追溯、完整独立审计、中文解释注释门禁 |

当前已暂存的其他两个 plan、VSCode gitignore 与未跟踪 thirdparty 目录属于原有工作区状态。

## 4. Files and Evidence Read

路径简写：`oc/` = `packages/opencode/`，`core/` = `packages/core/`，`tmp/` = `D:/Temp/opencode/`。

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `oc/src/tool/shell.ts:424,465,774,788,909,924,951,1139,1151` | 原生包装、权限/执行分界、race、输出 consumer 与 scope | observed |
| `oc/src/session/prompt.ts:1182,1212,1254,1275,1292` | ctx.abort、权限取消、snapshot barrier、Bash 协作取消豁免 | observed |
| `oc/src/session/processor.ts:86,427,1060` | interrupted 元数据、清理后终态覆盖及保留 metadata.output | observed |
| `core/src/cross-spawn-spawner.ts:166,240,279,393,426,437,447` | source/tap、exit/close 解耦、scope finalizer、kill 合同 | observed |
| `core/src/process.ts:156,187` | 共享 adapter 消费者，取消与流作用域 | reachable |
| `oc/src/tool/registry.ts:430`、`src/mcp/index.ts:959`、`src/file/ripgrep.ts:662`、`src/project/project.ts:492` | 共享 spawner 的实际使用面 | reachable |
| `oc/src/tool/progress.ts`、`src/tool/truncate.ts`、`src/util/text-decoding.ts`、`src/util/output-notice.ts` | decoder flush、final durable progress、spill、取消结果 | observed |
| `oc/src/tool/shell/prompt.ts`、`shell/shell.txt` | 当前唯一 shell profile 文本与通用提示 | observed |
| `oc/test/tool/shell.test.ts`、`shell-prompt.test.ts` | 真实 execute、权限门禁、Python 原生输入、历史文字预算 | contracted |
| `core/test/effect/cross-spawn-spawner.test.ts` | 延迟订阅、背压、kill、scope、pipe/Fd 行为 | contracted |
| installed Effect `internal/effect.ts` 与 `.opencode/references/effect-smol/.../internal/effect.ts` | raceAll 首成功、raceAllFirst 首完成、并发监督 | observed |
| installed `@effect/platform-node-shared/src/NodeStream.ts:299` | reader scope 只销毁交给它的 PassThrough | observed |
| `tmp/bash-longtail-*`、`post-result-tail-report.md`、`post-result-tail-cases.json`、`post-result-tail-validation.json` | 全量索引、所有取消/错误、长尾及最终输出逐条证据 | observed |
| `tmp/post-result-body-*.txt` | 六份历史探针脚本体，来自原消息/patch 按顺序重建；仅作数据读取 | observed |
| `tmp/post-root-cancellation.test.ts`、`post-root-cancellation-findings.md` | 当前真实 execute 的 root 后取消与 deadline 红测；原型对照 | observed |
| `tmp/shell-execute-supervision.test.ts`、`shell-execute-supervision-findings.md` | 原始退出/流错误被延后的真实组件红测 | observed |
| `tmp/ownership-differential.mjs`、`first-wait-bun-probe.mjs`、结果 JSON | PowerShell 5.1/7、Bun 后代、独立/共享 I/O 对照 | observed |
| `tmp/execution-category-matrix.md`、`execution-taxonomy.json` | 旧 1,814 候选及 1,156 对照的全部类别；由扩展长尾扫描补充 | observed |
| `tmp/execution-safe-probes.mjs`、`patch283-followup.md` | Python 原文/标准输入与 SSE cleanup、正则 CPU 区分 | observed |
| PowerShell v7.6.6 `Process.cs` | Start-Process 参数触发 CreateProcess及真实实现 | observed |
| Win32 pipe handle inheritance 文档 | 继承句柄及EOF合同 | contracted |

外部来源：`https://raw.githubusercontent.com/PowerShell/PowerShell/v7.6.6/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs`；`https://learn.microsoft.com/en-us/windows/win32/ipc/pipe-handle-inheritance`。平台实现事实与本机差分相互核对。

## 5. Current Behavior and Complete Investigation

```text
Agent 原生命令 -> Snapshot/插件 -> 原有权限审批
-> ShellTool.run -> spawn -> output fiber
-> race(root exit, ctx.abort, timeout)
-> root exit 获胜，撤销 abort/timer
-> 无界 join(output) -> decoder/progress/spill -> 返回
```

### 5.1 全量口径

北京时间 2026-07-29 00:00 至 2026-09-29 00:00：109,686 条 Bash Part，101,939 次去重调用。主扫描只读 SQLite，冷包在内存校验解码，数据库冷冻状态保持原状。

最新补查覆盖所有错误、所有取消/stream-ended 结果、全部调用时长前 5% 及此前候选，共 8,102 次详细调用。前 300 长尾逐条检查；所有 307 条带 metadata.output 的取消记录逐条读取，包括 154 条 `(no output)` 占位。实际有意义输出的取消为 153 条，其中 128 条在工具预算到来前结束，145 条无审批元数据。

| 指标 | 数量 |
| --- | ---: |
| 唯一 error 记录，全覆盖分类 | 1,520 |
| 真正取消/stream-ended 结果 | 540 |
| 预算前发生的取消/stream-ended | 495 |
| 已辨识最终结果或前台最终启动确认后仍挂起 | 40 |
| 上述 40 条中以取消结束 | 22 |
| 相比此前 timeout 初筛新增最终输出案例 | 5 |

实际 Shell duration 的中位数 1.318 秒，p99 332.730 秒，74,614 次低于 5 秒。所有 error 记录缺少终态 Shell duration，分别保留 state 总跨度。短操作是常态，长尾按保留的最终输出及脚本工作内容核实。

### 5.2 最有辨识力的历史长尾

| Record | 已完成的输出 | 持续情况 | 首分歧归属 |
| --- | --- | --- | --- |
| `prt_fc8ea210f001VtY0fa0M1gKJgn` | 单次 suite：6 pass、2.04 秒 | state 13,611,389 ms 后 aborted | suite 后 teardown/程序或 pipe；历史 root/EOF 时间待补 |
| `prt_fe09addae001fEUr6tYlhPsYqt` | 单次 suite：14 pass、2.14 秒 | state 823,608 ms 后 aborted | 同上 |
| `prt_fe0b100ca001798kAewDiRCKHx` | 单次 suite：18 pass、2.17 秒 | state 1,405,700 ms 后 aborted | 同上 |
| `prt_fcb696d09001cYcH6pkc4fZZdW` | 单次 suite：56 tests、10.45 秒 | Shell 7,738,357 ms，预算120,000 ms | 超长执行/capture，保留部署与挂起阶段边界 |
| `prt_fb90a17fa001JN2zHV5ZsvNcLu` | 最终诊断 JSON，随后 assertion | Shell 830,171 ms 后 user_abort，预算900,000 ms | 参数解析错误后，renderer/shared worker 的释放遗漏 |
| `prt_fb9184dec00100yzpl93rPCEYd` | 全部240轮、完整JSON、算法6839.9195 ms | Shell57,815 ms后 user_abort，预算900,000 ms | 已恢复脚本缺 client.destroy；相邻仅补释放后相同命令8053 ms退出 |
| `prt_0a2d93288001zvQCRGyyFB7ZeB` | 最终启动确认 | Shell51,853,398 ms、exit0，预算180,000 ms | 共享pipe启动拓扑；当前机制可复现 |
| `prt_0b5981dd4001bMWFtQ3m8E7Oar` | HTTP server/日志释放以后最终 ConPTY smoke JSON | Shell90,736 ms，预算90,000 ms | 余下 native/runtime 或 capture；通用关闭server建议不足 |
| `prt_019ea86ba001LK2FcH6BsIw1CA` | scoped Effect.runPromise 之后最终JSON | Shell180,954 ms | imported/global runtime 或 capture，业务processor operation已完成 |

40 条完整清单在 `tmp/post-result-final-case-table.md`。其中测试链的第一段 summary、`RESOLVED` 中间标记、故意挂起的 mock Promise 均与最终探针分开。存在原始脚本已删、历史 root/EOF 时间未记录的条目；逐条归因状态和具体所需证据都已保留，不能以空输出判定工作量。

### 5.3 当前确定的 Harness 首分歧

root exit 与 output EOF 不同。`shell.ts:924` 却只把前者放进成功分支。root 先退出后，race 取消 timer 和 ctx.abort listener；`:951` 输出等待失去两个终止途径。Session adapter 又明确把 Bash 从外层 AbortSignal interruption 中豁免，因而此时用户点击停止仍依赖已消失的 Shell listener。

其后原始读端存在第二项资源缺口：`setupOutput` 将 native stdout/stderr pipe 到 eager PassThrough。NodeStream 消费/销毁 tap，原始 native source 的生命周期没有随 scope 完整释放。Windows root 已退出时 process finalizer 直接返回。

### 5.4 程序仍存活的另一条长尾

已恢复 benchmark 的最终 JSON 位于工作循环之后，shared worker 仍存活。只加 `await client.destroy()` 的相邻修正使同一命令回到约8秒正常返回，是调用程序资源归属的直接历史对照。SSE 成功采样后只清 timer、renderer 抛错绕过 destroy、browser 连接保留等同属显式资源释放问题。Harness 保留原生命令行为，通过原有 timeout/abort 控制整个调用；Agent 的有限探针须在拥有资源的作用域释放它。

## 6. Supported Input Domain and Reachability

| Input / condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| root 已退出、后代持有stdout或stderr | Start-Process、原生spawn | schema仅提供原生command；已审批 | handle.exitCode完成、all仍开 | Shell orchestration / core source所有权 | observed |
| root之后用户取消 | SDK AbortSignal -> ctx.abort | 原有Session取消流程 | adapter明确委托Shell | ShellTool | observed |
| root之后到达原执行deadline | input.timeout/default | 审批完成后spawn才计时 | timer应覆盖调用完成 | ShellTool | observed |
| output先EOF，root仍运行 | 静默/关闭stdout的程序 | 合法命令 | stream完成而exit未完成 | ShellTool | reachable，组件探针observed |
| root后有合法late stdout/stderr | 原生后代/队列中的缓冲 | fork要求输出保真 | eager tap -> output fiber | core/Shell | observed |
| exitCode或stream失败 | 信号退出/OS读取/consumer异常 | adapter返回typed error/defect | 现有raceAll首成功掩盖失败 | ShellTool | observed |
| source/tap在scope取消或无订阅时仍打开 | eager capture | public scoped spawner | NodeStream只拥有tap | core adapter | observed / reachable |
| 探针共享worker、stream或browser未释放 | Agent脚本 | 原生执行保真 | 最终输出后event loop仍活 | 脚本/资源API owner | observed |
| 审批延迟或拒绝 | Permission服务 | 用户明确要求保留 | run之前 | Permission | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 全部审批先于执行，审批时长不消耗执行预算，策略完整保留 | 用户原文 | shell permission gates、precheck现有测试 |
| INV-02 | 一个同步结果；原生命令正文/五字段/schema/shell选择保持 | 用户原文、R9 | native script fidelity、shell-prompt |
| INV-03 | 正常成功同时需要exit outcome和输出消费完成 | fork保真合同 | delayed subscription、post-root drain guards |
| INV-04 | abort与原执行deadline持续覆盖root退出后的输出等待 | 当前真实execute红测 | 本任务补充post-root abort/deadline |
| INV-05 | 取消保留已消费文本、decoder tail及最终metadata，返回原取消语义 | 既有Tool输出合同 | preserves output when aborted |
| INV-06 | 作用域结束释放本地拥有的stdout/stderr source与tap | public scoped spawner | 本任务补充scope resource closure |
| INV-07 | 真实错误及时传播；数值非零退出仍为普通命令结果 | typed adapter/error合同 | exit-error/output-error红测 |
| INV-08 | 正常晚到输出、长静默前台、kill升级及其他spawner消费者保持合同 | 已有用户fork行为 | core、AppProcess、Shell regressions |
| INV-09 | 提示词零修改；原始Python/PowerShell语义和schema保留 | 本轮用户原文、R9 | 既有shell-prompt与native inputs回归，文件零diff |
| INV-10 | 全量分类与最终输出恢复保持准确；未记录阶段单列证据需求 | 用户完整检查要求 | 8102索引与验证JSON |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-04 | 把仅root exit当作race成功完成，撤销abort/timer | ShellTool.run | actual execute：root1457ms退出、1744ms取消、5458ms才返回exit0；timeout1500也失效 |
| INV-06 | native source pipe到tap之后缺少同作用域source释放 | CrossSpawnSpawner.setupOutput | interrupt-only原型返回但两source destroyed=false；补owner release后均关闭 |
| INV-07 | raceAll只接受首成功；output fiber失败无人并行监督 | ShellTool.run | actual execute两个故障注入红测 |
| 调查归因 | 有限探针输出后遗漏所拥有worker/stream清理 | Agent源码/资源owner | 同一benchmark补client.destroy前后历史对照；保持调查结论，生产不增加prompt或源码改写 |

红测命令（cwd=`packages/opencode`，TEMP/TMP设为`D:/Temp/opencode`，使用项目preload的内存DB）：

```powershell
bun test --preload ./test/preload.ts D:/Temp/opencode/post-root-cancellation.test.ts --test-name-pattern 'current-|candidate-interrupt-only' --timeout 20000
bun test --preload ./test/preload.ts D:/Temp/opencode/shell-execute-supervision.test.ts --timeout 15000
```

观察：第一组3项预期失败；第二组4 pass、2 fail。前者为真实进程与当前ShellTool，后者只有公开spawner service seam的故障注入。原型组合对照命令 `--test-name-pattern 'candidate-owned|candidate-normal'` 为3 pass：post-root abort约45ms后返回、deadline按原起点生效、正常case保留late stdout/stderr。原型green尚待实施时转换为实际生产green。

## 9. Responsibility and Seam

| Concern | Owner | Promise | Rationale |
| --- | --- | --- | --- |
| complete outcome与abort/deadline | ShellTool.run | 一个同步命令结果及其取消 | Session adapter已明确委托，沿现有owner修正 |
| 原始capture读端/tap | CrossSpawnSpawner | spawn scope拥有其I/O资源 | 原始Node source只在adapter可达，不增加public stopOutput方法 |
| 正常EOF、解码/压缩与最后metadata | 既有decoder/ToolProgress/Truncate | 保真与终态前flush | 复用现有流程，取消也finalize已捕获字节 |
| 有限程序worker/stream/browser | 创建资源的脚本/API | 完成时释放所拥有资源 | shell不猜测任意程序内部资源 |
| 独立启动的I/O选择 | Agent原始调用/原生Start-Process | 启动确认与后台工作分离 | 通过明确native调用指导，仍过原权限 |
| 审批 | Permission | 用户授权策略 | 全部保留 |

## 10. Single Approved Primary-Path Design

### 10.1 完整生命周期的一次竞争

修改 `oc/src/tool/shell.ts` 的 `run`，保留创建output fiber的位置、decoder.end() finalizer和timer起点。用同时等待exit与output的单个completion替换“只等root”的成功分支：

```ts
const completion = Effect.all([handle.exitCode, Fiber.join(output)], {
  concurrency: "unbounded",
}).pipe(Effect.map(([code]) => ({ kind: "exit" as const, code })))

const exit = yield* Effect.raceAllFirst([
  completion,
  abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
  timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
])
```

`Effect.all` 保证两个正常前提，并立即观察任何typed failure/defect；`raceAllFirst` 保留失败而非等待timeout成功。正常分支已完成消费，后面的无条件join删除。root先退、output先EOF两种次序统一处理；不增加另一套failure observer。

### 10.2 真正取消时结束本地等待

abort/timeout胜出后，按既有字段设置 `aborted/expired`，结果exit code为null。

1. Windows若 `handle.isRunning` 为false，直接进入本地consumer结束；存活Windows root与POSIX进程组保留既有kill/升级责任。
2. 存活root的kill与自然输出排空保留现有500ms宽限；宽限到期执行既有SIGKILL升级。宽限只在已经决定取消后使用。
3. 取消分支最后始终 `yield* Fiber.interrupt(output)`，等待现有decoder.end/onChunk完成；随后不再join已中断fiber。kill与interrupt用 `Effect.ensuring` 组合，确保kill失败也会停止consumer并进入资源释放。
4. root在isRunning检查后退出的竞争：kill失败后复查isRunning；已退出视为终止完成，仍存活则保留原异常传播。该分支只识别终止事实，绝不制造成功命令结果。
5. scope关闭时执行原有progress trailing flush及closeSink；使用现有 `formatShellExecutionNotice` 生成user_abort/timeout。已捕获文本继续走现有压缩、截断和诊断；`truncated`仍只描述大小截断。

此处deadline范围为执行与输出消费；审批、原有终态持久化职责保持。OS终止异常仍作为异常交付，不承诺任意OS故障下的绝对墙钟上界。

失败分支也经过spawn scope释放。为使POSIX上忽略TERM的存活进程在consumer failure时仍使用同一升级策略，将现有500ms提为私有共享常量，两个`cmd()`的ChildProcess options同时设置`forceKillAfter: 500`，与取消宽限引用同值。此参数只约束scope的进程终止阶段；普通执行、审批和用户timeout保持原值。添加真实TERM-resistant输出失败回归，避免只在合成handle中验证错误即时传播。

### 10.3 Core补齐同一capture资源的释放

将 `core/src/cross-spawn-spawner.ts` 中 `setupOutput` 改为scope effect，`:426` 调用点改为 `yield* setupOutput(...)`。保留创建即pipe的eager buffering以及exit/close解耦。

- 在同一个 `Effect.acquireRelease` 中建立stdout/stderr各自的native source、PassThrough和error relay；释放函数持有这两对真实对象。建立资源和注册释放的临界区由acquireRelease负责。
- release对每一对执行 `source.unpipe(tap)`、`source.destroy()`、`tap.destroy()`，以Node流原生幂等行为覆盖自然close、consumer提前退出和无订阅scope关闭。仅释放本适配器创建的capture资源，inherit/ignore无read stream分支保持。
- error relay的监听清理由其同一owner完成，保证关闭期间异步error仍有消费方；在source已关闭后移除relay，不制造未处理的error event。
- release绑定spawn scope，绝不绑定root exit或固定安静时长。正常调用到这里已读到EOF；取消与失败明确结束剩余读取。
- additional Fd、stdin、进程组策略、unref、command piping保持原合同，标准输出资源修复的回归需覆盖这些已存在分支。

共享consumer在scope结束后本就失去handle使用权限，资源补齐不改变其scope内输出。MCP、ripgrep、AppProcess、direct shell的正常及取消测试进入验证。

### 10.4 提示词和原生调用保持

R2按用户最新要求撤销R1的全部提示词提议，`shell/prompt.ts`、`shell/shell.txt`、schema字段说明、错误notice文本及其组装零修改。现有引用、WSL、Python stdin、PowerShell版本指导和R6文字预算测试完整保留，也不引入双基线。

§10.1–10.3直接修正当前执行器的监督和资源所有权。调用脚本的资源遗漏作为已完成调查的一部分保留于§10.5，不通过新增模型指令、自动改写、强制process.exit或改变审批弥补。

### 10.5 调用脚本的具体修正方法

- 已定位benchmark：在拥有的client/renderer创建之后建立try/finally；成功或assertion都调用其实际dispose/destroy；shared TreeSitter使用其共享owner释放API。补`client.destroy()`的单一历史修正已有8.053秒成功对照。
- SSE采样：finally取消owned reader/response，并清timer；单独clearTimeout保留网络流。已读取样本原样输出。
- Promise测试：使用mock的实际resolve/reject控制完成所有已入队工作，随后await idle；故意保持pending的负测由测试框架管理，不能把标记文字视为Promise已完成。
- 部分acquisition抛错：清理放在分配资源却抛错的acquisition owner；调用者拿到对象之后的finally覆盖不到分配中途。
- Python复杂源码使用literal here-string到所选解释器stdin，代码和输入数据同时存在时用显式脚本文件；保留原生 `$` 和反斜杠语义。
- `for ($k=137..173)` 改成 `foreach ($k in 137..173)`；标记查找加长度边界及missing分支；`; elseif` 改成紧邻前一个block的原生分支。
- 4.4MB patch上的`.*tail\(text.*`改为按行字面匹配或有明确边界的正则，此项属于算法计算，不改generic Shell。

这些方法进入测试/复验fixture及调用指导；已删除的历史临时脚本不在生产变更清单中，也不把外部库全部换成强制process.exit。

## 11. Secondary and Replacement Path Inventory

| Path | Current/proposed | Classification | Success? | Decision share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 原生command -> configured shell | current | primary | yes | 主路径 | preserve |
| complete exit+output vs abort/timeout | proposed | primary-contract branch | 正常yes；取消partial | 主路径 | replace旧exit-only race |
| root已退出免于Windows死PID kill | proposed | primary-contract branch | 仅取消语义 | 主路径 | add事实判断 |
| kill失败且确认root已退出 | proposed | primary-contract branch | 仅取消语义 | 主路径 | 容纳真实exit竞争 |
| core scope capture release | proposed | primary resource ownership | n/a | 主路径 | add |
| 层层重试/换shell/改写命令/静默截断 | rejected | forbidden fallback | 会伪造成功 | 0 | reject |
| 现有killGroup到killOne、shell查找 | shipped | existing compatibility | 原合同 | 无扩展 | preserve |
| 新诊断/遥测模块、schema字段 | 未提出 | diagnostic | no | 0 | 不添加 |

新增alternate success路径=0；新增独立diagnostic决策面=0%。测试和plan中的证据表不属于生产决策面。

## 12. Workaround Deletion and Replacement

| Existing item | Problem | Replacement | Location |
| --- | --- | --- | --- |
| 只race root后无条件join | root先退时丢失deadline/abort | 一次完整completion竞争 | shell.run |
| cancel升级后仍join同一output | 可重新绑定剩余writer寿命 | interrupt consumer并释放本地读端 | shell.run |
| 只tap有readable finalizer | native source缺owner release | spawn scope成对释放 | core.setupOutput |
| 研究阶段failure-only observer提议 | 比完整问题少覆盖post-root取消 | 统一Effect.all completion | 只保留本方案 |
| 旧Python适配 | 已移除 | 保持原生执行 | 无新增变更 |

## 13. Forward Traceability

| Invariant | Production path | File/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | ask -> run -> spawn | 保留权限；只改run内部 | 审批Deferred长于执行预算仍不spawn/不消耗预算；拒绝始终不执行 |
| INV-02 | schema/psEncoded/command | 保留原路径 | 现有五字段/原文/退出码/引号码点测试 |
| INV-03/08 | complete outcome | shell.ts Effect.all | EOF先于root、root后late stdout/stderr、静默前台 |
| INV-04/05 | post-root cancellation | shell.ts scope/cancel | 真实writer存活时abort/deadline仍返回已捕获partial+正确notice+durable metadata |
| INV-06/08 | source/tap owned scope | core.setupOutput | 读端scope释放、无订阅、晚订阅、两个并发调用隔离 |
| INV-07 | failure outcome | raceAllFirst/all | exit/consumer failure即时传播，普通exit17保持命令结果 |
| INV-09 | existing native input/render | prompt/schema零diff | 原有shell-prompt、两版PowerShell/Python源码测试直接回归 |
| INV-10 | evidence coverage | 本plan+local ledger | 全部8102disposition、540取消、307metadata输出，保留40最终输出案例 |

## 14. Reverse Traceability

| Proposed concept | Requirement | Evidence | Reuse insufficiency |
| --- | --- | --- | --- |
| 完整completion竞争 | INV-03/04/07 | 真实post-root红测+故障注入 | 当前race只包exit |
| cancel consumer interruption | INV-04/05 | interrupt原型可停止等待 | 原无条件join需要未来EOF |
| source/tap scope release | INV-06 | interrupt-only留下两个native reader | NodeStream只销毁tap |
| Windows dead-root检查与kill竞争处理 | INV-04/05 | 已退出root上taskkill仍可能失败 | isRunning/exit信号是现有可复用事实 |
| 测试故障注入 | INV-07 | OS信号/读错误是public adapter合法错误 | Windows很难稳定制造相同OS异常，使用公开service seam |

## 15. File-Level Change Plan

| File | Operation | Exact responsibility | Estimate |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | modify | 完整竞争、取消consumer、共享既有500ms终止宽限覆盖失败scope与原结果构建 | 40–70有效行 |
| `packages/core/src/cross-spawn-spawner.ts` | modify | setupOutput scoped source/tap ownership与yield调用 | 25–45有效行 |
| `packages/opencode/test/tool/shell.test.ts` | modify | 真进程生命周期红绿、故障seam、必要审批保护；复用既有原生回归 | 160–280有效行 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | modify | native capture scope所有权与无订阅/隔离 | 60–100有效行 |

现有fixture内联有限子脚本，优先不新增仓库文件。生产范围2文件，硬上限5文件/800变更行（新增加删除均计入）；Permission、Config、Session schema、SDK、prompt及外部库保持。测试只断言用户可观察的结果、取消原因、必要输出及资源生命周期；已有测试足以覆盖的语义直接复用，避免重复计数/内部实现断言。

## 16. TDD Behavior Slices

测试seam为公开 `ShellTool.init().execute`、`ChildProcessSpawner.spawn` 的scope合同；`ShellPrompt.render`只跑既有保护测试。采用现有testEffect/fixture，按用户授权的实现目标及本方案批准seam逐个垂直slice执行red/green。审计意见先核对用户要求及本次改动的真实影响，存疑时复用原auditor任务引用具体证据复议。

| Order | Red / protection behavior | Current failure | Minimal green |
| --- | --- | --- | --- |
| 1 | root先exit、捕获最终标记后ctx.abort | 当前返回等待到子EOF且exit0 | complete race+interrupt+source释放，子自然结束前返回user_abort |
| 2 | root先exit、原deadline到达 | 当前timer取消，超预算exit0 | 原timer持续，partial timeout |
| 3 | 仅interrupt tap之后退出scope | native reader仍开 | source/tap成对释放 |
| 4 | 正常root后late stdout/stderr | 保护测试，当前通过 | 保留全部真实输出及decoder tail |
| 5 | output先EOF、root仍活；长静默前台 | 保护测试，当前通过 | 不提前成功 |
| 6 | exit failure、consumer typed error/defect | 首成功race掩盖/延后 | 首完成+并发completion原因传播；真实忽略TERM进程按同一500ms终止策略清理 |
| 7 | live-root timeout/abort、忽略TERM后代 | 现有测试需保持 | 保留kill升级；取消后停止本地剩余读取 |
| 8 | 审批迟延/拒绝 | 保护测试 | spawn与budget仍在审批之后 |
| 9 | scope无订阅/晚订阅/并发scope | 读资源清理/隔离 | scope结束释放，scope内缓冲完整 |
| 10 | 既有prompt/native行为 | 保护测试，现有行为保持 | 提示及组装零修改、原生输入保真 |

真实进程fixture使用ready/release信号、有界自然结束failsafe；先拍证据再做fixture清理，防止测试清理掩盖生产泄漏。资源验证优先使用隔离consumer进程：scope结束后它应自然退出，同时有限后代仍等待测试释放，从public生命周期验证读端不再keepalive；若需适配器级native观测，在隔离进程中转发真实spawn，仅观察OS close事件，不断言私有函数/调用次数。

手动取消专测设置显著长于fixture自然寿命的执行预算，使post-root用户取消稳定成为winner；deadline用独立专测并因果确认root已退出。临时红测中两者共用了1500ms预算，生产回归拆分预算以隔离两个合同。

取消保留已捕获字节，不断言尚未到达的未来字节。比较调用返回与子程序自然结束的因果顺序，不用1秒启动阈值替代正确性。prompt行为例证不冒充模型采样成功率保证；本任务不调用付费模型评测。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective code E | 280–500 | 生产+测试；排除imports/格式/纯移动 |
| Required C | `max(1, ceil(E * 0.15))` | 约42–75行，最终逐行统计 |

邻近解释内容：exit≠EOF、正常/取消两条输出合同、timer属于执行而非审批、source/tap双重所有权、scope而非root绑定、数值退出与Effect错误、因果测试排序、部分字节与未来字节、共享服务回归。每个测试说明实际保护的不变量，避免逐行翻译控制流或为了注释比例堆叠测试断言。

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts --timeout 30000` | packages/opencode | 原生、权限门禁、取消/timeout、最终输出 |
| `bun test test/tool/shell-prompt.test.ts --timeout 30000` | packages/opencode | 既有exactrender/schema/文字预算 |
| `bun test test/tool/shell.test.ts --test-name-pattern 'progress' --timeout 30000` | packages/opencode | 既有文件中的terminal前durable flush |
| `bun test test/effect/cross-spawn-spawner.test.ts --timeout 30000` | packages/core | scope资源、晚订阅、pipe/Fd、kill |
| `bun test test/process/process.test.ts --timeout 30000` | packages/core | AppProcess消费者 |
| `bun test test/shell/shell.test.ts test/session/prompt.test.ts --timeout 30000` | packages/opencode | direct shell/Session取消保护 |
| `bun test test/file/ripgrep.test.ts test/mcp --timeout 30000` | packages/opencode | 共享scope消费者 |
| `bun typecheck` | packages/core | adapter类型 |
| `bun typecheck` | packages/opencode | Tool/测试类型 |
| 同一组在Windows与Linux/macOS的现有runner执行 | 对应package | 原生平台差异、POSIX进程组 |

上述路径已按当前repo核实。progress用例位于shell.test.ts；运行时同时检查匹配到实际用例数量。无SDK/schema/生成变更。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| New production/test files | 0 preferred | 复用2个现有测试文件 |
| Modified production | 2，硬上限5 | 仅两个既有owner |
| Modified tests | 2 | 实际生命周期、adapter资源 |
| Deleted files | 0 | 删除仅限旧join/竞争逻辑 |
| Production effective lines | 65–115，生产新增+删除硬上限800 | 无新API/native框架或提示变更 |
| Tests effective lines | 220–380 | 自然因果fixture，复用现有保护测试 |
| Generated lines | 0 | 无生成链 |

## 20. Real Risks and Open Decisions

### Actual risks

- 关闭本地读端会使仍写入的后代遇到broken pipe；仅取消/timeout/失败或scope结束时发生，正常完成保留真实EOF。
- `core`为共享适配器；scope结束的资源释放应通过MCP/AppProcess/ripgrep回归，不能把source释放提前到root exit。
- decoder/progress/spill的finalizer仍有自己的职责。当前已复现长尾的主要分歧在race/output ownership，未把每个历史pending一概归到同一处。
- 40条历史最终输出案例缺逐次root/EOF时间；已给出程序仍存活、独立启动pipe及阶段待定三个owner组。动态库部分acquisition要在实际资源owner查证后另做精确修改。
- shared worker原型的清理必须按实际API引用计数/所有权实施；禁止粗暴kill所有worker或process.exit掩盖。
- Bash abort/timeout决议与OS进程退出同时发生，以实际first-completion判定；一旦取消获胜保持取消结果，真实kill失败保留异常。

### Open Decisions Requiring the User

用户已明确要求实施到verified，提示词全部保持且不调用question。当前没有需要用户裁决的产品分支；确有证据的审计阻断按原目标全范围修订与重审。

### Rejected Speculation

全局去掉&包装/EncodedCommand/NonInteractive、重新启用Python改写、按输出FINAL/PASS自动返回、按静默时长判断结束、统一提高或缩短timeout、缩短审批、改成异步Bash均不进入方案。实验已经将wrapper字符、原生进程与流所有权分别验证。

## 21. Audit Contract

独立auditor读取本文件与用户原文，从当前repo重新构造生产/测试/调用链。每轮覆盖完整最新要求，检查根因owner、完整取消、输出保真、共享consumer影响、审批保留、prompt零变更、自然测试、5文件/800行上限与15%中文解释注释。primary仅hand off和原样记录verdict；历史数据和临时原型为证据，不能被误写成已实施green。

## 22. Plan Audit Record

历史记录：以下原文及批准仅属于对应 R1/R2，不批准 R3；不得以旧 full-scope 标签缩窄最新原始目标。R3 独立全范围审计尚未进行。

| Round | Revision | Full scope | Findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | Blocking: none; Non-blocking: N-01 | No blocking findings; APPROVE | `ses_f16001a07ffeRBBxLv3zWfGiv3` |
| 2 | R2 | yes | Blocking: none; Non-blocking: N-01 | No blocking findings; APPROVE | `ses_f16001a07ffeRBBxLv3zWfGiv3` |

R2独立审计原文：

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> - **N-01 保留：历史归因边界不变。** 40 条最终输出案例缺少逐次 root exit、EOF 时间戳，不能全部归为同一 Harness 缺陷。R2 §5、§20 明确保留这一限制。
> - 本轮核对了完整 R2，并通过只读 diff 确认此前直接审查的核心源码、测试及相关合同未变。未重新运行测试或 typecheck；实现阶段仍须执行 §18 的验证。
>
> ## Rejected speculation
>
> - 不要求恢复 P1/P2/P3、新增诊断框架、备用执行路径或公共控制接口。Harness 修复本身不依赖新增提示词。
> - 不要求根据最终标记或静默时间提前返回，也不要求修改审批或缩短用户执行预算。
> - 不以审计覆盖率为由增加内部调用次数断言、重复保护测试，或扩展到共享文件中的无关既有问题。
>
> ## Requirement and traceability coverage
>
> 本轮覆盖完整原始要求、R2 全部拟修改区域及其直接影响路径。
>
> | 范围 | 审计结论 |
> |---|---|
> | 审批、同步接口及原生命令 | 保持 `ask → run → spawn`；审批时间不进入执行预算；schema、shell 选择和原始正文不变。 |
> | root 退出后的取消与 timeout | §10.1 将 exit 与输出消费合为唯一 completion，使 abort/deadline 持续覆盖输出等待，直接修复 `packages/opencode/src/tool/shell.ts:924` 的首分歧。 |
> | 错误与取消清理 | 首完成竞争传播真实错误；取消结束 output consumer；既有 500ms 升级策略覆盖失败时的进程 scope 清理，保留数值非零退出合同。 |
> | capture 所有权 | §10.3 在 `packages/core/src/cross-spawn-spawner.ts:240` 补齐 source/tap 的 scoped 释放，保留 eager buffering、晚到输出及 exit/EOF 解耦。 |
> | 输出及共享消费者 | decoder、progress durable flush、截断和 notice 保持；AppProcess、ripgrep、MCP 等消费者继续按既有 scope 合同使用资源。 |
> | 调用构造调查 | Python、独立启动及 owned resource 的具体修正方法保留于 §10.5；没有转成自动改写或额外模型指令。 |
> | 测试敏感性 | post-root abort/deadline、原始读端释放及错误监督测试可以揭示旧缺陷；正常输出、权限和原生语义复用既有保护测试。 |
> | 变更约束 | 计划仅改 2 个生产文件、2 个测试文件；提示及组装零修改；生产新增与删除合计受 800 行、最多 5 文件约束。 |
>
> 正向需求与反向生产概念映射成立。R2 删除提示提议和双基线测试后，没有留下依赖它们才能成立的 Harness 行为。
>
> ## Primary-path and fallback verdict
>
> 通过。
>
> 正常完成只有一个权威条件：**exit outcome 与输出消费均完成**。abort/timeout 保持取消语义；dead-root 检查处理真实退出竞争，不尝试另一套执行算法。
>
> 旧 exit-only race 和无条件 join 被替换，资源释放回到 adapter owner。新增 alternate-success 路径为 **0**，新增独立 diagnostic 决策面为 **0%**。
>
> ## Code quality and Chinese-comment verdict
>
> 计划阶段通过。
>
> 方案主要调整既有监督与释放逻辑，不新增公共 API、配置、依赖或生产测试接口。测试约束明确要求自然的可观察结果、因果排序及资源生命周期证据，无须为审计额外扩充分支。
>
> §17 承诺 `C >= max(1, ceil(E × 0.15))`，估计 `E=280–500`、`C=42–75`。实际代码质量、生产修改行数及 E/C 必须在实现 diff 上独立核算。
>
> ## Release verdict
>
> **APPROVE — 仅批准 `docs/plans/bash-post-result-lifecycle-and-native-invocation.md` 当前 R2，full-scope。**
>
> 本结论批准计划，不代表已经达到 `verified-implementation`。该终态仍需实际修复、行为红绿验证、相关回归与完整独立实现审计。

独立审计原文（行政记录；实施仍须遵守§2、§20中的用户确认边界）：

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> - **N-01：历史归因仍有明确边界。** 已读取的历史材料没有逐次 root exit、输出 EOF 或最终输出时间戳。40 条案例能够证明“最终业务输出后调用仍未结束”，不能全部归因为同一个 Harness 缺陷。R1 §5、§20 已保留这一限制，不影响当前可复现主路径的修复批准。
> - 本轮直接检查了源码、测试、实验脚本和已有结果文件；未重新执行实验、测试或 typecheck。已有原型结果仅支持方案可行性，生产实现仍须完成 §16、§18 的验证。
>
> ## Rejected speculation
>
> - 不要求依据 `PASS`、最终 JSON 或静默时间提前返回；这些信号无法证明进程与输出消费已经完成。
> - 不要求缩短审批、统一缩短 timeout、改成异步 Bash，或增加替代 shell、Python 改写及备用 launcher。
> - 不把共享文件中未改动的其他兼容路径、additional Fd 或 Session 持久化逻辑自动扩展为本次修复范围；当前未发现 R1 会使其缺陷新增可达的证据。
>
> ## Requirement and traceability coverage
>
> | 范围 | 独立核对结果 |
> |---|---|
> | 审批及执行预算 | `packages/opencode/src/tool/shell.ts:1139` 的审批发生在 `run` 之前；R1 保留这一顺序及权限内容，补充延迟审批、拒绝审批测试。 |
> | 同步接口与原生命令 | `packages/opencode/src/tool/shell.ts:424`、`packages/opencode/src/tool/shell/prompt.ts:23` 支持现有 shell、原生命令与五字段合同。方案不新增后台交互接口。 |
> | root 后挂起 | `packages/opencode/src/tool/shell.ts:924` 只竞争 root exit；随后 `:951` 无界等待输出。`packages/opencode/src/session/prompt.ts:1292` 又将 Bash 取消交给 Shell 自身处理。首分歧与责任 owner 均成立。 |
> | 错误及时传播 | 已核对安装版 Effect 的 `raceAll` 首成功语义和 `raceAllFirst` 首完成语义。完整 completion 同时监督 exit 与 output，覆盖当前错误延后路径，并保留数值非零退出结果。 |
> | capture 资源释放 | `packages/core/src/cross-spawn-spawner.ts:251` 创建 source→tap；NodeStream 的 finalizer 只销毁传入的 tap。R1 将两者绑定 spawn scope，保留 eager buffering 与 exit/EOF 解耦。 |
> | 输出、取消与终态 | 保留 decoder finalization、已消费文本、progress durable flush、截断及 notice；正常完成仍等待完整输出，取消后明确结束本地消费。 |
> | 共享调用者 | 核对 AppProcess、ripgrep、Project git、MCP 的实际 scoped 使用路径；修复发生在 scope 释放边界，未提前到 root exit。 |
> | 提示与调用构造 | P1–P3 分别对应 owned resource 清理、Windows 独立启动的 pipe 归属、Python 原生 stdin 入口；有源码、既有测试或差分实验支持。 |
> | TDD 与验证 | §16 的 post-root abort/deadline、资源释放及错误监督测试对旧行为敏感；保护测试覆盖晚到输出、提前 EOF、权限、原生语义与共享消费者。§18 使用 package 内测试及 typecheck。 |
>
> 正向需求映射与反向生产概念映射完整。500ms scope 强杀升级也有明确用途：避免输出失败已经被观察到，却继续卡在忽略 TERM 的进程释放阶段。
>
> ## Primary-path and fallback verdict
>
> 通过。
>
> - 正常结果只有一个权威路径：**exit outcome 与 output consumption 同时完成**。
> - abort/timeout 返回明确的取消结果；本地 reader 结束不伪装成正常成功。
> - Windows dead-root 判断及 kill 后复查只处理终止事实，不重试另一套执行算法。
> - source/tap 释放属于 adapter 的资源所有权；脚本内部 worker、stream、server 的释放仍归其创建者。
> - 新增 alternate-success 路径为 **0**；新增独立 diagnostic 决策面为 **0%**。
>
> ## Code quality and Chinese-comment verdict
>
> 计划阶段通过。
>
> 修改集中于两个既有 owner 和两个提示承载位置，无新公共 API、配置或依赖；旧 exit-only race 与无条件 join 有明确删除安排。
>
> §17 承诺按实际有效代码计算 `C >= max(1, ceil(E × 0.15))`，估计 `E=345–580`、`C=52–87`，解释内容与变更决策相邻，具有可执行性。本轮没有实现 diff，实际 E/C 留待实现审计独立计算。
>
> ## Release verdict
>
> **APPROVE — 仅批准 `docs/plans/bash-post-result-lifecycle-and-native-invocation.md` 当前 R1，full-scope；核对基线为 `378033d16a3662197a264fb3fe96ef2e74a8c5f1`。**
>
> 这是计划批准。生产实施及三处精确提示修改仍遵守 R1 中的用户确认边界；实现完成后必须提交实际 diff、红绿测试及完整独立实现审计。

任何实质性修订提升revision并清除approval。记录独立verdict使用原文，行政记录不夹带设计变更。

## 23. Implementation Evidence

历史 R2 实现证据，完整保留。本节通过项是取消/错误监督与资源释放的已验结果，不是 R3 正常结束根修的 green，也不是全部历史案例归因完成。

### Actual Files and Diff

批准revision：R2。仅改以下4个实现/测试文件及本plan，原有其他工作区内容保持。

| File | Diff | Necessity |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | +36 / -20 | 完整exit+output竞争；取消consumer；既有500ms终止宽限复用；真实退出竞争处理 |
| `packages/core/src/cross-spawn-spawner.ts` | +32 / -13 | 原始stdout/stderr与tap的同scope释放；既有source error relay保留至close |
| `packages/opencode/test/tool/shell.test.ts` | 9个新case | 3个真实post-root分支、4个adapter完成/错误分支、真实存活root失败清理、审批后计时 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | 3个新case | 无订阅/中断后的真实pipe closure，两个scope隔离 |

生产2文件、新增+删除共101行，低于5文件/800行上限。提示词、schema字段说明、配置、Permission及reviewer均零diff。实际实现保持同一个capture路径，没有新公共API、配置、依赖、迁移或native launcher。

### Red-Green Test Evidence

1. Core真实无订阅后代写入测试：旧实现返回`open|open`，预期`closed|closed`；RED为0 pass/1 fail。补scope资源释放后同一测试1 pass，后续3个ownership测试与原有晚订阅测试全部通过。
2. 仓库ShellTool真实取消测试：旧实现返回`ROOT_FINAL/HOLDER_READY/LATE_STDOUT/LATE_STDERR`且缺user_abort，RED为1 fail。完整生命周期修复后该测试及既有abort组13 pass。最终精简合并的post-root suite为9 pass、21 assertions。
3. 规划期真实`ShellTool.execute`退出/输出故障反馈环原为4 pass/2 fail；生产修复后6 pass、29 assertions。普通数值exit17、root后decoder/progress排空、审批等待及拒绝均保留。

### Verification Commands and Results

Windows Bun 1.3.14，命令均在相应package执行：

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | packages/opencode | 241 pass、0 fail，1230 assertions |
| `bun test test/tool/shell.test.ts --test-name-pattern 'tool.shell post-root lifetime' --timeout 30000` | packages/opencode | 最终fixture9 pass、0 fail，21 assertions |
| `bun test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp --timeout 30000` | packages/opencode | 68 pass、1既有skip、0 fail |
| `bun test test/session/prompt.test.ts --timeout 30000` | packages/opencode | 115 pass、14既有skip、0 fail；459.03秒 |
| `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | packages/core | 50 pass、0 fail，89 assertions |
| `bun typecheck` | packages/opencode | PASS |
| `bun typecheck` | packages/core | PASS |
| `git diff --check -- <四个实现/测试路径>` | repo | PASS |

首次合并Session回归的外层命令预算300秒用尽；拆分后provider-retry单例通过，完整文件在900秒外层预算内完成。`temporary reviewer outage`为既有503重试fixture输出，最终该case及完整文件通过。生产审批/执行预算保持原值。

Linux（WSL Ubuntu-22.04、Bun1.3.14、Node22.16）补验：Windows安装的node_modules junction在WSL原样运行报ENOENT，因此将当前代码与原测试打包到`D:/Temp/opencode`的隔离产物，未变更共享依赖或仓库文件。

- `linux-core-spawner.test.js`：原core完整spawner测试，29 pass、0 fail、42 assertions。
- `linux-shell-bundle/linux-shell-entry.test.js --test-name-pattern 'tool.shell post-root lifetime|tool.shell abort' --timeout 30000`：22 pass、0 fail、65 assertions，覆盖POSIX进程组与实际TERM-resistant root的失败清理。
- 构建脚本`D:/Temp/opencode/build-linux-shell-probe.ts`使用既有`OPENCODE_MIGRATIONS`编译入口携带29个migration，只把测试的projectRoot/models-api路径定位到Linux对应路径，生产源码及断言不改。此前隔离bundle的migration相对路径缺失已通过这个标准构建入口解决。

Linux运行环境显式PATH包含`/mnt/d/Temp/opencode/bun-linux-x64`与`/mnt/d/Temp/opencode/node-v22.16.0-linux-x64/bin`，TMPDIR为`/mnt/d/Temp/opencode`。原生Windows全套是主要集成验证，Linuxbundle是额外平台行为验证。

### Original Feedback-Loop Result

cwd=`packages/opencode`，TEMP/TMP设为`D:/Temp/opencode`，通过项目preload使用隔离XDG与`:memory:`数据库：

```powershell
bun test --preload ./test/preload.ts D:/Temp/opencode/post-root-cancellation.test.ts --test-name-pattern 'current-' --timeout 20000
bun test --preload ./test/preload.ts D:/Temp/opencode/shell-execute-supervision.test.ts --timeout 15000
```

第一组旧实现两项RED，修复后2 pass、19 assertions：真实root后ctx.abort在约11ms完成返回，保留`FINAL_RESULTS/POST_ROOT_BYTES`，code=null、user_abort，两个native reader已destroy，返回时有限后代尚未结束。timeout同样在原1500+100ms预算附近返回partial timeout。第二组6 pass、29 assertions。

正常case和原有final-metadata测试继续确认root后的late stdout/stderr及durable flush完整交付；不依赖静默窗口或业务输出文字推断结束。

### Actual Secondary and Replacement Paths

- 正常路径：同一个exit+output completion；移除旧exit-only race及其后的无条件join。
- abort/timeout路径：沿用kill/升级，最终interrupt consumer并释放owned capture；显式partial取消结果。
- Windows dead-root及kill之后真实退出：复用isRunning事实，保持选定取消语义；真实存活root错误仍传播。
- 既有killGroup到killOne与shell配置选择原样保留；零新增alternate-success路径，零新增独立diagnostic决策面。

### Chinese Comment Calculation

`D:/Temp/opencode/count-bash-repair.mjs`按四个文件的git diff新增非空行保守统计，排除import-only行与注释，连括号和fixture源码行都计入E；没有通过排除格式展开行缩小分母。中文注释逐行列入`bash-repair-comment-count.json`供独立语义复核。

| File | E | C |
| --- | ---: | ---: |
| core/src/cross-spawn-spawner.ts | 28 | 4 |
| core/test/effect/cross-spawn-spawner.test.ts | 75 | 12 |
| opencode/src/tool/shell.ts | 27 | 9 |
| opencode/test/tool/shell.test.ts | 207 | 28 |
| Total | **337** | **53** |

`C/E=15.73%`，最低`ceil(337×0.15)=51`。代表性解释：root与EOF双条件、timer不包含审批、NodeStream仅拥有tap而原始source属于spawn scope、POSIX取消进程组与Windows死root的区别、真实ready信号与自然fixture清理、错误对象与真实root存活状态共同验证。

### Remaining Verification Boundaries

Windows主要回归和Linux补验已执行；macOS运行环境在本机不可用。历史40条记录的逐次root/EOF归因边界继续保留；此次验证证明当前主路径缺陷及修复，不将所有历史worker/native库问题归为同一原因。独立实现审计已完成并原样记录于§24。

## 24. Implementation Audit Record

历史 R2 独立 verdict 原样保留；其中终态结论不得用于最新澄清后的 R3。当前未批准、未实施 R3，无 R3 实现审计结论。

| Round | Plan revision | Full original scope | Blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | none | No blocking findings; APPROVE | `ses_f16001a07ffeRBBxLv3zWfGiv3` |

本轮首次回复为验证待完成，未提出代码级阻断；primary引用用户既有GOAL验证授权后，同一auditor继续本轮完整验证，期间实现diff未变。以下为最终独立verdict原文：

> ## Blocking findings
>
> No blocking findings.
>
> 此前的验证待完成状态已解除；本轮独立验证未发现需要修改实现的阻断问题。
>
> ## Non-blocking findings
>
> - **N-01 保留：历史归因边界。** 40 条历史案例缺少逐次 root exit/EOF 时间戳。本次验证证明当前主路径缺陷得到修复，不能据此将所有历史长尾归为同一原因。
> - macOS 未执行。Windows 使用仓库原始测试完成主要验证；Linux 使用隔离 bundle 完成补验。
>
> ## Rejected speculation
>
> 不要求新增提示词、诊断框架、备用执行路径、公共控制接口或内部调用次数断言。没有发现需要扩充生产分支才能满足当前要求的证据。
>
> ## Requirement and traceability coverage
>
> 完整检查覆盖四个实现/测试文件的全部 diff、批准计划 R2、原始需求及直接相关的生产者—消费者路径。
>
> - 审批仍先于执行，审批等待不消耗命令预算；同步接口、原生命令、schema 和提示保持不变。
> - `packages/opencode/src/tool/shell.ts:930` 同时监督 exit 与输出消费，取消和 deadline 持续覆盖 root 后等待。
> - `packages/opencode/src/tool/shell.ts:938` 保持取消结果，结束 consumer，并沿用既有终止升级策略。
> - `packages/core/src/cross-spawn-spawner.ts:252` 将 source/tap 释放绑定 spawn scope，保留 eager buffering、正常晚到输出和共享调用隔离。
> - 新测试针对真实生命周期和可观察结果；既有权限、输出、原生语义及共享消费者回归未被削弱。
>
> **独立执行结果**
>
> 以下 `oc` 指 `packages/opencode`，`core` 指 `packages/core`：
>
> | 命令 | 工作目录 | 结果 |
> |---|---|---|
> | `bun test test/tool/shell.test.ts --test-name-pattern 'tool.shell post-root lifetime' --timeout 30000` | oc | 9 pass，0 fail |
> | `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | core | 50 pass，0 fail |
> | `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | oc | 241 pass，0 fail |
> | `bun test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp --timeout 30000` | oc | 68 pass，1 skip，0 fail |
> | `bun test test/session/prompt.test.ts --timeout 30000` | oc | 115 pass，14 skip，0 fail |
> | `bun typecheck` | oc、core 分别执行 | 均通过 |
> | `git diff --check -- <四个审计文件>` | 仓库根目录 | 通过 |
>
> Session 日志中的 503 已核对为 `packages/opencode/test/session/prompt.test.ts:2043` 的既有故障夹具，完整测试最终通过。
>
> **原始反馈环**在 oc 目录使用项目 preload、隔离临时目录重新执行：
>
> - `post-root-cancellation.test.ts --test-name-pattern 'current-'`：**2 pass**。root 后手动取消约 **37ms** 返回；输出保留、退出码为 null、原始读端已释放，返回时后代尚未结束。timeout 同样返回明确的部分结果。
> - `shell-execute-supervision.test.ts`：**6 pass**。真实错误及时传播；提前 EOF 不提前成功；数值退出码 17、最终 durable metadata 和权限门禁保持。
>
> **Linux 补验：**Core bundle **29 pass**；Shell lifetime/abort bundle **22 pass**。Shell 首次从仓库 package 目录运行时，额外加载 Windows 依赖 preload，因 junction 解析失败而未进入测试；改从 `D:/Temp/opencode/linux-shell-bundle` 使用 bundle 内置 preload 后通过。没有修改源码、断言或依赖来绕过失败。
>
> ## Primary-path and fallback verdict
>
> 通过。
>
> 正常结果只有一条权威路径：**exit outcome 与输出消费均完成**。取消保持取消语义，真实错误继续传播；旧 exit-only race 和无条件 join 已移除。
>
> 新增 alternate-success 路径为 **0**，新增独立 diagnostic 决策面为 **0%**。资源释放位于既有 owner，未引入替代执行算法。
>
> ## Code quality and Chinese-comment verdict
>
> 通过。
>
> 生产修改仅 **2 文件，新增 68 行、删除 33 行，合计 101 行**，符合 5 文件/800 行限制。提示词、schema、Permission 和 reviewer 未修改；无新增公共 API、配置或依赖。
>
> 独立读取 diff、计数并复核注释语义：
>
> | 文件 | E | 合格 C |
> |---|---:|---:|
> | Core spawner | 28 | 4 |
> | Core tests | 75 | 12 |
> | Shell | 27 | 9 |
> | Shell tests | 207 | 28 |
> | **合计** | **337** | **53** |
>
> 排除 import-only、空行及注释行；修改代码按新增侧计入 E，不重复计算删除侧。`C/E = 15.73%`，达到 15% 目标，也通过审计硬门槛。
>
> ## Release verdict
>
> **APPROVE — 批准当前四文件实现 diff，基于批准计划 R2，full-scope。**
>
> 此前阻止放行的独立验证缺口已关闭。当前实现满足 `verified-implementation` 的审计条件；主代理可将本 verdict 原样记录到 canonical plan，再更新状态。本轮审计未修改生产、测试源码、提示词或 Git 状态。

## 25. R3 Design History and Evidence Boundaries

本节为R3历史设计；当前R4以§26补齐新增复现、依赖交付和全范围验收。保留原设计脉络，不将旧draft结论或后来已补齐的证据缺口当作当前状态。

### 25.1 Revision Boundary and Success Contract

本轮先完整读取 R2 共703行（含全部审计记录），再读取当前 dirty 源码和新增实验材料。仅修订本 canonical，不改现有四文件实现、不撤回 R2、不执行历史工作负载、不重跑已中止的 installed binary、不读取或操作 live daemon 的锁/数据库/控制端点。此次诊断复用已执行的隔离实测及原始结果，不把重跑已知探针当作推进全范围归因的替代品。

R3 继承 INV-01–10，补充以下稳定要求。R2 的 abort/deadline 和失败清理修复继续作为生命周期安全基线；“更快报错/取消/超时”不能满足新增正常结束验收。

| ID | Required invariant | Evidence class | Acceptance |
| --- | --- | --- | --- |
| INV-11 | 普通 Shell 子命令不因隐式继承父 OpenCode role/runID 而成为内部 worker 或复用父运行身份 | observed | 真实有限 child 的 metadata 为 main、非空且不同于父 runID；无取消、正常 exit0 与完整输出 |
| INV-12 | 普通环境、UTF-8 设置、显式 shell.env 覆盖优先级保留；专门 daemon 启动仍能显式指定 worker | contracted | 真实 child 可见无关继承变量及插件最终值；隔离显式 worker 启动合同仍成立 |
| INV-13 | 不该发生的正常结束长尾须定位并修复首分歧；不得用 deadline、静默窗口、最终文字或强制 exit 替代真实完成 | contracted | exit outcome + stdout/stderr EOF/消费 + Tool/Session 完成链证据；scope OPEN 项不能借角色修复闭合 |
| INV-14 | 全范围调查明确区分历史证据、当前源码、已部署产物，以及审批和实际执行时间 | contracted | 每个 owner 未知项保留确切缺失证据；101分钟审批污染 pair 不作已确认执行挂起 |

本次已完成的是 R3 文档修订和已知首分歧设计，不是全部任务完成。没有需要用户裁决的产品选项；缺口是可验证事实，不调用 question、不 commit/push。生产累计预算继续按最初实现基线计算，不能因修订号归零。

### 25.2 Additional Sources and Observed Signals

已加载 first-principles-planning、diagnosing-bugs、tdd、effect；完整读取 policy、canonical template、CONTEXT、根/package/test AGENTS 和 ADR 索引（唯一现有 ADR 为 triage，无 Shell 生命周期决策），并读取 TDD tests/mocking 参考。以下新增证据与 §4 历史索引共同供独立审计；临时报告不是实现批准。

| Evidence | Observation / relevance | Class |
| --- | --- | --- |
| `oc/src/tool/shell.ts:426,778,911,930,1155,1172` | 两个 cmd 分支使用同一 explicit env；shellEnv 直接扩展 process.env；权限先于环境和 run；当前已采用 R2 completion | observed |
| `core/src/util/opencode-process.ts:8,12,19` | metadata 使用 ??= 保留显式身份；现有 sanitizer 仅删除两个内部身份键，复制其他已定义值且支持 overrides | observed |
| `oc/src/index.ts:45,51,116`、`oc/src/cli/cmd/tui/worker.ts:24` | worker role 在 yargs/version 前分流，真实 server 保持存活 | observed |
| `oc/src/cli/cmd/tui/daemon.ts:334,374`、`oc/test/cli/tui/daemon.test.ts:2022` | daemon 有意 sanitize 后设置 worker/runID；已有 source-entrypoint 合同验证此路径 | contracted |
| `node_modules/effect/src/unstable/process/ChildProcess.ts:545,720,747`、实际 `dist/unstable/process/ChildProcess.js` 运行时选项检查 | make 原样保存 options，不默认添加 extendEnv=true | observed |
| `.opencode/references/effect-smol/packages/effect/src/unstable/process/ChildProcess.ts:383,625,630` | 参考源码的同一选项语义；以实际安装运行时为准 | observed |
| `core/src/cross-spawn-spawner.ts:107,298,413`、`node_modules/cross-spawn/index.js:12`、`lib/parse.js:65` | 只有 truthy extendEnv 合并父环境；否则传 explicit env；cross-spawn 浅复制 options 后交 native spawn | observed |
| `packages/plugin/src/index.ts:269`、`oc/src/plugin/index.ts:401`、`oc/test/plugin/trigger.test.ts:47` | 现有 shell.env 公共 hook 可修改 env；本地 file plugin fixture 可复用，无需生产测试入口 | contracted |
| `tmp/process-role-normal-return-findings.md`、`process-role-shell.test.ts`、`process-role-shell-results.json` | 真实 ShellTool 与真实 metadata helper 的角色泄漏及 sanitizer 对照 | observed |
| `tmp/entry-role-isolated.mjs`、`entry-role-isolation-preload.mjs`、`entry-role-isolated-results.json` | 真实入口 clean --version exit0+EOF；worker 环境同 argv 进入健康 server，清理前仍活 | observed |
| `tmp/conda-historical-report.md`、`conda-normal-completion-findings.md`、`conda-session-integration-report.md` | 历史语义分类、当前 Conda 原生对照、真实 Session 完成链；覆盖限制见下表 | observed |
| `tmp/normal-eof-stress-findings.md`、`tree-client-lifecycle-findings.md`、`inheritance-flag-falsification-findings.md` | EOF压力/worker生命周期当前返回对照；全局 noninherit 候选破坏正常输出 | observed |
| `tmp/git-approval-pair-artifacts.json`（空数组）、pair 查询脚本（仅阅读，未执行）及本轮用户提供的 log 核对结论 | 两个 Part 无存续 DB 证据；审批污染时长不得归入执行 stall，本轮不重新访问用户 DB | contracted |

新增角色探针的已执行命令和观察（本轮只读取既有结果）：

```powershell
# cwd packages/opencode；该实验进程 TEMP/TMP 为 D:/Temp/opencode，OPENCODE_DB=:memory:
bun test --preload ./test/preload.ts D:/Temp/opencode/process-role-shell.test.ts --timeout 30000
# cwd D:/Temp/opencode；全部新 config/db/home/lock、loopback 临时端口隔离
bun D:/Temp/opencode/entry-role-isolated.mjs
```

第一组1 pass/0 fail/9 assertions是**确认缺陷与对照**，不是生产 green：原 ShellTool child 得到 worker/`finite-role-probe-parent-run`；临时 service-boundary sanitizer 对照得到 main/fresh runID，二者保留 `preserve-user-env` 且自然退出。原探针明确断言旧模式为 worker，不能原封不动当修复回归，否则修好反会失败。

第二组 clean 源入口打印 `local`，stdout/stderr EOF约4129ms、exit0约4151ms；worker 环境在约4172ms已发布自己的健康 server，尚无 version 输出、root exit 或 EOF，随后仅终止所创建 PID。清理后的 SIGTERM/EOF不是正常 --version 完成。preload 只把 test-owned HTTP bind 从请求4096改到127.0.0.1:0，未知形状先报错；另一个 control listener 本就使用临时端口。配置、数据库、锁和访问的 health 全归该 probe，不接触 live daemon。该对照证明错误入口路由，不证明已中止 installed --version 的具体历史原因，也不是完整 ShellTool 嵌套入口端到端 green。

### 25.3 First Divergence, Domain and Owner

```text
daemon 有意持有 worker/父 runID
-> 普通 Bash 审批成功
-> ShellTool.shellEnv 扩展 process.env                FIRST DIVERGENCE
-> cmd explicit env -> 当前 Effect make -> CrossSpawnSpawner -> native shell
-> 用户调用独立 OpenCode CLI
-> ensureProcessMetadata("main") 保留继承的 worker/父 runID
-> index.ts 在 yargs 之前进入永久 worker；--version 根本未执行
```

这不是“命令已完成但丢失 EOF”的实例，而是 producer 把有限 CLI 调用错误地转成服务。真实 source probe 中 worker 健康而未返回符合错误入口的生命周期；调短 timeout 只会终止错误进程，不会使版本命令运行。首次破坏 INV-11 的 owner 是普通 Shell 环境构造，不是 metadata helper 或 daemon dispatcher。

| Reachable input | Producer / guarantees | Owner / disposition |
| --- | --- | --- |
| 父 daemon worker/runID 被普通命令隐式继承 | daemon.ensure 显式构造自身身份；ShellTool 原 env 未隔离 | ShellTool 调用既有 sanitizer，不改全局 process.env |
| 任意普通自定义变量、PATH、Conda变量 | 父环境与既有 UTF-8 policy | 保留；不做新 allowlist 或扩展删除 OPENCODE_* |
| shell.env 显式注入 role/runID 或覆盖 UTF-8/用户变量 | Plugin 公共 string-record hook，无禁止这些键的合同 | 保留最后覆盖，sanitizer 只处理 base；这是显式传递而非隐式泄漏 |
| daemon.ensure 显式 worker 启动 | 既有 daemon/compiled-entrypoint 合同 | daemon 继续 sanitize 后 overrides；index/helper 不改 |
| 用户命令内部显式 env 设置、普通 wrapper/Conda/native 程序 | 已审批原生命令 | 不解析/重写正文，实际原生行为保持 |

### 25.4 Exact Minimal Primary Repair

仅在 `packages/opencode/src/tool/shell.ts` 新增既有 `sanitizedProcessEnv` 的 import（`@opencode-ai/core/util/opencode-process`），将 shellEnv 返回对象的基础展开改为：

```ts
return {
  ...sanitizedProcessEnv(),
  ...utf8Env,
  ...extra.env,
}
```

hook 调用位置和 await 顺序不变，UTF-8构造不变，显式插件覆盖仍最后执行。不在最终合并后再删 role/runID，不改 helper 的 ??=，不清理父进程身份，不新增 env helper，不更改 core 全部 spawn。普通变量仅沿既有 sanitizer 排除 undefined 的已有行为；无需自建第二套过滤器。

**实际 spawn 的 extendEnv 已核实，不猜测库默认值。** 本轮在 `packages/opencode` 执行只构造 command、不 spawn 的命令：

```powershell
bun -e 'import { ChildProcess } from "effect/unstable/process"; const env = { R3_PROBE: "kept" }; const command = ChildProcess.make("unused-no-spawn", [], { env }); console.log(JSON.stringify({ resolved: import.meta.resolve("effect/unstable/process/ChildProcess"), options: command.options, hasExtendEnv: Object.hasOwn(command.options, "extendEnv"), sameEnv: command.options.env === env }));'
```

实际解析到本仓库 `node_modules/effect/dist/unstable/process/ChildProcess.js`；输出 `options={env:{R3_PROBE:"kept"}}`、`hasExtendEnv=false`、`sameEnv=true`。安装源码 makeStandardCommand 原样保存 options，make 的 array 分支只默认 options={}；core env 函数仅 `opts.extendEnv ? {...process.env,...opts.env} : opts.env`。两条 Shell cmd 分支都传非空 explicit env 且未设置 extendEnv，native 层不会因 env 缺两个键而补回父环境。既有实际 sanitizer 对照的 child 结果也符合此链。

因此 R3 **不增加两个 `extendEnv:false`**：在当前实际依赖/adapter下它们没有额外修复行为。不是因为忘记检查，也不依赖其他版本“默认false”的笼统假设；真实 child 回归必须覆盖两种 cmd 分支，若实际边界出现不同合并行为则该验证失败，需回到 owner 修订本计划，不能静默扩改 core。若未来依赖默认值发生变更，测试应暴露它，不能在本轮为假设添加兼容层。

§10.1–10.3 的 R2实现保留并回归；本次新增根修不改变完成条件、deadline、kill、scope释放、进程组、raw command、schema、prompt、审批或输出。新路径为一次 base-env producer 修复，正常结果仍只有 exit+完整输出的一条路径。

### 25.5 Full-Scope Assessment and Open Evidence

| Original scope / cohort | Current evidence | Disposition and evidence still required |
| --- | --- | --- |
| 全量历史最终输出案例，§5的40条与8102详细调用 | 原扫描/恢复材料保留；无逐次历史 root/EOF 时间 | **OPEN**。逐项区分最终业务输出、程序退出、剩余writer和Tool/Session；不能把40条全部归角色泄漏或R2 race |
| root后abort/deadline、consumer/source释放 | §23/24 R2真实红绿与独立审计 | 已验证的局部安全修复，继续回归；不是正常结束根修完成证据 |
| 普通子进程 worker-role 泄漏 | 实际 ShellTool/helper 和实际入口两段实测 | **已定位、设计具体、未实施**；还缺仓库红绿和真实 ShellTool嵌套入口自然返回验收 |
| Conda/Python历史 | 2032 lexical调用全量材料，60个本地 conda run调用全部返回（58 exit0、2 COM非零），最大Shell30846ms | 不混淆词法命中/调用数/子进程数；未发现可确认的前台Conda整段最终输出后stall，不否定用户报告。动态/嵌套语义和相关历史 owner仍保留限制 |
| 当前Conda正常完成 | 7形式×2次×Tool/native两路径=28真实命令，均exit0和完整输出；OS root后Tool15–44ms | 已测形式无正常完成red，不改Conda/编码/wrapper；任意历史扩展库/激活hook/其他平台未获证明 |
| 真实Session正常完成 | 12 turns/28 Bash；真实Permission显式allow、SDK result、durable completed、next-model全部匹配 | 已测有限并发/压缩开关无stall；shared TEMP的8/14 exit3是Conda执行前临时文件冲突，正常返回，非本次post-result根因。每调用TEMP隔离只是实验条件，不加入生产 |
| native/tap/Effect EOF与Tool返回 | 752验证执行通过，含迟订阅、背压、空输出、并发；48 follow-up记录真正execute边界 | 未复现lost-EOF；曾见约1.75s额外耗时发生在Tool已返回后的测试scope，不计Tool挂起。非所有race不存在的证明 |
| shared TreeSitter worker/renderer | 28 finite probes自然exit0；其中4个outstanding-destroy是取消清理，非成功parse证据 | 历史缺client.destroy的caller已有相邻8053ms成功对照且当前已补；不改库unref/force exit。六测试/full suite及另一个lifecycle benchmark仍 **OPEN**，后者补shared cleanup后仍超时，不能归同一遗漏 |
| 显式文件重定向的独立启动持有pipe | noninherit差分可消除这类继承等待，但也丢直接Python、Conda及合法前台/后代stdout/stderr且exit0 | **OPEN** 的具体owner/保真修复设计；全局清HANDLE_FLAG_INHERIT已证伪，不以此替换capture，不加恢复分支 |
| 约101分钟两个Git tool日志时长 | 用户提供的log核对已确认审批污染；pair `prt_0c562e80f001Lfqk3YNSk5Mqwn` / `prt_0c562e8fc001JNi5gM3RkU6JcV`无存续DB Parts | 排除为已确认执行stall；不将tool总时长或state-minus-shell当执行时间，不反推该pair root/EOF |
| 当前源码与部署 | 探针测dirty R2源码；live是独立installed产物，未确立对应commit/build | 不把源码测试当部署已修复，不重跑installed binary或触碰live daemon；部署对应性仍未验证 |

全范围关闭要求不是继续跑同一组通过样本。对尚未归因的每个历史组，应在其可恢复脚本/环境/版本下，用安全有限复现记录：审批结束/spawn、目标Python或worker及wrapper/root的实际退出、native stdout/stderr EOF、Effect consumer完成、Tool返回、durable终态及下一模型请求。分支证据必须回答“第一处尚未完成的是谁、为什么”：root活则查实际资源owner/剩余操作；root退而EOF未到则查writer/句柄归属；exit+EOF已到则查consumer/finalizer/持久化真实pending点。无法恢复的脚本或阶段时间明确记录为不可验证，不能改写为fixed。

**仍 OPEN 的具体需求**：历史six-test/full-suite、ConPTY/scoped Effect probe及lifecycle benchmark最终输出尾部归因；文件重定向独立启动意外pipe持有的保真正常结束修复；用户Conda例子与确切历史/当前复现的关联；部署构建对应性。普通有限Conda和压力样本的通过只减少假设，不关闭这些要求。若后续识别新的首分歧，须同一canonical再升revision、清批准、全范围重审，不为补齐表格猜测生产修复。

### 25.6 Forward and Reverse Traceability

| Requirement | Production path / planned change | Public behavioral verification / boundary |
| --- | --- | --- |
| INV-01/02/09 | 保留ask->shellEnv->run，raw command/schema/prompt零修改 | 原权限延迟/拒绝、native fidelity、shell-prompt回归；审批时长排除 |
| INV-03–08 | 保留R2 Shell completion和core scoped ownership | §16/18生命周期、late output、error、scope、共享consumer回归 |
| INV-10/14 | 本canonical全范围证据分类；无新生产遥测 | §25.5逐项classification及缺失时间；历史/源码/部署不能互相替代 |
| INV-11 | shellEnv base改用既有sanitizedProcessEnv | public execute真实有限child，旧代码worker/父runID为red，新代码main/fresh为green |
| INV-12 | base<UTF-8<extra.env顺序不变；daemon producer不改 | 真实local file plugin输出override可见；独立显式worker合同保留 |
| INV-13 | 正常结果仍exit+EOF/消费；已知role首分歧根修 | 临时完整ShellTool嵌套source --version自然exit0验收；§25.5未知owner无敏感red，保持OPEN并阻止全目标完成声明 |

| Proposed concept | Requirement / proof | Reuse and responsibility |
| --- | --- | --- |
| 一个sanitizedProcessEnv import与base展开替换 | INV-11；真实角色泄漏对照 | helper已存在，复用而非重复删除；ShellTool是普通命令身份边界 |
| 显式extra.env最后覆盖 | INV-12；Plugin hook公开合同 | 原有主路径pass-through，不新增denylist或特殊插件分支 |
| public execute有限child fixture | INV-11/12；actual native环境是最终可见合同 | 复用现有testEffect、shells、tmpdirScoped/provideInstance；无生产测试接口 |
| 临时嵌套源入口probe | INV-13；两段证据尚非端到端green | 验证原始错误路由自然消失；只在D:/Temp，非生产新launcher |

未归因项不虚构生产file映射，其精确验证限制和owner发现步骤见§25.5。这是当前draft尚未达到全范围设计/目标闭合的原因，不是将原需求从审计中删去。

### 25.7 Secondary Paths and Workaround Disposition

R2 §11/23所有现有路径继续列入审计；新增base sanitizer属于主合同，不是失败后重试；UTF-8及explicit plugin env属于原合同pass-through；显式daemon worker属于独立既有启动域，不受普通Shell隐式继承修复影响。临时观察器仅诊断，不提供生产成功路径。新增alternate-success=0，独立生产diagnostic决策面=0%。无rollback请求，无新retry、cache、setting、fallback、native package、polling接口或生产临时文件。

删除/替换仅是 shellEnv 的原 `...process.env` base；保留其后两层。拒绝全局core环境过滤、改metadata为无条件main、先删完再恢复插件键、清句柄继承、停止capture、固定安静时长、FINAL/PASS识别、强制process.exit和调timeout。R2现有取消安全不删除，也不被称为新增正常完成方案。既有临时错误断言probe保留为历史数据，不反向修改旧结果来呈现green。

### 25.8 File Plan, TDD and Red-to-Green Gates

| File | R3 operation after approval | Estimated incremental change |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | modify only import、shellEnv base和邻近根因解释；cmd两分支保持 | 约4–8新增+删除行；约1有效生产行 |
| `packages/opencode/test/tool/shell.test.ts` | modify，复用公开execute/真实spawner及现有shell矩阵；加入角色和plugin两个行为slice | 约45–80有效测试行 |
| `packages/core/src/cross-spawn-spawner.ts`及原core测试 | R3不新增修改；R2 diff仍属于完整审计对象 | 增量0 |
| 当前canonical | 本轮唯一编辑 | 文档，不计生产预算 |

生产累计仍2文件，R2历史101新增+删除行，加R3估计4–8行仍远低于800（最终按原基线实际diff核算）；测试累计仍原2文件。没有新仓库文件、依赖、生成、配置或prompt变更。临时子脚本和本地plugin由既有fixture创建并清理，不是生产脚本落盘机制。

测试seam已由用户指定为公开 `ShellTool.init().execute`；不用private shellEnv、不检查source文字/import或spawner调用次数。两个slice逐个red/green，不先写一整层mock：

1. **角色隔离红测**：在隔离测试进程/串行受控fixture暂设parent role=worker、runID=固定parent值、无关变量=已知literal。通过实际execute运行有限Bun child，导入真实ensureProcessMetadata("main")并打印其结果及无关变量，随后自然结束。预期main、runID为非空string且不等父值、无关变量保留、Tool exit0且完整结果。当前R2必因worker/父runID失败，不靠超时失败；实现后同一测试通过，不在测试spawner或子脚本先sanitize。按已有shells矩阵覆盖Windows PowerShell及非PowerShell cmd分支；POSIX runner覆盖-c。环境恢复由scope/finally负责，不能污染并行测试；不要断言某个随机UUID字面值。
2. **显式插件优先级保护**：复用既有本地file plugin fixture和真实Plugin触发，hook设置固定显式role/runID、与父冲突的无关变量及UTF-8键。仍执行同一个有限metadata child，断言最终显式值原样可见（可用worker作为显式role，但child只导入metadata helper，不启动index服务）。此用例当前应绿，是防止“最终合并后过滤”或错误优先级回归的保护，不谎报为旧缺陷红测。无plugin时的第一slice同时保护默认WindowsUTF-8值；只增必要字段断言，不复制sanitizer计算预期。
3. **原始场景临时端到端验收**：R3曾要求补齐actual ShellTool->shell->真实source index --version整链；现已取得`tmp/process-role-fullchain.test.ts`实际red，详见§26.2。批准后的green仍须以worker父身份走真实execute，保留隔离config/db/lock/home和loopback临时端口，普通路径不能用plugin/service wrapper预先删除role/runID。版本输出、自然exit0、两EOF、正常Tool返回且无新listener必须发生于cleanup/abort/deadline前；watchdog仅作失败清理。显式直接worker控制仍保留其独立启动合同。probe留在临时目录，不加永久端到端daemon框架。

角色slice不要求任意1秒性能阈值；完成真值来自实际进程/流和Tool结果。安全watchdog上界不是生产超时政策。完整端到端red现已执行，生产green尚待实施；sanitizer实验对照不冒充生产green。原 `.mjs` 直接入口worker控制在修复后仍应worker，不能期待修改ShellTool改变不经ShellTool的调用。

### 25.9 Verification, Comments and Audit Gates

实施前先记录新增角色slice在R2的red，实施后重跑同一命令：

| Command | cwd | Required evidence |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts --test-name-pattern 'process identity' --timeout 30000` | packages/opencode | 新describe以process identity命名；实际child角色红绿与plugin优先级保护，不能零匹配 |
| `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | packages/opencode | 全Shell/native/权限/输出/生命周期和零prompt行为回归 |
| `bun test test/plugin/trigger.test.ts --timeout 30000` | packages/opencode | 既有真实file plugin同步/异步hook合同 |
| `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | packages/core | 完整累计R2适配器及消费者diff回归 |
| §18其余Session/direct shell/MCP/ripgrep回归 | 各自package | 全范围影响验证，不只审新增角色行 |
| `bun typecheck` | packages/opencode、packages/core分别 | 最终累计diff类型检查 |
| `git diff --check -- docs/plans/bash-post-result-lifecycle-and-native-invocation.md` | repo | 本轮文档检查；不代替实现测试 |

嵌套入口临时probe和原始结果现已存在，R4在§26.2记录实际0 pass/1 expected fail及控制自然返回；实施时补同一普通路径的生产green。不得直接运行现有daemon测试去抢4096；显式worker控制仍须test-owned临时端口隔离。本轮文档修订未执行生产测试或typecheck。

R3增量估计E=46–81（imports/格式/纯移动不计），C须至少`max(1, ceil(E*0.15))`，约7–13合格中文解释行；累计R2+R3仍需按最终实际diff重新计算，不自动继承旧53/337比值。解释分布在真实边界：普通Shell不继承内部身份、sanitizer在插件覆盖之前、child有限性与不能启动服务、真实spawn而非option断言、父env恢复隔离、两类cmd分支、端到端自然退出与失败清理区别。禁止为比例堆重复断言/拆空泛注释。本轮文档不构成实现E/C。

**审计状态与全范围门禁**：R3为draft，Approved revision=none，Implementation allowed=no；独立审计待primary阅读diff后发起，未自审、未复用旧APPROVE。已知角色路径设计可执行，但§25.5 OPEN项及未执行端到端red/green必须在同一原始范围内被评估，不能将批准对象改成“只审env两行”或把历史unknown统称无关。审计应重新读§1全文、§2–24历史、§25当前设计及真实生产者/消费者，覆盖R2累计diff和所有最新正常完成要求；任何批准/阻断均由独立auditor给出并由primary原样记录。

若全范围证据仍不足以给出原目标完整修复，保持draft/OPEN并报告缺失事实，不宣称规划或实现目标已全部闭合。后续设计完成才转audit-required；精确当前revision获得完整独立No blocking findings且记录后才可能授权实施，实施完成还须全范围独立实现审计。旧R1/R2原文为历史记录永久保留。

## 26. R4 Full-Scope Root Repair and Delivery

### 26.1 Authority, Context and Scope

修订前完整读取主代理更新后的906行canonical，包括§1完整澄清、全部历史审计与R3设计。本轮只编辑此文档；保留现有工作区/暂存改动。first-principles policy/template、CONTEXT、根/package/test AGENTS、TDD与Effect参考沿用已读取内容，新增读取`thirdparty/opentui/AGENTS.md`（该目录下无更深AGENTS）。没有问题需要用户裁决；不调用question、不commit/push/publish、不改gitlink、submodule源码或installed node_modules。

当前方案包括三项同一生命周期合同下的owner修复：A保留R2的完整completion与scoped capture释放；B在ShellTool环境producer移除隐式内部身份；C在CodeRenderable循环owner拒绝销毁后的下一次streaming工作。B避免有限CLI误入常驻服务，C避免已经完成业务与释放操作后重新产生keepalive worker。它们无相互失败重试关系，成功仍须真实进程结果及完整输出消费完成。保留同步非交互Bash、原文/五字段/UTF-8/压缩、既有权限及审批耗时排除；prompt及组装零修改，累计最多5生产文件/800新增+删除行。

新增稳定不变量：

| ID | Invariant | Class / verification |
| --- | --- | --- |
| INV-15 | 已destroy的CodeRenderable不得开始下一次streaming迭代；已开始操作按现有post-await检查释放/丢弃结果，finally必须结算highlightingDone | observed；真实onHighlight/onChunks gate复现并验证client不被重新初始化 |
| INV-16 | client由合法live owner显式重新initialize继续可用；普通活跃streaming输出/样式/callback保持 | contracted；既有client测试与真实reuse highlight、installed streaming回归 |
| INV-17 | 根修必须进入root实际tarball+Bun patch消费图，既有ScrollBox扩展和release provenance保持 | contracted；frozen install、installed-runtime测试、clean gitlink closure、隔离构建及JS hash证据 |

INV-01–14仍全部有效；INV-13全范围评估以§26.6显式验证限制映射，替代R3将所有未知历史阶段都作为待猜测生产修复的笼统OPEN门槛。审计范围没有缩窄，不能据此宣称每一条历史原因已知。

### 26.2 New Evidence and Feedback Loops

| Evidence read | What it establishes | Class |
| --- | --- | --- |
| `tmp/lifecycle-topology-findings.md`、`lifecycle-topology-validation.json`、`lifecycle-topology-reconstruction.json`、recovered body的markdownRun、build/supervisor脚本 | 恢复历史pre-force-exit topology，当前source及installed均复现最终JSON后root活；7失败/3真实owner释放自然退出 | observed |
| `tmp/code-destroy-minimal-repair-research.md`、`code-destroy-public-seam.test.ts`、unchanged/loop-guard JSON、natural child/supervisor/results | 真实public async hooks最小化；临时源码副本单while条件修复；非生产patch green | observed |
| `tmp/process-role-fullchain-findings.md`、`.test.ts`、`-results.json` | actual ShellTool->pwsh->source index --version完整red；只改变两个env键的控制自然返回 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:385–484,828`、`client.ts:284,620,794`、`tree-sitter/index.ts:62`、`renderer.ts:4319` | destroy、pending admission、client重新初始化、singleton移除的因果链 | observed |
| `Code.test.ts:2547,2577,2606`、`client.test.ts:1241–1281` | 原测试覆盖在途create释放、已建buffer和stale；销毁完成后initialize是现有合同 | contracted |
| installed `@opentui/core/package.json`、`index.js:46`、`index-b5dpwnes.js:3403–3479` | root实际入口导入含CodeRenderable的chunk，与source相同缺失循环guard | observed |
| 根`package.json:39,131,147`、`bun.lock:705,1621`、既有core patch全部74行 | 固定released tarball与补丁映射，现有ScrollBox JS/d.ts hunks必须保留 | observed |
| `oc/test/cli/cmd/tui/opentui-streaming-runtime.test.ts`、`oc/test/cli/tui/scroll-layout.test.ts` | 已有installed包公开行为seam与ScrollBox回归 | contracted |
| `oc/script/verify-opentui-closure.ts`、`opentui-provenance.ts`、`build.ts`、`packages/script/src/index.ts`、`smoke-opentui-artifact.ts` | resolver/remote tag/clean gitlink门禁、安装/构建副作用、发布开关、smoke隔离限制 | observed |
| `thirdparty/opentui/packages/core/package.json`及`scripts/build.ts`、root git ls-files和nested git status | gitlink=`b0cf25352ca75b964eca476af3554e6aa8dd8b20`，submodule clean；build:lib生成dist但不更新root消费图 | observed |
| PowerShell v7.6.6 `Process.cs:2408–2479,2619`，Win32 Pipe Handle Inheritance文档，`tmp/ownership-differential.mjs`与旧ownership/noninherit报告 | 文件重定向仍通过bInheritHandles=true继承其他pipe引用；原生对照重现，不是EOF已到后consumer丢信号 | observed |

角色完整反馈（已执行历史结果，本轮只读）：cwd=`packages/opencode`，TEMP/TMP=`D:/Temp/opencode`、OPENCODE_DB=`:memory:`，`bun test --preload ./test/preload.ts D:/Temp/opencode/process-role-fullchain.test.ts --timeout 100000`，结果**0 pass、1 expected fail、14 assertions、20.71s**。期望`[true,true]`自然返回，实际`[false,true]`；ordinary路径在清理前形成其独有healthy worker且root/两EOF/Tool均未完成，随后owned-tree清理不是成功。控制仅删除role/runID，约6934ms自然exit0、两EOF、`local`版本及无listener；这是根因控制，不是已实施green。preload验证child ppid/lock pid/dbPath后仅访问其临时loopback端口；installed opencode.exe未执行。

拓扑反馈：cwd=`D:/Temp/opencode`，`TOPOLOGY_MINIMAL=1`、`TOPOLOGY_IMPLEMENTATION=source`、`TOPOLOGY_LABEL=minimal-source-`，`bun D:/Temp/opencode/lifecycle-topology-supervisor.mjs baseline`当前exit1（final JSON后仍活，12秒失败watchdog）。installed最小与完整tiny package均同症状；source和installed各自`release-clients`控制自然exit0/EOF。恢复物为`prt_fcda1f6400016GOSpRYBiY3K7R`加`prt_fcda5158d001gzVbOLY0x4B61J`的shared cleanup，排除强制exit补丁`prt_fcda85f03001RhBYXWxZydDSia`；原body SHA256=`c3c81e24ee5ec966979c9834884d435a5b9802833048e25439f1298c7f4911a8`、preforce=`e8d8fa8dc8ea39a2618962d29138bfe82f61fa7a82c5db727ca4ff3074537e4c`。仅执行updates=2/longUpdates=3/trials=1的有限拓扑，非原性能任务；package模式不执行build-local HTTP/build/junction或tui子程序。

公开seam反馈：在tmp以`CODE_VARIANT=unchanged`或`loop-guard`分别运行`bun test D:/Temp/opencode/code-destroy-public-seam.test.ts -t 'onHighlight|onChunks'`，四个正常async-hook用例基线均red、guard均green；完整五case报告为0/5 fail对5 pass/0 fail/24 expectations，第五项是单独的reentrant diagnostic，不计正常渲染成功。`bun D:/Temp/opencode/code-destroy-natural-supervisor.mjs`的guard child自然exit0且两EOF、无watchdog；unchanged child在settled后仍clientInitialized=true，只有失败watchdog终止。该supervisor将“基线确实失败”作为实验预期，进程本身成功不代表生产通过。源码副本的guard研究不能替代patched installed consumer green。

### 26.3 First Divergence and Minimal Owner Repair

角色路径B保持§25.3/25.4：只把shellEnv的`...process.env`替换成`...sanitizedProcessEnv()`，先base后原utf8Env再extra.env；复用现有helper。已核实安装Effect make不默认extendEnv=true，core只在truthy时合并，故不添加无行为增量的两个extendEnv:false。实际native child和fullchain验证最终环境；专用daemon仍显式worker，不改index、metadata helper或global process.env。

streaming路径C的首次分歧：

```text
Markdown内嵌Code streaming，有active操作及pending下一值
-> renderer/Code destroy；shared registry移除旧client并await client.destroy
-> 旧async continuation恢复到runStreamingLoop循环入口
-> while仅判断pending，允许已destroy owner再createStreamingBuffer    FIRST DIVERGENCE
-> 旧client.createBuffer自动initialize，新worker重建
-> 后续destroy检查释放buffer，worker仍referenced，旧client已不在singleton
-> final JSON后root仍活；重复destroyTreeSitterClient找不到该旧对象
```

精确修复是CodeRenderable循环admission增加`!this.isDestroyed`。不修改TreeSitterClient重用语义、不新增终态状态机、不清pending再加setter/start guard、不unref worker、不延迟销毁、不在Shell结束时杀库worker。已admit的create仍由现有post-await destroyed分支释放buffer；update/hook fulfilled、rejected、stale及snapshot变化回到guard；零次迭代也经过finally，`highlightingDone/isHighlighting`正常结算。未释放的用户async hook本身仍由其owner结算，guard不伪造其Promise完成。

源码等价修改为`Code.ts:415`，但**本交付不修改submodule**。扩展已存在`patches/@opentui%2Fcore@0.4.3-smark.13.patch`，保留全部ScrollBox hunks，末尾附标准unified-diff文件段（当前chunk准确上下文如下）：

```diff
diff --git a/index-b5dpwnes.js b/index-b5dpwnes.js
--- a/index-b5dpwnes.js
+++ b/index-b5dpwnes.js
@@ -3422,7 +3422,8 @@
   async runStreamingLoop() {
     this._streamingActive = true;
     try {
-      while (this._streamingPending !== undefined) {
+      // 已销毁的 owner 不得开启下一轮，否则旧 client 会在清理后重新创建 worker。
+      while (!this.isDestroyed && this._streamingPending !== undefined) {
         const content = this._streamingPending;
         this._streamingPending = undefined;
         const snapshot = this._highlightSnapshotId;
```

仅一个runtime条件和邻近解释；无声明/API变化，不改d.ts、不重建整个bundle、不修改sourcemap或生成dist入库。patch目标是固定版本tarball中的既有chunk，不是猜测下次构建hash。Bun实际应用若找不到此唯一上下文应失败并调查包身份，禁止模糊匹配、改版本或fallback包。

为什么只清pending不足：public line-info-change可在renderSelf当前栈里同步destroy，随后startStreamingHighlight重新设置pending；while guard仍拒绝admission。研究中该路径还存在既有`TextBuffer is destroyed`绘制异常，guard不修复或掩盖它，本计划不添加第二套绘制guard。当前normal async-hook与恢复benchmark的自然退出根修不依赖此异常。此相邻错误没有被当作正常长尾根因或修复成功证据。

### 26.4 Runtime Delivery and Isolation

root目录是消费released tarball的仓库，`thirdparty/opentui`是clean gitlink而非未跟踪vendor。catalog/overrides/lock固定0.4.3-smark.13，`patchedDependencies`用完整core URL映射到现有patch。index.js实际导入index-b5dpwnes.js，production与测试从安装包解析。upstream source仅用于定位/对照；live submodule源码改动会使closure的clean-at-gitlink检查失败，未发布commit/gitlink也不满足remote annotated tag验证。因此本轮不采纳研究报告中的source companion两文件建议，不运行upgrade-opentui、不publish、不改manifest/版本/URL/远端，不绕过closure。

批准后验证工作在`D:/Temp/opencode/r4-verify-<unique>`的**独立工作区副本**执行：复制所需仓库源码、workspace manifests/lock/patch和独立Git元数据快照以供原closure只读检查（含正确相对路径的submodule metadata及clean release源码），纳入批准的dirty累计diff；不复制用户.env/凭据，不用live node_modules/junction或可写hardlink。不得以git worktree/add/checkout/stage/commit来准备它；不生成新的Git历史。新副本缺失gitlink证据时应补齐真实metadata快照，不能伪造pin或删掉校验。fixture/cache/home/XDG/TEMP/TMP均指向该temp根下，依赖安装使用独立`BUN_INSTALL_CACHE_DIR`。

安装先运行`bun install --frozen-lockfile --ignore-scripts`。若且仅若Bun证明修改patch要求更新lock，在此副本用`bun install --ignore-scripts --lockfile-only`再frozen install；保存原报错、生成diff及重跑结果。仅允许生成的必要patch/lock元数据回写根`bun.lock`，不手编hash，不接受版本/URL/无关resolution漂移。其他安装错误如下载失败、平台依赖缺失照实解决，不算lock必须变更的理由，不清live缓存。这里是包管理一致性步骤，不是生产失败后的替代执行路径。

安装后从副本`packages/opencode`解析core，记录realpath、manifest、patch SHA256、index-b5dpwnes.js SHA256及原tarball integrity；root/plugin/TUI的实际core应属于同一独立install图。运行installed runtime与ScrollBox现有测试确认旧hunks生效，然后执行原closure检查。原closure还检查全部平台package roots；若ignore-scripts/宿主安装未包含它所需的可选平台包，按既有锁图在隔离安装中提供这些包，不删校验、不把“未跑”当PASS。不得以源码临时copy的green冒充这个步骤。

正常应用build在副本`packages/opencode`执行`bun run script/build.ts --single --skip-install --skip-embed-web-ui`。必须在子进程环境**删除**OPENCODE_RELEASE（字符串`0`也是truthy），设置`OPENCODE_CHANNEL=r4-verify`、`OPENCODE_VERSION=0.0.0-r4-verify`，清除继承的OPENCODE_BUMP/role/runID，隔离全部home/config/db/lock/TEMP路径；无GH/NPM发布凭据。理由是`build.ts:605–613`在Script.release为真会执行gh release upload，而`packages/script/src/index.ts:71`以!!env判断。--skip-install避免build自动install/清cache，generate.ts及dist写入仅发生在独立副本。构建自带版本与voice worker smoke不替代生命周期测试，保留其结果和生成opentui-build.json；后者只有native/executable哈希，须另记修复JS chunk哈希。

研究报告建议的`smoke-opentui-artifact.ts --scenario normal`不是本机直接可安全执行的门禁：脚本只隔离状态目录，launcher `[project]`未显式指定daemon端口，fixture的port=0只是模型server；daemon仍可能尝试4096，不能认作已隔离loopback namespace。该额外artifact烟测仅在独立VM/网络namespace执行，或后续独立核实既有安全端口入口后执行；本轮不修改该脚本，不碰live监听器。必需验证采用无服务的installed streaming child、隔离source fullchain和上述build；状态明确，不把未执行额外烟测当实现失败的替代理由，也不宣称完整TUI smoke已通过。

### 26.5 Public TDD and Verification

保留§16/18全部R2回归及§25.8角色两个slice。先公开seam red、后最小生产改动、再green；不增加private状态、mock client、Worker调用次数或source字串断言。

1. 在`oc/test/tool/shell.test.ts`的process identity组使用真实execute/child，期望main/fresh runID、无关env、Windows UTF-8，随后以真实file plugin保护extra.env最后覆盖。ordinary不sanitize测试环境输出、不改metadata helper。保留两个cmd分支覆盖，父身份变更在隔离或串行fixture内scope恢复。
2. 在已有`oc/test/cli/cmd/tui/opentui-streaming-runtime.test.ts`添加public async-hook teardown组：onHighlight/onChunks各fulfill/reject，真实installed TreeSitterClient、CodeRenderable、createTestRenderer。entered/release Promise因果排序：首hook entered后第二content/render产生pending，保存highlightingDone，destroy Code并await client.destroy，再release并await saved done。期望`isHighlighting=false`、`client.isInitialized()=false`，再显式initialize同一client做真实有限highlight成功，finally清理。client初始化状态而非仅buffer数抓住根因；复用参数化fixture，不复制四套实现。已有正常streaming内容/callback测试不削弱。
3. 同一installed-runtime测试文件增加一个小的独立child自然退出测试：child走上述public gate、销毁client一次、释放hook、await done、清理renderer/style后自然返回，**正常路径不得第二次client.destroy**。parent并行排空stdout/stderr，要求自然exit0/两EOF且无watchdog/kill，诊断JSON仅检查语义；watchdog只失败清理owned PID。不要用测试finally二次destroy掩盖复活。临时child脚本由fixture生成，导入从当前consumer解析的installed包绝对入口，不能因文件位于tmp解析回live node_modules或thirdparty源码。
4. 在临时隔离反馈环重跑**不加观察器/extra cleanup**的原tiny recovered markdownRun(2,true)及tiny package topology，import只定位到独立patched install，保持destroy/shared-cleanup顺序和固定有限输入，要求final JSON后自然exit0/两EOF。完整topology中未释放style不是已证实root keepalive原因；该复验不改变其原清理来替guard作功。可用原supervisor的失败判定，路径参数化/复制修改只限临时probe；保存red/green拓扑及payload相同的证据。
5. 重跑已有process-role-fullchain red的同一ordinary路径，临时副本中的源码/import/preload绝对路径全部定位独立workspace，保留parent worker身份及test-only端口隔离。最终`[true,true]`、版本行、两EOF、无listener、无cleanup；sanitizer-control只作控制，不承担ordinary成功。版本期望依source入口`local`，不得混用build版本。实际显式worker入口控制不经普通Shell，既有合同保持。

测试watchdog是测试进程失败上界，按启动/CI余量设置，不是hardcoded短执行期限或quiet-window生产策略；不对比算法计时猜root完成。已destroy后永不再admit与live-client可重用均由可观察状态/自然进程结局验证。新增reentrant-native-error永久测试不属必需，避免为证明同一guard扩充非正常渲染合同；已有研究明确保留相邻异常限制。

| Verification command | Working directory | Required evidence |
| --- | --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | 隔离root | 原映射自然应用旧ScrollBox+新Code hunk；必要时才生成lock |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts --timeout 30000` | 隔离packages/opencode | 新public teardown red/green、natural child、既有live streaming输出 |
| `bun test test/cli/tui/scroll-layout.test.ts --timeout 30000` | 同上 | 旧dependency patch未丢失 |
| `bun test test/tool/shell.test.ts --test-name-pattern 'process identity' --timeout 30000` | 同上 | 角色修复敏感red/green，非零匹配 |
| `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | 同上 | 全Shell/native/permission/输出，prompt无修改 |
| `bun test test/plugin/trigger.test.ts --timeout 30000` | 同上 | 真实plugin hook合同 |
| `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | 隔离packages/core | R2完整scope/capture及consumer回归 |
| `bun test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp --timeout 30000` | 隔离packages/opencode | 共享调用者 |
| `bun test test/session/prompt.test.ts --timeout 30000` | 同上；外层预算至少900秒 | 原SDK/Session终态合同 |
| `bun typecheck` | 隔离packages/opencode、packages/core分别 | 累计实现/测试类型检查 |
| `bun run script/verify-opentui-closure.ts` | 隔离packages/opencode | clean released gitlink、remote tag、lock/resolver/native闭包；不绕过 |
| `bun run script/build.ts --single --skip-install --skip-embed-web-ui` | 同上；严格使用§26.4非发布环境 | 实际patched消费图可编译、build smoke/哈希证据 |
| `bun test --preload ./test/preload.ts D:/Temp/opencode/process-role-fullchain.test.ts --timeout 100000` | packages/opencode；实施时用路径已定位隔离workspace的临时同源probe副本 | 已有red的ordinary路径green，精确实际命令另记 |
| `bun D:/Temp/opencode/lifecycle-topology-supervisor.mjs baseline` | tmp；TOPOLOGY_MINIMAL=1；实施时将temporary imports定位隔离installed graph | recovered无观察器topology自然完成；再验证tiny package mode |

临时source-copy public-hook green已存在；Bun patch实际安装、仓库新测试、隔离build及patched topology green均尚未执行，属于实现验证门禁。本轮仅规划，不能填写PASS。Linux沿用R2已有证据并在可用runner做installed-runtime/capture补验；macOS未有本机环境明确列未验证。无需为这一个JS条件重编native库或改源码release；可选isolated source build:lib对照不能代替root安装验收。

### 26.6 Full Original Scope and Observation Limits

| Scope | Classification / owning behavior | Mapping and remaining verifiability |
| --- | --- | --- |
| 审批及同步原生执行、合法长静默前台/后代晚输出 | contracted；Permission/raw shell/capture | INV-01/02/03/08/09，R2回归全部保持，不缩预算/不加启发式 |
| R2 post-root取消与capture释放 | observed Harness首分歧，已累计实现 | §10/23/24全部保留且全范围重验；不能当B/C正常根修green |
| role泄漏 | observed ShellTool环境owner错误 | B具体根修+公开child及actual fullchain red->green；不归因installed aborted版本命令 |
| recovered lifecycle benchmark | observed CodeRenderable已destroy后再次admit | C实际tarball patch+public测试+原topology绿色；证实当前源码/installed重现，不声称历史August原PID取证已确定 |
| 历史缺client.destroy benchmark | observed caller遗漏，已有8.053s正常对照且当前已补 | 保留独立结论，不与C混同，不再泛称所有worker尾部是caller问题 |
| Conda/Python原范围 | 2032词法记录、60本地run返回；当前28 Tool/native命令与28真实Session Bash正常 | 用户症状继续保留；未找到该类新的owner分歧不支持包装/Conda更改。动态/remote/native扩展历史缺原脚本/进程阶段，需确切调用及目标PID/root/EOF/Tool时序才能归因，不猜fixed |
| native EOF压力 | 752通过；真正execute后测试scope尾部不计Bash挂起 | INV-03/06回归和观测限度；不证明所有race不可能 |
| 历史six-test/full-suite、ConPTY、scoped Effect等 | 历史final-output证据存在，逐次退出/EOF及当时脚本版本不足 | INV-10/13/14映射为历史不可验证；需可恢复版本/资源topology及阶段trace。不能归C，也不要求逆推出未记录事实才能审已证实根修 |
| 101分钟Git pair | 审批污染，无存续DB Parts | 排除已确认execution stall；不以审批/总tool时长扩缺陷 |
| source、tarball、live部署 | 三种身份分开 | INV-17验证新隔离安装/build；未触碰live，不宣称部署已更新或验证 |

**Start-Process/capture显式域**：本Tool捕获root及共享其stdout/stderr写端的真实字节，正常结果需root exit+所有capture writer关闭后的EOF/消费；合法foreground关闭stdout后仍运行要等root，合法后代晚写仍需保留。不同于“只等shell PID”或“最后业务文本即完成”。Windows桌面Start-Process默认ShellExecute独立启动且另有I/O所有权时，可在child工作结束前自然关闭root capture；其launch结果不代表child工作完成。

对于`-NoNewWindow`/`-RedirectStandard*`选中的PowerShell CreateProcess分支，重新读取v7.6.6源码确认SetStartupInfo只替换标准句柄slot，`:2619`仍传bInheritHandles=true，并无此调用的显式handle allowlist。Win32 EOF需**所有**write handle关闭；文件重定向并不证明原capture引用未被继承。native node:child_process直接调用同一PowerShell的差分在绕开ShellTool/Effect后仍复现约1.9–3.8秒pipe尾部；控制清继承位可消除尾部但丢合法Python/Conda/foreground输出，故全局候选已反证。这里已确认的producer机制属于PowerShell二次native launch，当前无证据显示Harness独占write handle或已到EOF而丢失完成。

此分类**保留**独立启动早返回诉求及原案例，明确当前同步capture合同下不能透明地把静默继承holder与未来writer分开。没有已证明的、在不改原命令/外部PowerShell实现且保留输出合同下的Harness修复可交付；不把它猜为C/B已解决，也不添加隐藏launcher/捕获后端。可安全验证的native独立I/O调用示例保留为§10.5/ownership研究证据，不修改prompt、不自动替换用户调用。若要证明另一Harness缺陷，所需数据是：相同原生命令在相同OS shell/argv/env/stdio的native与Tool对照、实际继承写handle的owner及关闭时刻，尤其**所有writer已关闭/两native EOF已到但Tool仍pending**或额外Harness独占write引用。原历史条目未保存这些信息，阶段归因不可补造；当前源码/差分只能建立上述native机制。此限制按policy的显式不可验证原因映射，不偷删需求、不等价于当前确认的Harness缺陷可以不修。

### 26.7 Bidirectional Traceability and Path Inventory

| Requirement | Cumulative production delivery | Behavioral proof / explicit limit |
| --- | --- | --- |
| INV-01/02/09 | Shell权限/原文/同步schema/prompt保留 | 既有permission、native、prompt回归；零prompt diff |
| INV-03–08 | R2 shell completion+core owned capture | 全部原生命周期红绿及共享consumer复验 |
| INV-10/14 | canonical全量分类 | §26.6逐项已知/不可验证、审批/部署区分，无新增生产遥测 |
| INV-11/12 | shellEnv复用sanitizer+保留UTF8/plugin覆盖 | public child、plugin、fullchain普通路径green；专用worker合同保持 |
| INV-13/15 | CodeRenderable循环guard，固定tarball既有patch交付 | 真实destroy+pending红绿、自然child与恢复topology；历史无阶段数据例外显式映射 |
| INV-16/17 | 保留client重用、原ScrollBox hunks、manifest/gitlink | live highlight/reuse、scroll-layout、frozen install、closure/build及JS hash |

| New production concept | Requirement / evidence | Why minimal and owned here |
| --- | --- | --- |
| sanitized base | INV-11；actual fullchain wrong worker | 现有helper复用，一处producer替换，无core全局策略 |
| while !isDestroyed | INV-15；public hooks与recovered topology | admission owner是CodeRenderable，现有post-await检查太晚；client重用不能禁用 |
| 现有dependency patch新增一hunk | INV-17；实际tarball消费而非submodule | 唯一真实交付通道，无publish/gitlink/API/source双实现 |
| 必要时Bun生成lock元数据 | INV-17；包管理器实际一致性要求 | 非预设修改，仅保持同一版本/URL/patch可重现 |

R2分支全保留在审计范围；B、C都是主路径owner修复。plugin explicit override是既有pass-through；live/non-streaming/非Markdown为支持域分支，沿现有逻辑；client重新initialize为原API，不是失败fallback。新增alternate success=0，新增独立生产diagnostic决策面=0%。不新增guard之外的retry/cache/helper/public接口/native包或生产临时文件。删去旧base spread与旧while条件；拒绝强制exit、worker unref、循环清理所有client、重新查singleton补杀、清pending再叠start/setter guard、关闭capture或静默定时退出。研究用release-clients延迟干预和源码副本只作因果证据，不进入生产。

### 26.8 Cumulative File and Comment Budget

| File | Cumulative responsibility | R4 incremental estimate |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | R2完整completion/取消 + B env producer | B约4–8新增+删除行 |
| `packages/core/src/cross-spawn-spawner.ts` | R2 source/tap scoped释放 | 新增0；保留现有+32/-13 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | C单while条件，保留ScrollBox原hunks | 约13行patch文本；实际payload一代码行+一解释行 |
| `packages/opencode/test/tool/shell.test.ts` | R2原测试 + 角色及plugin | 约45–80有效行 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | R2原资源回归 | 增量0 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | installed真实hook/reuse/natural child | 约100–170有效行 |
| `bun.lock` | 仅Bun要求时生成的patch相关元数据 | 预期0或很小，必须实际核算，不准版本图漂移 |
| 本canonical | 唯一当前编辑文件 | 文档 |

生产bearing累计3文件，若保守把必要lock计生产则4文件；不修改submodule/source/gitlink，不新增仓库测试文件。当前git diff HEAD生产仍R2的101新增+删除行，B+C后约118–125加必要lock变更，硬上限仍800（把patch header/context文本也保守纳入新增，不靠“生成物”豁免runtime一行）。tests累计3文件；总文件数不冒充生产文件上限。新生成bundle/dist及临时probe不提交。

E/C按实际累计实现重新核算：R2历史E=337/C=53；B约46–81有效代码行（含测试），C约101–171，累计预估E=484–589，最低C=73–89。计划增量至少22–38条邻近合格中文解释行以保持实际`C >= ceil(E*0.15)`，不是强求注释条数替代语义。解释重点是销毁admission、在途操作仍结算、hook因果gate、正常child不能二次清理、client合法reuse、installed resolver/输出EOF、环境覆盖与隔离；一个production patch中文解释如上。patch元数据、imports、纯格式不计E，人工修复runtime payload不能以bundle生成而排除；不得重复计算源码副本或堆无意义注释。lock若生成仅元数据按policy排除，实际有语义变化则重新评估范围。

### 26.9 Audit and Completion Gates

Status=audit-required、Revision=R4、Approved revision=none、Implementation allowed=no。当前两条正常完成根修及实际delivery有可执行设计、红能力证据与双向映射；历史不可取证和native外部语义已按完整原需求显式分类，因此不把缺失历史阶段变成要求全知证明的阻断，也不把它标成fixed。安装/build及生产green缺口是已列出的实施门禁，不能提前宣称达成。

primary提交独立plan审计时仅给§1完整原文、canonical路径、repo root、Audit mode: plan；本轮不自审、不记录批准。审计必须覆盖全部原需求、R2累计diff、B/C及实际patch/lock消费链、合法前台/后代/审批/无prompt/预算和§26.6验证限制，不能缩为新hunk。若出现新confirmed reachable owner缺陷或patch消费链不成立，修改同一canonical升revision、清批准并全范围重审。

实施完成必须具有：普通Shell fullchain自然green、installed streaming public/natural/recovered topology green、原完整回归、独立install/closure/build身份、实际预算/E/C、零fallback及全范围独立实现审计。最终报告同时保留历史无法归因项、未运行平台/额外smoke及live部署未更新事实，不用局部根修宣布所有历史均已消失。R1/R2审计verbatim和R3历史均保留，不改写旧实验结果来制造通过。

## 27. R4 Independent Plan Audit

Invocation: `ses_f16001a07ffeRBBxLv3zWfGiv3`; mode: plan; revision: R4; full-scope. 以下为独立 verdict 原文；本次仅记录审批，不改变设计。

## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01：历史归因边界继续保留。** R4 能支持当前已复现的角色泄漏和 streaming worker 复活两项根修；不能据此断言历史 40 条最终输出案例均已归因或都会消失。
- **N-02：临时原型通过不等于实际依赖交付通过。** 已直接读取 public-hook、自然退出及角色整链的实验源码与结果。固定 tarball 经 Bun patch 安装后的测试、恢复拓扑复验、closure 和隔离 build 仍是实施门禁，R4 没有提前将其标为通过。
- 本轮为计划审计，未重新执行实验或安装、构建命令，也未修改文件。

## Rejected speculation

- 不要求增加 worker 终态状态机、额外 setter/start guard、循环清理 client、worker unref 或强制退出。已证实的首次错误发生在销毁后的下一轮 admission，一个循环条件有明确责任边界。
- 不要求对 Conda、Python、编码包装或所有子进程环境新增全局处理。现有证据支持 ShellTool 的两个内部身份键隔离，不支持扩大过滤范围。
- 不要求清除全部 Windows 句柄继承位，或根据最终文字、安静时间提前结束 capture。这会破坏已存在的合法输出合同。
- 不将缺失历史 trace 自动视为已修复，也不要求为无法恢复的历史状态猜测生产分支。

## Requirement and traceability coverage

本轮覆盖完整原始要求、R2 累计修复、R4 的 B/C 两项根修，以及 patch、安装、测试和构建消费链。

| 范围 | 独立核对结论 |
|---|---|
| R2 生命周期基线 | 保留 exit+output completion、取消监督及 scoped source/tap 释放；不能以这些安全修复代替正常结束根修。 |
| 普通 Shell 角色泄漏 | `packages/opencode/src/tool/shell.ts:786` 隐式复制父身份；`packages/opencode/src/index.ts:51` 在参数处理前进入 worker。首次分歧位于环境 producer，复用 sanitizer 的修改位置正确。 |
| 环境与专用 worker 合同 | `packages/core/src/util/opencode-process.ts:19` 仅删除 role/runID；UTF-8 和插件最终覆盖保留。`packages/opencode/src/cli/cmd/tui/daemon.ts:334` 的显式 worker 启动不受影响。 |
| 销毁后 worker 复活 | `thirdparty/opentui/packages/core/src/renderables/Code.ts:415` 允许 destroyed owner 消费 pending；随后 `client.ts:629` 自动 initialize。现有 post-await 检查发生得太晚，不能阻止 worker 重建。 |
| 最小 owner 修复 | 循环入口加入 `!this.isDestroyed`，保留在途操作检查和 finally 结算；不改变合法 live client 的重新初始化合同。 |
| 实际 runtime 交付 | 已核对安装包 `index-b5dpwnes.js:3425` 存在同一缺口，现有 patch 和 manifest 映射可承载这一变更；旧 ScrollBox hunks 必须保留。 |
| 行为验证 | public async-hook gate 能使旧实现失败；自然 child 禁止二次 destroy 掩盖复活；恢复后的原 topology 和普通 Shell fullchain 都必须自然退出，而非依靠 watchdog 判成功。 |
| Start-Process 与未知历史 | §26.6 保留共享 writer 的确定性 EOF 合同，并区分 PowerShell 原生继承机制、当前 Harness 缺陷和无法补造的历史阶段证据。 |
| 审批、提示与范围 | 审批及预算顺序、同步接口、原始命令、schema、提示均保持；累计生产范围及行数估计满足限制。 |

正向需求与反向概念映射成立。隔离安装和构建用于验证实际依赖交付，没有成为另一条生产执行路径。

构建安全条件也与源码一致：`packages/script/src/index.ts:71` 对 `OPENCODE_RELEASE` 使用 truthiness；R4 要求删除该变量，能够避免 `packages/opencode/script/build.ts:605` 的发布分支。

## Primary-path and fallback verdict

通过。

- A：既有 Shell completion 与 capture 所有权修复。
- B：普通 Shell 环境 producer 复用既有 sanitizer。
- C：CodeRenderable 在销毁后拒绝下一轮工作。

三者分别修复各自 owner 的首次错误转换，没有失败后尝试另一算法的关系。正常成功仍依赖真实进程结果及完整输出消费。

新增 alternate-success 路径为 **0**，新增独立生产 diagnostic 决策面为 **0%**。插件显式覆盖和 live client reuse 均属于现有合同。

## Code quality and Chinese-comment verdict

计划阶段通过。

R4 新增生产行为集中于一处环境展开替换和一个循环条件；通过既有 dependency patch 交付，不新增公共 API、配置、依赖版本或 launcher。

累计预计 **3 个 production-bearing 文件**，必要 lock 元数据保守计入后为 **4 个**；预算远低于 800 行，但最终仍须按实际累计 diff 核算。

§26.8 承诺实际累计 `C >= ceil(E × 0.15)`，预估 `E=484–589`，所需 `C=73–89`。解释主题与生命周期、环境覆盖和测试因果边界相邻，具有可执行性；实现审计须独立重算，不能继承 R2 比例。

## Release verdict

**APPROVE — 仅批准 `docs/plans/bash-post-result-lifecycle-and-native-invocation.md` 当前 R4，full-scope。**

批准范围包含 R2 累计修复、角色环境根修、销毁后 streaming admission 根修及其实际依赖交付方案。达到 `verified-implementation` 仍须完成 R4 明列的生产红绿、自然退出反馈环、隔离安装/closure/build、完整回归和独立实现审计；不得将历史未知项或 live 部署状态改写为已解决。

## 28. R4 Implementation Evidence and Validation In Progress

### 28.1 Administrative State and Evidence Sources

本节仅记录已批准R4的实际实现与验证，不改变§26设计、revision或§27批准原文。当前元数据保持 **Status: approved / Revision: R4 / Approved revision: R4 / Implementation allowed: yes**；实施验证仍在进行，未转implementation-audit-required或verified。§21/§26中批准前的状态文字属于设计时点，当前行政批准以页首及§27为准。本节不是独立实现审计，也不构成自我批准。

记录依据：直接读取六个实现文件相对HEAD的完整diff并两次逐行重算；读取`D:/Temp/opencode/r4-b-implementation-evidence.md`、`r4-c-implementation-report.md`、`r4-combined-verification-report.md`、`r4-session-verification-findings.md`及`r4-combined-final-identity.json`。测试/安装/build结果来自这些执行记录，本次文档任务未重跑测试、安装、构建或基线比较。primary另行提供的core复验在下表独立标明；未将其假称本记录者执行。

**完整验证尚非green**：组合385 pass/1 skip明确不含Session；完整Session为114 pass/14 skip/1 fail。另一个agent的基线对照仍进行中，本节不预判是既有失败、R4回归或已解决。primary在对照证据齐备后决定验证状态及独立审计发起时机；不因已有局部green跳过剩余门禁。

### 28.2 Actual Files and Primary Routes

| Actual file, relative to HEAD | Added / removed | Delivered responsibility |
| --- | ---: | --- |
| `packages/core/src/cross-spawn-spawner.ts` | +32 / -13 | A：eager source/tap同spawn scope acquireRelease；正常root exit不提前截断输出 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | +90 / -1 | A：无订阅/中断真实pipe释放及并行scope隔离 |
| `packages/opencode/src/tool/shell.ts` | +39 / -21 | A：exit+output完整竞争、取消consumer与既有终止升级；B：sanitizedProcessEnv基础环境 |
| `packages/opencode/test/tool/shell.test.ts` | +323 / -1 | A：post-root生命周期、故障/真实root释放、审批后计时；B：实际shell矩阵identity与真实plugin覆盖 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | +13 / -0 | C：index-b5dpwnes.js的while增加!isDestroyed；保留旧ScrollBox hunks |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | +135 / -1 | C：真实installed public hooks四种结算、合法client reuse、无二次client清理的自然child退出 |

生产承载 **3文件，+84/-34，共118变更行**；包含全部13行patch envelope/context/payload文本，未只按payload压缩生产预算。测试3文件，+548/-3，共551行。六文件合计+632/-37；文档及临时计数证据不计生产。`bun.lock`未变，不存在第四个生产文件；全部低于5生产文件/800生产变更行约束。

实际B没有添加extendEnv选项、helper或全局环境过滤；base→utf8Env→extra.env优先级保持。实际C只有admission条件，不封死client重新initialize，不加unref/production timer/强制exit/state machine。A/B/C保持各owner单一主路径，新增alternate-success=0，新增独立生产diagnostic决策面=0%。原取消分支仍返回明确partial取消，不能充当正常结束green。

直接diff核对`packages/opencode/src/tool/shell/prompt.ts`、`shell/shell.txt`、`bun.lock`零变更；shell.ts实际diff未改description/prompt组装、schema导出、五字段参数、原生命令构造或Permission调用。无SDK/schema/配置/migration/API变更；daemon/index/metadata helper未修改，旧ScrollBox内容未删除。未修改submodule/gitlink、依赖版本、installed live node_modules或live daemon；不以此文档记录授权部署。

### 28.3 Root Red-Green and Original Feedback

| Behavior | Actual red | Actual green / retained limitation |
| --- | --- | --- |
| A完整生命周期与capture资源 | §23保留真实pipe `open|open`、post-root取消缺notice、错误监督红测 | R2历史green保留；当前组合core50和Shell249复验覆盖累计A；Linux旧证据不能自动当R4新平台验证 |
| B公开execute身份 | `bun test test/tool/shell.test.ts --test-name-pattern 'process identity' --timeout 30000`：4 pass/4 fail，16 assertions，12.15s；ordinary收到worker/parent-run而非main，所有child自然exit0 | 同命令8 pass/0 fail、20 assertions、40.10s；bash/pwsh/powershell/cmd及四个真实plugin优先级均过 |
| B actual ShellTool→pwsh→source index --version | 原fullchain0 pass/1 expected fail、14 assertions，正常向量[false,true]；错误worker确认后才清理 | 当前生产ordinary路径不加诊断sanitizer：1 pass/0 fail、20 assertions、46.11s，向量[true,true]；控制如今改变0个env键 |
| C installed public onHighlight/onChunks teardown | queued teardown组0 pass/4 fail、8 assertions、13.06s，均client.isInitialized()得到true | 实际Bun patch安装后四case及live streaming通过；最终含natural child的文件6 pass/20 assertions |
| C finite child自然结束 | 未修installed包0 pass/1 fail，20秒失败watchdog触发，未计成功 | patched installed child自然exit0且两个EOF，无watchdog；child正常路径仅一次client.destroy |
| C恢复原topology | source/installed preforce拓扑在最终JSON后仍活，§26.2保留7失败与owner-release因果控制 | 无observer/额外cleanup的patched installed baseline：minimal markdownRun(2,true)自然exit0/两EOF（JSON后34ms）；tiny package自然exit0/两EOF（118ms），mismatches=0，原cleanup/输入保持 |

B fullchain命令在原`packages/opencode`以标准test preload、TEMP/TMP=`D:/Temp/opencode`、OPENCODE_DB=`:memory:`运行`bun test --preload ./test/preload.ts D:/Temp/opencode/process-role-fullchain.test.ts --timeout 100000`。ordinary的stdout/stderr EOF约23830/23826ms、root exit0约23866ms、Tool正常返回约23875ms；控制约10739ms返回。无listener、taskkill、timeout或abort，两组均打印`local`；已知Bun tsconfig directory-mismatch诊断仍保存，非installed binary版本。证据`process-role-fullchain-r4-green-results.json`与旧red分开保存，未覆盖旧red。

C拓扑命令由`bun D:/Temp/opencode/r4-c-run.mjs topology-green . bun D:/Temp/opencode/r4-c-topology.mjs`执行；`r4-c-topology-results.json`保留payload、OS退出/EOF与路径重定位哈希。临时probe只重定位installed包和数据路径，未用source-copy guard或release-clients控制替代交付。上述毫秒值是观察，不是生产阈值或文本完成判定。

### 28.4 Installation, Final Build and Provenance

独立workspace为`D:/Temp/opencode/r4-verify-c-1790682474904`。复制记录包含6539个tracked源码文件及真实独立Git metadata，跳过.env、不共享node_modules/可写hardlink；gitlink和clean nested release身份保留。首次`bun install --frozen-lockfile --ignore-scripts`成功安装2336包（254.50s），无需lockfile-only重试。root/opencode/plugin解析到同一独立core；原live chunk仍未修改。

最终组合验证先发现隔离Shell副本仍是B修复前内容，遂同步两份Shell源码/测试并重建；最终`r4-combined-final-identity.json`记录六文件逐字节匹配、零copy。**C-only旧build哈希已被新build取代，不能作为最终A/B/C产物。** 最终runner的home/data/cache/config/state/tmp/lock位于`D:/Temp/opencode/r4-verify-c-1790682474904-verification-state`，在Git worktree外，避免external_directory测试误认同项目路径。

| Identity | Recorded final value |
| --- | --- |
| core版本/tag/gitlink | 0.4.3-smark.13 / v0.4.3-smark.13 / b0cf25352ca75b964eca476af3554e6aa8dd8b20 |
| 原始与隔离bun.lock SHA256 | `a9a87360e4d28341848ad9785aadc7a7ca86d8e75c9d65bfac65f9834c44cfa2` |
| dependency patch SHA256 | `55fca404c209b402687dfed055bc6c75415ab93615bbbc9f12864575f5ea0fd8` |
| patched index-b5dpwnes.js SHA256 | `075889adbe757fcedd37ed1c8b1084f8ec661d5d1eed5f129eec6cdb13518362` |
| unchanged live index-b5dpwnes.js SHA256 | `316dae73791ad3b76c7e80dcf0d7d95c34c88576ff8fc7da8c455d2d55c0b368` |
| 最终Shell source SHA256 | `59ed8847597637091a724987b7bfaa3ae04f6afd3587d21b0abe4edc4538f3da` |
| 最终executable SHA256 / bytes | `00d086c51372297021cd1a831b3d1c0ad733d46f9eac18fb3cb63ce9130874e9` / 152572928 |
| native opentui.dll SHA256 | `5fd5f3610be1dadbb1736f4bd757b6046c1c04fa55624552cd389e838722faf7` |

最终binary位于该独立workspace的`packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，相邻`opentui-build.json`提供native/executable身份；JS chunk单独记录。`bun run script/build.ts --single --skip-install --skip-embed-web-ui`exit0，channel=r4-verify、version=0.0.0-r4-verify、release=false；runner删除OPENCODE_RELEASE及发布凭据。版本和compiled voice Worker smoke通过，未发布、未覆盖live产物。closure通过11包及Solid1.9.12/release provenance检查。extra TUI/daemon artifact smoke未执行，保持§26.4端口隔离限制。

### 28.5 Complete Verification Matrix and Retained Failures

组合行均来自隔离workspace最终六文件同步后的顺序执行，调用形式为`bun D:/Temp/opencode/r4-c-run.mjs <label> <package-cwd> bun <arguments>`；cwd在对应package，所有原始stdout/stderr/exit保存于`r4-c-<label>.json`。本表不把重复复验相加制造独立覆盖数量。

| Label / cwd | Arguments after bun | Recorded result |
| --- | --- | --- |
| combined-shell-final / packages/opencode | `test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | 249 pass/0 fail，1250 assertions，204.39s |
| combined-plugin / packages/opencode | `test test/plugin/trigger.test.ts --timeout 30000` | 2 pass/0 fail，2 assertions，6.75s |
| combined-consumers / packages/opencode | `test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp --timeout 30000` | 68 pass/1 skip/0 fail，162 assertions，26.76s |
| combined-core / packages/core | `test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | 50 pass/0 fail，89 assertions，33.18s |
| combined-runtime-scroll / packages/opencode | `test test/cli/cmd/tui/opentui-streaming-runtime.test.ts test/cli/tui/scroll-layout.test.ts --timeout 30000` | 16 pass/0 fail，105 assertions，8.02s |
| combined-typecheck-opencode / packages/opencode | `typecheck` | exit0，tsgo --noEmit |
| combined-typecheck-core / packages/core | `typecheck` | exit0，tsgo --noEmit |
| combined-build / packages/opencode | `run script/build.ts --single --skip-install --skip-embed-web-ui` | exit0，新A/B/C产物，version/voice smokes通过 |
| combined-closure / packages/opencode | `run script/verify-opentui-closure.ts` | exit0，实际installed graph、release gitlink及native身份通过 |
| primary额外core复验 / packages/core | `test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | primary提供50 pass、35.64s；单列重复确认，不累加组合总数 |
| session-full / packages/opencode | `test test/session/prompt.test.ts --timeout 30000` | **RED：114 pass/14 skip/1 fail，516 expectations，971.75s，exit1** |
| Session focused / 原packages/opencode | `test test/session/prompt.test.ts --test-name-pattern 'running (subtask|task tool) preserves metadata after tool-call transition' --timeout 30000` | RED：0 pass/2 fail，3 expectations，22.10s |
| session-metadata-narrow / 隔离packages/opencode | 同focused参数 | RED：0 pass/2 fail，6 expectations，19.61s |

组合五组测试总计 **385 pass、1 skip、0 fail、1608 assertions**，明确排除Session。完整Session唯一失败为`running subtask preserves metadata after tool-call transition`，注册5000ms、实测5004.03ms失败；task-tool对应测试本次完整suite通过但focused仍出现注册10000ms超限。CLI --timeout 30000不覆盖这两个显式注册预算。

保留的非green记录及边界：

- B早期并发负载下Shell+prompt为248 pass/1 fail，既有coalesces进度断言得到4次durable而要求<=3；单独及无并发完整重跑通过，未修改断言。这不能证明其时序敏感性已消失。
- 首次隔离combined Shell为221 pass/28 fail，均external_directory。旧runner把HOME/TEMP置于复制Git worktree内，fixture因而属于同项目；仅将临时验证state移到worktree外后，同249测试通过。原失败`r4-c-combined-shell.json`保留，生产权限/测试均未调整。
- primary此前完整Session外层900秒timeout没有完整verdict，不能记PASS，也不能单凭截断点归因503。最新完整运行自然返回exit1，记录wall972068ms，说明旧外层预算可能截断；`temporary reviewer outage` HTTP503是另一个既有fixture日志，不是本次唯一失败，也不是已完成基线比较。
- Session observer仅诊断：fixture/project native Git链耗时约4.18s，某次body在deadline后仍完成metadata断言、cancel和fiber await；task-tool captured cancel约2158ms后有限完成。该样本反驳永久deadlock，不确定全部内部等待或宿主变慢原因。测试使用in-process Task/Session，观测未走B shellEnv或worker子进程；这种路径区分不能替代正在进行的HEAD/R2基线对照。

未改变测试预算/fixture/断言来使Session变绿，未把observer延长观察窗口后的有限完成当原测试PASS。**Session基线对照及其最终处置待另一agent/primary提供，当前完整R4验证仍RED。**

### 28.6 Independently Recounted E/C

计数直接基于六文件`git diff HEAD --unified=0`，而非将R2/B/C报告数字相加。逐项注释位置、资格说明、import/blank/patch排除行保存在`D:/Temp/opencode/r4-independent-comment-accounting.json`；其中链接完整实际diff证据供复核。本计数是行政证据复核，不能替代独立实现auditor。

| File | Effective added code E | Qualifying Chinese C |
| --- | ---: | ---: |
| core/src/cross-spawn-spawner.ts | 28 | 4 |
| core/test/effect/cross-spawn-spawner.test.ts | 75 | 12 |
| opencode/src/tool/shell.ts | 28 | 10 |
| opencode/test/tool/shell.test.ts | 275 | 39 |
| existing OpenTUI dependency patch runtime payload | 1 | 1 |
| opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts | 111 | 19 |
| **Total** | **518** | **85** |

保守计算`C/E=16.41%`，最低`ceil(518×0.15)=78`，85合格注释行达到门槛。E包括新增代码的括号/fixture字符串源码，修改按新增侧计一次，不重复计删除侧；实际排除9行顶层import-only、9行空白、85行注释、11行patch envelope/context/旧payload。算术校验：632新增-9-9-85-11=518。未借生成bundle名义排除人工修复runtime payload，亦未做额外formatter/pure-move扣减。

与报告简单相加515/85的差别是**嵌入式fixture import行口径**：本次统一保守计入生成脚本内容；R2的shell.test.ts当前2254行和C的runtime test当前75/76行此前排除，B的shell.test.ts当前249行此前已计。故本次较简单相加多3行E，C不变。若把全部4行嵌入import一律作为import-only排除，E=514/C=85；本节采用更大的518作门禁分母，不混用规则。所有85行解释均紧邻实际所有权、真实完成、测试因果顺序、清理边界、平台差异或隔离约束；没有为比率补文字或增断言。

### 28.7 Remaining Limits and Independent Audit Record

| Prerequisite / limit | Current state |
| --- | --- |
| Session required regression | 后续完整R4重跑115 pass/14 skip/0 fail，见§28.8；保留此前RED及其尚未归因的时长波动 |
| Full-scope independent implementation audit | **pending，尚无invocation/verdict记录**；§27仅是plan批准，不能冒充implementation批准 |
| Linux/macOS | R2有历史Linux隔离bundle结果；R4 B/C累计实现未新增Linux验证，macOS未跑，不跨revision借用green |
| Historical 40 post-output cases | §26.6分类完整保留；当前两根修不证明所有旧记录同因或全消失，缺历史root/EOF/版本的项仍不可验证 |
| Conda/Python、Start-Process | 保留原正常有限矩阵及native句柄继承边界，不宣称当前两根修处理所有外部进程/合法后代寿命 |
| Deployment / artifact smoke | 新产物只在隔离temp目录，live包/daemon未更新；额外TUI/daemon smoke因端口隔离限制未执行 |
| E/C and production budget | 本节独立重算可用；实现auditor仍应从实际最终diff复核 |

当前只追加行政实现证据，未改变R4设计、审批或顶层状态。待Session基线任务结果和必要处置到位后由primary补证、决定是否转implementation-audit-required并发起**完整原始范围**审计；不得仅审B/C新行或把385组合通过当完整验证。独立实现审计No blocking findings之前不更新verified，不commit/push/publish，不修改live部署。

### 28.8 Session Paired Verification and Audit Handoff

本节补充§28.5/28.7记录之后完成的验证，保留前次失败记录。来源：`D:/Temp/opencode/r4-session-paired-findings.md`、`r4-session-paired-results.json`、`r4-session-paired-full-results.json`。

同一临时工作区和外部HOME/TEMP、固定依赖链接、相同命令及原5s/10s测试期限下，交错串行运行三组HEAD/R4对照。HEAD用只读git show提取三个生产变更文件并切换真实runtime payload，每次记录源码/payload哈希；未改主工作区或已验证隔离产物。

| Pair | HEAD 378033d16a | Current R4 | Result |
| --- | --- | --- | --- |
| 1 | 13.27s | 11.88s | 两侧各2 pass/0 fail |
| 2，顺序反转 | 16.30s | 14.34s | 两侧各2 pass/0 fail |
| 3 | 15.41s | 13.59s | 两侧各2 pass/0 fail |

聚焦用例连续通过后，完整R4 `bun test test/session/prompt.test.ts --timeout 30000` 在独立临时工作区的`packages/opencode`运行得到 **115 pass / 14 skip / 0 fail、516 assertions、541.95s**。自然exit0及双流EOF，watchdog未触发；既有reviewer503夹具日志保留。精确runner/cwd/argv与hash见上述原始产物及findings。该结果与§28.4组合385 pass/1 skip共同覆盖批准回归，重复聚焦/core结果不重复累加。

三组对照均未观察版本相关失败，也未重现旧失败，故旧时长波动仍未归因，不宣称HEAD已证明有同一失败或flake已修复。配对副本的依赖链接拓扑与先前物理安装工作区不同；同组双方拓扑一致，但971.75s与541.95s差值不能归因于某一个变量。原R4验证工作区受保护hash未变，最终无残留Bun进程。

当前六文件实现冻结供完整独立审计：Status=implementation-audit-required，Approved revision=R4。门禁证据齐备但未宣称verified；所有历史归因、平台和live部署边界继续保留。除审计要求的返工或新批准revision外，不增加材料性改动。

## 29. R4 Independent Implementation Audit

Invocation: `ses_f16001a07ffeRBBxLv3zWfGiv3`; mode: implementation; approved revision: R4; round: 1; full-scope. 以下独立 verdict 原样记录，顶层状态据此更新为 verified。§28的pending/RED为按时间保留的中间验证记录，最终独立结果以本节为准。

## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01：历史归因边界保留。** 当前角色泄漏与 streaming worker 复活已取得正常退出证据，不能推断历史 40 条最终输出案例全部同因或全部消失。
- **N-02：既有测试耗时波动尚未归因。** 本轮独立完整 Session 回归通过，未修改测试期限或断言；此前 Session 超时及 progress 时序失败记录仍须保留，不能宣称其波动已经修复。
- **N-03：平台和部署边界。** 本轮验证为 Windows；R4 未新增 Linux/macOS 验证。实际 patched 安装图及构建产物位于隔离目录，主工作区 installed dependency 和 live daemon 未更新。

## Rejected speculation

不要求新增 worker 状态机、额外清理循环、setter/start guard、worker unref、备用执行路径或提示词。

未发现需要改写 Conda/Python、改变审批、清除所有句柄继承位，或依据输出文字、静默时间提前返回的证据。

## Requirement and traceability coverage

审计覆盖当前六文件累计 diff、批准 R4、完整原始要求及其直接影响路径。已用 Git blob hash 独立确认隔离验证副本的六文件与主工作区一致。

| 范围 | 独立结论 |
|---|---|
| 审批与原生合同 | 审批先于执行；预算起点、原始命令、同步五字段接口、提示及其组装保持。 |
| R2 生命周期基线 | exit+output 共同完成；取消覆盖 root 后读取；source/tap 按 spawn scope 释放，保留正常晚到输出。 |
| 角色泄漏根修 | 普通 Shell 复用 `sanitizedProcessEnv()`，只隔离隐式内部身份，UTF-8 和插件显式覆盖优先级保持。 |
| worker 复活根修 | dependency patch 在循环 admission 检查 `!isDestroyed`，阻止销毁后的新工作；保留在途结算及合法 client reuse。 |
| 实际依赖交付 | 已直接读取隔离 installed chunk 的真实 guard；旧 ScrollBox patch 保留。closure 独立复跑通过，lock 零变更。 |
| 根因测试敏感性 | 对未修改的主工作区旧依赖独立运行新 teardown 测试，得到预期 **5 fail**：四种 hook 恢复后 client 复活，自然 child 触发 watchdog；同一测试源码在 patched 图中通过。 |

### 独立执行验证

除角色 fullchain 和刻意执行的旧依赖 RED 外，以下测试在已核对一致的隔离工作区、对应 package 目录执行：

| 验证 | 结果 |
|---|---|
| Shell + shell-prompt 完整回归 | **249 pass，0 fail** |
| Core spawner + AppProcess | **50 pass，0 fail** |
| direct shell、ripgrep、MCP、plugin | **70 pass，1 skip，0 fail** |
| installed streaming runtime + ScrollBox | **16 pass，0 fail** |
| 完整 Session prompt | **115 pass，14 skip，0 fail**；518.99 秒 |
| opencode、core 的 `bun typecheck` | 均通过 |
| `verify-opentui-closure.ts` | 通过；11 包、唯一消费图及 release gitlink 闭包成立 |
| 六文件 `git diff HEAD --check` | 通过 |

本轮还独立复跑了两个正常结束反馈环：

- **角色 fullchain：**真实 ShellTool → pwsh → source CLI `--version`，普通路径及控制均自然完成，**1 pass、20 assertions**；没有用诊断 sanitizer 替代普通路径。
- **恢复的原 topology：**minimal Markdown 与 tiny package 均自然 exit0、两路 EOF、无 watchdog；未添加 observer 或额外 client 清理，tiny package 的 `mismatches=0`。

已直接核对 frozen install 和最终 build 的原始执行记录：均 exit0，构建使用 `release=false`，版本及 compiled voice Worker smoke 通过。**本轮未重新安装或构建**，未把读取记录表述为独立重跑。

## Primary-path and fallback verdict

通过。

A/B/C 分别修复既有生命周期监督、环境 producer 和 streaming admission owner，没有失败后尝试另一算法的关系。

正常成功仍要求真实进程结果与完整输出消费；新根修已通过自然退出验证，不依赖更快报错或 timeout 交付。新增 alternate-success 路径为 **0**，新增独立生产 diagnostic 决策面为 **0%**。

## Code quality and Chinese-comment verdict

通过。

生产承载 **3 文件，新增 84 行、删除 34 行，共 118 行**；包含 dependency patch 全部 envelope/context 文本，满足 5 文件/800 行限制。无新公共 API、配置、依赖版本或提示修改。

独立从累计 diff 计数并复核注释语义：

| 文件 | E | 合格 C |
|---|---:|---:|
| Core spawner | 28 | 4 |
| Core tests | 75 | 12 |
| Shell | 28 | 10 |
| Shell tests | 275 | 39 |
| OpenTUI patch runtime payload | 1 | 1 |
| installed runtime tests | 111 | 19 |
| **合计** | **518** | **85** |

排除顶层 import-only、空行及 patch 元数据/上下文；嵌入 fixture 的 import 保守计入 E，人工 runtime 修复不因位于 bundle patch 而排除。`C/E = 16.41%`，超过 15% 目标。

## Release verdict

**APPROVE — 批准当前累计六文件实现 diff，基于批准计划 R4，full-scope。**

当前实现满足 `verified-implementation` 的独立审计条件。主代理可原样记录本 verdict 并更新 canonical 状态，同时保留历史未知、平台未验、测试耗时波动及 live 部署未更新的边界。本批准不授权 commit、push、发布或替换 live 产物。

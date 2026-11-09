# Canonical Implementation Plan: 最近多次必过核心 CI 红测的累积修复

> Status: audit-required
>
> Revision: R9
>
> Approved revision: none
>
> Audit mode: full-scope
>
> Requirement source: 本轮用户原文及最新 CI 验收补充（见第 1 节）
>
> Implementation allowed: no
>
> Last updated: 2026-11-07

This file is the sole implementation specification for this task. Chat summaries, superseded revisions, and builder rationale outside this file are not implementation authority.

## 0. Cumulative Failure and Repair Ledger

本 revision 纠正 R8 只保留最新失败、错误撤销 R6 已验证 HUNK 的范围问题。以下账本跨最近约八次 Actions 保留每个尚未关闭的失败；新 run 只能增加证据或改变状态，不能删除历史未解决项。

| Failure group | CI evidence and current state | R9 disposition |
| --- | --- | --- |
| ProjectCopy 删除 macOS `.git` 的 ENOENT | run `42277643108` 原始红色；`67a07de994` 的 `project-copy.test.ts:364` 仍是非幂等删除 | 恢复 R6 HUNK：`force: true`，只忽略 NotFound。 |
| daemon 无响应强停真实 CLI 超时 | run `42294195465` 原始 30s timeout；R6 双强停 2/2 候选通过；`67a07de994` 仍无精确 stop 快速加载 | 恢复 R6 的 `src/index.ts` 精确两参数加载及 fail-help 回归；daemon 行为测试零改动。 |
| 旧 Windows run-process 进程超时 | run `42235595844` 原始红色；精确提交隔离副本 13/13，后续 CI 恢复，原 hosted worker 无法补取 | 保留零代码观察，不伪造生产 HUNK；实施后任何必过复现仍阻止验收。 |
| execute 启用时直接 bash/task/goal/MCP 消失及下游 SSE/run-process 失败 | run `42342270890` 原始红色；`14790e2dbb` 已恢复直接工具入口；本地 run-process 13/13、代表工具 6/6、snapshot race 1/1 | 已由后续提交关闭；保留证据，不重复修改。 |
| DB maintenance election `Expected false / Received true` | runs `42349679562`、`42358565595`、`42373519357`、最新 `42380368095` 持续出现；精确哈希候选 Linux 3/3 | 保留 R8 HUNK：精确 election readiness。 |
| 统计/token 估算问题 | 原早期失败由用户分配给其他 agent；后续统计提交已覆盖 | 不属于本 plan 修改；不夹带其他 agent 工作。 |
| App E2E 等警告 job | 用户明确排除警告内容的必要修改范围 | 只观察，不驱动 HUNK；不得借警告包装必过失败。 |
| Windows SDK `matches generated SDK prompt no-reply routes` 30s timeout | 最新 run `42380368095` / head `3a73ac6124` 原始红色，0 assertions；该提交不在当前 `dev1-smark` | 保留零代码开放观察；精确提交隔离副本 4/4 通过，尚无可复现 first divergence，禁止先调 timeout 或猜改 execute。 |

因此 R9 的已验证实施范围是 **4 个文件、3 组根因修复**；旧 run-process 与最新 promptAsync 是 **2 组零代码观察项**，既不从账本删除，也不被宣称为已修复。当前 PR head 与 `dev1-smark` 不同，实施后必须在实际受影响目标 ref 上跑必过 CI，不能用另一个 head 的绿色替代。

## 1. Verbatim Requirement

> 当前我发现我的 GitHub 线上仓库发生了多次的 CI 的 action 的红测，也就是 red test，你去检查一下到底怎么回事。保持只读调研，不要去写入任何文件。当然你可以在本地进行复现测试。不过保持高效，只进行必要的检查以及测试。

> 注意要求的验收结果是CI不会再发生相应的类似的红测，同时不能丧失对应的CI测试的目标测试行为和语义，譬如你不能放宽，但是可以让测试的目标更加符合测试本身的目标方向。

> 不要增加用户没有要求的 feature，任何没有要求的 feature 都不要去做增加，保持最小的 HUNK 和最高泛化性的这种修改逻辑。

> 审计啊，说过了要求你将最新的逻辑内容保持不进行红测，换言之你的任务是解决所有红测问题。

最新补充：

> 我说过了，最后的验收标准是所有的CI都是绿色的。你不能给我一个红色的说怎么怎么样，或者说去把一些本来是红色的东西回报成绿色，但是如果它是红色，你需要去修正，要么是修正测试，要么是需要去修正相应的具体的生产代码。然后当前的任务流程是构建 plan，必须按照 first principle plan 的原则，必须保证你实施之后的内容是不会发生红色。

最新范围澄清：

> 请注意我说的这个 CI 的测试的错误啊，巴拉巴拉的东西，我指的主要是这个必过的核心测试，警告的东西呢，你不需要太过担心，请注意这点。也就是警告的内容本身并不在你的这种修改范围内，或者不在这个必要修改的范围内。

累积范围要求：

> 有一个问题，你这个修改的内容都会修改多少呢？而且你解决的测试都有解决多少的？只解决了一个测试问题吗？旧的历史的问题现在还会存在吗？我没有只让你解决最新的问题哈，请注意这一点。

> 换言之，你的 play本质上应该是包含了你所有已经验证过的一些那个内容啊。你不应该只是每一次都完全重写，然后重写只包含最新的，这不对呀。

> 按理来说应该包含，比如最近八次 action 的红色的，就是所有人为解决的这些红色的一些问题，不包含那个短断断断的一些风险性或者警告性测试。

本阶段目标终态是 `approved-plan-only`：只形成并审计本 canonical plan，不修改当前工作区的 production、tests、configuration、migration、generated files 或 CI。实施后的最终验收不是“目标用例本地通过”，而是全部 GitHub **必过核心 job** 实跑全绿，并逐 job 核实测试 step 与 JUnit 失败数；任何必过红测都阻止完成声明。警告 job 不属于本任务必要修改范围。

## 2. Explicit Non-Goals

- 除第 10.2 节已验证的 CLI 入口按需加载外，不修改其他生产逻辑；尤其不修改 `Flock`、`ServerLock`、offline compression、daemon election 或 models-dev，失败现场已证明 DB first divergence 在测试 readiness。
- 不增加或延长任何 timeout，不降低并发，不重试、跳过、隐藏或放宽测试，不删除现有断言。
- 不重做 `14790e2dbb` 已修复的 execute 直接工具入口，不修改 Goal、Task、MCP、run-process 或 daemon/SSE 行为；daemon stop 只允许第 10.2 节的入口加载 HUNK，原行为测试不变。
- 不修改 App E2E、上游额外包测试或其他警告 job；`continue-on-error` 的警告结果不进入本任务必要修复范围。
- 不处理用户此前分给其他 agent 的统计/TUI 问题，不夹带 token、voice、UI 或 CLI 框架改动。
- 不新增 helper、公共 API、配置开关、重试机制、CI job、fallback 或第二套锁文件名算法。
- 不把本地目标用例通过、WSL 的部分通过或历史绿色 run 描述成“必过 CI 已绿”。实施后的任何必过红测都必须继续修复并重新审计，不能豁免；不得只看被 `continue-on-error` 包装后的结论。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/guides/workflow.md:18-43,45-71,86-97,109-112` | 要求 first divergence、完整 producer/consumer 映射、red-capable feedback、独立全范围审计和真实验证结果。 |
| `.opencode/policy/first-principles-engineering.md` | 没有证据不得构造 edge case；不得用 fallback、症状掩盖或 speculative production defense 代替根因修复。 |
| `packages/opencode/test/AGENTS.md` | 真实子进程使用 live clock；并发生命周期测试应等待 published readiness，而非无关活动或固定睡眠。 |
| `packages/opencode/AGENTS.md` | Effect/service 生命周期保持现有 owner；本方案不改变服务、runtime 或进程拓扑。 |
| `packages/core/src/util/flock.ts:327-357` | `Flock.acquire` 使用 `Hash.fast(key) + ".lock"` 生成唯一锁目录名；测试必须复用同一算法，不能另猜文件命名。 |
| `docs/adr/` | 无 DB maintenance/election 专项 ADR；无额外架构授权。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| R6 ProjectCopy 原始红色与候选 | run `42277643108` 的 macOS `.git` ENOENT；只在测试前置删除增加 `force: true` 的候选保持 NotFound 幂等，其他错误仍传播。 | observed |
| R6 daemon CLI 候选验证 | 双真实 CLI 强停 2/2；help/fail-help 3/3、34 snapshots、50 assertions；普通 run-process 13/13、47 assertions；无响应强停约 7.72–8.54s。 | observed |
| `67a07de994` 源码复核 | ProjectCopy 目标删除仍无 `force: true`，`src/index.ts` 仍无精确 stop 加载；历史 HUNK 不能因后续未红而删除。 | observed |
| GitHub run `42342270890`, head `3be36822bf` | execute 提交曾使 provider 只剩 `execute/invalid`，造成 run-process、Goal、Task、MCP 等大量失败；该 run 不是最新验收基线。 | observed |
| GitHub run `42373519357`, head `67a07de994b4000910112b035f0a25ef771b711d` | R8 审计时的 PR 基线。必过核心仍只有 Linux/macOS 的同一 election 失败；主测试 job `128418970275`、`128418970354` 及对应结果检查均失败，没有其他必过失败。 | observed |
| GitHub run `42358565595` 的必过 artifacts `13568713810`、`13569225982` | 两个 JUnit 均只包含 `database maintenance CLI > holds the daemon election while initially offline compression runs`：`Expected: false / Received: true`；与最新 PR run 签名一致。 | observed |
| 上一 run `42294195465` 的 artifacts `13541812126`、`13541263370` | 同一用例此前在 Linux/macOS 通过，3 个断言均执行；证明测试目标本身有效，不应删除或放宽。 | observed |
| `packages/opencode/test/cli/db-maintenance.test.ts:20-52,242-274` | 测试以独占 tmp HOME/DB/XDG 启动真实 PTY CLI；当前等待锁目录中的任意 `.lock`，随后竞争者获取 `opencode.server:<lockPath>`。 | observed |
| `packages/opencode/src/cli/cmd/db.ts:60-72,367-371,515-599,604-672` | offline compression 在初次 `liveDaemon` 后获取 election，并保持到 compression、reclaim 决策和输出结束；没有测试所暗示的提前 release 路径。 | observed |
| `packages/core/src/util/flock.ts:148-200,223-288,327-357` | 锁目录原子创建、heartbeat、token release 和精确哈希命名；竞争者在锁不存在时可正常立即获取并释放。 | observed |
| 当前工作区原 execute 回归复验 | `run-process` 13/13、47 assertions；6 个 Task/Goal/MCP 代表用例 6/6；HttpApi Task 1/1；snapshot race 1/1。证明这些历史失败不属于 R9 新 HUNK。 | observed |
| 原生 Linux Bun 1.4.4 复现原始测试 | 原任意 `.lock` 等待可复现 `Expected false / Received true`，不是 hosted-runner 专属现象。 | observed |
| 外部副本的 acquire/release 现场 | 先出现 `models-dev:<cache>` 锁；测试因“任意锁”提前启动，`opencode.server:<lockPath>` 竞争者先获取并立即释放；主 CLI 随后正常取得同一 election，压缩并到达 Reclaim。失败时主锁仍可见。 | observed |
| 外部候选在 Linux 连续运行 3 次 | 精确等待 election 哈希文件后，目标用例 3/3 通过，每次完整执行原 3 个断言；未改 timeout、生产代码或测试输出。 | observed |
| WSL 全文件运行 | 目标用例通过，但同一 WSL 环境其他维护用例出现启动/30s timeout；该运行不计为全文件绿色证据，也不用于豁免任何红测。实施后仍须在受支持环境跑完整文件和全部必过核心 CI。 | observed / insufficient for acceptance |
| 最新完成 run `42380368095`, head `3a73ac6124` | Linux/macOS 仍为同一 election 失败；Windows integration 新增 `matches generated SDK prompt no-reply routes` 30s timeout、0 assertions。 | observed |
| 精确 `3a73ac6124` 隔离副本 promptAsync 复现 | `bun test test/server/httpapi-sdk.test.ts --timeout 30000 -t "matches generated SDK prompt no-reply routes"` 连续 4/4 通过，耗时 14.21–16.68s；没有红色 first divergence，不能宣称已修复或新增猜测 HUNK。 | observed / unresolved original CI symptom |

## 5. Current Behavior

### 5.0 历史未解决项及零代码观察

ProjectCopy 的第一分歧仍是测试前置删除把“路径已经不存在”当成错误；这与公开 refresh 行为无关，修复 owner 是该 fixture。daemon 超时的可控成本源头是入口在任何业务执行前加载全部命令模块；R6 已用阶段探针和候选时长证明精确 stop 只加载所需命令可消除无关工作，而原 stopDaemon、真实 CLI 退出和强停语义保持不变。

旧 run-process 与最新 promptAsync 的原始 CI 红色仍保留在第 0 节账本。前者在精确提交隔离副本和后续 CI 未复现，后者在精确 `3a73` 隔离副本 4/4 通过；二者都缺少可重复 first divergence，因此本 revision 不伪造代码修复，也不将其写成已解决。实施后必过 CI 若再次出现任一签名，必须返回诊断并递增 revision。

### 5.1 已恢复的 execute 失败

`3be36822bf` 曾在 execute 启用时跳过所有进入脚本目录的直接工具，导致 provider 只看到 `execute/invalid`，继而出现 bash/task/goal/MCP 不可用及其下游断言失败。最新 head `14790e2dbb` 已移除该跳过逻辑；最新 CI 与本地代表回归均证明这些失败已恢复。R9 不重复修改该路径。

### 5.2 持续出现的 DB election 失败时序

```text
test 启动真实 db compress PTY
-> CLI 启动阶段取得 models-dev:<cache> 锁
-> 共享 locks 目录出现 models-dev 的 *.lock
-> 测试的“任意 .lock”条件误判为 election readiness
-> contender 请求 opencode.server:<tmp>/tui-server.json
   [主 CLI 尚未取得该 key，竞争者立即成功]
-> contender 的 await using 立即 release，但 acquired 已被永久写为 true
-> 主 CLI 正常取得同一 opencode.server election
-> offline compression 完成并停在 Reclaim prompt，主 election 仍持有
-> expect(acquired).toBe(false) 读取到早期竞争者留下的 true，测试失败
```

因此，失败并不意味着主 CLI 在 compression/prompt 期间失去 election，也不要求修改生产锁。测试把同目录的无关锁当成目标锁，让竞争者在目标 critical section 之前运行；这是一个错误的同步前置条件。

### 5.3 被证据排除的解释

- 不是 stale/heartbeat 接管：现场没有出现 stale cleanup，且主锁随后仍由主 PID 持有。
- 不是主流程提前 release：主 CLI 的 `Flock.release` 只发生在测试回答之后；失败前的主 election 仍存在。
- 不是锁 key 哈希不一致：主 CLI 与竞争者使用相同 key 和相同哈希文件，只是竞争者启动得更早。
- 不是 30s/60s timeout 不足：修改等待对象即可恢复原语义，不需要改变任何期限。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| ProjectCopy 目标 `.git` 已不存在 | 测试 tmp copy 与并发/平台删除时序 | 前置只需保证路径不存在 | 原 `rm` 抛 ENOENT；`force: true` 只吞 NotFound | 测试 fixture | observed |
| 精确 `daemon stop` 两参数 | 真实 CLI argv | 无 help、全局或未知参数 | 只加载 DaemonCommand，共用 parser/middleware/exit | CLI 入口 | observed |
| 非两参数 stop、help、普通命令 | 真实 CLI argv | 必须保留完整命令表与 fail-help | 原完整 imports/注册链 | CLI 入口 | contracted |
| promptAsync no-reply SDK parity | 真实 server worker | 30s 内输出并成功退出 | 原 CI 一次 timeout；精确提交 4/4 通过，未建立可复现路径 | 开放观察 | observed / unresolved |
| `models-dev` 或其他非 election 锁先出现 | CLI 启动与共享 XDG locks 目录 | 不同 key 产生不同哈希锁文件 | 已复现：任意 `.lock` 使 contender 提前启动 | 测试 readiness | observed |
| 主 election 已出现 | `daemonElection()` + `Flock.acquire` | `Hash.fast(electionKey) + ".lock"` 是唯一目标文件 | 精确文件出现后启动 contender，contender 必须等待主 release | 测试 readiness / Flock | observed |
| contender 在主 election 前运行 | 过宽的测试等待条件 | 此时锁空闲，成功获取是正确生产行为 | 当前红色路径 | 测试 fixture | observed |
| contender 在主 election 持有期间运行 | 正确 readiness | 主锁 heartbeat/token/release 继续提供互斥 | prompt 前 `acquired === false`；N 退出后 contender 成功 | 测试与 Flock 合同 | contracted |
| 主流程异常或未到达 prompt | 真实 CLI | 现有 `Promise.race`、测试期限和清理继续暴露失败 | 不由本 HUNK影响 | 现有测试 | reachable |
| 其他 CI job 或外部依赖失败 | GitHub workflow/网络 | 不得伪报绿色或豁免 | 实施后任何红测都继续阻塞验收 | 完整 CI 验收 | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-00 | ProjectCopy 前置只要求目标不存在；NotFound 幂等，其他删除错误仍传播。 | macOS ENOENT 与 R6 候选 | 原 ProjectCopy 测试 |
| INV-07 | 真实 CLI 强停仍在原 30s 内完成，退出码、文案、PID/lock 与 stopDaemon 合同不变。 | 原红测、R6 双强停 2/2 | 两个原 daemon 测试零改动 |
| INV-08 | 非精确两参数 argv 保留完整注册、help/fail-help 与普通 run 行为。 | R5 审计分歧与 R6 候选 | 新增 fail-help 等价测试 + 34 snapshots + run-process |
| INV-09 | 未复现的 run-process/promptAsync 不得被写成已修复；任何必过复现继续阻塞验收。 | 原始红色与隔离副本对照 | 实施后目标 ref CI |
| INV-01 | contender 与 `daemonElection()` 必须使用完全相同的 `opencode.server:<lockPath>` key。 | `db.ts:367-371`、测试 contender | 当前用例 |
| INV-02 | contender 只能在本测试主 election 的精确锁文件出现后启动，不能由 models-dev 等无关锁触发。 | Linux 失败时序 | 需要修正 readiness 条件 |
| INV-03 | Reclaim prompt 前 contender 不得成功，`acquired === false` 原断言保留。 | 原测试第 269 行 | 原断言不改 |
| INV-04 | 测试回答 N、CLI exit 0 后 contender 才成功；原 exit/acquired 两个断言保留。 | 原测试第 270-273 行 | 原断言不改 |
| INV-05 | 不修改生产锁、压缩、prompt、输出、timeout、重试或测试并发。 | 最小 HUNK要求 | diff review |
| INV-06 | 最终只接受全部必过核心 job 实跑全绿；必须同时核实 job conclusion、测试 step 和 JUnit failures/errors=0，不能只看被包装的成功结论。 | 用户最新原文 | 实施后必过核心 CI |

## 8. First Divergence and Root Cause

### 8.1 ProjectCopy fixture

Origin 是 `project-copy.test.ts` 对目标 `.git` 的非幂等删除：所需状态只是“不存在”，NotFound 却提前终止测试。`force: true` 修复该 origin，不修改公开 refresh 行为，也不吞其他删除错误。

### 8.2 daemon CLI 启动成本

Origin 是 `src/index.ts` 在精确 `daemon stop` 业务执行前初始化全部无关命令。R6 阶段探针把主要成本定位到 imports，候选把无响应强停降至约 7.72–8.54s。修复必须删除这部分不需要的工作，而不是增加 timeout、替换 stopDaemon 或移除真实 CLI 覆盖。

### 8.3 DB election readiness

First divergence 位于 `packages/opencode/test/cli/db-maintenance.test.ts` 当前等待循环：

```ts
while (!(await readdir(electionDir).catch(() => [])).some((file) => file.endsWith(".lock"))) {
```

该条件把“任意 key 的锁文件出现”错误等同为“本测试的 election 已被主 CLI 获取”。后续 contender、主 CLI 和 Flock 都按各自合同运行；失败是错误启动时序留下的 `acquired=true`，不是生产锁互斥失效。

修复 owner 因而是测试 readiness，不是 `Flock`、`db.ts`、models-dev 或 CI timeout。

### 8.4 尚不能定位的观察项

旧 run-process 和最新 promptAsync 只有原始 hosted CI 红色，没有稳定本地红色。精确提交的隔离复验是目前可执行的最小反馈环，但均通过，因此没有证据授权任何生产或测试 HUNK。它们继续由第 0 节账本和最终 CI 门禁追踪，而不是被静默删除。

### Red-capable feedback loops

1. **原始信号**：最新 Linux/macOS JUnit 同一断言 `Expected false / Received true`；本地 Linux 原测试亦复现。
2. **鉴别信号**：外部副本记录 models-dev 锁先出现、contender 先 acquire/release、主 CLI 后 acquire 并到达 prompt。
3. **候选信号**：只将等待条件收窄到同一 key 的既有哈希文件，Linux 连续 3 次通过原 3 个断言。
4. **最终信号**：实施后完整 package 测试、相关平台 matrix 和全部必过核心 jobs 必须全绿，且测试 step 与 JUnit 均无失败；本地候选结果不能替代该门槛。

## 9. Responsibility and Seam

- **ProjectCopy fixture owner**：`project-copy.test.ts` 的目标路径前置删除，只负责建立“不存在”状态。
- **CLI loading owner**：`src/index.ts` 的 argv 选择与原 yargs parser；stopDaemon 仍拥有强停业务，help-snapshots 拥有 fail-help 回归。
- **Readiness owner**：`db-maintenance.test.ts` 当前等待循环，负责识别本测试主 CLI 的 election，而不是目录中的任意活动。
- **Lock filename owner**：继续复用 `Flock.acquire` 已使用的 `Hash.fast(key) + ".lock"`，不复制另一套算法。
- **Contender owner**：继续复用同一 `electionKey`，避免 readiness 与 contender 的 key 漂移。
- **Production owner**：`db.ts` 与 `Flock` 行为已被现场排除，不修改。
- **Acceptance owner**：实际 GitHub CI 全量结果，不由本地测试或方案文字替代。

## 10. Cumulative Primary-Path Designs

### 10.1 ProjectCopy：修复测试前置的幂等删除

仅将目标 `.git` 删除改为：

```diff
-await rm(path.join(copy.path, ".git"), { recursive: true })
+// 前置只要求目标不存在；缺失是合法状态，其他删除错误仍必须抛出。
+await rm(path.join(copy.path, ".git"), { recursive: true, force: true })
```

不改 `ProjectCopy.refresh()`、fixture 结构、测试断言或其他删除路径。

### 10.2 daemon stop：只消除无关入口加载

`packages/opencode/src/index.ts` 提前计算现有 `args`，仅让精确两参数调用进入 Daemon-only 加载：

```diff
+const daemonStop = args[0] === "daemon" && args[1] === "stop" && args.length === 2
+// 仅无额外参数的 daemon stop 跳过无关模块；其他 argv 保留完整注册和 fail-help。
+if (daemonStop) {
+  const { DaemonCommand } = await import("./cli/cmd/daemon")
+  cli.command(DaemonCommand)
+} else {
+  // 原普通 CLI imports 与 command 注册链按原顺序移动到这里，内容不变。
+}
```

普通分支保持原 import 顺序和 `Acp -> Mcp -> Daemon -> TuiThread -> ... -> Db` 注册顺序。两条分支共享同一 yargs options、middleware、strict/fail、FormatError 与 finally `process.exit()`；这不是第二套 parser 或失败 fallback。两个原真实 CLI daemon 强停测试逐字不改。

在 `packages/opencode/test/cli/help/help-snapshots.test.ts` 增加一个真实 CLI 回归：`daemon stop --definitely-unknown` exit 1，`daemon stop --help` exit 0，二者经现有 normalize 后的 stderr 完全相等。邻近中文注释说明按需加载只覆盖无额外参数调用；不改 snapshot 文件。

### 10.3 DB maintenance：精确 election readiness

本组仅修改 `packages/opencode/test/cli/db-maintenance.test.ts`：

1. 引入现有 `Hash`：`import { Hash } from "@opencode-ai/core/util/hash"`。
2. 在 `electionDir` 后定义唯一 `electionKey = \`opencode.server:${path.join(tmp.path, "tui-server.json")}\``。
3. 用 `const electionLock = Hash.fast(electionKey) + ".lock"` 得到与 Flock 相同的精确文件名。
4. 将任意 `.some((file) => file.endsWith(".lock"))` 改为 `.includes(electionLock)`。
5. contender 改用同一 `electionKey`，保持 options、30s 期限和 `await using` 不变。
6. 在等待条件附近保留一条中文注释，说明共享目录还有 models-dev 等锁，必须等待本次 election 的精确文件。

目标差异形态：

```diff
 import { Flock } from "@opencode-ai/core/util/flock"
+import { Hash } from "@opencode-ai/core/util/hash"
@@
 const electionDir = path.join(tmp.path, "state", "opencode", "locks")
+const electionKey = `opencode.server:${path.join(tmp.path, "tui-server.json")}`
@@
-while (!(await readdir(electionDir).catch(() => [])).some((file) => file.endsWith(".lock"))) {
+// 同一目录还有 models-dev 等锁；必须等待本次 election 的精确文件再启动竞争者。
+const electionLock = Hash.fast(electionKey) + ".lock"
+while (!(await readdir(electionDir).catch(() => [])).includes(electionLock)) {
@@
-await using _ = await Flock.acquire(`opencode.server:${path.join(tmp.path, "tui-server.json")}`, { dir: electionDir, timeoutMs: 30_000 })
+await using _ = await Flock.acquire(electionKey, { dir: electionDir, timeoutMs: 30_000 })
```

不增加生产分支，不改变测试成功标准。精确等待不是放宽：它消除了竞争者提前成功的假失败，同时仍严格要求主 election 在 prompt 期间阻止同一 contender。

## 11. Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| ProjectCopy 非幂等前置删除 | 由 `force: true` 的单点状态建立替代；其他错误继续传播。 |
| 精确两参数 stop | Daemon-only 是同一 CLI 主路径内的选择加载，不是失败后的备用 parser。 |
| 非两参数 argv / 普通命令 | 原完整 imports 和注册链为 contracted pass-through，行为与顺序不变。 |
| 两个原 daemon 强停测试 | 原样保留真实 CLI、30s、退出码、文案、PID/lock 断言。 |
| run-process / promptAsync 零代码观察 | diagnostic path；没有稳定红色，不创建替代实现或新测试。 |
| 原“任意 `.lock`”等待 | 被精确 election 文件等待替代，必须删除，不能保留为另一条启动路径。 |
| contender 内联 key 字符串 | 由同一 `electionKey` 复用替代，避免 readiness/contender 使用不同 key。 |
| `Flock` 生产 acquire/release/stale | 原样保留；无第二套锁实现。 |
| `db.ts` election 生命周期 | 原样保留；无提前 release 或额外锁。 |
| models-dev 锁 | 原样保留；它是合法的不同 key，不应为测试而移动或禁止。 |
| timeout/retry/skip | 不新增、不延长、不启用。 |

## 12. Workaround Deletion and Replacement

- ProjectCopy：删除对 NotFound 的非幂等处理，直接表达“确保不存在”；无第二删除路径。
- daemon stop：删除精确两参数调用的无关模块初始化；普通 argv 仍走唯一原完整注册路径，无失败后 fallback。
- DB readiness：删除以共享目录任意锁作为 election readiness 的过宽判断，复用 Flock 已有哈希命名；旧任意锁路径不得与新路径并存。
- 零代码观察：不增加 workaround、重试、timeout 或兼容分支；原 hosted 红色只在账本和最终 CI 门禁保留。

## 13. Forward Traceability

| Requirement / invariant | Owner / path | File / test |
| --- | --- | --- |
| 恢复历史 ProjectCopy 修复 | INV-00 / 测试前置幂等删除 | `project-copy.test.ts` 原测试 |
| 恢复历史 daemon CLI 修复 | INV-07 / 精确 stop 选择加载 | `src/index.ts` + 两个原 daemon 测试 |
| 保持普通 CLI 与 fail-help | INV-08 / 非两参数完整注册 | `help-snapshots.test.ts` 新回归 + 34 snapshots + run-process |
| 追踪未复现历史红色 | INV-09 / 零代码观察 | 实施后目标 ref 必过 CI，无本地猜测 HUNK |
| 修复持续 Linux/macOS DB 红测，不放宽语义 | 精确 election readiness | `db-maintenance.test.ts` 目标用例 |
| INV-01 | 共享 `electionKey` | readiness 与 contender 两处 |
| INV-02 | `Hash.fast(electionKey) + ".lock"` | 替换任意 `.lock` 条件 |
| INV-03/04 | 原 prompt、N、exit、contender 断言 | 全部保留 |
| INV-05 | 四文件累积最小 HUNK | diff/typecheck/原测试 |
| INV-06 | 必过核心 GitHub CI | 所有必过 job、测试 step 与 JUnit 均零失败 |

## 14. Reverse Traceability

| Proposed concept | Requirement / evidence | Why existing mechanism cannot carry it unchanged |
| --- | --- | --- |
| `force: true` | INV-00；前置只要求路径不存在 | 原 `rm` 把合法 NotFound 当错误；production refresh 不是该状态 owner。 |
| 精确 `daemonStop` argv 判断与 Daemon-only 加载 | INV-07/08；R6 imports 成本与候选时长 | 原入口始终加载无关命令；改 stopDaemon 或加 timeout 不消除该成本。 |
| fail-help 等价回归 | INV-08；R5 审计曾发现 argv 域缺口 | 合法 help snapshots 不能证明未知参数仍走完整 parser。 |
| `Hash` import | Flock 自身用同一函数命名锁文件 | 任意后缀无法区分 key；另写哈希会复制 owner。 |
| `electionKey` | 主 election 与 contender 必须同 key | 内联 key 与 readiness 分离容易再次漂移。 |
| `electionLock` | models-dev 与 election 可共享目录 | 当前任意锁条件已实测产生错误启动。 |
| 一条中文注释 | 非显然共享目录约束 | 防止未来把精确文件再次泛化为任意锁。 |
| 生产变更仅限 CLI index | DB 现场证明生产互斥正常，daemon 成本 owner 是入口加载 | 其他生产变更会越过各自 first divergence 并扩大风险。 |

## 15. File-Level Change Plan

| File | Allowed changes | Forbidden changes |
| --- | --- | --- |
| `packages/core/test/project-copy.test.ts` | 目标 `.git` 删除增加 `force: true` 和一条邻近中文注释。 | 不改 production、fixture 结构、断言或其他删除。 |
| `packages/opencode/src/index.ts` | 精确两参数 stop 的 Daemon-only 加载；其他原 imports/注册链纯移动；一条中文注释。 | 不改 parser/middleware/fail/exit，不扩大 argv 域。 |
| `packages/opencode/test/cli/help/help-snapshots.test.ts` | 一个真实 CLI fail-help 等价回归及一条中文注释。 | 不改 snapshots 或已有用例。 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | Hash import；共享 electionKey/electionLock；精确等待；一条中文注释。 | 不改测试名、PTY、prompt、回答、断言、timeout、其他用例或 fixture。 |

不得修改其他文件。若实施前这些 seam 已漂移，停止并重审，不强行套用 HUNK。

## 16. TDD Behavior Slices

1. **ProjectCopy slice**：原 macOS ENOENT 为 red；只改 fixture 删除后跑原 ProjectCopy 测试，证明公开行为不变。
2. **daemon slice**：原真实 CLI timeout 为 red；先增加 fail-help 回归并确认其在宽 argv 候选上可红，再应用精确两参数加载；跑双强停、help/fail-help 与 run-process。
3. **DB slice**：原 Linux/macOS contender 提前成功为 red；只应用精确锁等待，恢复原 3 个断言并跑完整维护文件。
4. **零代码观察**：run-process 与 promptAsync 使用原测试命令复验；当前通过不构成修复证据，任何必过复现返回诊断，不添加无根因测试或生产分支。
5. **Acceptance**：全部受影响目标 ref 的必过核心 CI jobs 全绿，且测试 step/JUnit 零失败；任何必过红色都递增 revision，不宣布完成。

## 17. Chinese Comment Budget

预计有效逻辑编辑 `E=18`：ProjectCopy `E=1`；CLI argv 选择/分支 `E=6`，原代码纯移动不计；fail-help 回归 `E=7`；DB readiness `E=4`，import-only 行排除。

新增有效中文注释 `C=4`，分别解释 ProjectCopy 的 NotFound 前置、精确 argv 与 fail-help 边界、真实 CLI 参数错误合同、共享锁目录 readiness。`C=4 >= max(1, ceil(18*0.15))=3`。实施时记录实际 E/C；不得拆行凑数或添加复述代码的注释。

## 18. Verification

### Plan-stage evidence already executed

- R6：双真实 CLI 强停 2/2；help/fail-help 3/3、34 snapshots、50 assertions；run-process 13/13；ProjectCopy 与 CLI 根因均有原始红色和候选对照。
- R8：DB 原测试 Linux 复现红色；外部候选 Linux 连续 3 次通过，每次 3 assertions。
- 最新 `42380368095`：Linux/macOS 为 DB election 红色，Windows integration 另有 promptAsync timeout；不能用较早 run 的“只有 DB”描述替代。
- 精确 `3a73` promptAsync 隔离副本连续 4/4 通过，14.21–16.68s；原始 CI 红色保留为零代码观察。
- WSL 全文件运行未全绿，因此**不作为回归通过证据**。该限制不得被隐藏或改写为绿色。

### Required implementation verification

在 `packages/opencode` 及 CI 指定工作目录执行，不用 repo root：

1. 在 `packages/core` 跑 `bun test test/project-copy.test.ts` 和 `bun typecheck`。
2. 在 `packages/opencode` 跑两个原真实 CLI daemon 强停用例、`bun test test/cli/help/help-snapshots.test.ts --timeout 30000` 与 `bun test test/cli/run/run-process.test.ts`；保持原 30s、34 snapshots、fail-help 等价和 13 个进程用例。
3. 在 `packages/opencode` 跑 `bun test test/cli/db-maintenance.test.ts -t "holds the daemon election while initially offline compression runs"`，随后跑完整 `bun test test/cli/db-maintenance.test.ts`；不能用 WSL 的部分结果替代完整绿色。
4. 在 `packages/opencode` 跑 `bun typecheck`、相关 package suite 与 execute/Task/Goal/MCP 代表回归，不得出现新红测。
5. 在受影响精确 head 跑 `bun test test/server/httpapi-sdk.test.ts --timeout 30000 -t "matches generated SDK prompt no-reply routes"`；通过只作观察，不声明原 hosted 故障已定位。
6. 推送或正式 CI 触发后，逐个检查全部 `必过` jobs（packages/opencode、core、tui、http-recorder、OpenTUI、VSCode、HttpApi 等）：job `conclusion=success`、测试 step 无失败、JUnit `failures=0` 且 `errors=0`，三者缺一不可；PR head 与 dev head 不得互相替代。
7. 警告 job 只作观察，不驱动本任务 HUNK，也不计入必要放行；不得借警告范围排除任何必过失败。
8. 任一必过检查失败都保持任务未完成，记录真实日志并修复；不得标记 flaky、环境原因或外部原因后直接放行。

## 19. Diff Budget

- 文件：4 个，其中 1 个生产 CLI 入口、3 个测试文件。
- 逻辑：约 18 个有效编辑点，原 imports/注册链纯移动不计；4 条必要中文注释。
- 生产代码：仅限 `src/index.ts` 的精确选择加载；DB/daemon/Flock 业务逻辑 0 变更。
- 断言：0 删除、0 放宽。
- timeout/retry/config/API/snapshot：0 变更。

## 20. Real Risks and Open Decisions

### Real Risks

- 锁目录在 `mkdir` 后即对 contender 可见是既有 Flock 行为； contender 会看到新鲜锁并等待，不需要等待 meta/heartbeat 另行就绪。
- 若主 CLI 未获得目标 election，精确等待会一直等到现有测试期限并失败；这是正确暴露异常，不应回退到任意锁或加 fallback。
- 必过 job 仍可能因实际代码或基础设施问题失败；按用户要求任何必过红色都不能伪报成功或豁免，但不得为推测中的失败提前增加无关 HUNK。警告 job 按最新范围澄清不计入必要放行。

### Open Decisions Requiring the User

无用户决策。三组修复路径已由失败现场和候选对照确定；两组未复现观察项不构成实施前阻塞，但其实际 CI 复现仍是实施后验收阻塞。

### Rejected Speculation

- 不修改 heartbeat/staleMs：没有 stale cleanup 证据。
- 不移动或禁止 models-dev 锁：不同 key 的锁是合法行为，测试不应依赖目录只有一种锁。
- 不修改 `db.ts` election release：失败时主锁仍存在，生产路径未发生 first divergence。
- 不调整任何 timeout：三组修复分别删除错误前置、无关启动工作和错误 readiness，不靠等待更久。
- 不为 promptAsync 猜改 execute、worker teardown 或 SDK：精确提交 4/4 通过，尚无 first divergence。
- 不恢复已证伪的 execute、daemon/SSE、registry lazy-loading 等旧候选；R6 的精确 CLI stop 加载有独立成本证据，不属于这些被排除候选。

## 21. Audit Contract

审计必须覆盖 R9 的完整累积需求：第 0 节最近约八次 Actions 账本、R6 三个未落地文件、R8 DB readiness、最新 promptAsync 与旧 run-process 零代码观察、已关闭 execute/统计项的排除证据，以及四文件最小 HUNK。必须重建 ProjectCopy、CLI argv/parser/fail-help、真实 daemon 强停、models-dev/Flock、DB contender 与 promptAsync 的相关 producer/consumer，不得只审最新 run 或相信本计划摘要。

最终门禁仍是所有受影响目标 ref 的必过核心 CI 全绿，并逐 job 检查 conclusion、测试 step 与 JUnit。警告 job 按用户澄清排除，不得重新扩入；未复现观察项不得被伪报已修复，也不得在无 first divergence 时新增 HUNK。任何 blocking finding 都要求递增 revision、清空 approval 并重新 full-scope 审计。只有精确 revision 获得独立 `No blocking findings` 和 `APPROVE` 才可设置 approved。

## 22. Plan Audit Record

- R1–R6：围绕早期 ProjectCopy、Windows CLI/daemon 与 execute 前基线进行调查和审计。R9 复核确认 ProjectCopy 与精确 stop 加载仍未落地，因此恢复其已验证 HUNK，而非将其视为被新 run 取代。
- R6 曾获批准；R7/R8 错误地把“最新 CI 范围”解释为撤销旧 HUNK。用户随后明确要求累积最近约八次 Actions 的所有未解决项，R9 纠正该范围错误并重新审计，旧批准不直接继承。
- R7：独立审计 **BLOCK**。B-01 指出仅检查 job conclusion 会把 `continue-on-error` 包装后的失败误判为绿色；审计同时发现更新的 run `42358565595`，其必过失败仍与本 readiness 修复匹配。
- R8：按用户最新澄清将必要范围限定为必过核心；验收增加测试 step 与 JUnit 零失败，警告 job 不再扩入。独立审计结论：**APPROVE — 仅限 canonical plan R8；No blocking findings。**
- R8 非阻断记录修正：N-01 将当时基线更新为 PR run `42373519357`；N-02 将第 20 节措辞明确限定为必过 job。R8 的 DB HUNK 和验收语义继续保留，但单文件范围不再足够。
- R9：恢复 R6 三个文件，保留 R8 一个文件；新增最新 run `42380368095` 的 SDK 红色证据及精确 `3a73` 4/4 未复现结果。当前 **audit-required / Approved revision: none / Implementation allowed: no**，等待新的独立 full-scope 审计。

## 23. Implementation Evidence

尚未实施。本阶段当前工作区只允许存在本 plan 的修改；外部副本探针和候选验证不构成工作区 implementation。

实施时必须补充：实际 files/diff、red-green 命令与结果、完整验证、原始 feedback loop、secondary paths、实际 E/C、未验证项。

## 24. Implementation Audit Record

待实施及必过核心 CI 验收后进行。未经实际 diff 独立审计、全部必过 job 成功以及其测试 step/JUnit 零失败，不得设置 `Status: verified`，不得报告任务完成。

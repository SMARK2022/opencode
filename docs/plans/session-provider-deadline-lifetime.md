# Canonical Implementation Plan: SessionRunner provider 总期限的取消归属

> Status: implementation-audit-required
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: §1 用户原文；原 GitHub #5 Linux Guard Core 分片异常
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-22 HKT

本文件是此变更的唯一实施规格。固定 pre-R1 基线为当前官方 `dev1-smark` `4555c21eb8615e15eb88d746df89f9ac9538898c`，tree `2fc8aaec8b46395df037ef6212d9ae6a41b87243`。这是 #11 合入后的共享缺陷处理，不更改 #5 的产品设计，也不与已独立审计的 MCP 夹具修复合并。交付目标是最小实现并完成实际差分审计；发布目的地和动作仍按用户已经授权的范围执行。

## 1. Verbatim Requirement

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。

> 你可以去检查一下对应的静态问题，然后保持最小修改。

> 如果那个东西已经通过了，那我可以去选择合并PR都可以。你自己看一下，就是反正现在暴露了一些这个test问题，test问题需要进入到你的这个PR的一个新的commit，或者说新的PR都可以。

来源：用户消息 `Sentinel_9a4c3eb4956c8191a0de0f57220c05d2` 末两句，讨论 #11 的合并和基线中已发现的测试问题。

本方案处理 Core 清理红灯中已单独归因的一个 600 秒句柄。不改 Gate/get，不新增计时器或测试实例。只为这一项已证实的既有红测选用最小独立 draft PR 及其必要的 head 分支，用户决定并执行合并。已合并的 #11、独立 MCP 夹具和未归属的 1 秒句柄分别记录。

## 2. Explicit Non-Goals

不改变 provider 或 Session 的公开接口、配置默认值、时限、Clock、调用次数、取消原因、输出投影、缓存、存储、权限、重试策略或 Gate。保留 transport、LLMClient、legacy/native-runtime、Core timeout 工具和锁定的 Effect 依赖。现有用例和 preload 不改。600 秒是症状的时长，本方案不修改或新增计时器。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md`“V2 Session Core”与“Testing / Type Checking” | SessionRunner 归 Location；同一 turn 仅一次 `llm.stream`；保留共享取消和恢复；从包目录验证 |
| `CONTEXT.md` 的 Session Drain、Safe Provider-Turn Boundary | 进程内 drain 的完成与单次 provider 生命周期要一致，不改变持久化边界 |
| `.opencode/policy/first-principles-engineering.md`、`docs/guides/workflow.md` 和 canonical template | 单一执行路径、原因就地修复、原反馈、单独方案与实施审计 |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 与本变更无重叠决策，无需新增 ADR |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 官方 `4555` commit/tree 及其父 `db536`、`2808abcc` | 新基线只合入 #11 五个 OpenCode 路径及其 Plan，未改本链的 Core 代码、测试、原 preload 和锁 | observed |
| `packages/core/src/session/runner/llm.ts:550–605` | 单次 provider 流、总期限、失败时 publisher flush 及原可中断执行位置 | observed / contracted |
| `packages/core/test/session-runner.test.ts:1287–1352,1766–2046` | 原 TestClock 默认／显式／禁用合同，以及由真实 runner、registry、子 Session 和可中断 Deferred 组成的原用例 | observed |
| 锁定 Effect 的 `dist/internal/effect.js:948–971,1465,2075–2087,2105–2120,2502–2508` | `timeoutOrElse` 的竞速、立即启动的 daemon 子 fiber、时钟 sleep 与 scoped fiber 的注销行为 | observed |
| [#5 原 Linux Guard job](https://github.com/SMARK2022/opencode/actions/runs/44928048203/job/136918673031)，官方制品 14717192065 | Core 包一个 afterAll 报 600000、60000、30000、1000 四个句柄，无子进程；OpenCode 分片另有两个业务失败 | observed |
| 私有 `pr5-core-llm-ab.k9cuuB`，清单 SHA-256 `d9c470d10d374b6698e595865ff0b7e8633bf1ab243a00d4543b7a8b8f6eda11` | db536 与当时 #5 d1ef 原用例并行：各只留一个 600000；候选源 owner 与新 #5 2a4a 对应文件逐 blob 相同 | observed |
| 私有 `pr5-core-600-fiber-proof.NK8Vcg`，清单 SHA-256 `5fd56817f853054ae674db7167e1a25c22c2e2f8b8b67e4159704e2ed4a8d3a4` | 原用例中父中断、父终态、迟到子 fiber 启动、原计时器分配的因果顺序；没有测试源变化 | observed |
| 私有 `pr5-core-600-contract-pair.qHEJWc`，清单 SHA-256 `bbb5efba8f6543bf626abe7ec97cd22720ade2a640b92d2b2731e28f6d742878` | 相同两条原用例在只读基线和仅作用域归属改变的内存投影之间的红绿 | observed |

`4555` 上关键 blob：runner `6a3023d71065daec40223e0257ec8ac02ee25461`，测试 `dd3897b1855b8deb8f33b5fa1c4be098dfff431d`，原 preload `b000b0bfec035161a3df2d32f951daf33bd0da70`，锁 `b8df0beac78938ebd6f2a7d971d457ccd5e50694`。计划实验在已核验字节等价的 db536 投影中运行，**不是**声称已在 4555 完整交付树或最新 #5 上运行。4555 实际候选须重跑。

## 5. Current Behavior

```text
SessionRunner 单次 turn -> 既有 LLMClient.stream 和消费队列
  -> 对整个消费过程设置同一次总期限 -> 返回原结果或原 LLMError
  -> 既有 publisher.flush、取消投影及原重试
```

`model.timeout === false` 直通；其他情况用给定数值或 600000 ms。期限覆盖整个消费，不因收到 chunk 重置。当前 `Effect.timeoutOrElse` 竞争的两个子分支由 Effect 立即以 daemon 方式启动。取消可在首分支注册期限之前重入，使期限在已终止父操作之后才分配。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantee | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 未配置、显式数值、`false` | 原模型设置 resolver | 合法期限与禁用语义已解析 | Provider 消费的现有期限边界 | SessionRunner 当前 turn | contracted |
| 正常 EOF、流失败或期限到达 | 真实 LLMClient 流 / 原 Effect Clock | 原 transport 取消、错误及分片合同 | 原 consume → flush → 退出结果／重试 | 原消费和错误处理 | contracted / observed |
| 用户取消、中断 foreground 子任务 | Session 取消与 Task 对原 fiber 的中断 | Effect 流与原 Deferred 可中断；没有不可取消的模拟 Promise | `Fiber.interrupt` → 正在启动的期限竞速 | 当前 provider 操作作用域 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 完成、失败或取消后，单次 provider 操作不留下自己的活动期限 | 原失败句柄与当前因果追踪 | 原 canonical Task 用例 + stock leak preload |
| INV-02 | 一次全流期限；默认 600000 ms、显式数值、`false` 与原结果相同 | 原模型解析和虚拟时钟对照 | 原 total timeout 用例 |
| INV-03 | 到期继续生成同一 LLMError；原输出 flush 位置和成功／失败分类、取消原因、重试与恢复维持 | `llm.ts` 现有退出路径与配对结果 | 两条原用例 |
| INV-04 | 仅一个已有生产文件；无新测试、计时器、配置、依赖、Gate/get 或发布范围 | 用户原文及实际路径审计 | 精确全差分与必要原 Gate |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | 父操作已中断并进入终态，`raceAllFirst` 仍启动期限 daemon，未注册进一个可在原操作结束时回收的 scope | 通用分叉实现位于锁定 Effect；当前代码可修的第一边界是 SessionRunner 把新期限直接交给该竞速的方式 | 父 1115 在 seq1197 被 1107 中断；期限子 1135 在 seq1203 首次运行，此时父已经 Failure/Interrupt；seq1204 分配，afterAll 未中断子 fiber。实际 timer 栈由 `Clock.sleep` 到 `raceAllFirst` |
| INV-01 后果 | 一个活跃的 600000 句柄进入原 afterAll 无泄漏断言 | 原 preload 只报告，不分配该计时器 | 独立原用例，与 MCP 两句柄及未知 1 秒分开 |

原入口（从 `packages/core`；固定 Bun 1.4.4、原锁、原 preload、私有仅环回环境）：
```sh
bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts -t 'executes and resumes canonical task sessions with durable results and scoped permissions|bounds active provider streams by total timeout and respects explicit timeout or false'
```
同一两条业务用例均 pass，原实现再因单个 600000 句柄退出 1；私有作用域投影下两例 pass、清理不报错、退出 0。业务断言无弱化，测试独立于原 afterAll 是否报错。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 每次 provider 操作总期限的纤程 | `core/src/session/runner/llm.ts` 现有期限操作 | 原消费过程结束后不再有活跃期限分支 | 本模块知道当前 provider 操作何时开始、结束和被取消 | Caller/transport 不同时持有消费与期限；通用 timeout 工具与 MCP 不在本批准路径 |
| 错误、flush 和重试 | 原消费与 SessionRunner 的后置代码 | 保留同一 Cause、原输出/取消投影与重试 | 修改只替换期限的所有权 | 不另建错误转换、状态、队列或统一调度 |

## 10. Single Approved Primary-Path Design

在原期限表达式内捕获当前 `model.timeout` 到局部常量，保留 `false` 的直接分支。对启用的原总期限，在 **当前 provider 消费** 的窄 `Effect.scoped` 中，以 `Effect.forkScoped` 先把原 `Effect.sleep(timeout ?? 600_000)` 后的同一个失败分支登记为作用域资源，再用原 `Effect.raceFirst` 比较 provider 消费和 `Fiber.join` 结果。不增加第二个 sleep、备用超时或额外调用；`Effect.suspend` 只保证原 LLMError 在期限到达才构造。使用现有 `forkScoped` 的调度，不另设起点、倍数或重试。

```text
原模型设置 → 当前操作拥有一期限 fiber → 原消费 / join 竞争
  → 作用域统一结算期限 → 原 flush、Cause 传播、取消与重试
```

范围从原 deadline 表达式开始并在其结果边界结束；原 publisher flush 保留在外侧同一位置，外层 `uninterruptibleMask/restore` 不动。提前登记意味着后续即使在竞争子分支登记前结束，已挂到 scope 的计时结果不再依赖那一步清理，原计时器随其 fiber 取消；不在计时器文件、终态或 Gate 增加兜底。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- |
| `timeout === false` | 原合同直通 | 是，消费本身 | 新增 0% | 保留 |
| 有期限下原消费成功、原流错或期限失败 | 同一主路径的三个正常终态 | 仅原消费成功 | 无新增判断 | 保留，替换期限的资源所有权 |
| 私有监测、Bun 加载时投影 | 诊断 | 否 | 生产 0% | 永不提交 |
| 未受控执行或期限失败后重新启动 | 禁止备用 | 否 | 0% | 无此路径 |

## 12. Workaround Deletion and Replacement

替换原来直接把有副作用的期限交给 `timeoutOrElse` 的这一处调用，不保留双实现。没有已提交的诊断、超时调整或测试绕过需清理；私有探针、输出和依赖映射不进入差分。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned change | Behavioral test |
| --- | --- | --- | --- |
| 持续解决红测 / INV-01 | provider → scope → 原终态 | 只改 `llm.ts` 当前期限的归属 | canonical Task + 原 preload 红转绿 |
| INV-02 | resolver → 默认、显式或 false → 同一 Clock | 保留原毫秒和禁用逻辑 | total timeout 原用例默认 10 min／2 min／false |
| INV-03 | consume → 原 Cause、flush、退出和重试 | 保留原顺序和分型 | 两条原用例的既有业务断言；完整现有文件回归 |
| 最小修改 / INV-04 | 原规则与实际 diff | 仅一个源文件与本 Plan | 精确路径比对、原 Gate 入口、独立实施审计 |

## 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 将原期限 fiber 注册到一次操作的现有 Effect Scope，竞争时等待该 fiber | INV-01/02/03 | seq1197→1203→1204，及隔离双用例红绿 | 原 `timeoutOrElse` 只通过竞速的回调清理，注册前重入时没有已登记的期限 owner |
| 使用原 Clock sleep、同一失败构造和原 race 结果 | INV-02/03 | 真模型设置与 TestClock 对照 | 已有实现足以继续承载；只复用，不新建错误或配置概念 |

## 15. File-Level Change Plan

| File | Action | Exact responsibility | Expected line delta |
| --- | --- | --- | --- |
| `packages/core/src/session/runner/llm.ts` | modify | 当前 provider 总期限归 scope；必要的 `Fiber` 导入；原 Cause、flush 与调用顺序保留 | 仅原期限块和导入，约 +7～11 / −2～5 |
| `docs/plans/session-provider-deadline-lifetime.md` | add | 唯一计划和审计记录 | 本文件 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why pre-R1 fails | Minimal green | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 原 canonical Task pass，但 stock 清理退出 1 | 父在故障分支登记前进入终态，后加入的期限纤程未受控 | 同一原测试在修复后无 600 秒句柄 | 前台取消、结果持久化和权限域 |
| 2 | 原 total timeout 可在未修复时验证已有合同 | 它保护正常期限与错误，不单独复现资源泄漏 | 默认、显式、禁用以及原错误和重试语义继续通过 | 每个 chunk不重置期限；原重试后恢复 |

不新增用例、检查开关或临时源码留痕。私有探针仅定位首次分歧；验证接口为现有生产调用及原清理检查。

## 17. Comments

一到两条邻近中文注释解释 **为何在竞速前登记期限资源**，以及有需要时说明消费结果与期限子 fiber 的作用域边界。不要翻译函数名。实施记录实际 E/C，排除空白、import-only、formatter-only、生成和 pure-move；满足用户 15% 门槛。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| §8 原二例命令，在确切 4555 基准、实际精确候选各一次 | `packages/core` | 同锁原红转绿，无间接计时器修改 |
| `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts` | `packages/core` | 原 SessionRunner 场景照跑，自然终止；任何独立既有失败单列，不能忽略 |
| `bun run typecheck` | `packages/core` | 原包类型检查 |
| `bun script/guard/check.ts . --changed-since 4555c21eb8615e15eb88d746df89f9ac9538898c --files packages/core/src/session/runner/llm.ts,docs/plans/session-provider-deadline-lifetime.md` | 同一实际候选仓库根 | 原架构、变更路径与实际出口 |
| 当前原 Gate 的所需契约、选测及适用 A/B；批准后按真实目标 SHA 取得原回执 | 已授权的当前仓库／原 GitHub 检查 | 用最新实际基线和同一实际候选验收；不能用历史窄绿替代 |

Phase 1 结果已实测：原两例 2 pass、单个 600 秒 afterAll 红、exit 1；窄范围的同环境加载期投影 2 pass、0 fail、exit 0，正常默认/显式/禁用期限、原超时报错、flush/retry 和中断的原断言均通过。两边使用相同 Bun、测试、锁和 preload。作用域投影只在临时目录，未产生可交付差分。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| 文件 | 一份 Plan 新增，一个已有源文件修改，零删除 | 只有当前消费的期限 owner 需要修复 |
| 测试／依赖／Gate／配置／生成 | 0 | 原回归直接红绿；范围未扩张 |
| 源码 | 一个已有表达式及必要导入 | 不引出新工具、框架修补或计时器 |

## 20. Real Risks and Open Decisions

真正风险是作用域关闭改变已观察的期限合同；原 default/explicit/false、恢复与取消已有私有对照，正式阶段对实际候选再次验证。不得用强制退出或跳过原门禁取得绿灯。

### Open Decisions Requiring the User

本方案的技术路线无待决定项。正式线上验收选用一份仅含本 Plan 和既有 `llm.ts` 修复的独立 draft PR，保留原 §18 的真实候选 SHA、preflight、原选测和适用 A/B 要求。此记录只指定验收载体；远端尚未创建，线上门禁尚未运行，合并由用户决定并执行。

### Follow-up

| Concern | Evidence | Baseline behavior | Raised in round |
| --- | --- | --- | --- |
| MCP 30／60 秒 | 已有独立精确配对及其方案 | 原测试模拟 connect Promise 不结算，与本次迟到注册不同 | R1 |
| Core 1 秒 | 整包原日志仅有 `unknown` | 窄测原用例未产生该句柄；无 owner 证据 | R1 |

### Rejected Speculation

不将 600 秒归因于 PAT、cold-v3、MCP、Git、通用 timeout 或测试线程的吞吐。没有用户证据要求改变重试数、时限或取消后的持久会话行为。

## 21. Audit Contract

独立审计严格核对 §1、完整方案、原基线到目标行为、真实 owner、原用例和私有红绿证据。完整审计须核对唯一范围、无备用路径、无诊断源码。批准绑定当前确切文件；实施差分另行独立审计。

## 22. Revision Delta and Plan Audit Record

R1 独立方案审计：`BLOCK`。B-01 指出 §18 的 `--files` 只接受一个逗号分隔的值；空格分隔导致 Plan 路径未纳入检查，未满足 INV-04。

R2 仅修正 §18 参数，使用一个逗号分隔的值同时传入源码与 Plan 路径。依据当前基线 `script/guard/check.ts:88–105` 核对；实现、范围和验收标准沿用 R1。

### R1 独立裁决全文（全范围）

````markdown
## Blocking findings

### B-01 静态验收命令漏掉 canonical Plan

- **Violated invariant:** INV-04。正式静态验收须覆盖实际两条变更路径。
- **Evidence class:** contracted。
- **Producer and execution path:** §18 命令 → `script/guard/check.ts` → `--files` 显式文件集。
- **Source evidence:** `script/guard/check.ts:88–105` 用逗号拆分 `--files` 的单个参数；显式文件集优先于 `--changed-since` 推导。
- **Canonical-plan evidence:** §15 列出源文件和 Plan；§18 用空格分隔它们。
- **Responsibility owner:** §18 正式验收命令。
- **Concrete behavioral consequence:** 命令只把 `llm.ts` 纳入显式检查；退出 0 不能证明同一命令检查了两条批准路径。
- **Pre-R1 baseline behavior on the same path:** 原检查器接受逗号分隔的文件集，本方案未改检查器。
- **Minimal correction direction:** 把两条路径合成一个逗号分隔的 `--files` 参数。

## Non-blocking findings

无。

## Follow-up

在精确 `4555c21e` 和实际候选上重跑原两例及 stock preload，随后执行 §18 的全文件回归、类型检查和原 Gate。

## Rejected speculation

不把另外的 MCP 和 1 秒句柄归到当前 provider 期限，也不因通用竞速实现的行为扩大修改到锁定依赖。

## Requirement and traceability coverage

独立核对了四个基线 blob、父中断与迟到期限子的追踪清单，以及原两例的配对回执。原实现两条业务用例通过，但 stock preload 留下一个 600 秒句柄；同一环境中，作用域投影两条通过并正常退出。现有 default、explicit、false 和 canonical Task 行为均有对应入口。当前实验证明的是字节等价投影的行为，正式发布树仍须复验。

## Primary-path and fallback verdict

方案把现有 deadline 预先登记到当前 provider 作用域，再用原结果竞速；`false` 直通、原到期错误和外侧 flush 位置保留。未提出第二个计时器、后备成功路径或测试弱化。

## Release verdict

**BLOCK**

适用于精确 **R1 方案**，SHA-256 `53f2fdfc0fb116f7499475889c57c14122ec43b28242ee8bfe33ee8756af2963`。修正 §18 的参数后送复审。
````

### R2 独立裁决全文（全范围，judge_pair_check）

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§22 保留了 R1 的 BLOCK 摘要。补录原裁决全文，保留审计记录；本项不改变 R2 的批准范围。

## Follow-up

在精确 `4555c21e` 和实际候选上复验原两例及 stock preload，再执行全文件回归、Core 类型检查和原 Gate。

## Rejected speculation

本次 600 秒期限与其他已观测句柄分别归因。无需修改通用调度器、锁定依赖或现有计时预算。

## Requirement and traceability coverage

B-01 已关闭。§18 现在将源文件和 canonical Plan 作为同一个逗号分隔的 `--files` 值传入，符合检查器实际解析方式。复核了四个基线 blob 和隔离对照的清单：基线两条业务用例通过，但 stock preload 报一个 600 秒句柄；相同范围的作用域投影两条通过并退出 0。R2 保留 R1 的范围、原行为和复验要求。

## Primary-path and fallback verdict

期限由当前 provider 操作的作用域持有；原消费、到期错误、`false` 直通和外侧 flush 不变。无第二个计时器或替代成功路径。

## Release verdict

**APPROVE**

批准精确 **R2 方案**，SHA-256 `4b9d096eb2bc4dd69b78a0934d50f10e7903d5d9ea3a741b9a9d28fb8cfc5aac`。登记裁决后可实施；实际差分须另经独立实现审计。
````

## 23. Implementation Evidence

### Actual Files and Diff

相对精确 `4555c21e`，仅新增本 Plan，修改 `packages/core/src/session/runner/llm.ts`。生产原始 diff +19/−12，净增 7。源文件多行排版展开作用域和原错误字面量；没有新函数、接口或额外的期限机制。测试、配置、依赖、生成文件、Gate/get 各 0 改动，测试实例净增 0。实际生产 blob `3e4b668`；完整实际 diff、路径清单及 tree 由独立暂存区导出。

E=13，C=2，15.38%，最低 2。按当前差分的新增或实质修改侧核算，排除 Markdown、1 行 import-only、2 行纯注释和原封移入的 3 行错误字段；没有空行、生成或额外 formatter-only 排除。C 解释期限必须在竞速前成为作用域资源，以及十分钟默认值与 AISDK 的兼容边界和分片不重置。具体行位置及逐行清单在实施回执。

### Red-Green Test Evidence

用 §8 既有命令、同一个 Bun 1.4.4（38afee6c8）、原锁、原 preload 和私有仅环回网络，分别在精确 `4555` 和实际候选执行。原树两个业务用例通过，176 断言，原 preload 只报 `setTimeout(600000) @ unknown`，子进程 0，exit 1，3.00 秒。候选同两例通过，175 断言，0 fail，exit 0，2.88 秒。两边 workspace 依赖名均解析到各自树的源码；第三方包复用同锁定的现有依赖。

### Verification Commands and Results

| 检查 | 工作目录／命令 | 精确实际结果 |
| --- | --- | --- |
| 完整 SessionRunner 文件 | `packages/core`，`bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts` | 105 pass、0 fail、1182 断言，exit 0，34.58 秒 |
| 原 Core 类型 | `packages/core`，`bun run typecheck` | 原 `tsgo --noEmit` exit 0 |
| 两路径静态 | 候选根，§18 的逗号分隔 `--files` 命令 | exit 0，0 错误、0 提示。原检查器的 TS／JS 报表计 1 源文件，Markdown 仍在传入的两路径范围；精确全差分独立核对文档及源码 |
| 原契约 | 候选根，`bun script/guard/gate.ts contracts` | schema、protocol 均通过，exit 0 |
| 原 Stop | 候选根，`bun script/guard/gate.ts stop --files packages/core/src/session/runner/llm.ts,docs/plans/session-provider-deadline-lifetime.md` | 规则检查、依赖选测、TUI 两文件 35 pass，exit 0；原 Stop 决定预检转交事项见下。语音原实时时限用例自然结束 |
| 原提醒对照 | 两个树各自根，`bun script/guard/unneeded-guards.ts packages/core/tsconfig.json packages/core/src/session/runner/llm.ts` | 两边同两条既有提示（基线 370/735，候选 370/742，源码均未修改）；默认 Stop 将这一结果记录为提示 |

精确执行回执目录：`core-provider-deadline-stage3.kSmLl3/exact-replay/`。每套保留命令、cwd、Bun 和关键文件散列、原 stdout/stderr、退出码、隔离状态；两树另保留实际包解析结果和 workspace 别名映射。Gate 选测输出为该目录的 `static/affected.json`。

### Original Feedback-Loop Result

在精确基线复现了原 600 秒残留，落盘的实际候选按相同入口消除残留。全 SessionRunner 文件回归没有出现独立句柄；该结论范围为这 105 个用例。

### Actual Secondary and Replacement Path Inventory

`false` 仍走原合同直通；开启期限时消费结果和原到期错误继续竞速，外侧 flush 与恢复逻辑未改。移除原不受当前操作作用域持有的 `timeoutOrElse` 调用；无备用成功路径、诊断模块、新 timer 或测试绕过。

### Remaining Unverified Items

原 Stop 将 Core 全量（静态选择 161 文件）和 OpenCode 全量（323 文件）移交正式线上 preflight。运行时路径符合原 Gate A/B 规则，线上选测及 A/B 尚待同一目标 SHA 的真实回执。独立 MCP 30/60 秒和整包曾见的 1 秒不在此方案；全 SessionRunner 文件验证未覆盖原整包其它红点。

## 24. Implementation Audit Record

精确 R2 全范围独立实现审计已通过。下方原裁决绑定登记本节之前的实际差分；本次仅补写审计记录，生产 blob `3e4b6689638ea1a08e0ef73fc0bd0c2e829f5fde` 不变。

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

核对同一正式候选 SHA 的线上 preflight 和原 A/B 回执。当前 Stop 已把 Core 和 OpenCode 全量移交线上验证。

## Rejected speculation

本次差分修复已归因的 600 秒 provider 期限。独立 MCP 句柄和整包曾见的 1 秒句柄不在此差分的验收范围。

## Requirement and traceability coverage

复核了批准的 R2 原稿、精确父树、实际两路径差分和回执清单。基线原两例通过，但原泄漏检查报告一个 600 秒句柄并退出 1；实际候选同两例通过并退出 0。SessionRunner 全文件 105 例通过；Core 类型检查、两路径静态检查、Schema／Protocol 契约和 Stop 均退出 0。测试、依赖和 Gate 保持原样。

## Primary-path and fallback verdict

当前 provider 作用域持有原期限，成功、失败和中断均由该作用域收尾。原默认和显式期限、`false` 直通及到期错误仍走同一消费路径，外侧 flush 位置不变。没有第二个期限或备用成功路径。

## Code quality verdict

只改一个现有生产文件并新增一份 Plan。`git diff --check` 通过；两条中文注释解释竞速前登记资源和全流期限的边界。

## Release verdict

**APPROVE**

批准精确 **R2 实现差分**，SHA-256 `1cd068c81f7cc20b12e8ce6c0b62ac110ca230f7acfc50618f30fe51e33a5798`，候选树 `c971d78884029b6cca586fdd96a5cc00a866d8c9`。本裁决通过独立实现审计；最终交付仍按 §18 的线上门禁判定。
````

本地实施和独立实现审计已通过；§18 的正式线上选测、preflight 和原 A/B 仍未运行，状态不升为 `verified`。

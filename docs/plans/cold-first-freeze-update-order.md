# Canonical Implementation Plan: 首次冷冻资格与冷读取 Worker 的测试见证的测试时序

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户原文，§1
>
> Implementation allowed: no
>
> Last updated: 2026-11-22

本文件是此范围唯一实施说明。R3 目标基线为 dev1-smark `c6217876c2dd3733f3ec2ac041bb7e2ac07442c0`，候选前镜像为 #12 单提交 `d0d00522d85f5359c2fbda575de7948630a83f8b`。现有 Part 更新和 Session 活跃见证均定位在真实冷包编码结束后、写事务前；现有 cold reader 用例以真实 Worker 请求和回复证明解码离开主线程。§1–21 保留已验证的 R1 设计与范围；§25 记录 R2 对同一文件及见证的增量规范，连同保留的 R1 组成从当前目标基线到最终树的完整合同。§22–24 的原始裁决和验证只适用 R1；§26 保留 R2 独立裁决，§27 是本轮追加的验收和实现合同。

## 1. Verbatim Requirement

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。
>
> 你可以去检查一下对应的静态问题，然后保持最小修改。
>
> 不要大幅度地补各种各样的测试，我再说一遍

> 8怎么红测了？
>
> 同时最新主线的test的macos要参与到CI修复

来源：当前 #8 Guard 原始片段后的用户消息 `Sentinel_d26b99b17f548191bcd5165ea5666822`；与上面既有红测修复指令同时适用。

本方案只负责上述需求中已归因的 Linux `cold-v3` 既有红测。正常流程仍须达到可合并质量；不代合并。

## 2. Explicit Non-Goals

不改产品冷存储、DB 写入/恢复、Worker、公开字段/API、Bun/计时器配置、Guard、覆盖率或 workflow。只替换 update 夹具的变更安排，保留 preserve/delete/activity/cancel 的原代码路径、原断言和真实 Worker。Windows `MessageV2.stream` 与 benchmark 另有独立反馈，不在这里修复。实施审计前不提交、推送或决定发布进哪个 PR。

## 3. Repository Context

| 来源 | 约束 |
| --- | --- |
| `AGENTS.md`、`docs/guides/workflow.md`、`.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md` | 单 canonical、隔离反馈、原样保留验证、先独立方案审计。 |
| `packages/opencode/AGENTS.md`、`CONTEXT.md` 的 Session/持久化边界 | 用包内 Effect 测试和既有 SQLite 测试装配，不另建产品 API。相关设计背景在 `docs/plans/cold-maintenance-worker-parallelism-and-progress.md`，当前实际代码为准。 |

## 4. Files and Evidence Read

| 证据 | 用途 | 类别 |
| --- | --- | --- |
| `packages/opencode/test/storage/cold-v3.test.ts:244–367`、`test/preload.ts`、`bunfig.toml` | 五个变体、真实 test preload、原断言和清理 | observed |
| `packages/core/src/storage/cold-maintain.ts:89–98,519–530,561–648`、`cold-store.ts:999–1172`、`cold-codec.ts` | 实际 lease、快照、Worker pack RPC、写事务和返回 | contracted/observed |
| GitHub #12 [Linux job 136948285595](https://github.com/SMARK2022/opencode/actions/runs/44937817459/job/136948285595)、#5 [Guard job 136948311125](https://github.com/SMARK2022/opencode/actions/runs/44937816866/job/136948311125) | 同一行361且同一 received 冷引用 `RuVvIf5JbQB6mH-asnGScO75LqyJUv9pfu4DNDVRmBk` | observed |
| [4555→976 compare](https://github.com/SMARK2022/opencode/compare/4555c21eb8615e15eb88d746df89f9ac9538898c...976fc039f70fb9d95e15868cfa2e7fc43dfacd5a)、[4555→5ac](https://github.com/SMARK2022/opencode/compare/4555c21eb8615e15eb88d746df89f9ac9538898c...5ac31c3633e14cd41ae7e88d1b0bb9a5f8959d59) | 前者仅12个 Guard/报表文件，后者另有 #12 的两文档两 Core 夹具，冷路径和实际解析到的源码字节相同 | observed |
| 私有证据 `pr5-list-local.eYTcVr/warmup-976/cold-update.local.log`、`cold-update.controlled.log`、`cold-update.projected-v2.log`、`cold-update.projected-ordered.log` | Linux Bun1.4.4 的原单例、限定事件顺序的前后对照及候选验证；均未改正式文件 | observed |

## 5. Current Behavior

```text
首次冻结 update fixture → part 初始 checkpoint → 只排 setTimeout(0)
  → prepareFreezeBatch (SQLite deferred 只读事务)
  → worker pack (真实 zstd，等待结果，不占数据库预约)
  → lease.assertOwned → commitFreezeBatch (SQLite immediate 写事务)
  → 重读快照/年龄，匹配才写真实 pack + cold_ref → 原断言
```

原 fixture 的 `changed` 只证明回调执行过。它既不证明晚于只读快照，也不证明早于提交。原 SQL 保留时间戳并直接改 Part payload，不会替已经完成的冻结清除冷引用。业务提交用完整 owner 行比较而非只比较毫秒时间；更新恰好进入窗口时，业务会跳过旧 pack。

## 6. Supported Input Domain and Reachability

| 输入 | 生产者 | 保证 | 路径 | Owner | 类别 |
| --- | --- | --- | --- | --- | --- |
| 过期根 Session 上已完成的 read Tool | 现有测试 | 真实 Part，显式旧的 Session 活跃时间 | freeze Part，原公开完整读 | fixture | observed |
| 同时间戳、不同的 output | 原测试同连接 SQL | 刻意绕过更新时间自动写入，仅模拟并发变更 | 预读后、立即事务前 | fixture | observed |
| 四个邻接动作 | 原各测试 | 构造独立真 DB、同样的真实 Worker | 原定时与取消边界 | fixture | observed |

## 7. Required Invariants

| ID | 行为 | 证据 | 测试 |
| --- | --- | --- | --- |
| INV-01 | update 必须在真实快照/编码后、写事务前发生，覆盖同时间戳的内容变化 | 锁有写前的既有 lease 与 ordered A/B | 原 update |
| INV-02 | 测量真实事件循环的推进，仍需真实 Worker 与原公开读完整字段；保持 `ticks>0`、无 cold_ref、更新字段和原状态断言 | 原测试 + off-tree 绿 | 同文件五个原变体 |
| INV-03 | 生产、四邻例、timer 值、门禁和总测试数量保持 | 仅测试 hunk 与 Plan | 对照源码、回归原样 |

## 8. First Divergence and Root Cause

| 不变量 | 最早分歧 | Owner | 证据 |
| --- | --- | --- | --- |
| INV-01 | update 夹具在 checkpoint 只排零延时 timer，把调度机会当成提交顺序保证 | 现有测试的 mutation 调度 | 有序 A/B 同源码、同测试，在真实 `immediate` 事务前后移动同一个原 SQL 即翻转。A：pack dispatch→更新→reply→事务 rawBytes=0，exit0；B：reply→事务 rawBytes=7118→同 SQL，exit1，精确第361行和同一线上 hash。 |

已执行命令：在基线包目录运行 `bun test --timeout 30000 --only-failures --test-name-pattern 'first freeze keeps progress responsive [(]update[)]' test/storage/cold-v3.test.ts`，原单例本次 1 pass / 5 assertions / 3.29s，是自然绿对照。离线受控 loop 在相同命令另传本地 `--preload order-cold-update.ts`；`COLD_ORDER=before/after` 只决定原回调是自然执行还是由真实事务完成后释放。线上没有逐事件 trace；有序 B 证明同一可达失败如何发生，线上的具体调度时刻不由相同 hash 推定。

## 9. Responsibility and Seam

| 关注点 | Owner | 接口承诺 | 为什么放在这里 | 拒绝 |
| --- | --- | --- | --- | --- |
| 明确 update 样本在预期事务边界发生 | update 测试 | 现有 part 首 checkpoint 第一次 lease 是开始读批，第二次 lease 是 pack 返回后、写前 | test 已传专用 lease 对象，可在同连接不持预约时发起原 SQL | 产品不负责夹具顺序；不能改 Worker 或让 checkpoint 提早写 |
| SQLite 任意同毫秒更新的重检 | `commitFreezeBatch` | 新事务比较完整当前 owner 行 | 业务路径已存在且 A 见证真实生效 | 不把直接测试 SQL 改成公开 API 修复 cold_ref 以绕过测试 |

## 10. Single Approved Primary-Path Design

对 update 变体，原 part 初始 checkpoint 从未挂载状态转为等待本批的 lease 检查。原循环的第一次 `assertOwned()` 在读取和 pack 之前，只推进夹具状态；第二次在真实 pack reply 后、写事务之前，执行原同连接同时间戳的单次 Part UPDATE，成功后设置原 `changed`。保持同一已准备批和已编码 stale 快照，写事务重读、拒绝旧 pack，原读取断言仍检查完整对象。之后的 lease 检查不重复写。非 update 分支保持原 `checkpoint` 定时安排、清理和断言；区分真实业务快照与 fixture 信号。

```text
part 初始 checkpoint → 先经过真实读取与 Worker → 现有写前 lease
  → update 夹具 SQL → 原 SQLite commit guard → 原 hot-row 与公开读断言
```

试投影把候选测试文件复制到独立非 Git 目录，真实应用/Worker 与依赖仍来自字节相同的基线。仅观察的投影实测 `pack.reply→drizzle.test.mutation→part.commit.return(rawBytes=0)`；原只针对 timer 回调的后置扰动不再改变 update 顺序。同一投影的原 stock 单例 1 pass、5 断言（2.68s）；带观察器的五原变体 5 pass、23 断言（5.64s）。日志 SHA-256：原 stock `8c56ac6d1a6fb3198046b13df377b75f9c7d1fc9fdf8b43b090ed71f760c5574`，受控前后 `bcee2459ef1534fe182526bb3545aaafd0ead0642c9970d731b8bedac3a84086`，候选五例 `1b554f20c6fdd7022d92e9ca41958afbdcbcda705318fa41a765521e0f2ca4e8`。该证据不是正式实施。

## 11. Secondary and Replacement Path Inventory

| 路径 | 当前/拟议 | 分类 | 产生成功 | 决策份额 | 处理 |
| --- | --- | --- | --- | --- | --- |
| 真实业务 Worker 与 SQLite | 现有 | primary-contract branch | 是 | 全部 | 保留 |
| update 的 timer 触发变更 | 当前 | 夹具竞争 | 可能 | update 一条 | 替换 |
| 原四个变体 | 现有 | 现有测试分支 | 是 | 各自 | 保留 |
| 私有 observer 与有序 B | 当前 | diagnostic | 否 | 仅证据 | 不进仓 |

## 12. Workaround Deletion and Replacement

| 原写法 | 为什么存在 | 替代理由 | 位置 |
| --- | --- | --- | --- |
| update 随同其他变体在 checkpoint 排 timer | 让真实写尝试有机会交织 Worker | 写前 lease 明确在读事务释放和写事务开始之间 | 原循环的 update 分支；只从共用 timer 回调中移出 UPDATE |

## 13. Forward Traceability

| 需求 | 生产路径 | 文件改动 | 验证 |
| --- | --- | --- | --- |
| INV-01 | maintain→pack→commitFreezeBatch | `cold-v3.test.ts` update 的触发时序 | 原行361 + ordered 对照 |
| INV-02 | 原真实 pack + `MessageV2.get` | 无行为/断言删除 | 五原变体 |
| INV-03 | 原 workflow | 无生产、配置、测试增量 | git diff/官方路径核验 |

## 14. Reverse Traceability

| 概念 | 不变量 | 证据 | 复用 |
| --- | --- | --- | --- |
| 仅测试的一次性 Part lease 相位 | INV-01 | 原后到写能独立触发同一红 | 复用既有两个 lease 检查点与原 SQL。没有生产概念。 |

## 15. File-Level Change Plan

| 文件 | 类型 | 责任 | 预算 |
| --- | --- | --- | --- |
| `packages/opencode/test/storage/cold-v3.test.ts` | modify | 把 update 原 SQL 连同 `changed` 移到一次性写前测试接缝；维持其他动作条件 | +26/−14 的私有投影；0 新实例 |
| 本 Plan | add | 证据、路线、独立审计记录 | 文档 1 份 |

每个 hunk：关联状态与原 SQL 的移动给单个 UPDATE 一个可验证的写前顺序；lease 之后带 pack completion 的位置不动则仍受 Linux 调度影响；checkpoint 的 update 特例阻止旧 timer 重复写；从旧 timer 删除 update 尾部避免两条路径，其余 timer 内容保持；不扩展其他测试。

## 16. TDD Behavior Slices

| 顺序 | Red | Why baseline | Green | 回归 |
| --- | --- | --- | --- | --- |
| 1 | 同原 SQL 后置→原 cold_ref 不为 null | 原 timer 没有事务栅栏 | 在真实写前 lease 执行一次 | 真实 pack、同毫秒快照拒绝与完整输出 |
| 2 | 不改其他变体 | 它们不是本次线上红的证据 | 原四变体的调度与断言原样 | 原五变体与完整文件 |

## 17. Comments

用邻近中文注释解释 part 两次 lease 分别为进入读批、编码完成后写前。这是从测试代码自身看不出的对应关系。删除 update 沿用 timer 的旧时序注释中已不适用部分，保留非 update 分支的真实原含义。

## 18. Verification

| 命令 | 目录 | 证据 |
| --- | --- | --- |
| 上文完整 stock named 命令 | `packages/opencode` | 精确已有 update |
| `bun test --timeout 30000 --only-failures --test-name-pattern 'first freeze keeps progress responsive' test/storage/cold-v3.test.ts` | 同上 | 真实全部五变体 |
| `bun test --timeout 30000 --only-failures test/storage/cold-v3.test.ts` | 同上 | 原文件完整 |
| 原最新 Push Guard、对应精确 SHA Linux Opencode required checks | 仓库/workflow | 不把私有隔离复测代替线上发布门禁 |
| `git diff --check`，核对完整两路径、0 新用例、0 生产或门禁变更 | 根 | 边界 |

## 19. Diff Budget

1 文档新增、1 原测试修改；0 文件删除、0生产行、0 生成行、0 新测试。变更仅同夹具已有 SQL 与触发位置，保持原断言。

## 20. Real Risks and Open Decisions

既有写前 lease 若未来重构，夹具锚点要按新真实写前边界重对齐；若没有更新，原 `changed` 和热态断言即失败。对旧定时器扰动的本地候选证据在阶段1；实际 diff 与原 runner 仍走独立验证。当前没有交用户的界面或产品选择。

### Follow-up

| 独立事项 | 证据 | 基线 | 轮次 |
| --- | --- | --- | --- |
| Hosted benchmark stream/tools warmup 和 Windows MessageV2 分页 | 独立 job | 本方案不触及路由 | R1 |

### Rejected Speculation

增大输出、加 sleep、改变 timer 或全局调整 SQLite 都不能提供 update 原目的要求的 happens-before；有序 A/B 已证明更窄的夹具接缝。不能据邻例删除绿排除时序：即使晚删，最终无行仍可通过。

## 21. Audit Contract

独立审计员基于用户原文、精确历史 R1 基线 976 的 fixture/业务调用链和有序反馈做 full-scope 核查，检查所有原断言与 scope。须先 `No blocking findings` 及 `APPROVE`，才放行 exact revision。

## 22. Revision Delta and Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 `e4f877e65ee9530f5523aa2b1fd1f01428c3f77136921627b7495b417dbf3574` | yes | None | None | APPROVE | r16 |

原始裁决：

> ## Blocking findings
> No blocking findings.
>
> ## Non-blocking findings
> None.
>
> ## Follow-up
> Verify the exact implementation with all five existing variants, the full test file, and the required Linux and Guard checks.
>
> ## Rejected speculation
> The controlled reproduction matches the CI failure and cold reference. It establishes a reachable failure sequence, not the exact event order of the original CI run.
>
> ## Requirement and traceability coverage
> The same SQL mutation passes before commit and fails after commit. The proposed fixture runs it once after the real worker replies and before the write transaction, preserving the original assertions.
>
> ## Primary-path and fallback verdict
> The plan reuses the existing test lease and real SQLite and worker paths. It adds no fallback, timer, test instance, or production change.
>
> ## Release verdict
> **APPROVE** exact R1 plan SHA-256 e4f877e65ee9530f5523aa2b1fd1f01428c3f77136921627b7495b417dbf3574.

## 23. Implementation Evidence

### Actual Files and Diff

基线 976fc039f70fb9d95e15868cfa2e7fc43dfacd5a。实际路径为本 Plan 和 `packages/opencode/test/storage/cold-v3.test.ts`。测试源 SHA-256 `146396cee213aa2e756a9c533f46bab10054f2dd657e19e128bb3d5b022d0413`，各复验前后一致。测试 +28/−14；新增测试实例、生产、配置、生成行均 0。按变更前后折叠纯缩进、纯移动，排除空行和注释，E=16（14 个新有效行，2 个被替换有效行），C=3。三条邻近注释分别解释一次性 checkpoint、绕开同毫秒自动更新、真实 pack 后的写前 lease。

### Red-Green Test Evidence

隔离的原基线/原 test 使用相同 Bun1.4.4、30秒测试预算、已有真实 Worker、原 SQL 与返回对象。后置 observer 复验原测试 exit1，仍见原 `cold-v3.test.ts:361` 和官方冷引用；实际候选在同 observer 下 exit0，其 update 经 pack reply、SQL 更新、real commit return(rawBytes=0)，候选全部五个原变体 5 pass / 23 assertions。未纳入 observer 或诊断补丁。

### Verification Commands and Results

在 `packages/opencode` 跑原 uninstrumented full 文件 `bun test --timeout 30000 --only-failures test/storage/cold-v3.test.ts`：20 pass / 259 assertions。最终注释后的原 976 仓根 `bun script/guard/gate.ts stop --files docs/plans/cold-first-freeze-update-order.md,packages/opencode/test/storage/cold-v3.test.ts`：规则与原静态选择器通过，只执行原 cold 文件 20 pass，exit0。包目录 `bun run typecheck --singleThreaded` exit0。首次独立工作树依赖投影把两个外部认证包的类型定位到旧目录；只对这两个已安装包的实体建立本地硬链接，统一解析而未改代码、依赖版本或检查命令。重新运行同原命令通过。

远端返回 4555c21 后另**在精确 4555 Git checkout**以字节相同测试重跑该基线原 Stop，规则/静态/同原 20 例 exit0；该条保留为当前目标对照，不替代上面的 976 方案或未来正式 Guard。

### Original Feedback-Loop Result

原现象与行号复验前后可辨。真实更新不被冷快照压掉，`MessageV2.get` 原断言未缩窄。其余四个变体保留现有行为与原测试数量。

### Actual Secondary and Replacement Path Inventory

只替换旧 update 夹具 timer 的调度位置；原四邻例和 heartbeat timer 不变。无 fallback 或新增路径。

### Remaining Unverified Items

正式目标候选的 Push Guard 与必过 Linux required 仍待执行，当前无提交、推送、合并。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | None | None | APPROVE | r16 |

原始裁决：

> ## Blocking findings
> No blocking findings.
>
> ## Non-blocking findings
> None.
>
> ## Follow-up
> Run the original Push Guard and required Linux checks on the final target-bound commit before declaring merge readiness.
>
> ## Rejected speculation
> The controlled reproduction establishes how the fixture can fail. The CI log alone does not establish the order in which its worker and update ran.
>
> ## Requirement and traceability coverage
> The original test reproduced the non-null cold reference after a late update and exited 1. The candidate ran the same SQL once after the real worker replied and before commit. All five variants passed; the unchanged full test file passed 20 tests and 259 assertions. The original Stop passed on both `976fc039` and `4555c21e`, whose fixture preimages match. Typecheck passed.
>
> ## Primary-path and fallback verdict
> The fixture reuses the existing lease callback, real worker and SQLite write. It does not rearm or add a fallback. The original assertions and other variants remain intact.
>
> ## Code quality verdict
> Only the Plan and existing test changed. E/C is 16/3. No production, Gate, timer, or test-count changes.
>
> ## Release verdict
> **APPROVE** the exact R1 implementation for the next Workflow step: tree `dbd207d3a8c34f2e44bdb285c6d88f0e722c3351`, diff SHA-256 `bd4351dea424f222b110b4c6d13fe6e2aab0df5d335b0dbc8606462f0abc0374`.

## 25. R2：首次冷冻时 Session 重新活跃

### 需求、证据和最早分歧（对应 §1–9）

现有五个用例中的 activity 模拟真实会话在首次 Part 冻结期间重新活跃。应用必须在写事务内按最新 Session 活跃时间重验资格；Part 原内容、公开读取及完成状态保持原样。R1 的 update 是同毫秒 Part 内容变化，保留其现有见证。preserve、delete、cancel、产品代码、Gate、时限和测试数不动。

[合并 #8 后的 Guard 44954020733](https://github.com/SMARK2022/opencode/actions/runs/44954020733) 的 `guard-logs-linux` 14726603911 记录 5442 pass / 45 skip / 1 fail。原 activity 在 `cold-v3.test.ts:361` 跑了 4893.43 ms，期望热态，实际 `RuVvIf5JbQB6mH-asnGScO75LqyJUv9pfu4DNDVRmBk`。#8 触及的 Execute 代码不在该夹具的冻结路径上。当前 #12 未改 activity 的定时安排；候选夹具 Git blob `34295d3a378410944022da57669eaa1579b8692e`。

依仓库 `AGENTS.md`、包指令和 §3 既有文档，读 `cold-v3.test.ts` 的 Part checkpoint、两条原 SQL 与公开读取断言、`cold-maintain.ts:565,625–649` 的读批、真实 Worker pack 和写前 lease，以及 `cold-store.ts:1060–1172` 的真实 SQLite 写入重验。前镜像的测试、Bun lock/配置/preload 与四个 Core cold 文件均和使用的已安装私有投影逐 Git blob 匹配。该投影只用来验证受影响路径，不替代精确新 head 的在线工作流。

用 Bun 1.4.4，包目录内运行 `bun test --preload observer.ts --timeout 30000 --test-name-pattern 'first freeze keeps progress responsive [(]activity[)]' test/storage/cold-v3.test.ts`。隔离环境只有本地回环；observer 记录 Part Worker 回复和 SQLite immediate 事务返回。在正控中放行原零延时回调：pack dispatch → 原 Session UPDATE → pack reply → 写事务返回 `rawBytes=0`，1 pass / 5 assertions / exit 0。在负控中，只将同一个真实 Session UPDATE 释放到真实写事务返回后：dispatch → reply → commit `rawBytes=7118` → 原 SQL，得到同一旧引用，1 fail / exit 1。正控日志 SHA-256 `1a19914b0f64d6e73a22ef7b2ae791c56f46f9a26432c8ad48b4e77032241e85`；负控 `9045550c3f0a4df726add0649528f0d1632b2f1a8c6f550698d04860453ba00f`。原 Hosted 没有逐事件时刻，受控实验验证可重现的因果顺序。最早偏离是 fixture 把“已排零延时回调”当成“在提交前已写 Session”；`changed` 只说明回调执行。原生产路径在事务内用真实活跃时间复核，正控已实测其生效。

### 单一路线与路径（对应 §10–15）

复用 R1 已建立的 Part 初次 checkpoint 和两次既有 lease，标记 `update` 或 `activity` 在相同相位等待。第一次 lease 在读取前，第二次在真实 pack 完整返回后、开启数据库写事务前。在已有测试闭包的同一连接上，根据变体执行原 Part UPDATE 或原 Session `time_updated=Date.now()` UPDATE，成功后设置 `changed`，随后继续原资格重验。只执行一次；只有 update 和 activity 进入此路径。移除 activity 在旧 timer 回调中的分支，保留 delete/cancel 的原调度与清理，不改 heartbeat。避免用睡眠、额外 barrier、新测试、生产钩子或时间覆盖来凑顺序。

正向：活跃写先于冻结提交 → 已有 Part 写前 lease → 同一测试文件原 activity 分支 → 原 `changed`、`cold_ref`、真实 `MessageV2.get`。同毫秒 Part 仍走同一 lease 和原 update 分支；其他用例不变。反向：夹具写前分派只服务两个已证时序见证，复用已有相位计数，不引入新的生产概念或重试。变更仅本文与 `packages/opencode/test/storage/cold-v3.test.ts`；对照现有 #12 其余文件无变动。

方案正控仅复制测试文本到私有目录，重映射两个相对/包别名引用至同一真实业务投影；没有编辑项目文件。保留负控试图后置原 timer 的设置，移位后的 activity 已不通过 timer：观测到真实 pack reply → SQLite Session UPDATE → 真提交返回 `rawBytes=0`；五条原断言、1 pass、exit 0。日志 SHA-256 `e074496b63ffa6bc95fcc015297b39f3679e353d60af2cfc998da59d9ba4429a`。

### TDD、注释、验证及审计（对应 §16–24）

红：同一旧 activity 回调在真事务后写，原热态断言失败且 pack 被持久化。绿：原 stock activity 在原 30s 下通过；用私有 observer 核对真实 Worker reply → 原 Session 活跃更新 → 真写事务返回 0 字节。随后跑首次冻结五个原变体、完整 cold-v3 文件、原 `gate.ts stop --files`、现有 #12 的精确发布 Guard 和 Linux 原测试；对照 `git diff --check`、文件/行差分和 0 例净增。保留原两条业务断言及调度检查。中文注释放在写前分派附近，解释活跃资格与 Part 内容是两条不同见证以及为何同用最靠近写事务的 lease。无待用户决定的事项。R2 实施须经独立全范围审计；只有收到原样 `No blocking findings` 和 `APPROVE` 才放行。

## 26. 历史 R2 独立方案审计原文

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> §21 仍引用 `976fc039`，宜标明这是 R1 的历史审计基线。R2 页首和 §25 已明确当前目标为 `c6217876`，实施前镜像为现有 #12 的 `d0d00522`。
>
> ## Follow-up
>
> 实施后在精确候选上复跑五个既有变体、完整 `cold-v3` 文件、原 Stop，以及绑定候选 SHA 的正式 Guard 和 Linux 检查。
>
> ## Rejected speculation
>
> 线上日志确认了失败的 activity 用例及冷引用。受控对照证明晚写 Session 能重现该结果；线上回调的实际执行顺序未记录。当前证据支持修正夹具时序，保留产品事务、Worker 和时限。
>
> ## Requirement and traceability coverage
>
> 已核对当前主线、#12 前镜像、实际夹具和冷存储源码，以及 [原 Linux Guard](https://github.com/SMARK2022/opencode/actions/runs/44954020733/job/136998098604)。三个私有回执的散列匹配：提交前运行原 Session UPDATE 时保持热态；提交后运行同一 UPDATE 时产生线上相同的冷引用；候选在真实 Worker 回复后、写事务前执行原 UPDATE，提交返回 `rawBytes=0`，原五条断言通过。R1 的 Part 更新见证及原 preserve、delete、cancel 路径保留。
>
> ## Primary-path and fallback verdict
>
> activity 与 update 共用已存在的写前 lease，各按原测试意图执行一次 SQL；真实写事务继续重验完整 Part 与 Session 活跃资格。没有新增计时器、测试实例、产品接口或备用路径。
>
> ## Release verdict
>
> **APPROVE**。适用于精确 R2，SHA-256 `4007848d64a27684e853885dae44bf3dda6dc7e0c7f605ac4e52c21287c082d7`。下一阶段可实施，实际差分和正式门禁另行验收。

## 27. R3：用真实冷读取 RPC 见证，并纳入主线 macOS

### 源头与反馈

同一 `cold-v3.test.ts:54–98` 原用例承诺冷包解码发生在非调用线程。原见证以主线程一个零延时回调已执行作为判断；Worker 回复能先于该回调，两个事件没有先后保证。实际代码 `packages/core/src/storage/cold-codec.ts:1482–1540,1616–1618` 把现有冷包复制/转移给 native Worker，Wire 请求体为 `{ id, op: "decode", input: { owner, payload: { hash, ... } } }`，Worker 在自身线程执行 decode，并用同一 request id 回复。已核对项目工作流、原测试、Worker owner、请求 admission 与销毁路径。后续的损坏拒绝、无法克隆失败与池恢复均保留。

本地现有私有实验用 Bun 1.4.4，命令 `timeout 20s ./bun144-verified.xs8bfv/bun run cold-reader-stage1.yssbbR/probe.ts`。使用原真实压缩输入和产品入口：13 轮原常态见证；第 14 轮受控把主线程 heartbeat 留在解码完成之后，真实 Worker thread 3 的 request 14 与 response 14 配对，正文完全相同，旧 heartbeat 为 false。直接同步解码负控正文也正确，但无 Worker 配对，因此新见证拒绝同步替代。实验未改主线源文件；probe SHA-256 `ef1b74fc5c452332cf59d91c2b8a42dc826dcdb4bab02463ed3fb984de95c0f2`，日志 `b8a91280463ca5436f49e2ef229259aceb2ef03aa52af3dc2317e80273e8ad50`，exit 0。此处只把真实离线程结果与旧计时判断的顺序缺陷分开，保留 §25 的 activity 实测独立性。

### 唯一路线和边界

仅在原测试的首次有效冷读内短暂拦截 `Worker.prototype.postMessage` 作为测试观察点；按 `op==="decode"`、本测试的 `input.payload.hash` 和 `input.owner==="message"` 匹配，不改参数/transfer，调用原方法。对匹配请求记录正 threadId 及该 Worker 的 request ID；以同一 Worker 的消息监听只接纳相同 ID，观察真实回复。在首次真实 `ColdCodec.decodeColdPayloads` resolve 后用一个明确断言校验正 threadId 和同一 ID 回复。使用配对后立即解绑、测试 `finally` 恢复原 prototype 并移除未结监听；随后才跑原损坏、不可克隆和池恢复断言。不要用全局 fake timers、轮询、任意第一条回复或产品 hook；本文件 normal serial contract 不变，任何其他 Worker 调用直接原样通过。清除仅服务旧见证的第一个 heartbeat 与零延时 timer，保留正文、输入大小、解码协议和错误路径。不开新测试、不改总数、基准、配置、Gate 或 Worker。

正向映射：离线程解码 → 原 ColdCodec reader postMessage 和 reply → 既有 cold reader 用例 → match protocol + positive thread + payload 及三个原错误/恢复检查。反向：请求 hash/owner/id 和清理逻辑只服务此单一原测试，避免捕获其他本地 Worker 的并发消息；不会改变产品调用路线。修改仍仅原 canonical 文档及同一个既有测试文件，保留 R2 activity、R1 update 和其他 #12 已审更改。新增注释只解释跨线程因果边界和匹配隔离，实施证据记录实际 E/C。

### TDD 与三平台验收

阶段 3 先复测上述真实 native 正控与同步负控；实现后先跑原 cold reader 单例、五个首次冻结变体、完整冷存储文件与原 `gate.ts stop --files`。没有新测试用例，原测试超时原样保留。执行现有 #12 单提交普通 Test 和 Guard，绑定最新目标基线与候选真实 checkout，不用重基前信号代替。Linux 查冷读和 activity；Windows 与 macOS 均核对原分页 `MessageV2.stream > handles sets exceeding internal page size` 的 JUnit 及整分片，保留已审分页修复。最新 [主线 macOS Test 136998014414](https://github.com/SMARK2022/opencode/actions/runs/44954020649/job/136998014414) 在 `c621` 真实失败于此现有分页用例（55.81ms）；主线 Windows 会话分片 136998014452 本轮通过，已有此前的同类分页红测记录。分页实现和 Plan 仍使用独立的原已审合同，不在这里追加产品修改。判断三平台结果时保留原工作流全部基准、测试及归档，用户决定是否合并。R3 目前仅允许独立审核，不授予实施。

## 28. R3 独立方案审计原文

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> §27 应注明：受控 probe 的 `late` 分支省略了旧 heartbeat 的调度，用于验证旧断言会拒绝真实 Worker 成功结果。它没有捕获一次自然发生的 timer 晚到，也没有复现具名线上冷读取失败。另将页首标题的重复“测试”删掉。
>
> ## Follow-up
>
> 实施时保持请求匹配、同一 Worker 回复和 `finally` 恢复的边界。跑原冷读取单例、五个冻结变体及完整文件；正式验收记录最新主线 macOS 的原分页用例、候选整分片 JUnit 和最新 Gate。
>
> ## Rejected speculation
>
> macOS 已确认的主线失败是 `MessageV2.stream` 分页用例。它由独立已审方案处理；本计划不把分页失败或 #8 的 Execute 改动归为冷读取红测的原因。
>
> ## Requirement and traceability coverage
>
> §1 保留了本轮三句用户原话。核对了提交对应的原 fixture、真实 Worker 请求与回复路径，以及 probe 源码和日志校验值。已有 update／activity 两条事务见证保留；冷读取见证改为请求与回复配对，原正文、损坏拒绝、不可克隆及池恢复断言保持。
>
> ## Primary-path and fallback verdict
>
> 真实 `ColdCodec` 读取仍走既有 Worker。测试只观察匹配请求及同一 Worker 的回复，不改传输参数，不新增计时器、用例、产品接口或备用成功路径。
>
> ## Release verdict
>
> **APPROVE**。仅批准 R3 方案，SHA-256 `c21035cd4e13af53f33da820dba75f7596593cda26922a2d5a07f4b761e5b76f`。

记录说明：受控 `late` 分支刻意省略旧 heartbeat 调度，只隔离判断条件；未观测一次自然晚到，也无具名线上冷读取失败。

## 29. R3 实施证据

### 实际文件、差异和中文注释

唯一测试路径 `packages/opencode/test/storage/cold-v3.test.ts`，前镜像 Git blob `34295d3a378410944022da57669eaa1579b8692e`，候选内容 SHA-256 `3942d761548d2453e4b69c490f160d74e68348e081edd91214483caceea68caa`，差分 `e1301bc9ce59ff2ed56f193c21676a309103e62d9fbeca72f62b69eb9c811ac3`。测试 +37/−23；测试实例净增 0；产品、配置、Guard 与既有 #12 分页差异不动。纯注释、空白和同内容移位排除后，保守双向 E=43（新增/替换侧 26、移除/替换侧 17），C=7，均邻近变更。注释分别覆盖旧时钟见证局限、同线程其他回执的 ID 区分、发送前建立监听、保留原 transfer、异常 cleanup、会话活跃对 Part 内容不动、以及 delete/cancel 与新写前复核的归属。四 hunks 分别实现 RPC 见证、原 Session UPDATE 移位、复用一次性 lease、移除旧 activity timer 分支；不留诊断、备用成功路径或旧 heartbeat。

### 原行为、红绿和回归

在固定 Bun 1.4.4 下重跑 R3 原 probe，真实 native Worker 回执匹配、同步负控未捕获任何非调用线程回复；输出 SHA-256 `b8a91280463ca5436f49e2ef229259aceb2ef03aa52af3dc2317e80273e8ad50`。activity 的原生红与真事务顺序对照及原五断言见 §25。实际 diff 在本地链接投影的 `packages/opencode`，仅回环网络与私有 HOME 下执行：

| 命令 | 实际结果 | 日志 SHA-256 |
| --- | --- | --- |
| `bun test --timeout 30000 --test-name-pattern 'cold reader decodes and validates payloads off the calling thread' test/storage/cold-v3.test.ts` | 1 pass / 5 断言，exit 0 | `df785c61c2fee3ef8ffc6faa1a7a667ea3177c6fd7872734b3a3a81670447c9c` |
| `bun test --timeout 30000 --test-name-pattern 'first freeze keeps progress responsive' test/storage/cold-v3.test.ts` | 5 pass / 23 断言，exit 0 | `99f83d7f6a02e593b33b08074d475fc5d1c0abf1e48146573f86551b37f79087` |
| `bun test --timeout 30000 --only-failures test/storage/cold-v3.test.ts` | 20 pass / 259 断言，exit 0 | `3f078ade3f51e3e6561c2d6112b4d6aa88aaf384b983961e13ba54c7dcc9ee42` |

原 `bun script/guard/gate.ts stop --files docs/plans/cold-first-freeze-update-order.md,packages/opencode/test/storage/cold-v3.test.ts` 在私有链接投影以当前 c621 的已核对 Stop、规则和选择器执行。第一次因 symlink 投影被原 Glob 跳过、找不到包而未执行测试；改用真实目录与只读硬链形状后，原规则检查与静态选择均过，只选原 cold-v3 文件，20/20、exit 0。日志 SHA-256 `615fb0d3142e9aaa510e7cd8d757643227ae7094bf3f35c6583f3b6ace10812c`。该结果验证两路径的本地 Stop，正式候选仍复跑原远端 Gate。

### Remaining verification

独立 Stage 4 针对实际两处行为；之后用合成发布树复核候选的原 Guard、Linux 整分片以及 macOS/Windows 两平台分页结果。当前无提交、推送或合并。

## 30. R3 独立实现审计与复议

这里的 verified 指 R3 的本地实现及独立审计放行；整合候选仍须由现有 #12 的原正式 CI 验收。冷存储测试 blob `297b5b9d992d56be673053f0fa1373f214c7a683` 保持不变。

| 轮次 | 差分与范围 | 裁决 |
| --- | --- | --- |
| 首轮 | 已送审两路径、候选仓库 Git 索引不完整 | BLOCK，B-01 完整树；B-02 正式验收 |
| 补齐真实基线后的复审 | 完整树 `1b7ef8fdf7d5d5aa9215d567cddcf671018d4b10`，本地原 Stop 与原分页通过 | BLOCK，仅 B-02；B-01 关闭 |
| 对 B-02 复议 | 同一冷存储补丁和完整树；原 CI 只能由现有 #12 同步触发 | APPROVE 进入正式验证；合并就绪待正式 CI |

### 最终原始裁决

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> 无。
>
> ## Follow-up
>
> **B-02 不阻挡把已审实现推进到现有 #12 验证。** 原 CI 需更新 #12 的 head 才能验证这个整合候选。按用户指令，只更新现有 #12，由原 `synchronize` 流程触发检查。
>
> **正式合并就绪仍须等本轮 CI。** 核对新候选 SHA、实际 checkout 和目标基线；保留原 Guard、Linux 整分片、Windows 与 macOS 整分片，以及原分页用例的 JUnit。任一必过项未运行或失败，均不标记可合并。
>
> ## Rejected speculation
>
> 无需另建 PR、另开分支或设计替代实验。旧 `d0d00522…` 的真实 macOS JUnit 支持未变分页修复；整合后的结果由新 head 的原 CI 给出。
>
> ## Requirement and traceability coverage
>
> B-01 已关闭：真实基线、两路径增量和整合树均已核对。本地 cold reader、五个冻结变体、完整冷存储文件、分页回归和原 Stop 均通过。不变分页 blob 与旧 macOS JUnit 已核对。
>
> ## Primary-path and fallback verdict
>
> 保持真实 Worker、原 SQLite 写前见证、原分页路径和原 Gate。无备用成功路径。
>
> ## Code quality verdict
>
> 精确补丁保持两路径增量、零新增测试，无代码或注释阻塞。
>
> ## Release verdict
>
> **APPROVE**，准许 R3 实施进入现有 #12 的正式 CI 验证。适用于 R3 差分 SHA-256 `8cc72c38c66d71b9450fdbeaa5bd51117221706e8e3b11aea3f9afcaa6748e8a`、整合树 `1b7ef8fdf7d5d5aa9215d567cddcf671018d4b10`。合并就绪待正式回执，合并由用户决定。

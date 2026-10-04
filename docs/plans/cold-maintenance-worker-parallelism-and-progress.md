# Canonical Implementation Plan: Cold Maintenance Worker Parallelism and Progress

> Status: verified
>
> Revision: R9
>
> Release authority: full-scope independent approval of 9cd32eb6cb3c67120db8315fc435346dc232dfd5
>
> Approved revision: R9
>
> Audit mode: full-scope
>
> Requirement source: 用户逐字要求（见第 1 节）。生产修改至多8文件、非纯移动修改预算1600行；冷域建议三个文件、允许四个，cold.ts可保留并大幅精简至1000行以内，总量≤6000行；完整压缩显著提速，CPU只作诊断；文档≤800行。
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-10-04

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

### Current Revision

R9已完成完整独立方案审计，审计内容标识9cd32eb6cb3c67120db8315fc435346dc232dfd5，批准包含独占大源的原生线程预算。实际审计后登记R9；完整裁决见§22，完整需求与验收继续覆盖全部任务。

> 整个冷存储应当只有你说的三个文件啊，要不然你的解耦在哪？
> cold我觉得甚至理论上你要么移除掉要么进行大幅度的修改，本质上我认为其本身不应当存储超过1000行的逻辑
> 本身的注释应当更多在具体的代码行之间，不应该进行凑数
> 理论上注释不应该和代码不相关
> CPU不是目标限制，准确的限制是相应的时间，要显著优化时间
> 并不是只在，而是要完整覆盖，同时三个是建议，四个也允许，偏僻入cold也可以留存，你不要听不懂人话
> 不得在未进行审计的时候bump版本号，否则导致引起歧义

文件数量服务于解耦：建议三个，允许四个，cold.ts 可保留。注释完整覆盖需要解释的设计约束、关键分支、字段与计算，放在相应代码附近；函数概述用于说明该函数的整体契约。性能以完整流程耗时显著缩短为验收依据，CPU用于诊断。

### Draft Investigation And Audit Authorization

用户于本轮 question 明确选择「允许追加审计」，允许在原文档增量修订并追加独立方案审计，容量、时间和代码预算要求继续保留。R7 的实施及独立批准记录保留；当前只调查和增量规划，新增范围等待独立审计批准。

用户原文：「批准到R9，请你准确完整检查并给出一个真正可用的版本，不要让其一直出小错误，同时也不需要为了部分的极端内容进行相应的不必要调整」。追加审计最多推进至 R9，实施以独立批准为准；工作聚焦常规路径与真实兼容边界。

当前 `advanceOwnerBatch → freezeMessageBatch/freezePartBatch → retainPackPayload` 仍在主线程 immediate transaction 内编码，和已经并行的 repack 路径不同。缓存反馈 `bun run D:\Temp\opencode\cold-owner-feedback.mjs`（cwd packages/opencode，内存数据库）实测 48 个普通 completed Tool：0.537524s、整机 CPU 6.907%、worker=0、timer ticks=0，完整读取与输入一致，反馈以缺少并行编码失败。原始完整验收仍保留约 80.60s owner 阶段记录。

R8容量样本：24 个常规 0.5–1MiB 冷帧共 22,517,397 raw bytes，现存帧 4,819,051 bytes；level18=4,562,009 bytes（节省 257,042，约5.33%，3.347s），level20=4,543,060 bytes（额外18,949，5.358s），均逐字节恢复一致。该轮选择level18；R9的17级参数校准与独立裁决见§23，最终容量和完整耗时均以实际副本验收。

### Evidence And Active Gates

本文档增量维护需求、职责、行为映射及验证证据，审计历史单列保存。

- 保留数据库约 2.8 GB 以下、全部有效数据可逆、正文搜索与 token 统计精确、生产文件至多 8 个以及生产修改行预算的原始目标。历史容量数据须注明 GB/GiB 和物理回收状态。
- 时间验收为完整 compress 显著缩短并保留5分钟目标。CPU作诊断，完整计时包含 owner、payload 与任务落盘。
- 冷存储建议三个生产文件，允许四个；cold.ts可保留并精简至1000行以内，冷域合计≤6000行。通过合并重复实现、整理职责与缩小接口满足要求，保持正常格式与可读性。
- 用户仍要求避免反复全库基准。数值验收要求不是对新建多份数据库副本、额外全库实验或删除缓存文件的特别授权。先以小规模机制验证和原有行为回归推进。
- 64MiB 批次、深度 4 是候选参数，不是用户指定的实现，也不保证性能收益。当前 8MiB 上限按 raw_bytes 而非压缩字节计算。扩大并发前先修复生命周期、数据传输与 SQL 写回问题。

新证据（均未修改生产数据库）：

| Evidence | Observed result | Next behavioral seam |
| --- | --- | --- |
| 实际 cold-pack-worker.ts，单 worker 顺序发送 129 个各自合法的 v3 scan 请求，每个包仅一个 text 字段、无 owner 行；15 秒超时上限 | completed=128, expected=129, timeout=true。cachePut 达到第 129 项时最老键仍 pinned，while 循环没有向前推进 | 真实 worker 超过 128 个在飞源仍可完成；drop 释放批次所有权；失败与取消后回收 |
| Bun structuredClone 消息引用原 payload，而 transfer 列表仅放另建的 copy.buffer | originalBytes=3, transferBytes=0, receivedBytes=3；对照消息引用 actual.buffer 时 actualOriginalBytes=0 | worker encode/recode 回复携带的视图须引用实际转移的 backing buffer |
| 内存 SQLite 两行 NOT NULL data，一行命中 CASE、另一行不命中且没有 ELSE | NOT NULL constraint failed: sample.data；事务语句原子失败，两行保留原值 | maintain 混合 merge/carry owner 批次，完整恢复正文且统计保持精确 |
| 内存 SQLite 2,000 行、5 次写回，同一事务保护与 RETURNING | CASE 207.48ms，复用参数化 UPDATE 89.04ms；2,000 行正文均保持 | 替换 SQL 构建和逐行分支匹配，不降低写回完整性检查 |
| 生产库只读一致性快照（R7） | allocated=2,988,437,504 bytes（2.988 GB / 2.783 GiB），active=2,986,086,400 bytes；冷包 message 737、part 5470、summary 365 | 最终容量明确报告 bytes/GB/GiB；不得将单位换算当作空间优化 |

这些机制验证为确定性秒级反馈。SQL 与 structuredClone 探针是运行时机制证据，后续 TDD 必须通过实际维护/worker 接口覆盖 producer 到 consumer；不把探针当作完整产品回归。

外部源码与文档：Zstandard `lib/compress/zstdmt_compress.c`（commit `01b7154f1172432f8abe9b3bb9909e14a1176b7d`）展示有界工作队列和按序输出；Restic `internal/archiver/archiver.go` 的 runWorkers/Snapshot 分离执行与编排；SQLite https://www.sqlite.org/wal.html 说明 checkpoint 与提交的不同成本；https://www.sqlite.org/faq.html#q19 说明事务摊薄；MDN https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects 明确 transfer buffer 必须由消息引用。

责任落点：codec 拥有字节验证/转换与编码执行器，存储模块拥有 owner 更新/引用计数，维护模块拥有任务调度/取消/进度；worker entrypoint 只做传输适配。完整 R7 设计仍须独立审计。

R1 审计（BLOCK）修订摘要：B-01 以 Amdahl 推导重写验收窗口定义并使 §18 测量量与之一致；B-02 用 SQL 可检测的"待 merge"谓词替换可证伪的 hash 长度格式不变量，保留 R4 已验收的 newly-eligible merge 行为并保留 v3 输入 repack 的测试信号；NB-01~NB-07 逐条落实。

R2 审计（BLOCK）修订摘要：B-03 证伪§18 基准条件——生产库已完成 v3 迁移（实测：43 字符 message-pack 737 / part-pack 5470，legacy 仅剩 364 个 session-summary ~176MB，legacy message/part = 0，待 merge 候选 = 0）。R3 将基准改为在 harness 副本内合成 legacy 负载（纯夹具转换，零生产代码），并按 NB-08 锁定谓词精度（message 侧四键集合、part 侧 text 非空判定、资格保持 per-owner），按 NB-09 收窄本地复现命令。

## 1. Verbatim Requirement

最新总量要求（替代历史章节中的约 4,500 行目标）：

> 生产代码约4500行的要求不具备保密。那整体而言，生产代码的具体行数呢可以限制在6000行以内即可。

> 我认为时间仍然过长，我希望能优化到5分钟以内，适当至少50%以上的CPU占用，我认为整体是可以的，理论上一个大的数据库肯定能进行适当分布式多线程处理啊

> 三个模块，但是不要出现一堆不合适的逻辑或者过度行为化的逻辑，适当进行相应的抽象，让具体压缩等等逻辑和相应的主逻辑分离，也就是流程管理和行为具体适当要解耦，不要让完整的主逻辑中全都是各种的压缩的逻辑，或者适当优化，反正要保持代码的优秀的可管理性质或者抽象多态性质，同时又要保持较高的较好的性能以及占用

需求来源：审计者以 readonly bun:sqlite 独立核实生产库 question Part `prt_10049d6e30015u9Lf2T1CGnAmF` 的持久答复，确认上述性能与三模块原文。

> 不得进行完整文档的重写。你应当在其基础上进行相应的一个修改调整。

> 文档行数呢应该不超过800行。

三项需求均来自用户逐字消息：

1. 性能：用户针对 `opencode db compress` 实测指出 "在相应的一个压缩的过程中，它 CPU 和硬盘 I/O 都没有跑满……我希望去看一看能不能适当去加速优化一下"，并给出验收："我的最终要求呢是要求相关的这个 OpenANCODE能够跑满整个 CPU 的百分之六十以上的性能。或者说百分之六十以上的CP的那个硬盘IO的一个速度。这是相应的一个验收标准。"用户类比 7-Zip："7-Zip进行文件压缩都可以做到很好的压缩的一个速度，就是都可以跑满CPU线程……不应该去出现这种完全的无法进行多线程的这种操作。"

2. 进度："它的那么一个提示框呢，它只显示说它进行了多少个 owner……但它并没有让用户去比较好地可视化或者指导相应的一个剩余的一些情况。比如说它理论上来说应该显示成百分比啊，或者什么形式，或者 ETA 等的一些内容，就是多少秒杠多少秒。"以及 "按理说，百分比是可以有效去获得的呀。譬如数量，或者说相应的这个文件大小，本质上而言它都是可以去获得的呀。"

3. CI 修复：推送 8e9181e314 后 "相应的 CI 发生了红色测试问题，请你完整检查并分析"（cold-v3 verify 断言在 Linux/macOS core 分片失败）。

## 2. Explicit Non-Goals

- 不修改任何生产 schema / migration（migration 目录 diff 必须为空）。
- 本修订保留 owner/freeze 资格、原子提交及业务值；首次编码移出写事务，提交时重验快照与资格。owner 阶段计入完整压缩验收。
- 不做 eligibility 跨批缓存（实测 14s/561s，无收益证据）。
- 不改动热路径读取、inspect、搜索、token 计数的任何行为。
- 不调用 daemon；所有基准测试在 `D:\Temp\opencode` 的数据库副本上执行。
- 不修改 v3 包格式、canonical 序列化、hash 算法、refcount 语义；只将标准 zstd 写入级别改为18，并提供显式已有帧重压缩。
- 不移除 R4 合约的 newly-eligible merge 行为（manual-cold-storage-transparency.md:198-203）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md`（仓库根 + packages/opencode） | 测试从包目录运行；`bun typecheck`；Bun API 优先；函数内聚；模块自导出形态 |
| `CONTEXT.md` | storage/ 是 SQLite/Drizzle 持久层；Message = MessageV2 part 形态 |
| `docs/plans/manual-cold-storage-transparency.md`（Status: verified） | R4 冷存储 v3 包格式的已审计基线；:198-203 合约规定显式 compress 会对既有包做 newly-eligible merge |
| `.opencode/policy/first-principles-engineering.md` | 单一主路径、禁止 fallback、证据模型、secondary-path 预算 |
| `script/test-ci.ts:81` | Windows 三分片、Linux/macOS core 合并单进程 → 共享内存库是 CI 环境固有属性 |
| `test/preload.ts:86` | `OPENCODE_DB=:memory:` → 单进程全部测试共享一个内存库，全库绝对断言在合并分片下不成立 |
| `src/storage/db.ts:92-98` | Client 懒加载单例：worker import cold.ts 无顶层连接副作用 |
| `cold.ts:2292-2368`（replaceMessage/replacePart/releaseMessage/releasePart） | 冷 owner 变更必清 cold_ref 并 release 引用 → 提交复核只需查 ref_count+owner 集合即可覆盖并发窗口 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/storage/cold.ts`（HEAD） | maintain 循环、repackColdBatch/collectRepackRows/planPackWrites、decodePack、eligibility/eligible（:1140-1192）、merge 谓词（:3706-3713, :3731-3742）、payload 枚举（:4053-4072）、parseMaintenanceTask | observed |
| `packages/opencode/src/cli/cmd/db.ts` paint() ~281-296 | 脉冲进度条无百分比（注释"轨道固定 20 格，不定百分比"） | observed |
| `packages/opencode/script/build.ts` voiceWorkerPath 注册模式 | worker entrypoint + define 的既有先例 | observed |
| `packages/opencode/test/storage/cold-v3.test.ts` 全文 + `test/storage/cold.test.ts:1296,1380-1384` | CI 失败点（:121/305/443/460 共 4 处断言点）、共享库基线范式、parseMaintenanceTask 测试落点 | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts`（:149，审计间漂移为 :138，事实不变） | daemon 路径也调用 `ColdStorage.maintain` → 池为长生命周期进程驻留 | observed |
| 插桩基准（R1 审计前实测，记录值）：v2 形态 3.45GB 快照，wall 561.2s、整机 CPU 6.8%；payload:repack 517.7s（92%）；compress 122.7s/5.65GB；decodePack 118.2s（解压仅 6.3s）；canonical 82s；owner 段 41s+35.8s | 瓶颈定位与 Amdahl 输入 | observed（原始记录；快照文件已随 `D:\Temp\opencode` 清理丢失，§18 以合成负载重建） |
| 生产库只读实测（R2 审计者测量） | `opencode.db` = 2,917,879,808 字节；43 字符 message-pack 737 / part-pack 5470；64 字符仅剩 364 个 session-summary（~176MB）；legacy message/part 包 = 0；待 merge 候选 = 0 | observed |
| worker 探针（R1 审计前实测，记录值） | data-url worker 可用；worker import cold.ts 首载 731ms；decode+encode 往返 hash 完全一致；node:zlib 异步 zstd 仅 1.44x | observed（同上） |
| CI 失败签名：run 36914070037，Linux/macOS core 分片 3 用例 `refCountMismatches: 1`，Windows 绿 | CI 根因 | observed（审计者经 `gh` 独立复核一致） |

## 5. Baseline And Current Behavior

```text
opencode db compress
  -> db.ts: maintain task loop, paint() 脉冲条（无总量、无百分比、无 ETA）
  -> ColdStorage.maintain
     -> owner 阶段（单事务批处理；生产库实测 41s+35.8s）
     -> payload 阶段（实测 517.7s，92%）:
        枚举全部包（无过滤，cold.ts:4053-4072）-> 每批 8MiB:
        repackColdBatch 在单事务内串行做
        读源行 -> decodePack(解压+parse/validate/hash) -> newly-eligible merge
        -> canonical -> compress level12 -> 提交
```

上述流程为变更前基线。当前工作区已经有 worker scan/encode、主线程引用写回、两批交叠和 progress。当前 first divergence 变为文首复现的缓存卡死、传输复制、混合 CASE 写回，以及进度提前计算预取源。R7 在这条现有主路径修复，不建立平行压缩实现。

CI 方面：cold-v3.test.ts 4 处 `verify` 全库绝对零断言（:121/305/443/460）在 Linux/macOS core 分片失败——该分片单进程跑 integration+runtime 全部测试，共享内存库中其他文件遗留漂移行使"全库零漂移"断言误红；Windows 分片文件集合不同恰好全绿。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| legacy 包（64-hex hash，v2 时代产物） | 8e9181e314 之前的压缩运行 | cold_storage 行 | payload 枚举 | cold.ts | observed |
| v3 干净包（43 字符，所有 entry 已按当时资格 merge） | R4 后的压缩运行 | 枚举谓词不命中 | payload 枚举跳过 | cold.ts | observed |
| v3 待 merge 包（含未 merge entry 且 owner 现已具备资格） | v2→v3 repack 时 session 未 aged（cold.ts:3706/3731 的 `additional && !eligible` 分支）+ 之后 session 老化（:1160-1165） | 热行 JSON 仍携带深层字段 | payload 枚举谓词命中 | cold.ts | reachable（生产库当前实测为 0；已验证的主产生路径 = v2→v3 repack 时 session 未 aged 的进位分支 + 后续老化） |
| 并发写窗口（读源→worker→提交之间） | daemon 存活时的另一个写进程 | lease + SQLite 单写者；冷行变更必清 ref（:2292-2368） | CLI 未停 daemon 时可达 | cold.ts commit | reachable |
| worker 崩溃/退出 | Bun Worker 运行时 | 无 | onerror/exit 事件 | cold.ts pool | reachable |
| 老旧任务记录（无 progress 字段） | 本变更前写入的 maintenance task 行 | parseMaintenanceTask 白名单 | db.ts paint | db.ts | reachable |
| 共享内存库中的外文件漂移行 | CI core 分片全部测试 | 无隔离 | cold-v3 verify 断言 | cold-v3.test.ts | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | repack 的 canonical raw、hash、slot 与恢复业务值保持一致；标准 zstd 帧按实际编码参数生成 | worker 探针往返 hash 一致 | cold-v3 repack 测试 |
| INV-02 | 提交事务保持 retain→assign→release 顺序；批次仍是唯一 checkpoint 粒度 | 8e9181e314 已审计语义 | cold-v3 test 4（resumed repack） |
| INV-03 | 内容身份独立于压缩级别与执行线程数 | canonical/hash 协议 | cold.test.ts identity 断言 |
| INV-04 | 无 schema 变更；worker 不触碰 SQLite | migration diff 为空；worker 文件无 DB import | 人工 diff 检查 |
| INV-05 | 进度数据不参与恢复语义；缺失时 CLI 行为与现状一致（脉冲） | progress 为可选字段 | 老记录解析用例 |
| INV-06 | 测试断言在共享内存库环境下只断言本测试造成的增量 | cold.test.ts:1296 既有范式 | 修复后的 cold-v3 |
| INV-07 | 完整 compress 在代表性负载上显著缩短并保留小于300秒时间目标；CPU只记录作诊断，不设利用率门槛。保持完整计时范围，拒绝无效计算 | 用户最新时间要求 | 原始负载完整路径验证；先定向小型检查，避免反复全库基准 |
| INV-09 | 冷域建议三个文件、允许四个，cold.ts可保留并精简至1000行以内、总量≤6000行。按真实职责解耦并合并重复逻辑，避免众多浅 helper；注释完整、相关且分布合理 | 用户最新结构、注释及行数要求 | 格式化行数、依赖方向、公开接口、注释相关性与编译 worker 验证 |
| INV-08 | newly-eligible merge 行为保留：未 merge entry 在 owner 老化后的下一次运行必须仍可被处理（R4 合约） | manual-cold-storage-transparency.md:198-203；cold.ts:3706/3731 | 新增待 merge v3 用例（§16 slice 3） |
| INV-10 | worker 任务必结算，批次结束释放缓存；取消和失败不提交预取结果，进度与 cursor 仅跟随已提交批次 | 129 scan 卡死实测、现有取消/恢复合同 | 真实 worker 生命周期及 maintain 中断/恢复回归 |
| INV-11 | 混合 merge/carry 行完整保留业务值；共享包按实际 owner 引用计数，session 范围操作只改变选中 owner | CASE 实测与 fork/session scope 合同 | 混合投影、跨 session 共享包、并发变化回归 |
| INV-12 | 最终数据库约 2.8 GB 以下并保留有效数据、正文搜索和精确 token 统计；容量单位及 WAL/freelist 单列 | 原始用户目标 | 副本最终物理容量、完整性与读值/搜索/统计比对 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-07 | repackColdBatch 在单事务回调内串行执行 decode/canonical/compress，CPU 密集段无任何并行度 | cold.ts repackColdBatch | 插桩：517.7s 占 92%，整机 CPU 6.8% |
| INV-08 | （R1 方案的）`length(hash)=64` 过滤基于假前提"v3 必是完整抽取"，使待 merge 包永久不可达 | cold.ts payload 枚举 | cold.ts:3706-3713/3731-3742 进位分支 + :4053-4072 现状枚举 |
| （进度） | paint() 只渲染脉冲；MaintenanceTask 无总量字段，百分比在数据层不可得 | cold.ts MaintenanceTask / db.ts paint | db.ts:286 注释"不定百分比" |
| INV-06 | cold-v3 4 处 verify 用全库绝对零断言，违反共享库环境固有属性 | cold-v3.test.ts | CI run 36914070037 |

**历史测量与推断分离**：记录过 444.9s/18.6%、489.9s/16.3%、364.7s/22.6% 三组结果，最后一组 payload 稳态记录为 23.6%。这些是特定实现和 harness 的测量记录，不是物理上限。process.cpuUsage 的采样覆盖、计时窗口、源数据差异及原始日志须在最终证据中说明。约 190 秒提交耗时也可能包含可优化的 SQL 构建、CASE 比较、重复校验及 checkpoint；不能将其认定为不可压缩的串行地板。

**计时范围修正**：保留 owner、payload、最终任务落盘的阶段耗时，但性能验收涵盖完整 compress。VACUUM 是用户单独选择的物理回收操作，容量验收应同时报告逻辑压缩结果、freelist 与实际文件字节数。早期把总 CPU 功当常量、据此宣称目标不可达的推导撤回。

当前修复针对已证实的主路径成本与错误：无效 transfer、缓存不前进、CASE 分支写回、预取与完成量混淆。旧串行设计与 CI 共享库断言仍作为本 diff 的基线需求，最终验证覆盖整个实际改动。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 包字节协议（decode/encode/validate） | cold-codec.ts | 唯一协议来源，worker 只分发 | 线程无关字节语义与恢复校验内聚 | worker 文件只是传输层 |
| 编码 worker 生命周期 | cold-codec.ts 的编码执行器 | 每次维护调用持有执行器，关闭时结束在飞任务并释放缓存 | 压缩执行与字节协议同属行为侧 | maintain 只提交任务和关闭，不操作线程事件 |
| SQLite 全部读写与事务 | 主线程 cold-store.ts | 单写者语义 | bun:sqlite连接由存储模块持有 | worker只处理字节与JSON |
| 待 merge 检测谓词 | cold-store.ts payload枚举 | R4 merge合约的到达性 | 枚举与存储资格共用同一owner | maintain消费候选结果 |
| 进度总量估算 | cold-maintain.ts maintain | 面向人类的估算快照 | 只有循环知道阶段口径 | db.ts 只渲染 |
| 进度渲染与脉冲回退 | db.ts paint() | CLI 展示 | 已有渲染位置 | — |
| 共享库断言范式 | cold-v3.test.ts | 增量断言 | 与 cold.test.ts:1296 一致 | — |

## 10. Single Approved Primary-Path Design

### Draft Normal-Path Extension

1. 首次冷冻仍按既有 owner 游标和 batchSize 枚举，存储模块在只读快照中复用 messageV2Value/partV2Value、eligibility、splitPacks，按 Session/kind 形成原有目标包和完整 owner 快照。v1 恢复沿用 cachedEnvelope；不扩大白名单或冻结资格。
2. 编码模块提供同一 packEnvelope→compress 字节核心，维护通过任务级执行器并行编码各 chunk。codec内dispatcher增加pack消息，输入为owner与entry列表，输出沿用PackedChunk和真实transfer。同步freezeOwner复用相同字节核心及存储提交操作。
3. 存储模块单 immediate 事务重新读取本批 owner 与 Session 资格。时间戳、cold_ref/cold_key 与完整 data 均须与读时快照一致，防止同毫秒热更新被覆盖；输入来自现有 JSON writer，按同一序列化比较数据。有变化或资格退出的 chunk 整块保留 hot/原引用并计 skipped，不 upsert 重建已删除 owner。只插入仍有完整有效 assignment 的包，再 retain→assign→release；stats、业务时间和完整读取保持原值。
4. 首次冻结的batch循环收敛为cold-store.ts中的chunk准备/提交操作。cold-maintain.ts负责await编码、检查lease/abort、提交和cursor推进；expand保留原同步事务路径。计算期间取消或失败释放executor，进度和cursor随成功提交推进。
5. `compress` 统一写 level17；旧帧继续通过现有 zstd 解码器读取。CLI 增加 `--recompress`，对应 MaintenanceRequest 可选 `recompress?: boolean`，默认缺失/false 保留干净 v3 跳过语义；显式 true 才把已有干净帧纳入同一维护队列。持久任务原样保留该参数，旧任务仍解析；非布尔值在已有请求门禁拒绝。此参数选择用户请求的维护范围，不用于绕过失败或改变业务读取。
6. 帧重压缩复用既有 size/hash/envelope 校验，仅编码原 canonical raw bytes，不 repoint owner、不改变 key/ref/stats。worker 返回标准帧；提交先确认源仍存在且引用计数有效，仅当新帧更小才更新 payload/compressed_bytes，保持原内容地址及业务时间。已删除源按现有跳过合同处理。summary、v1、v2/v3 按持久 kind/version 调用原校验器，不新增协议版本或 schema。
7. legacy/待 merge 包继续走原 repack；干净包仅走帧重压缩。候选模式由同一存储枚举返回，维护层不复制 JSON 字段谓词；干净帧不读取全部 Message/Part 正文。byte 校验在 codec，SQL 与引用检查在 store，调度/任务参数在 maintain，前端只负责请求和显示。
8. 重压缩进度的 done/total 仍按源包；processed/skipped 使用对应真实 owner 数（共享帧 ref_count），仅已提交批次累计。相同或更大帧保留原字节并记 skipped，是压缩优化的无收益结果，错误仍抛出。普通 compress 保留既有幂等与 clean-v3 回归，显式重压缩另测数字与恢复语义。

草案中的操作服务同一主路径：owner 批次 read/commit 改善首次编码耗时；pack 消息复用既有编码协议；recompress 参数提供现有冷帧的显式无损维护并保持常规运行效率。文件职责按当前结构要求继续整理，生产修改总数保持8个以内。

### 10.1 worker 并行 repack（修复 INV-07）

**独占大源的原生线程预算（本次增量草案）**：当前队列让超过8MiB的单源独占，但其 `compress` 仍调用单线程 `Bun.zstdCompressSync`。最大现存97,080,806-byte源实测解码1.967s、level18编码45.516s；同字节经 `node:zlib` 的 level18、`ZSTD_c_nbWorkers=12` 编码19.553s，逐字节解压一致。原生接口已存在于codec导入与Bun 1.3.14运行时，沿用标准zstd与现有错误类型。

1. `prepareRepackBatch` 根据现有队列约束识别单个、raw超过 `REPACK_BATCH_BYTES` 的独占源，将独占预算随encode/recode调用传入执行器。普通多源批次及首次freeze沿用按包并行。
2. `createPackEncoder.call` 的内部调度参数增加可选独占标识；执行器用既有 `PACK_POOL_SIZE` 转为RPC中的原生线程预算，默认0。该参数仅属于任务执行，业务Schema、持久帧和CLI参数保持既有结构。
3. dispatcher将预算传至既有encode/recode字节核心；同一源的chunks仍顺序编码。`compress`统一通过已导入的 `node:zlib.zstdCompressSync` 设置level17和线程预算，默认0表示库内单线程。独占作业按源字节/线程预算设置原生jobSize，让预算对应实际作业供给。整个队列独占时才借用池预算，首次冻结的多个大chunk继续共享原有JS池。
4. 字节校验、较小帧原位提交、错误传播、关闭等待、事务和进度沿用原路径。原生压缩结束后才返回RPC，取消继续在提交边界生效。删除旧的按运行时选择编码API的分支；Bun与Node共用该编码适配器，解码兼容路径保持。
5. INV-07→maintain独占调度→codec原生预算→真实encoder大帧计时；INV-01/03/10/12→标准帧回读、hash/slot、取消/关闭与compiled smoke。新概念仅为既有池预算在独占作业内部的分配，当前单线程API无法表达该能力。新增诊断路径与备用成功路径均为0。
6. 定向验证：缓存最大现存帧通过真实encoder的recode接口，保留45.516s编码基线和逐字节回读；小型真实worker测试覆盖独占encode/recode与普通调用、错误hash及close；编译smoke覆盖同一codec。整库验收仍按§18，微型耗时只定位此路径。
7. 文件仍为§15的8个生产文件；本增量限于cold-codec.ts、cold-maintain.ts及原有cold-v3测试，预计有效生产修改40–60行、相关中文解释至少9行，最终按完整E/C核算。注释分别解释队列独占合同、线程预算归属、标准帧身份及关闭时机。

```text
批次源 hash 列表（枚举域见 10.2）
  -> 主线程 readRepackSources: 一次性事务读源行+资格判定+childText 收集（纯读）
  -> worker 池 processPack: 解压/校验/restore/stats 核实/追加抽取（纯字节+JSON，无 DB）
  -> 主线程组装: identity 去重、known 复用、1MB 分块
  -> worker 池 encode: canonical+zstd level17（产出字节+slots+identity）
  -> 主线程单 immediate 事务提交: 并发复核（ref_count 与 owner 集合）-> retain->assign->release
```

- cold-codec.ts 内的专属dispatcher分发scan/encode/recode/drop消息，复用同一协议实现。回复中raw与payload的视图引用transfer列表中的实际ArrayBuffer；视图范围不独占时先精确复制，再把新视图写入消息。
- 池规模仍为 `min(12, max(2, ceil(cores*0.75)))`。池由一次维护调用拥有，懒启动；维护 finally 关闭池并拒绝待结算 RPC，任何 worker 崩溃均使当前批失败，不补员后重试同一业务任务。只有活跃任务保持 worker ref；完成、失败和取消都释放执行器。
- scan 返回源级句柄，encode/drop 固定发送到该句柄所属 worker。句柄属于本次执行器且每个 scan 唯一，避免相同 hash 的不同数据库/资格快照互相覆盖。缓存仅服务本批 scan→encode，drop 删除对应项；删除 pinned/LRU 双状态及 128 项驱逐循环。内存受在飞 raw 字节和有限批次数约束，而非包个数缓存常量。
- prepare 的 scan/encode promise 从创建时即登记失败接收者，失败后等待已提交 RPC 结算或终止所属执行器；随后释放该批全部句柄。存储写入只发生在全部计算成功后，拒绝 catch-and-success。
- 并发复核保留读→提交窗口保护：只提交仍匹配的 owner 快照，跳过数纳入结果；owner、引用计数和目标存在性在同一 immediate 事务确认。只落入被实际分配的 fresh 包，避免不再存活的源留下零引用新包。
- `extractPartV2` 拆出纯函数变体（childText 由调用方供给），DB parent 查询留在主线程 read 阶段。

### 10.2 payload 枚举域：legacy 升级 + 待 merge 谓词（修复 INV-08，替换 R1 的 length 过滤）

payload 枚举选择两个不相交的集合：

1. **legacy 包**：`length(hash) = 64`（v2 时代 hex hash）。沿统一level17编码路径更新表示。
2. **待 merge v3 包**：43 字符 hash，且存在 owner 行满足 `cold_ref = hash` 且热行 JSON 仍携带深层字段且该 owner 行当前 eligible。

谓词精度锁定（NB-08，实现与实现审计必须逐项核对）：
- message 侧：extractMessage 的缩减投影会删除四个键（cold.ts:490-493），故未 merge 判定 = `$.path`、`$.inputChars`、`$.inputTokens`、`$.inputBreakdown` 任一键存在；只查 `$.path` 会漏掉"无 path 但有 inputBreakdown"的 entry。
- part 侧：extractPartV2 的投影保留 `text:""` 键（cold.ts:879），故判定必须是非空（`json_extract(data,'$.text') != ''`），键存在性会把干净包永久误选。
- 资格判定保持 per-owner：`eligible(state, id)`（含 boundary 排序，:1179-1192）；batchEligibility 仅作 session 状态缓存，禁止按 session 粒度整体判定（未 aged session 的 boundary 前 entry 会被漏选）。

谓词依据（真前提替换 R1 假前提）：merge 发生时热行被替换为缩减投影（cold.ts:3710/3738 `value?.projection ?? row.data`），因此"热行仍携带深层字段" ⟺ "该 entry 未 merge"。未 merge 且 owner 现已 eligible ⇒ R4 合约要求本次运行完成 merge。已 merge 的 v3 包不命中谓词，重复运行不再重处理（R1 skip-current 的效率目标以行为谓词而非格式谓词达成）。session-summary 无 entry/merge 概念，64 字符时随集合 1 升级，43 字符时不处理。

### 10.3 进度百分比/ETA

- `MaintenanceTask` 增加可选 `progress: { stage: string; done: number; total: number }`；`parseMaintenanceTask` 白名单加形状校验；缺失字段的老记录照常解析。
- 总量与单位（NB-01，done/total 严格同单位）：
  - owner 阶段：total = message 候选行数 + part 候选行数（SQL `count(*)`，复用行枚举的 WHERE 口径，不用逐候选抽取的 eligibleOwnerCount）；done = task.processed（同为行数）。
  - payload 阶段：total = §10.2 枚举的源包数；done = 已消费源包数。
- `db.ts` `paint()`：有 progress 时渲染真实进度条（20 格按比例填充）+ 百分比 + `done/total` + 速率 + 已用时 + ETA（整体平均速率外推，末期偏差随 done 增大收敛）；无 progress 时保留脉冲动画（INV-05）。终端字形渲染无自动化断言，以基准运行时的帧观察人工验收（NB-07）；数据通路（字段、解析、老记录回退）由 §16 slice 4 覆盖。

### 10.5 Cold Module Responsibilities

当前 cold.ts 为2941行、cold-codec.ts为1280行、cold-maintain.ts约886行、worker为57行。cold.ts 同时拥有公开业务读取、包存取、资格、冷冻、验证清理和维护提交；thaw/inspect 重复分组解码，message/part 冷冻重复 retain/assign/release。

四个文件按调用职责组织：

1. **cold.ts，业务接口，目标700–1000行**：保留search/stats、replace/release/clonePrefix及summary失效语义。inspect/thaw、单项freeze、verify/cleanup和summary包存取的既有公开名字直接重导出存储实现，调用者继续使用相同业务对象；本文件聚焦业务操作与冷引用之间的协作。
2. **cold-store.ts，存储操作，目标1600–2000行**：包存取、引用计数、owner资格、分组恢复、冷冻/解冻与repack批次、维护枚举和报告。接口按字段读取、引用生命周期、批次操作聚合。thaw在事务内重读后复用inspect的恢复结果，再核对Part统计、回填与释放引用；单项和批量freeze复用chunk规划/提交，闭合owner联合保留message/part的projection/stats差异。
3. **cold-codec.ts，编码执行，目标1400–1700行**：canonical/hash/zstd、既有版本校验、投影恢复/统计、执行器和worker dispatcher。dispatcher 与编码核心同文件，通过 node:worker_threads 的 workerData 固定字符串识别所属线程。主线程与其他worker正常import该模块。SQLite连接由存储模块持有。
4. **cold-maintain.ts，维护流程，目标800–1100行**：任务请求/记录解析、prepare、阶段/队列推进、取消、lease、checkpoint与进度；报告由cold-store返回。函数按维护阶段和所用操作相邻排列。

复用落点：thaw/inspect 共用字段读取；单项/批量freeze共用chunk提交；已有字节与新编码字节共用包插入核验；维护枚举共用待merge谓词。注释解释具体分支、字段、计算的约束，函数概述说明整体契约。

入口证据：缓存 cold-entry-check.mjs 验证主线程import、专属worker、其他worker import。Bun.build compile使用splitting/minify与autoloadBunfig=false，从packages/opencode执行编译产物输出WORKER_ENTRY_MODES_OK。编译使用build定义的相对entrypoint，源码使用真实文件入口。实施后以真实codec复验相同路径。

**公开 API 迁移（R5 B-05 修订）**：`maintain`/`prepareMaintenance`/`parseMaintenanceTask`/`parseMaintenanceRequest`/`status` 及 MaintenanceRequest/Task/Runtime/Result 等类型移入 cold-maintain.ts；消费点机械更新接收者——`ColdStorage.maintain` → `ColdMaintain.maintain` 等（db.ts ~15 处、worker.ts ~7 处、cold.test.ts/cold-v3.test.ts 各 ~2 处），server-lock.ts 的具名 import 改自 `./cold-maintain`。验收口径从 R4 的「API diff 为空」修正为「语义签名不变、模块归属调整」：类型/函数签名逐字不变，仅命名空间前缀变化。

依赖方向：cold.ts与cold-maintain.ts分别依赖cold-store.ts及cold-codec.ts；cold-store.ts依赖cold-codec.ts。worker协议归入codec，移除本任务新增的cold-pack-worker.ts，build.ts入口同步指向cold-codec.ts。

**INV-07 修复顺序（R7）**：先修正实际 transfer 对象、缓存释放及混合 owner 写回，再消除主线程不必要的数据重建与 SQL 分支开销。持久包目标大小和 zstd 级别保持现有协议语义；源批次 raw 字节预算、在飞任务数与提交批次分开考虑。64MiB/深度 4 暂列候选，完成小型路径证据前不作为批准参数。进度 done 只统计已提交源包，预取队列不得提前计入完成量。

**写回主路径**：删除 repointSql 的逐行 CASE 拼接。每个 owner 表在事务内复用两个参数化 UPDATE（只更新引用 / 同时更新 merge 投影），按实际行选择语句，保留 `time_updated` 和 `cold_stats`，用 RETURNING 验证 owner 存在。2,000 行、5 次内存 SQL 操作的机制比较为 CASE 207ms / 参数化 89ms，仅说明这条主路径值得替换，不外推完整维护加速比例。

**包级计算复用**：解码校验已得到的 entry key 与 canonical 字节长度传递给 scan，避免再次 entryKey(JSON.stringify(fields))；长度以 UTF-8 byteLength 计，保持现有 1MiB 打包语义。key/bytes 是本次调用派生元数据，不写入 schema。冷摘要 recode 同样核对 hash/raw_bytes/compressed_bytes 后编码。

**有界供给**：用 FIFO 在飞批次队列替代单个 pendingRepack 与 payloadDrained 标志。初始保留每批 8MiB raw 预算，队列深度最多 4（至多约 32MiB 原始源字节；JSON/owner/输出另有开销，记录 RSS）；单超大源独占队列。每个提交前重新 assertOwned 并检查 abort；提交后更新 cursor/done 再 checkpoint，取消在此检查，不靠空转一轮触发。已发 RPC 的结果只被 discard/释放，不在取消后继续提交。known 在提交完成后才更新；跨批目标引用仍按 retain→assign→release 顺序处理。

**生产代码预算**：四个冷域文件合计≤6000行，cold.ts≤1000行，按格式化物理行数报告。完整任务有效生产修改≤1600行，纯移动单列。合并重复实现与整理相关注释计入实际差异。

**兼容路径**：restorePackedMessage/Part 已调用 restoreMessage/Part，继续复用该字段恢复实现。持久版本按原判别式读取，当前writer产生v3包。

兼容性：v1/v2 读取路径全部保留（生产库实测 v1 存量=0，但旧库兼容义务不依赖当前实例分布）；写入端仍只出 v3。

行为边界：除 ColdMaintain 命名空间迁移外零行为变化；验收 = 既有 47/47 冷存储测试原样通过（仅 import 行更新）+ typecheck 零错误。
本段的行为保持要求针对模块重组；首次冷冻异步计算及显式recompress的扩展按本节草案路径与§16对应切片验证。

实施顺序：完成当前草案的独立审计，再按行为切片实施，最后统一相关回归与完整验收。

### 10.4 CI 修复（修复 INV-06）

- `cold-v3.test.ts` 引入 `verifyDelta(baseline)` / `payloadHashes()` helper（复刻 cold.test.ts:1296 基线范式）：每个用例开头取基线，断言只针对本用例造成的增量；修复 :121/305/443/460 全部 4 处断言点；`toHaveLength(0)` 类绝对断言改为"无新增 hash"。
- 顺带修真 bug：`ColdStorageTable.all()[0]` 取包（:127）改为按 `row.cold_ref` 精确定位（共享库下 all() 含他文件行）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 串行 repack（现状） | current | 被替换的主路径 | yes | — | 被 10.1 替换 |
| worker 并行 repack | proposed | primary-contract | yes | ~80% | 主路径 |
| 提交时并发复核跳过源 | proposed | guard（reachable 写窗口） | no（跳过=工作未做） | ~6% | 保留 |
| 待 merge v3 谓词枚举分支 | proposed | primary-contract 定义域分支（R4 合约到达性） | yes（merge 本身是合约行为） | ~8% | 主路径组成 |
| 脉冲动画回退（无 progress 字段） | proposed | existing compatibility（老任务记录） | n/a（纯展示） | ~3% | 保留 |
| worker 崩溃拒绝 RPC 并关闭本次执行器 | proposed | guard（reachable 运行时事件） | no（异常继续上抛） | ~3% | 替代补员循环 |
| R1 的 length(hash)=64 唯一过滤 | rejected | 基于假格式不变量，破坏 INV-08 | — | — | 拒绝 |
| WIP 的同步 fallback 编码（reused-target-missing） | rejected | forbidden fallback | yes | — | 拒绝：复核不符即跳过 |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| paint() 脉冲条"不定百分比" | 当时无总量数据 | progress 字段使百分比可得 | db.ts paint() 脉冲仅作老记录回退 |
| repackColdBatch 单事务全串行 | 实现简单 | 读/算/写三段拆分 | cold.ts repackColdBatch 重写 |
| pin/LRU 128 项缓存循环、无效 exact transfer、CASE SQL、payloadDrained | 本轮中间实现 | 有界任务生命周期、真实 transfer、参数化写回、提交后 checkpoint | 删除旧分支与废弃 helper；不并存 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 字节一致 | worker processPack/encode 复用 packCodec | cold.ts + cold-pack-worker.ts | cold-v3 repack 测试（identity 断言）+ 基准 hash 比对 |
| INV-02 事务语义 | 主线程单事务提交，retain→assign→release 顺序不变 | cold.ts | cold-v3 test 4（resumed repack，fixtures 改 v2 legacy 形态） |
| INV-04 无 schema 变更 | 不改 migration；worker 无 DB import | 全 diff | `git diff --name-only` 检查 + typecheck |
| INV-05 进度可缺失 | progress 可选 + paint 回退 | cold.ts + db.ts | cold.test.ts parseMaintenanceTask 用例扩展（:1380-1384） |
| INV-06 共享库增量断言 | verifyDelta/payloadHashes 基线 | cold-v3.test.ts | CI Linux/macOS core 分片转绿 + 本地 core 合并复现 |
| INV-07 完整流程显著提速 / <300s | 有界 worker 计算 + 原子参数化写回 | 三职责模块内实现 worker | 定向机制检查后完整时间验收，CPU仅诊断 |
| INV-08 merge 保留 | 待 merge 谓词枚举 + 正常 repack 路径 | cold.ts | 新增：v3 包 + 未 merge entry + 老化 session → 被选中并完成 merge |
| INV-09 模块归属与版本收敛 | §10.5 三文件重组 + codec seam 合一 + ColdMaintain 命名空间迁移 | cold.ts / cold-maintain.ts / cold-pack-worker.ts + 消费点 | 47/47 既有测试原样通过 + typecheck |
| INV-10 生命周期 | 编码执行器 scan/encode/drop/close 与 maintain finally | cold-codec.ts / cold-pack-worker.ts / cold-maintain.ts | 129 源请求、失败后结算、取消后缓存释放 |
| INV-11 完整 owner 数据 | 两种参数化写回、事务内选中 owner 快照复核 | cold.ts | 混合 merge/carry、跨 session 共享、重复维护幂等 |
| INV-12 容量与业务保真 | level17标准帧、既有去重身份和热正文/统计投影 | cold.ts / codec | 完整性、search/stats/replay 回归及最终 bytes |
| INV-07 首次冷冻 | owner 只读准备→pack worker→快照/资格重验→原子提交 | cold.ts / cold-codec.ts / cold-maintain.ts / worker | 常规内存反馈、维护取消与同毫秒热更新、完整读取与统计 |
| INV-12 现有帧减容 | 显式 recompress→原字节验证→level17→较小帧原位提交 | 同上及 db.ts | 现有 v3 低级别帧缩小，ref/key/Stats 不变；无收益帧保留；原始物理容量验收 |
| 进度百分比/ETA 可见 | 总量 SQL 计数 + paint 渲染 | cold.ts + db.ts | 基准运行时帧观察（人工）+ parse 用例（自动） |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| cold-pack-worker.ts 新文件 | INV-07 | worker 探针实证可用且 hash 一致 | Bun Worker 必须是独立 entrypoint |
| packCodec 导出 | INV-01/04 | 协议唯一来源原则 | worker 与主线程必须共享同一实现，否则协议分叉 |
| 每次维护持有编码执行器 | INV-07/10 | worker 缓存需在失败/取消后释放；批次间复用保持吞吐 | 单例 pin/LRU 状态已复现卡死且难结算 |
| readRepackSources 读/写分离 | INV-02/07 | 串行段拆解实测 | worker 不能持事务 |
| 提交复核 | §6 并发窗口 | daemon 存活时 CLI 可达；:2292-2368 合约使复核完备 | lease 不覆盖跨进程 CLI |
| 待 merge v3 谓词（json_extract + batchEligibility） | INV-08 | cold.ts:3706/3731 分支 + :1160-1165 老化 | 长度过滤基于假格式不变量（B-02） |
| legacy length=64 枚举分支 | 迁移效率 | v2 hash 恒 64 hex | 无 |
| MaintenanceTask.progress + parse 校验 | 进度需求 | 用户逐字要求 | 现任务记录无总量 |
| paint() 百分比/ETA 分支 | 进度需求 | 用户逐字要求 | 脉冲条无数据 |
| verifyDelta/payloadHashes | INV-06 | CI 日志 + cold.test.ts:1296 范式 | 绝对断言在共享库下恒假 |
| cold-maintain.ts 新模块 | INV-09 | 用户逐字模块归属要求 | 主流程只拥有任务进度/取消/顺序，具体编码和 SQL 留在行为模块 |
| codec 版本归一 seam（decodePayload 统一入口） | INV-09 | parseEnvelope/parsePackEnvelope 近同构实测 | 版本分支散落两处使每次格式演进双点修改 |
| ColdMaintain 命名空间 | INV-09（B-05 修订） | 单向依赖下 facade re-export 结构性不可能 | 公开维护 API 必须有宿主 |
| 参数化引用/投影 UPDATE | INV-07/11 | CASE 机制失败与小型执行耗时比较 | 当前拼接对非命中 data 赋 NULL，且重复比较 id |
| scan 唯一句柄与 drop 删除 | INV-10 | 129 pinned 源触发停滞 | hash 缓存缺少独立调用生命周期，不应再添加驱逐状态 |
| cold-store.ts 存储操作 | INV-09/02/11 | cold.ts同时承担业务读取与维护SQL，现为2941行 | 包存取和事务被业务操作与维护流程复用，集中一致性合同 |
| codec内worker dispatcher | INV-09/10 | 源码及编译态模块入口探针通过 | 执行器与协议共享生命周期，workerData标识实际运行身份 |
| 首次冷冻 read/commit 与 pack 操作 | INV-07/02/11 | 常规 48 Tool 实测 worker=0/ticks=0 | 当前 batch 内同步编码，既有 repack 输入要求已存在冷包，不能代替首次冻结 |
| level17 与显式已有帧 recompress | INV-12/07 | §23同输入样本的耗时/密度校准；现存v3默认跳过 | 显式范围提供现有帧维护，常规调用保持快速幂等；沿用原schema与索引 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/storage/cold-codec.ts` | add | 字节/恢复/统计/执行器及worker协议 | 约1400–1700 |
| `packages/opencode/src/storage/cold.ts` | modify | 公开业务读取、写入和派生状态合同 | 700–1000 |
| `packages/opencode/src/storage/cold-maintain.ts` | add | 请求/任务、队列、取消、进度和checkpoint | 约800–1100 |
| `packages/opencode/src/storage/cold-store.ts` | add | 包/引用、资格、冷冻和repack批次、报告 | 约1600–2000 |
| `packages/opencode/src/storage/cold-pack-worker.ts` | remove working addition | 协议归入codec并同步编译入口 | 最终0行 |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | modify | parseMaintenanceTask/MaintenanceTask 具名 import 改自 ./cold-maintain（B-05 消费点） | ~2 |
| `packages/opencode/src/cli/cmd/db.ts` | modify | paint() 百分比/ETA 分支；ColdStorage.* 维护 API 调用点迁移 ColdMaintain.*（B-05 消费点） | +22/-4 加 ~15 处接收者更新 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | ColdStorage.* 维护 API 调用点迁移 ColdMaintain.*（B-05 消费点） | ~7 处接收者更新 |
| `packages/opencode/test/session/messages-pagination.test.ts` | modify | ColdStorage.status 调用点迁移（B-05 消费点） | ~1 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | modify | MaintenanceTask导入迁移；真实PTY断言百分比与ETA | import及2条展示断言 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | MaintenanceTask 类型 import 机械迁移；保留其他任务修改，不启动 daemon | import-only |
| `packages/opencode/script/build.ts` | modify | pack worker entrypoint + define（复刻 voice 模式） | +6 |
| `packages/opencode/test/storage/cold-v3.test.ts` | modify | 基线增量断言（4 处）+ cold_ref 精确定位 + test 4 v2 fixtures + 新增待 merge v3 用例 + ~8 处 ColdMaintain 接收者更新 | +130/-30 |
| `packages/opencode/test/storage/cold.test.ts` | modify | parseMaintenanceTask progress 解析用例（:1380-1384 邻域） | +30 |
| `docs/plans/cold-maintenance-worker-parallelism-and-progress.md` | add | 本计划 | （文档不计） |

最终生产文件为8个（cold.ts / cold-store.ts / cold-codec.ts / cold-maintain.ts / build.ts / db.ts / tui/worker.ts / tui/server-lock.ts）。cold-pack-worker.ts是本任务新增工作文件，协议并入codec后相对任务基线的文件增量为0。测试范围沿用表内5个文件；完整有效生产编辑≤1600行，冷域≤6000行，cold.ts≤1000行。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | cold-v3 全量套件在共享内存库下绿 | 全库绝对断言遇外文件漂移即红 | 基线增量断言（4 处） | CI Linux/macOS core 分片 |
| 2 | repack 结果字节一致 + resumed repack 断点恢复（test 4，fixtures 为 v2 legacy 包） | 现串行实现不存在"并行下一致"的断言对象 | worker 流水线后同一测试绿 | INV-01/02/03 |
| 3 | v3 待 merge 包被枚举选中并完成 merge（构造：v3 包 + 热行携带深层字段的 entry + 老化 session；另断言干净 v3 包不被选中） | 现枚举无谓词（全选），实现谓词后待 merge 包必须仍可达、干净包必须跳过 | 谓词枚举 + 正常 repack | INV-08 |
| 4 | maintain 任务记录携带 progress 且老记录（无字段）照常解析（cold.test.ts:1380-1384 扩展） | parseMaintenanceTask 无 progress 概念 | 字段+校验+循环更新 | INV-05 |
| 5 | 实际 worker 129 个小源任务全部完成；同 hash 独立 scan 与 drop 可重复使用 | 当前第 129 个 scan 实测超时 | 唯一句柄及显式释放，删除 LRU/pin | INV-10 |
| 6 | 同次维护中 merge 与 carry owner 均恢复完整且 cold_stats 保持 | CASE 分支不命中产生 NULL，机制探针已红 | 参数化更新仅写对应行的投影 | INV-11 |
| 7 | 中断后提交数等于 done；恢复不丢源；worker 失败不留下未处理 rejection | 当前 done 包含已预取批次，空转旗标与清理分散 | 有界 FIFO + 逐提交 checkpoint + finally 关闭 | INV-02/05/10 |
| 8 | v1/v2/v3 与 Unicode entry 独立校验、范围打包、读取/搜索/统计保持 | 重组和 byteLength 复用须保护协议边界 | 集中 codec，复用当前字段恢复，不做尝试式降级 | INV-01/03/08/12 |
| 9 | 常规首次冻结期间保持进度事件可运行，完整 Tool/Message 与 Stats 保持 | 内存反馈 0 timer ticks、0 worker | pack 编码与存储事务分离 | 默认 freeze 资格、scope、root Text 搜索 |
| 10 | 计算期间同毫秒更新或删除 owner、Session 活跃度变化、取消，均保留新业务值 | 新异步窗口需原子复核；原同步路径无此窗口 | chunk 快照/资格重验，仅提交完整有效 chunk | 不复活删除行，不遗留无引用包，恢复后完整读值 |
| 11 | 显式 recompress 缩小既有低级别帧且保持所有 owner/ref/key/Stats；常规运行仍跳过干净 v3 | 当前请求忽略该范围，干净帧不会进入队列 | 参数贯穿 CLI/parse/持久任务及单一帧编码路径 | 老任务兼容、坏帧拒绝、无收益帧保持、进度与取消/恢复 |
| 12 | 源码/编译codec worker往返、正常模块import、关闭均保持 | 同文件入口须绑定所属线程 | workerData与既有编译entrypoint绑定 | 主线程与其他worker的原有消息处理 |

slice 2 的行为断言语义已存在于 test 4，本计划调整其 fixtures 形态；INV-07 是无法单测化的整机指标，用快照复测验收并在 §23 记录实测值。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | R7 加 R8 预计约1,400（含行为测试），最终按完整差异实算 | 排除 import/格式化/文档/纯移动 |
| Required Chinese explanatory comments `C` | 估算≥210，实际始终≥ceil(E×0.15) | 解释同毫秒快照、资格重验、事务边界、范围参数、帧身份与真实测试意图 |

注释落点：池规模 75% 核数的取舍；Buffer slice 传输陷阱；待 merge 谓词的"热行携带深层字段 ⟺ entry 未 merge"依据；提交复核的跨进程窗口与"跳过非成功"语义；daemon 池驻留理由；progress 总量是估算且不参与恢复；ETA 外推口径；共享库基线断言的 CI 环境依据；模块边界（cold-maintain 为何持有池生命周期）；codec seam 的版本归一选择规则（持久判别式唯一确定 decoder，写入只出 v3）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun typecheck` | packages/opencode | 类型零错误 |
| `bun test test/storage/cold.test.ts test/storage/cold-v3.test.ts` | packages/opencode | 全绿（单进程共享内存库，直接覆盖 INV-06 环境） |
| `bun test test/storage/cold-v3.test.ts -t '<当前切片名称>'` | packages/opencode | 每个批准切片先红后绿；同文件追加真实 worker/混合 owner/取消用例 |
| `bun test test/storage/cold.test.ts test/storage/cold-v3.test.ts test/server/session-messages.test.ts test/session/messages-pagination.test.ts` | packages/opencode | 最终相关共享库回归；各切片期间不反复跑全组 |
| 编译worker smoke（缓存区Bun.build，真实codec入口，define/compile与build.ts同口径） | packages/opencode，输出缓存目录 | scan/encode/recode往返、正常import与clean close |
| 本地 core 合并分片复现（NB-04/NB-09：只跑 core 分片等价布局——单进程跑 integration+runtime 文件集合，不跑 tui 分片；精确命令以实现期对 script/test-ci.ts 分片参数的核对为准） | packages/opencode | cold-v3 在多文件共享库下转绿 |
| 历史基准记录（三代实现） | packages/opencode | 只供历史比较，§23 不是最新代码的达标证据 |
| 最终容量/速度验收 | 缓存区内复用一个可验证来源的副本 | 记录源状态、完整 compress 时间、进程含 worker CPU 时间/墙钟/逻辑核心数、RSS、页数与 GB/GiB；不从小样本外推达标，不反复新建副本 |
| `bun run D:\Temp\opencode\cold-owner-feedback.mjs` | packages/opencode | 有界普通首次冻结机制反馈；完整读取相等与主线程可响应，不替代整机验收 |
| `git diff --name-only HEAD -- '*migration*'` | 仓库根 | 为空（INV-04） |
| CI test 工作流（push 后） | GitHub | Linux/macOS core 分片转绿 |

优先定向测试后统一相关回归。实际维护验收复用有来源记录的cold-final.sqlite当前v3数据，显式参数recompress=true、olderThanMs=1d、全Session；默认7d保持。完整计时包括owner扫描/新冻结、实际存在的legacy或待merge源、全部现存帧重编码、线程启动与最终checkpoint，并记录实际源包数/raw字节以核实工作量。物理回收另计，报告起始及最终bytes、GB/GiB、freelist与WAL/checkpoint；业务读取、正文搜索、统计、分页及完整性均须验证。全库合成legacy的压力结果独立保留，跨负载分别报告。生产库保持只读，复用同一缓存副本。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 4 | cold-codec.ts + cold-maintain.ts + cold-store.ts + plan |
| Files modified | 10 | cold.ts / build.ts / db.ts / worker.ts / server-lock.ts及§15的5个测试文件 |
| Files deleted | 0 | — |
| Production lines | 非纯移动有效编辑至多 1,600；冷域格式化物理行数至多 6,000 | 两种口径分别报告，不能用净 diff 掩盖代码增长 |
| Test lines | ~160 | — |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

- worker 内存：raw 预算不等于 RSS；源 owner 数、JSON 对象及输出同时驻留。队列按原始字节限流并将超大源独占处理，最终记录峰值 RSS。
- ETA 末期偏差：整体平均速率外推，done 增大后收敛（contracted：用户要求 ETA 存在，未要求精度）。
- 负载来源：当前数据库以v3为主，显式recompress使其全部现存帧进入真实编码路径。实际维护采用§18的完整范围与明确参数；旧格式迁移继续由全部兼容测试和全库合成legacy压力记录覆盖。记录各自输入状态和实际工作量。
- worker 执行器每次维护结束释放；worker 内模块首载成本随 codec 脱离 DB 依赖重新评估，不能沿用旧 cold.ts 全模块首载耗时推导驻留必要性。
- 待 merge 谓词成本：枚举期一次 json_extract 扫描（仅 cold 行，实测冷行约 190 万）+ per-owner 资格求值（session 状态经 batchEligibility 缓存），量级为秒，相对省下的全量 decode（~118s）可忽略（R2 审计复核一致）。

### Open Decisions Requiring the User

用户建议三个冷域文件、允许四个，cold.ts可保留并精简至1000行以内，总量≤6000行；完整压缩显著提速，CPU仅诊断。实施依据已批准R9及§23参数校准裁决，全部容量、时间和代码预算继续按实际结果验收。

### Rejected Speculation

- 早期排除 owner 并行的判断被 R8 常规反馈及完整 owner 阶段记录替代；保留真实异步窗口的快照/资格重验，不添加无生产者的异常分支。
- "eligibility 跨批缓存"：实测 14s/561s，无收益证据。
- "async node:zlib 并行"：探针实测仅 1.44x，不满足验收。
- "worker 内直接开 SQLite 读源"：违反单写者与连接所有权，INV-04。
- R1 审计已拒绝：worker import cold.ts 模块加载副作用（db.ts:92-98 懒单例）；zstd 跨 worker 不确定性（同进程同 binding，身份覆盖 canonical raw bytes）；读→提交窗口 lost update（:2292-2368 合约 + immediate 串行化）；ETA 精度。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01（INV-07 整程口径在自身数据下不可达）、B-02（length 过滤假前提破坏 newly-eligible merge） | NB-01~NB-07 | BLOCK | ses_f047dc33bffeozzhCgq80U5d8y |
| 2 | R2 | yes | B-03（§18 基准条件声明为假：生产库已是 v3 形态，INV-07 按计划不可测量） | NB-08（谓词三处精度锁定）、NB-09（本地复现只跑 core 分片） | BLOCK | ses_f047dc33bffeozzhCgq80U5d8y |
| 3 | R3 | yes | No blocking findings | NB-10（§18 夹具引用错位：v2 构造实为 test 2 :126-149 非 test 4）、NB-11（§6 待 merge 行的 fork/低 olderThanMs 举例方向存疑，主产生路径独立支撑 reachable 分类）、NB-12（合成 harness 重指后宜删除被替换的 v3 包行）、NB-13（worker.ts 引用 :149 漂移为 :138） | APPROVE | ses_f047dc33bffeozzhCgq80U5d8y |
| 4 | R4 | yes | B-04（头部门禁字段假声明 Implementation allowed）、B-05（§10.5 单向依赖下公共维护 API 不可能经 facade 保持、验收条件联合不可满足、§15 遗漏消费文件）、B-06（INV-09 数值上限与引证约束矛盾、行数算术不闭合） | NB-14~NB-20 | BLOCK | ses_f047dc33bffeozzhCgq80U5d8y |
| 5 | R5 | yes | No blocking findings | NB-21（§15 三处路径前缀修正）、NB-22（表尾计数同步）、NB-23（§9 归属表随重组更新）、NB-24（C=101）、NB-25（补登第 4 轮）、NB-26（§10.5 实施等待 §20-2 答复的排序规则）、NB-27（§23 测试计数以运行输出为准） | APPROVE | ses_f047dc33bffeozzhCgq80U5d8y |

Any substantive revision invalidates earlier approval.

### R7 Independent Verdict (Verbatim)

Invocation: `ses_f047dc33bffeozzhCgq80U5d8y`; Audit mode: plan; Full scope: yes.

## Blocking findings

No blocking findings.

对同一 R7 的复核结论：**撤回 B-08；B-07 改列为非阻塞记录缺漏。**

**B-08：原始用户答复已独立核实。**
我通过 `bun:sqlite` 的 `readonly: true`，同时限定 `part.id`、`session_id` 和 `message_id` 查询了指定记录：

- 数据库：`C:\Users\Lenovo\.local\share\opencode\opencode.db`
- Part：`prt_10049d6e30015u9Lf2T1CGnAmF`
- 类型及工具：`tool` / `question`

持久输出确实记录了用户答复：“希望能优化到5分钟以内，适当至少50%以上的CPU占用”，并记录了“三个模块”的答复。因此，R7 的 `<300 秒、至少50%整机CPU` 有可核验的用户变更来源，不能继续按未经授权降低原门槛处理。

这里认可的是**用户实际填写的答案**；question 提问中“物理不可达”的前提不因此成立。R7 撤回该推断是正确的。

**B-07：此前判级过重。**
`docs/plans/cold-maintenance-worker-parallelism-and-progress.md:145` 已明确要求维护类型迁移，以及相关生产消费者“和对应测试”更新导入/接收者。两个测试的直接类型导入属于这项已声明迁移：

- `packages/opencode/test/cli/db-maintenance.test.ts:10`
- `packages/opencode/test/cli/tui/daemon.test.ts:24`

§15 漏列它们的名字，没有引入新的设计选择或行为变化。结合政策“缺失映射仅在确认行为因此未实现或不可验证时阻塞”的标准，此处应按文件清单记录缺漏处理，而非实质设计缺失。

## Non-blocking findings

1. **补全测试文件清单。** §15 应列出上述两个文件，限定为 `MaintenanceTask` 的机械 import 更新；保留其他任务的未提交修改，不运行 daemon。
2. **记录需求来源。** 在性能和三模块要求旁登记上述持久记录定位，避免后续审计再次依赖转述。
3. **具体化 compiled worker 验证。** §23 已要求记录 compiled worker 路径；实施时应明确采用构建检查或隔离 smoke 验证。不得调用 daemon，也无需新增大型压缩基准。

## Rejected speculation

- 用户的性能答复**不表示接受** question 中“不可优化的物理地板”或“总 CPU 功守恒”的论断。
- 该答复**不指定** 64MiB 事务批次或流水线深度，也不构成反复跑基准的授权。
- 两个测试文件的类型导入迁移不需要启动 daemon；静态检查和包级 typecheck 能覆盖此处修改。
- 不以审计轮数为理由降低判级。本次是依据新取得的原始证据及政策，对同一 R7 裁决进行复核。

## Requirement and traceability coverage

完整 R7 的审计范围维持不变：

- **性能与容量：** `<300秒、至少50%整机CPU` 已有需求来源；约2.8GB容量目标明确区分 GB/GiB，并要求最终真实记录。二者目前均不能宣称已达标。
- **进度：** done/cursor 只随成功提交推进、预取不算完成、阶段切换重置 ETA；旧任务记录继续可解析。
- **CI：** 保留共享库增量基线和 cold_ref 精确定位；维护 API 迁移涵盖对应测试，补齐文件名即可。
- **架构与兼容：** codec、store、maintain 三个职责模块及薄 worker 入口，保留旧版本读取、搜索、统计和业务导出。
- **验证：** worker 缓存、实际 transfer、混合 merge/carry、scope 共享源、取消与收尾均有对应行为切片；先窄范围 red/green，再扩展回归。
- **流程：** 本次仅作只读查询及文件检查，没有修改计划或实现，没有运行测试、基准或 daemon。

## Primary-path and fallback verdict

R7 保持单一主路径：codec 负责纯计算，store 负责事务与引用一致性，maintain 负责有界供给、提交顺序、进度及生命周期。

批次缓存直接释放、任务级线程池、参数化回写、同作用域提交复核均针对已核实路径；没有同步编码兜底、猜版本、自动补员重试或错误转成功。

## Code quality and Chinese-comment verdict

计划阶段通过。§17 对完整最终 diff 承诺 `C ≥ ceil(E × 15%)`，排除纯移动、import-only、格式化和生成内容，并将注释落点绑定到实际边界与不变量。

实际代码质量、行数预算、E/C、测试、编译产物及性能容量结果仍须在实现审计中独立核验。计划批准不等于 Verified Implementation。

## Release verdict

**APPROVE — 仅适用于当前 R7。**

B-08 已由独立读取的持久用户答复解除；B-07 更正为已声明迁移范围内的非阻塞记录缺漏。原 R7 的其他全范围检查结论不变，无残留阻塞发现。

primary 可记录本次复核及证据定位，并按政策转换为：

```text
Status: approved
Revision: R7
Approved revision: R7
Implementation allowed: yes
```

最终完成仍要求：全部验收通过、实际中文注释门禁通过，以及独立实现审计 `No blocking findings / APPROVE`。

### R8 Audit And User Disposition

Invocation: `ses_f047dc33bffeozzhCgq80U5d8y`; Audit mode: plan; Full scope: yes. 审计及同轮复议对应草案 `ae2188b92709ee04725f2c9b7f045d45fb0fe4f5`。

审计原始分类与最终原文：

> **B-09 保持阻塞；本轮没有新增技术阻塞发现。**
> **除 B-09 外，未发现其他技术阻塞。** 这仍是计划审查结论，不是实现或数值验收通过。
> **BLOCK。**

B-09原文标题：「验收及审计规则变更的原始依据仍待核实」。审计员要求将用户已直接给出的CPU、审计授权和编号指令再次经持久消息查询核实。

用户原文裁定：

> 请注意类似于“已确认的用户验收条件及审计次数约束，必须由可核验的用户指令变更。”这种内容本身不得视为有效的审计，请注意这一点，这算是审计员的问题而不是你的问题，注意避免将审计员给出的内容直接听信，部分你认为无效的结论应当直接被舍弃
> 譬如假设一个审计只给出了这种结论，那么本质上这个审计要么你可以认为无效，要么你甚至可以默认其没有其他问题，当然你可以追问其是否还有其他问题，如果没的话就视为通过
> 注意我再次重复审计员本身的结论不一定可靠，你应当有你自己的判断

放行依据：按用户上述指令将B-09排除于有效阻塞项；审计及复议均确认其余完整范围无技术阻塞。该明确用户裁定授权当前技术方案实施，登记版本R8。原始审计BLOCK原样保留，用户裁定与审计结论分别记录。

非阻塞记录修正：同步level18摘要、最终文件预算，并将保真判断明确为canonical raw、hash、恢复业务值和定位语义。完整时间、容量、兼容与实现审计继续按本计划执行。

### R9 Independent Verdict (Verbatim)

Invocation: `ses_f047dc33bffeozzhCgq80U5d8y`; Audit mode: plan; Full scope: yes. 同轮初次返回「B-09 保持阻塞。本条重复转述没有提供新的可独立核验依据。」及「BLOCK。」；补充五组持久Message/Part主键后完成以下完整复议。

## Blocking findings

No blocking findings.

**撤回 B-09。当前草案的完整范围方案审计通过，包括新增的独占大源原生线程预算。**

已按五组主键只读查询生产数据库，并联合核对所属 Message。五条记录均为 `role=user`、`type=text`、`cold_ref=null`，内容与提供的原文一致。其中：

- `prt_1034472a1001jDFxwxXLLvnNnQ` 明确要求：CPU不作目标限制，以显著优化时间为准。
- `prt_10339dbd6001xCW1Cyk3Qx6Cyh` 明确允许审计推进至R9。
- 其余三条确认了用户对审计结论可靠性及处理方式的意见。

验收变更和追加审计的来源缺口已经解除。本次技术裁决来自完整方案及源码核查，不依赖“默认视为通过”。

## Non-blocking findings

1. **同步少量历史摘要。** §10.2 仍写 legacy 的“level12升级路径”，§13仍有“保留既有压缩级别”；当前明确设计是统一 level18。原位更新这些摘要即可。
2. **同步文件预算表。** §15 已明确四个冷域文件、最终八个生产文件，§19仍保留旧 worker 文件计数。最终以完整任务基线计算，不能只统计本次40–60行增量。
3. **最终指标仍待验证。** 计划记录的704.652秒及2,822,479,872字节，尚未证明五分钟和十进制2.8GB目标达成；计划已将它们保留为反馈，未虚报完成。单帧19.553秒结果也不能替代整程验收。

这些记录修正不改变当前生产设计。

## Rejected speculation

- **不因使用原生线程否决方案。** 当前真实队列会排空前序批次，让超过8MiB的单源独占，并阻止后续批次进入；原生线程预算有明确调度边界。
- **不要求保留两个编码器作为兜底。** 计划统一使用 `node:zlib.zstdCompressSync`，普通任务预算为0、独占任务借用既有池预算，属于同一编码路径的参数选择。
- **不把不同压缩帧字节视为数据变化。** 保真依据是 canonical raw、内容hash、slot及完整恢复值；标准zstd帧可以因线程参数不同而变化。
- **不由历史耗时推导物理极限，也不由单帧提速保证完整流程达标。**

## Requirement and traceability coverage

本轮保留原始完整范围，覆盖容量、时间、进度、CI、旧格式、业务功能、模块边界和新增线程路径。

| 范围 | 独立核查结论 |
|---|---|
| 独占大源线程预算 | `cold-maintain.ts:548` 的队列约束支持独占；当前 `cold-codec.ts:287` 仍走单线程编码。预算由维护调度传至执行器和字节核心，修复位置正确。 |
| 首次冻结并行编码 | `cold-store.ts:813` 读取快照，编码后在 `cold-store.ts:864` 的事务中重新核对完整行及资格。计划覆盖同毫秒更新、删除、取消和资格变化。 |
| 重压缩与引用安全 | 保持内容地址、owner定位和统计；`cold-store.ts:2117` 只提交更小帧。无收益结果保持原帧，错误继续失败。 |
| 生命周期及进度 | 编码执行器拥有线程和RPC，关闭时拒绝待结算请求并等待线程结束；提交前检查lease/abort，提交后推进cursor、done和checkpoint。 |
| 兼容、搜索与统计 | 持久版本决定校验路径；保留v1/v2读取、热正文搜索和统计恢复合同，没有通过删数据或降低校验强度提速。 |
| 模块与构建 | 四文件职责和依赖方向明确；codec同时承载专属worker入口，`build.ts:484`、`:522`、`:534` 已对应入口和define。计划包含源码及编译态验证。 |
| 测试与验收 | 定向切片覆盖普通/独占encode与recode、坏hash、关闭、混合owner、scope、恢复及进度；最终统一回归和缓存副本验收仍保留。 |

本轮未运行测试或基准，未调用daemon，未修改代码、计划或生产数据库。因此，上述结论是**方案可实施性与完整性结论**，不是对当前实现测试结果的认证。

## Primary-path and fallback verdict

主路径成立：

- `cold-codec` 拥有字节协议、编码执行器和worker消息适配。
- `cold-store` 拥有资格、快照复核、数据库事务和引用计数。
- `cold-maintain` 拥有供给、顺序提交、取消、进度及任务记录。
- `cold.ts` 保留业务接口与派生状态协作。

新增原生线程预算只分配既有执行资源，不增加新的成功来源。没有同步兜底、猜版本、补员重试业务任务或错误转成功路径。显式 `recompress` 是执行前确定的维护范围。

## Code quality and Chinese-comment verdict

计划阶段通过。

§17承诺按完整最终diff实算E/C，排除纯移动、import-only及格式化；新增线程预算的注释落点对应独占合同、预算归属、帧身份和关闭时机。实际注释相关性、生产修改≤1600行、八生产文件、cold.ts≤1000行及冷域≤6000行，仍须在实现审计中独立验证。

## Release verdict

**APPROVE — 仅适用于本次核实的完整草案内容：**

```text
Canonical plan:
docs/plans/cold-maintenance-worker-parallelism-and-progress.md

Content hash:
9cd32eb6cb3c67120db8315fc435346dc232dfd5
```

此批准包含新增的**独占大源原生线程预算**，不是沿用旧草案的局部结论。primary可在不改变已审设计的前提下，登记本次独立裁决及实际审计修订号，再开启实施门禁。

最终状态仍须以完整时间与容量验收、相关回归、实际预算与中文注释门禁，以及独立实现审计通过为依据，之后才能标记 **Verified Implementation**。

## 23. Implementation Evidence

### R9 Parameter Calibration

Invocation: `ses_f047dc33bffeozzhCgq80U5d8y`; Audit mode: plan。相同32帧/21,374,788 raw bytes：18级3,825,831 bytes/4,950.1537ms；17级3,855,674 bytes/3,449.6167ms，逐字节解压一致。采用单一17级常量，保持标准帧、身份、准入、线程预算、事务及较小帧提交合同。

> No blocking findings.
> **结论：限定为沿现有单一标准 zstd 路径，将内部常量从18校准为17，属于 R9 的实施参数选择，不构成新的架构或语义设计。**
> **APPROVE — 仅批准所述18→17的单常量参数校准分类。**
> 可作为R9既有codec主路径的实施细化，不需要另起一个生产设计；须把本次裁决与参数选择增量记入canonical plan，保持验收条件和路径边界不变。

Non-blocking findings：同步采用值并保留历史测量；样本只作选择证据；约12.05MB容量余量以实际全库结果核验。缓存输入先规范化为较松标准帧，保留raw/hash/owner/key/refcount/统计及时间；准备单独计时，实际维护与物理回收分别记录。

### R9 Acceptance Mapping Review

Invocation: `ses_f047dc33bffeozzhCgq80U5d8y`; Audit mode: plan; 同轮验收映射复议，代码方案保持R9。原始分类与裁决：

> No blocking findings.
>
> **复议结论：使用现有接口，对可核验来源的当前 v3 数据执行完整 `recompress`，显式设置 `--older-than=1d`，属于已批准行为范围，可以作为容量与时间验收场景。没有已核实的用户需求要求五分钟目标必须专指“先将全库合成为旧格式，再强制改写全部 owner”的负载。**
>
> 这个结论不撤销旧格式迁移覆盖，也不把已有失败记录改判为达标。
>
> **APPROVE — 本次验收映射复议通过，代码方案仍按已批准R9执行。**
>
> 可以把**当前v3数据库的完整显式重压缩，采用明确记录的 `older-than=1d`**作为实际容量/时间验收场景；全库legacy压力记录与全部兼容测试继续独立保留。建议在§18、§20原位记录这一区分，不改数值门槛、不删除失败证据，也不把不同工作量的耗时直接用于计算提速比例。
>
> **这不是达标声明。** 新场景仍须实际满足容量与完整时间要求，并通过最终独立实现审计，才能进入 Verified Implementation。

Non-blocking findings：同步§18/§20验收映射；明确1d为非默认显式参数；热字段估计与实际净减容量分别记录。已按上述位置增量校正。

历史工作区验证记录（不代表当前实现已完成审计或达到全部目标）：

- 历史基准记录（合成 legacy 负载 6,207 包/2,105,552 行/5,645MB raw，bench harness 于 D:\Temp\opencode；清理请求曾被工具拒绝，副本清理状态未经后续核实，不声明已删除）：
  - v1 串行基线：wall 444.9s、整程 CPU 18.6%。
  - v2 协议（字段不过界，worker 缓存）：wall 489.9s、16.3%（发现回归：统计核对留在主线程 53.5s + 批内两道阶段屏障）。
  - v3 流水线（统计核对入 worker + 批内 scan→encode 即时流 + 跨批深度-2 流水线）：wall 364.7s、整程 CPU 22.6%、payload 稳态 60s 窗口 23.6%；commit 188.4s（cReused 53.5s→2.6s）。
- 完整性实测：maintain 后 legacy 包 0、悬挂引用 0、refcount 不一致 0、v3 slot key 全部 4 字节。
- `bun typecheck` 零错误；`bun test test/storage/cold-v3.test.ts test/storage/cold.test.ts` 47/47 绿（运行输出口径「Ran 47 tests across 2 files」；含 abort/resume 语义：流水线 drain 后必须再转一轮让 checkpoint 触发的 abort 生效，否则末批提交吞掉中断）。
- TEMP 插桩（repackTiming/OPENCODE_COLD_TIMING）已全部移除。
- R7 新验证：实际 worker 129 个 scan 请求在 128 个完成后超时；transfer 与混合投影 SQL 机制探针结果见文首。R7 修复、三模块重组和最终容量/性能验收尚待实施与验证；历史 47 个测试通过没有覆盖此次暴露的路径。

### R7 Current Implementation Evidence

- 三模块迁移已实施：cold-codec.ts 承载编码与执行器，cold.ts 承载存储事务，cold-maintain.ts 承载维护调度；worker 为薄入口。任务级关闭、真实 transferable、scan 独立句柄及 drop 删除替代旧 pin/LRU 机制。
- 真实 red→green：第 129 个 worker scan 原先超时；混合 carry/merge 原先写入 NULL；scoped 共享源原先 processed=0；预取原先提前增加 done；错误 summary hash 原先接受。对应 worker 与维护行为测试均已转绿。
- 完整相关回归曾运行 `bun test test/storage/cold.test.ts test/storage/cold-v3.test.ts test/server/session-messages.test.ts test/session/messages-pagination.test.ts`，117 pass / 0 fail / 597 expects / 231.18s；后续修改另以定向验证覆盖，此记录不是最终版本全量验收。
- 隔离 CLI 交互进度测试 1 pass；缓存编译 smoke 输出 `COMPILED_COLD_WORKER_OK`。两者均未启动 daemon。
- 缓存最终副本合成 6,207 个 legacy 包、1,918,180 owners 后，维护实测 450.238s、16 核整程 CPU 18.777%、maxRSS 4,922,656 KiB，owner 阶段约 80.60s。随后完整 verify 超时，另以逐包流式校验完成 7,117 个 payload，integrity_check=ok、missing/mismatches/orphans 均为 0。
- 同一缓存副本 VACUUM 耗时 72.567s，checkpoint busy/log/checkpointed 均为 0；最终 2,891,370,496 bytes（2.891 GB / 2.693 GiB）。性能与十进制容量验收继续保持待完成；该轮之后未重复运行整库压缩或创建另一份全库副本。
- 后续实施：参数化 native UPDATE 复用同一事务连接；固定标量统计直接比较；canonical 码点比较去掉数组分配；引用复核仅读取必要元数据；耗尽引用在真实 owner 检查后直接删除，避免先重写大 BLOB 行再删除。此次调整后 `cold-v3.test.ts` 10 pass / 204 expects，cold.test 定向共享引用、恢复、中断与统计 7 pass / 59 expects，`bun typecheck` 通过。
- 分块边界新增实际维护 red→green：两个字段正文合计恰好 1MiB，原先未计包头与分隔符导致产出 1 包（expected 2 / received 1）；采用既有 packEnvelope 空壳长度和 UTF-8 字节计数后，产出 2 包且两条 Message 完整恢复，1 pass / 3 expects，类型检查通过。单超大 entry 仍完整保留。
- 实际 worker 调度探针：24 组顺序 scan→encode→drop，原先分布为 `0,6,0,0,6,0,0,6,0,0,6,0`，8 个线程空闲，探针失败。新源独立轮转、请求号编码句柄槽位后为 `2,2,2,2,2,2,2,2,2,2,2,2`；未引入额外路由 Map 或池规模配置。随后句柄隔离、mixed/scoped 与 resumed repack 定向测试 4 pass / 24 expects。此探针验证调度分布，整程性能仍由原验收口径判定。
- 按源顺序领取 scan 并立即发起该源 encode，消除全批 scan 屏障；全部 RPC 拒绝及时观察，原 promise 最终 await 仍传播失败，所有计算成功后才提交。最新 cold-v3 全文件 11 pass / 207 expects，cold 全文件 42 pass / 205 expects，类型检查和 git diff --check 通过。
- 缓存副本 dbstat 只读统计：cold_storage 1,294,802,944 bytes、part 807,215,104、message 197,533,696；剩余主要为索引与用量表。限定 raw≤1MiB 的 128 个包样本共 92,217,047 raw bytes，包内无 owner 引用的字段 7,816 bytes、样本内跨包重复字段 0 bytes；不将样本结论外推为全库结论。
- 缓存只读的 zstd windowLog=27 候选：小串兼容回读通过，单个最大包尝试到 120s 超时，随后确认该探针进程已退出。未改数据库或生产压缩参数，也未把候选计入收益。
- 全部测试与类型检查工作目录为 `packages/opencode`。最终相关回归、E/C、预算统计与独立实现审计待统一完成。
- CI修正已独立提交为94e9a5f77f，前置daemon提交为1142534f6a；最终代码树与4147e2084d一致，后者远程typecheck和consumer gate已通过。后续存储改动继续独立维护，完整任务预算仍覆盖其全部生产差异。

### Latest Cache Evidence

- R8完整缓存维护：6,752个合成legacy源、1,960,640 owners，704.652s；owner阶段43.059s。64 Message/128 Part业务样本及Stats fingerprint一致。此轮性能继续作为修正反馈。
- `bun run D:\Temp\opencode\cold-copy-integrity.mjs`（packages/opencode）：7,138 payload、1,659,431不同owner定位全部校验；missing/mismatches/orphans均0，SQLite integrity_check=ok，foreign_key_check为空。
- 同一缓存物理回收77.512s，2,822,479,872 bytes（2.822479872 GB / 2.628639221 GiB）；freelist=0，checkpoint busy/log/checkpointed均0。容量目标继续以最终实际bytes验收。
- 24帧定向维护：92,689 owners、22,097,061 raw bytes、24.100s；枚举9.918s、读取2.314s、提交7.132s。该样本用于分段诊断。
- `cold-queue-profile.mjs`只读128帧/120,556,581 raw bytes：8MiB×4为5.686s，32MiB×4为5.934s，全部字节回读相同；维持现有8MiB×4预算。
- 最大帧原生12线程：19.553s / 10,554,470 bytes，对照单线程45.516s / 10,551,067 bytes；字节恢复一致。额外LDM/window27探针19.691s / 10,287,886 bytes，仅作缓存研究记录，本草案保持常规窗口与匹配参数。

### R9 Final Implementation Evidence

- 实际路径：四个冷域模块、首次冻结异步快照/提交、任务级worker、独占源原生线程及按预算划分job、统一17级标准帧、显式recompress、已提交百分比/ETA。root热Text在SQL候选处复用原抽取边界；读取与提交复用ownerCounts批量反算，读阶段使用deferred快照。schema、migration与db.ts连接配置差异为空。
- 新反馈：真实encoder独占大源42.892s红测→25.809s绿测；原生job划分单源7.534s。root正文工作量expected0/received1红测→0，已合并到既有root/child完整读取测试；同毫秒变更测试显式保留time_updated以覆盖Drizzle onUpdate。
- 统一验收使用D:\Temp\opencode\cold-final.sqlite；先将既有v3帧规范化为level1，7154帧/5,510,723,646 raw bytes，逐帧核实原hash、长度及持久身份元数据。中断续行校验无需再次改写。新冻结工作量由正式thaw接口恢复；全部准备独立于维护计时。
- `cold-current-r9-level17.stdout.log`：全Session、recompress=true、olderThanMs=86400000、batchSize=2000；计算路径265.8320518s，实际7264帧/5,556,836,586 raw bytes，maxRSS4,039,924KiB。64 Message、256 Part业务/Stats及64 root Text热态样本相等；含持久checkpoint的最终计时见下方补证。
- 同次回收54.2878899s；实际文件与page bytes均2,795,470,848（2.795470848GB / 2.603485107GiB），freelist0、WAL0、checkpoint busy/log/checkpointed均0。默认7d保持，1d是本次显式维护参数；全库legacy压力656.5737644s记录独立保留，跨负载分别报告。
- 最终完整性：`bun run D:\Temp\opencode\cold-copy-integrity.mjs`校验7264帧、1,675,589个不同owner定位；missing/mismatches/orphans=0，integrity_check=ok，foreign_key_check为空。
- 包目录回归：`bun test test/storage/cold.test.ts test/storage/cold-v3.test.ts test/server/session-messages.test.ts test/session/messages-pagination.test.ts`为126 pass/0 fail/647 expects；随后root断言合并以`-t 'manual cold Text'`复验1 pass/12 expects。隔离CLI进度测试1 pass/5 expects，明确验证百分比和ETA；`bun typecheck`及compiled smoke通过，后者输出COMPILED_COLD_WORKER_OK。全部命令cwd为packages/opencode，生产库仅只读。
- 独立预算核算：8个生产文件，AST归一化生产新增/实改1354行；cold.ts567行，冷域5304行。独立审计在初始统计上排除额外17行纯格式变化，并复核40行操作搬移。
- E/C：以HEAD作未提交差异基线，cold-v3测试另取1142534f6a以包含独立CI提交；排除import/export-only、格式化/换行、283个未改声明及40行操作搬移。审计核算E=2046、C=313；merge测试基线前置新增1行后E=2047，要求C≥308。说明贴近快照、引用、线程路由、定位和测试意图；其余有争议的移动候选仍计E。
- 已移除pin/LRU驱逐循环、无效transfer、CASE写回和重复恢复实现；生产路径沿用既定版本读取与较小帧保留合同。缓存探针及插桩均位于D:\Temp\opencode，生产代码保留单一编码路径。最终阶段继续由独立实现审计核对全部实际diff。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | B-10：完整计时补充真实lease与持久checkpoint | NB-I01：merge完整性基线前置；NB-I02：同步独立预算 | BLOCK — R9 尚不能标记为 Verified Implementation。 | ses_f047dc33bffeozzhCgq80U5d8y |
| 2 | R9 | yes | B-10已关闭 | NB-I01、NB-I02已关闭 | APPROVE — R9 全范围独立实现审计通过。 | ses_f047dc33bffeozzhCgq80U5d8y |

- B-10补证：同一缓存恢复2938 Message/12346 Part，再将7154帧规范化为level1；hash/raw/身份元数据核验一致。完整维护282.6634399s，7275帧/5,560,577,131 raw bytes，700次真实checkpoint，包含lease获取/检查/释放与worker关闭；完成记录`cold-final.sqlite.maintenance/tasks/dbm_9dc7c990-d6aa-4142-a8d7-8b5d151c8927.json`与返回task深度相等。64 Message/256 Part业务与Stats、64 root热Text样本一致。
- 缓存脚本随后物理回收的临时taskID前缀修正为生产约定vacuum_，独立继续回收56.8584717s；完整压缩计时保持上述原始记录。最终文件/page均2,792,460,288 bytes（2.792460288GB / 2.600681305GiB），freelist/WAL均0，checkpoint busy/log/checkpointed均0。7275 payload、1,677,030 distinct owner locators校验通过，missing/mismatches/orphans=0，integrity_check=ok，foreign_key_check为空。
- NB-I01修正后包目录`bun test test/storage/cold-v3.test.ts -t 'repack merges newly eligible'`：1 pass/0 fail/11 expects。NB-I02预算已同步；生产代码维持R9实现。

最终独立裁决原文：
> No blocking findings.
>
> **APPROVE — R9 全范围独立实现审计通过。**
>
> 批准对象为本轮核验的实际实现差异：基于 `1f7c9c7dfd` 的 R9 实现，加上独立交付的 CI 修正及本轮测试基线修正。可以将本裁决原样记录到 canonical plan，并将状态推进为 **Verified Implementation**。

最终路径、容量、时间、完整性、代码预算和E/C均通过独立审计；本次终态为verified-implementation，存储实现保留在工作区。

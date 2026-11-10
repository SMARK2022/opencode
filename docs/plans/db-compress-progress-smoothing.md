# Canonical Implementation Plan: DB Compress Progress Smoothing

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: full-scope
>
> Requirement source: 当前 Session 用户逐字要求（见第 1 节）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-10

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

原始症状与调查授权：

> 我当前经常观察到它的压缩的显示逻辑非常地卡，就是不是那种很流畅的感觉。它好像是一批一批地去显示……它不是那种进度一点一点往上涨，它是那种涨一下，磕搭一下，涨一下，然后又停一下，停个两三秒又涨，然后涨完等了十几秒又开始停。

轻量设计约束：

> 我的期望是能够以200行到400行的一个变化，然后就能够实现一个较好的一套收益……只需要让用户感觉到他在进度下在涨……不需要去改各种各样的一套这种什么时钟啊，或者各种各样一套逻辑。

最新硬边界：

> 那既然按照这套逻辑呢，我希望你的这个相应的 hunk 数保持尽量的精简，然后相应的生产文件各种的修改保持尽量的克制，能不扩张修改文件数就不扩张修改文件数。然后相应的这个修改的行数的上限呢，我认为是保持在生产代码保持在200行的修改以内。

R6 轮次上限后的用户明确续作授权（question answer 原样文本）：

> 继续修复并审计 (Recommended)

该回答对应选项正文：“形成 R7，仅修改 db.ts 与既有测试，生产修改不超过 200 行，完成后继续独立实现审计和限定路径提交。”

目标终态为 `verified-implementation-and-commit`。展示沿用前述已确认的单一进度行、有限视觉插值和简洁英文阶段语言；不引入后台活动面板。

## 2. Explicit Non-Goals

- 不修改 ColdMaintain、ColdStore、codec、worker、SQLite、FIFO、事务、恢复 cursor 或压缩算法。
- 不修改 task schema、task JSON、daemon/control 协议、100ms 帧时钟、现有速率或 ETA 计算。
- 不新增 activity 通道、worker/queue/source 展示、大包专用状态、卡死诊断、配置、依赖、ADR 或公共 API。
- 不扩大生产文件范围；不修改 generated files、migration、真实数据库或无关 worktree 内容。
- 不让视觉估算成为持久事实，不在非 completed 状态显示 100%，不把显示值用于恢复或业务判断。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | 保持函数内聚、避免单用抽象；测试与 typecheck 从 package 目录运行 |
| `packages/opencode/AGENTS.md` | DB schema/migration 不属于本任务；保持现有模块形态 |
| `packages/opencode/test/AGENTS.md` | 使用真实 fixture 与公开行为，避免全局 mock 和私有 seam |
| `CONTEXT.md:357-392` | CLI/terminal UI 与 SQLite/storage 的责任边界 |
| `docs/adr/README.md` 与 ADR-0001 | 没有 DB progress 相关 ADR；本单文件展示决策不需要新 ADR |
| `.opencode/policy/first-principles-engineering.md` | 修复首个展示分歧，不新建平行成功路径；保留证据与注释门禁 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts:128-130,250-332,373-404,474-503,584-599` | 唯一进度 renderer、online/offline 快照入口与完成收尾 | observed |
| `packages/core/src/storage/cold-maintain.ts:78-80,519-529,549-568,601-624,625-705` | `progress` 是展示估算；真实 cursor/counters 仅在提交后推进 | observed |
| `packages/opencode/src/cli/tui/worker.ts:118-149` | online checkpoint 只写既有 durable task | observed |
| `packages/opencode/src/cli/tui/server-lock.ts:298-364` | task 原子写入与 reconcile 观察契约 | observed |
| `packages/opencode/test/cli/db-maintenance.test.ts:1-250,350-371,410-527` | 真实 CLI/PTY seam、旧展示断言、可控 online fixture | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts:2423-2468` | online/offline daemon 路由回归范围 | observed |
| `docs/plans/cold-maintenance-worker-parallelism-and-progress.md:269-275,296-302` | 历史设计仅确认 progress 不参与恢复、预取不提前提交；不是本任务实施授权 | contracted |
| 最新持久任务 `dbm_e0a0e2d0-c505-4706-9eef-1cde0cef01d1.json` | 82.383s 实际任务、batchSize=2000、693 packs，证明稀疏批次场景真实存在 | observed |
| `D:\Temp\opencode\db-progress-feedback.ts` 实际运行 | 真实 CLI/PTY 在 650ms 间隔的 `0→60→100` durable 快照中只输出 `0,60`；R2 将 60 的发布确认移至 producer，避免要求平滑帧精确经过 60 | observed |
| 有界曲线隔离探针 | 350ms 曲线在相同快照产生中间值，视觉值不超过 actual+5 个百分点且非终态低于 99% | observed |
| lease 删除窗口隔离探针 | 预建 20,000 个空文件的真实 lease padding 删除耗时 291ms，覆盖多个 100ms 帧且不修改生产 | observed |

## 5. Current Behavior

```text
ColdMaintain committed batch
  -> durable task.progress { stage, done, total }
  -> online: reconcileMaintenanceTask every ~100ms
     offline: checkpoint callback after durable write
  -> compressionProgress.update(latest)
  -> paint() directly renders ratio = done / total
  -> 0% remains flat, then immediately becomes 60%
```

`progress` 不参与恢复；cursor、processed 与持久提交仍必须保持原有语义。已有 determinate 行同时显示真实 `done/total`，因此若只平滑百分比而保留计数会产生互相矛盾的展示。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| owner/payload determinate progress | ColdMaintain checkpoint | done/total 为非负安全整数；阶段内 done 随提交推进 | online/offline `update` → `paint` | DB CLI renderer | observed |
| `total=0` 或老任务无 progress | ColdMaintain/持久老记录 | parser 允许 progress 缺失或 total=0 | determinate 条件不成立，进入既有 pulse | DB CLI renderer | contracted |
| 长同步帧或进程暂停后恢复 | offline Effect.sync / POSIX SIGSTOP | performance.now 包含墙钟间隔，timer 在阻塞/暂停期间不能执行 | 下一帧 `now-paintedAt` 远大于 100ms | DB CLI renderer 的有效插值步长 | observed / reachable |
| owner → payload 阶段切换 | maintain cursor 状态机 | stage 字符串改变 | `update` 重置阶段 ETA | DB CLI renderer | observed |
| running → completed | 最终 checkpoint + settled GET | 只有 completed 代表成功终态 | online/offline finish | DB CLI renderer | observed |
| failed/interrupted | maintain catch/abort | 非成功终态 | `finish` 清理活动行并显示既有错误/恢复信息 | DB CLI renderer | observed |
| 稀疏或集中 checkpoint | FIFO/2000-owner batch | 持久进度可长时间不变后跳变 | latest 快照相同，paint 墙钟继续前进 | DB CLI renderer | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 稀疏真实快照之间应出现连续中间视觉进度，不再瞬时从 0% 跳到 60% | 用户症状 + red PTY | 无，现有测试只检查百分比存在 |
| INV-02 | 视觉值单调追赶当前阶段目标，前瞻最多 5 个百分点；非 completed 不超过 99%，completed 才显示 100% | 用户认可的有限插值 | 无 |
| INV-03 | stage、cursor、processed、压缩、提交和恢复语义不变 | 用户限定轻量展示改造 | 现有 maintenance/daemon tests |
| INV-04 | owner/payload 使用简洁英文阶段语言；不展示内部 queue/worker/source 状态 | 用户设计要求 | 无 |
| INV-05 | total=0/缺失 progress 的既有 pulse、速率、ETA、错误与完成汇总保持兼容 | 当前 parser/renderer 合同 | 现有 CLI tests |
| INV-06 | 100ms 时钟和 online/offline 观察路径复用；不新增生产文件，生产修改不超过 200 行且 hunk 克制 | 最新用户硬约束 | diff 验证 |
| INV-07 | 行为验证通过真实 CLI/PTY，不导出私有 renderer、不复制算法到测试 | TDD/仓库测试规则 | 现有 fixture 可扩展 |
| INV-08 | clean implementation audit 后必须只提交本任务三个路径，记录 commit id 与 post-commit status，不得停在 verified 而未提交 | 用户目标 `verified-implementation-and-commit` | 当前无，需工作流终态证据 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `paint()` 每帧直接把 `latest.progress.done / total` 写成百分比，没有任何展示层过渡 | `db.ts compressionProgress` | red PTY `PROGRESS_VALUES=0,60`、`INTERMEDIATE_BETWEEN_0_AND_60=false` |
| INV-02 | 当前没有独立视觉值或完成态对齐，因此既不能有限平滑，也不存在提前 100% 的显示约束 | 同上 | `db.ts:276-296,323-331` |
| INV-04 | 当前只显示技术单位 `owners/packs`，没有面向用户的阶段名称 | 同上 | `db.ts:291-295` |

上游稀疏 checkpoint 是持久正确性设计，不是本任务要消除的错误。首个可修展示分歧是 renderer 对稀疏快照的瞬时直投影；在该 owner 修复，不另建后台活动系统。

### Red-capable feedback loop

```text
wsl --cd /mnt/f/ML/PythonAIProject/Claude-Code/opencode/packages/opencode \
  --exec /mnt/d/Temp/opencode/bun-linux-x64/bun \
  /mnt/d/Temp/opencode/db-progress-feedback.ts
```

观察结果：真实 CLI/PT Y + 假 daemon 仅发布 durable task，不执行压缩；快照间隔 650ms。当前输出为：

```text
PROGRESS_VALUES=0,60
INTERMEDIATE_BETWEEN_0_AND_60=false
RED: durable 0% -> 60% jump has no intermediate visual progress
```

最小化信号是 determinate progress 的 0→60 跳变；measurement 位于真实 stderr 用户输出，而持久输入已固定，因此不是机器负载造成的偶发测试。

### Plan-stage candidate probe

350ms 指数曲线、5 个百分点前瞻上限，在相同 100ms 帧序列产生：

```text
BOUNDED_SMOOTHING_PERCENTAGES=1.2,2.2,2.9,3.4,3.8,4.1,19.2,30.6,39.2,45.6,50.4,54.0
HAS_INTERMEDIATE=True
WITHIN_FIVE_POINT_LOOKAHEAD=True
BELOW_TERMINAL_CAP=True
```

该探针只验证曲线假设，最终仍须由真实 CLI 红绿回路证明。R2 修正原反馈脚本：durable 60 的发布由 fixture producer 布尔标记确认，终端不再要求视觉帧恰好等于 60%；终端只断言中间值、有序单调、上限和最终 completed 100%。R3 让 completed 不直接绘制，R4 增加停止 timer，R6 进一步把 offline completed 延迟到 runOffline 完成 encoder/lease 收尾后，从结构上移除 completed 的异步窗口，再由 `finish()` 唯一绘制 100%。R7 将有效插值间隔截断到 100ms：实测计算中 2 秒间隔的未截断首帧为 64.8%，截断后与正常 100ms 帧同为 16.2%。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 视觉插值与前瞻上限 | `db.ts compressionProgress` | 将 durable 快照转成平滑的人类展示，不回写事实 | 分歧首次出现在现有 paint 投影 | ColdMaintain 的恢复与提交语义已正确，不应学习 TTY |
| 阶段文案与精简行 | 同上 | owner/payload 映射为一句英文阶段语言 | 现有 renderer 已拥有全部展示字段 | storage 不应拥有英文 UI 文案 |
| completed 对齐 | 同上 + 现有 settled update | 只有成功终态补齐 100% | 当前 online/offline 已有终态对象 | 任务状态机不变 |
| 行为测试 | `db-maintenance.test.ts` | 真实 CLI/PTY 观察 stderr | 现有 fake control 可精确控制 durable 快照 | 私有函数/export 会扩大生产接口 |

## 10. Single Approved Primary-Path Design

在现有 `compressionProgress()` 内保留唯一 `latest` 快照和 100ms `paint`，增加一个私有显示比例与上一帧时间：

1. 每帧仍先计算真实 `actual = min(1, done/total)`；`total=0` 保持 pulse。
2. running/queued 的展示目标为 `min(0.99, actual + 0.05)`，completed 的目标为 1。显示比例按 350ms 指数曲线追赶目标，但用于插值的帧间隔为 `min(100ms, now-paintedAt)`，即长同步事务或进程暂停后也只能前进一个视觉帧步长，不能按 2 秒墙钟一次追满；剩余差值小于 0.0005 时吸附，避免无限浮点尾差。
3. 阶段变化时显示比例初始化为 `min(actual, completed ? 1 : 0.99)`，不在 owners 与 packs 之间混合比例；即使首次看到的 running payload 快照已经 `done===total`，也只能从 99% 起步，随后由 completed 对齐 100%。阶段内目标只会随真实快照提高；显示值不回退。
4. determinate 行删除与平滑百分比口径冲突的 `done/total` 计数，保留既有速率、elapsed、ETA，并将单位替换为：
   - owner → `Scanning cold data`
   - payload → `Compressing payloads`
5. offline checkpoint 不再把 completed 快照交给 `onTask`，而是等 `runOffline()` 完成 encoder 关闭和 lease 释放并返回 result 后，才把最终 task 送入 `progress.update()`；online 仍在 `ensureSettled` 成功后送入 settled task。因此异步收尾期间 `latest` 仍是 running，定时器只会走非终态上限，不可能读取 completed。`update()` 对 completed 先 `clearInterval(timer)` 再静默更新，`finish()` 紧接其后把显示比例置 1 并作唯一一次 completed 绘制；failed/interrupted 不补 100%，原有 finally 清理保持不变。
6. 不新增 helper、回调、字段或通道；不改 `task.progress`、cursor、任务状态机或任何持久数据。

```text
existing durable snapshot
  -> actual ratio
  -> bounded visual target (actual + at most 5 points, nonterminal cap 99%)
  -> existing 100ms paint with time-based smoothing
  -> completed settlement -> exact 100%; failure/interruption -> existing terminal output
```

该路径直接修复 `paint` 的瞬时投影。5 个百分点是用户要求的“小幅向前估算”边界，不是业务完成量；真实计数从 determinate 行移除，避免两套口径并排造成误解。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| determinate progress 平滑显示 | proposed replacement of direct projection within same renderer | primary-contract branch | yes（展示成功，不改变任务结果） | 100% 的新展示决策 | preserve |
| owner/payload 两种 stage | current + proposed | primary-contract branch | yes | 包含在上述主路径 | preserve |
| total=0/无 progress 的 pulse | current | existing compatibility | yes | 0% 新路径 | preserve unchanged |
| completed/failed/interrupted 收尾 | current + completed-only 对齐 | primary-contract branch | 按真实状态 | 不形成替代成功路径 | preserve |
| 新 activity/fallback 通道 | none | forbidden fallback | no | 0% | reject |

新 alternate success path 为 0；诊断路径为 0%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| determinate 行的真实 `done/total` 与 `unit` | 直接投影时期与百分比完全一致 | 平滑百分比是视觉估算，继续并排真实计数会产生不一致；以简洁 stage 取代 | `db.ts` determinate `paint` |
| 后台 activity/大包/卡死诊断设想 | 早期调查中的过度设计 | 用户明确拒绝，现有快照足以完成轻量平滑 | 不创建 |
| 直接瞬时比例投影 | 无视觉过渡时实现最简单 | 由同一 renderer 内的有界平滑投影替代 | `db.ts compressionProgress` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 稀疏快照有中间进度 | actual → bounded target → 350ms paint；有效帧间隔最大 100ms | `db.ts` display ratio | online PTY `0→60→100` 中间值 + SIGSTOP 2 秒后首帧步长断言 |
| INV-02 前瞻与完成边界 | +5 点、99% cap、completed-only 1、状态感知初始化；offline completed 延迟到清理后 | `db.ts` target/update/finish + online/offline settled update | 稀疏 PTY 的终态 100%、恒定 60/100 的 65% 上限与单调性、满量 running 首帧 99%、最终 100% 时 lease 已释放、failure 非 100% |
| INV-03 业务语义不变 | 不改 core/task/storage | 仅 `db.ts` renderer | maintenance + daemon regressions、typecheck |
| INV-04 简洁英文阶段 | stage → 一句 label，删除真实计数 | `db.ts` determinate line | online `Compressing payloads`、offline `Scanning cold data` |
| INV-05 老记录与既有字段兼容 | 保留 pulse、rate、ETA、finish | 仅 determinate 分支 | 现有 CLI 全文件 + 无 progress 的 pulse PTY 场景（owners、elapsed、无 determinate 百分比） |
| INV-06 克制 diff | 单生产函数/少量相邻 hunks | `db.ts` | git diff 行数、hunks、文件清单 |
| INV-07 公开验证 | fake daemon durable snapshots → real CLI/PTY | `db-maintenance.test.ts` | red-green 同一公开 seam |
| INV-08 verified 后实际提交 | clean implementation audit → 核对 paths → commit --only → post-commit status | 本任务三个路径 | commit id、提交内容边界与工作树证据 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 私有显示比例和帧时间 | INV-01/02 | 当前 direct projection 的红信号 | latest 只有真实值，无法表示帧间视觉位置 |
| 350ms 时间常数 + 最大 100ms 有效插值间隔 | INV-01 | 100ms 帧、650ms red 快照与 2 秒长帧探针 | 现有 paint 没有过渡；只加曲线而不截断长帧会在恢复时一次追满 |
| +5 点/99%/completed 1 边界 | INV-02 | 用户允许有限估算但拒绝虚假完成 | 当前没有估算边界 |
| 阶段变化时按状态上限重置显示比例 | INV-02/04 | owners 与 packs 分母不同；running 可先发布满量 progress | 跨阶段插值会混合不可比单位，直接初始化 actual 还可能提前 100% 或随后回退 |
| 简洁英文 label、删除真实计数 | INV-04 | 用户要求减少内部信息 | 现有单位是技术术语，真实计数与视觉估算口径冲突 |
| offline completed 延迟到 runOffline 返回 + completed 停止 timer + finish 唯一 paint | INV-02 | online 终态此前不进入 update；普通 update 总会 paint，offline completed checkpoint 早于 encoder/lease 收尾 | 从结构上移除 completed latest 的异步窗口，同时封闭直接 update 与定时 paint，成功收尾精确对齐且不重复 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts` | modify | 现有 renderer 的有界平滑、阶段文案、completed 对齐 | 生产有效修改约 35–70 行，集中在 3–4 个相邻 hunks |
| `packages/opencode/test/cli/db-maintenance.test.ts` | modify | 稀疏/恒定/长帧/无 progress online PTY 断言与既有展示断言更新 | 测试有效修改约 120–170 行 |
| `docs/plans/db-compress-progress-smoothing.md` | add | 唯一 canonical plan 与审计证据 | 文档，不计生产行数 |

## 16. TDD Behavior Slices

公共 seam 已确认为真实 `opencode db compress` CLI/PTY；它捕获用户实际 stderr，无法证明各 worker/SQL 内部耗时，但本任务只改展示，因此覆盖完整受影响行为。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 扩展现有 online fixture：初始 0%，650ms 后 60%，再 650ms 后 100%；断言进度帧含 0<v<60 的中间值和最终 100% | 当前只有 0、60，且 online settled 不更新 progress | 有界平滑 + completed 对齐 | 稀疏跳变、非终态 cap、真实 100% |
| 2 | 复用同一 fixture 跑独立场景：首次 running payload 即为 60/100，保持后 completed；断言有序进度帧同阶段不回退，最终 100% 之前的每帧不超过 65%，并覆盖首次 running 即 100/100 只能从 99% 起步 | 当前直接投影虽可满足 65% 上限，但没有 settled 100%；同时可检出 future +50% 或倒退实现 | 状态感知初始化、统一目标上限、completed-only 收尾 | +5 点、单调性、满量 running 首帧不回退 |
| 2a | 在 fake-daemon 运行中先看到 0%，对真实 CLI 发 SIGSTOP；暂停期间发布 durable 60%，2 秒后 SIGCONT；恢复后的首个非零活动帧必须不超过 25%，随后继续平滑到完成 | 当前直接跳到 60%；未截断的 350ms 曲线会在 2 秒间隔后跳到约 64.8% | 插值有效帧间隔截断为 100ms，理论首帧约 16.2% | offline/长同步帧同类墙钟间隔的公开可重复代理，不依赖机器负载 |
| 3 | online 断言 `Compressing payloads`，offline 断言 `Scanning cold data`；同步更新旧 owners 断言 | 当前只有技术单位 | 简洁 stage label + 删除冲突计数 | 两阶段文案与老 pulse 兼容 |
| 4 | offline 真实压缩前预建 20,000 个空文件，owner 出现后原子移入 lease；断言活动帧最终 100% 恰好一次且出现时 lease 已不存在。失败用例补充不出现完成态 100%，运行既有速率清行用例 | 当前 direct-update 在 lease release 前绘制 100%，因此 `finalLockPresent=true`；新路径直到 runOffline 返回才提供 completed latest，异步窗口不再存在 | offline checkpoint 跳过 completed，result 返回后 update，finish 唯一绘制；保留 `EL` | offline checkpoint→encoder/lease→finish 的真实收尾边界、failed/interrupted、无残影 |
| 5 | 复用 fake-daemon fixture 保留一个无 `progress` 场景：running 时只推进 processed，断言 pulse 活动帧含 owners、elapsed，且无 determinate 百分比 | 当前 pulse 可工作，但 R2 的 determinate 场景无法防止其被后续修改破坏 | 保留现有 pulse 分支，不改其布局 | 正常首个无 progress checkpoint、老记录兼容 |

每个 slice 先运行并记录红，再实施该 slice 的最小行为；不批量预设额外功能。slice 4 的 lease padding 在 CLI 启动前预建，owner 出现后原子 rename 进 lease，不与压缩竞争；20,000 文件删除实测 291ms。PTY 只在含 `elapsed` 和 `100.0%` 的活动帧同步检查 lease 是否存在，正确实现必须在 release 后才画 100%，当前 direct-update 会在 release 前产生红信号。offline completed 改为 result 返回后才进入 renderer，异步窗口由结构消除，因此不再需要 1ms poll 或按到达时间猜测 durable completed 与帧的对应关系。slice 5 是现有兼容行为的敏感回归证据，不要求为了制造红而破坏生产分支；其有效性由随后只对 determinate 分支的修改及全文件回归共同验证。百分比只从带 `elapsed` 的活动 stderr 帧提取，避免把完成汇总的压缩率误当成进度。场景 2 不依赖帧到达时间推断 durable 快照：在 completed 前的恒定 60/100 运行段内，任何超过 65% 的值都必然违反 +5 点上限；满量 100/100 首帧则直接验证状态感知的 99% 初始化。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 180（生产 50 + 测试 130） | 排除空行、import-only、formatter-only、generated、pure move |
| Required Chinese explanatory comments `C` | 至少 27 | `ceil(180×0.15)=27`；实际按最终 E 重算 |

有效中文注释只放在：

- 视觉目标允许最多 5 点前瞻、非 completed 不得达到 100% 的产品边界；
- 350ms 只控制显示追赶，插值有效帧间隔最大 100ms，避免长同步帧恢复时一次追满；不修改持久进度或帧时钟；
- SIGSTOP/SIGCONT 只改变真实 CLI 的帧间隔，durable 发布仍由 fake daemon 控制，25% 首帧上限用于区分64.8%全量追赶；
- owners/packs 分母不同，阶段切换必须重置的解释；
- 稀疏 PTY fixture 的 650ms 与中间百分比断言意图；
- offline completed 必须等 runOffline 收尾后才进入 renderer，completed update 再停 timer，最后由 finish 唯一补满；失败不得补满；
- lease padding 的用途是让 direct-update 的提前 100% 稳定暴露为 lease 仍存在，而非依赖机器自然时序或帧时间戳关联；
- 恒定 60/100 running 快照的 65% 上限断言、满量首帧 99% 初始化与单调性验证意图；
- 无 progress 首个 checkpoint 必须继续显示 pulse 而非 determinate 百分比的兼容意图。

不通过复述赋值、翻译标识符或拆分短句凑比例。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| 上述 WSL `db-progress-feedback.ts` | `packages/opencode`（WSL 映射路径） | 原始红回路在实施后为 green，含中间百分比与完成结果 |
| `/mnt/d/Temp/opencode/bun-linux-x64/bun test test/cli/db-maintenance.test.ts -t "online observe completes while control status hangs during nonterminal work"` | `packages/opencode`（WSL） | slice 1/2 的真实 online PTY 红绿 |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode`（Windows） | 当前平台可运行的完整 DB CLI 文件回归 |
| WSL `bun test test/cli/db-maintenance.test.ts` | `packages/opencode`（WSL） | POSIX PTY 交互与完整 DB CLI 文件回归 |
| WSL `bun test test/cli/tui/daemon.test.ts -t "db compress variants keep the daemon"` | `packages/opencode`（WSL） | online/offline daemon 路由与收尾不回归 |
| `bun typecheck` | `packages/opencode` | 类型安全 |
| `git diff --check`、`git diff --stat`、目标路径 `git diff` | repo root | 无 whitespace 错误；验证 hunk、生产行数≤200、文件边界与无关改动隔离 |
| `git status`、`git diff`、`git diff --cached`、`git log --oneline -10` | repo root（仅 verified 后） | 提交前核对完整工作树、暂存区与提交风格 |
| `git add -- docs/plans/db-compress-progress-smoothing.md`，随后 `git commit --only -- packages/opencode/src/cli/cmd/db.ts packages/opencode/test/cli/db-maintenance.test.ts docs/plans/db-compress-progress-smoothing.md` | repo root（仅 verified 后） | 正常运行 hooks，只提交本 GOAL 三个路径；无关 config/untracked 内容保持原样 |
| `git status`、`git log -1 --oneline` | repo root（commit 后） | 记录 commit id 与剩余无关改动，证明无意外纳入 |

若某项环境前置缺失或存在无关失败，记录实际失败与最小隔离证据，不跳过或改写产品断言。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1（仅 canonical plan） | GOAL 必需文档 |
| Files modified | 2（1 production + 1 test） | 不扩大生产文件 |
| Files deleted | 0 | 无 |
| Production lines | 预计 35–70，硬上限 200 | 用户最新硬约束 |
| Test lines | 预计 120–170 | 复用现有 fixture 跑稀疏、恒定、长帧与无 progress 快照场景，不新建测试文件 |
| Generated lines | 0 | 无协议/SDK 变化 |

生产修改控制在现有 `compressionProgress`、online/offline settled 相邻位置；避免格式化整文件和无关 hunk。commit 使用中文多行信息 `fix(opencode): 平滑数据库压缩进度`，正文说明有界视觉插值、completed 收尾与持久语义不变；不得 amend、`--no-verify` 或 push。

## 20. Real Risks and Open Decisions

- 视觉百分比是明确的展示估算，可能在真实快照前最多 5 个百分点；真实计数被移除且持久数据不变，避免用户把估算当成恢复事实。
- 长任务 idle 时显示值到达当前有界目标后会停住，不无限虚构增长；下一次真实快照到达后继续平滑。
- Windows 交互 PTY 测试按仓库既有规则 skip，故必须在 WSL 运行原始红绿与 POSIX 交互测试，不能用 Windows skip 冒充验证。

### Open Decisions Requiring the User

无。用户已明确选择“继续修复并审计 (Recommended)”，授权 R7 处理长帧并继续实现、审计和提交。R7 使用同一 renderer 的 100ms 有效插值间隔与 SIGSTOP/SIGCONT 公开长帧回路。

### Rejected Speculation

- 不根据一次 UI 症状重写 worker、批次、FIFO、SQLite 或 daemon。
- 不新增“疑似卡死”、单个大包、吞吐衰减、ETA 重构或双时钟治理；这些超出本次已确认收益范围。
- 不为测试导出私有 renderer，不增加 source-text/算法复制品测试。
- 不处理与本展示分歧无关的历史日志或数据库状态。

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
| 1 | R1 | yes | B-01, B-02, B-03 | 无 | **BLOCK** | `ses_e3da07ee8ffeO32QmgaEFswY3T` |
| 2 | R2 | yes | B-01, B-02, B-03 | 无 | **BLOCK** | `ses_e3d92a66dffevGvZmjfTfwS6xI` |
| 3 | R3 | yes | B-01 | 无 | **BLOCK** | `ses_e3d87291fffeaA8omxhpeB4gnM` |
| 4 | R4 | yes | B-01, B-02 | 无 | **BLOCK** | `ses_e3d7da718ffesOpquYcHPyoNyT` |
| 5 | R5 | yes | B-01 | 无 | **BLOCK** | `ses_e3d6e0651ffeuFfLaBKr8bsDZ5` |
| 6 | R6 | yes | B-01（轮次上限后仍为 blocking open decision） | 无 | **BLOCK** | `ses_e3d5fb4f5ffeD1oOfeyhBlkBuc` |
| 7 | R7 | yes | No blocking findings | 无 | **APPROVE** | `ses_e3c7d0a5effemD2b4LnvQUCNJ2` |

### Round 1 independent verdict（原样记录）

#### B-01 阶段初始化可绕过非终态 99% 上限（Blocking）

- Violated invariant: INV-02：非 `completed` 不得显示 100%，且阶段内显示值不得回退。
- Evidence class: reachable
- Producer and execution path: `ColdMaintain` 在 payload 批次提交后先写入 `progress.done === progress.total`，此时任务仍是 `running`，随后才发布 `completed`。online/offline 快照都会进入 `progress.update()`。如果观察者首次看到的 payload 阶段已经是 `done === total`，计划要求“阶段变化时显示比例直接初始化为 actual”，即初始化为 1；但同阶段目标又被限制为 0.99，且显示值不得回退。
- Source evidence: `packages/core/src/storage/cold-maintain.ts:614-624` 设置满量 payload 进度；`packages/core/src/storage/cold-maintain.ts:689-694` 证明 running checkpoint 先于 completed checkpoint；`packages/opencode/src/cli/cmd/db.ts:276-296` 是当前比例渲染位置，`packages/opencode/src/cli/cmd/db.ts:309-321` 是两条执行域共用的更新入口。
- Canonical-plan evidence: 第 7 节 INV-02；第 10 节第 2、3 步，尤其是 `actual = min(1, done/total)`、非终态目标上限 0.99 与“阶段变化时显示比例直接初始化为 actual”的组合。
- Responsibility owner: `packages/opencode/src/cli/cmd/db.ts` 的 `compressionProgress`，负责阶段初始化和非终态显示边界。
- Concrete behavioral consequence: 单 payload、稀疏观察或较晚开始观察时，活动任务可能先显示 100%，随后要么违反“非 completed 不显示 100%”，要么向 99% 回退。两种结果都破坏已确认的可信进度语义。
- Minimal correction direction: 阶段切换初始化也复用同一状态感知的非终态上限，并在真实 CLI/PTY 中增加“running 且首次 payload 快照即为 done=total”的公开行为用例；无需增加新的显示通道或生产文件。

#### B-02 原始红绿反馈脚本会拒绝符合计划的平滑结果（Blocking）

- Violated invariant: INV-07 及完成门禁：原始用户场景必须能通过同一真实 CLI/PTY 回路完成红绿验证。
- Evidence class: reachable
- Producer and execution path: 脚本依次发布 durable `0% → 60% → completed 100%`，然后从终端文本提取百分比。计划中的连续指数平滑只保证出现中间值，不保证某一帧四舍五入后恰好为 `60.0`；但脚本仍执行 `values.includes(60)`，缺失时直接抛出“fixture did not publish the 60% checkpoint”。
- Source evidence: `D:\Temp\opencode\db-progress-feedback.ts:47-59` 发布三个 durable 快照；`D:\Temp\opencode\db-progress-feedback.ts:123-129` 将精确视觉值 60 当作 durable 发布凭证。
- Canonical-plan evidence: 第 8 节候选探针给出的平滑序列本身不包含 60；第 16 节 slice 1 只要求中间值与最终 100%；第 18 节却仍把该脚本列为实施后必须通过的原始终态反馈回路。
- Responsibility owner: 验证层的 `db-progress-feedback.ts`，而不是生产 renderer；不应为了迎合脚本让平滑曲线强制经过 60%。
- Concrete behavioral consequence: 正确实现 INV-01/INV-02 后，原始反馈回路仍可能报告 RED，使计划要求的 original feedback-loop green 无法可靠成立，并阻碍 `verified` 状态。
- Minimal correction direction: 在计划中将 durable 60 的发布确认移到 fixture/producer 侧，终端侧只断言中间视觉值与真实完成态 100%，并明确记录这一验证脚本修正。

#### B-03 前瞻上限和阶段内单调性没有可失败的实现级验证（Blocking）

- Violated invariant: INV-02 的“最多前瞻 5 个百分点、同阶段单调追赶”，以及每个确认不变量都必须具有行为敏感验证的门禁。
- Evidence class: contracted
- Producer and execution path: durable 快照经新显示比例进入真实 PTY 输出。计划中的 online 测试只明确要求存在 `0 < v < 60` 和最终 100，失败用例只补充非 100；因此使用 `actual + 50%` 的错误目标，或产生同阶段来回摆动的曲线，仍可能满足全部计划断言。第 8 节隔离探针只验证候选算法，不能观察最终生产实现。
- Source evidence: `packages/opencode/test/cli/db-maintenance.test.ts:412-527` 是当前要扩展的真实 online CLI/PTY fixture；`D:\Temp\opencode\db-progress-feedback.ts:123-129` 也只检查中间值是否存在，不检查每帧相对 durable 快照的上限或帧间单调性。
- Canonical-plan evidence: 第 7 节 INV-02；第 13 节 INV-02 仅映射到终态 100 和 failure 非 100；第 16 节 slice 1、3 未规定 +5 点上限和同阶段单调性的实现级断言。
- Responsibility owner: `packages/opencode/test/cli/db-maintenance.test.ts` 的真实 CLI/PTY 行为验证层。
- Concrete behavioral consequence: 实现可以过度虚报进度或让百分比倒退，同时全套计划测试仍然通过，直接漏掉用户所要求的“有限、可信、持续上涨”的核心收益。
- Minimal correction direction: 在同一受控 PTY fixture 中按 durable 快照阶段采集有序帧，断言阶段内单调且每帧不超过该阶段 `actual + 0.05`；继续通过公开 stderr 观察，不导出 renderer 或复制生产算法。

## Non-blocking findings

无。

## Rejected speculation

- 稀疏 checkpoint 本身是提交后发布持久事实的正确设计，不应据此修改 FIFO、worker、SQLite、批次或恢复 cursor。
- `parseMaintenanceTask` 已验证 progress 计数为非负安全整数，renderer 又只在 `total > 0` 时进入 determinate 分支；无需增加重复解析或恶意输入防护。
- 没有证据支持新增 activity 通道、卡死诊断、后台面板、配置项、依赖或 alternate success path。
- 完整进度条在接近 99% 时可能填满属于既有图形取整行为；本轮没有足够合同将其单独认定为新的阻塞缺陷。

## Requirement and traceability coverage

| 范围 | 审计结论 |
| --- | --- |
| 原始跳变症状与 INV-01 | 首个展示分歧定位正确：现有 `paint()` 直接投影 `done/total`，修复 owner 是现有 `compressionProgress`。中间帧测试具有原始行为红信号。 |
| 有限平滑与可信边界 INV-02 | 未通过。运行中满量首帧存在设计冲突，且 +5 点和单调性缺乏实现级验证，见 B-01、B-03。 |
| 持久进度与业务语义 INV-03 | 计划只修改 CLI renderer 和测试，不改变 cursor、processed、checkpoint、提交或恢复语义；方向正确。 |
| 简洁英文阶段语言 INV-04 | `Scanning cold data` / `Compressing payloads` 映射到现有 owner/payload 分支，online 与 offline 均有计划断言。 |
| pulse、速率、ETA、错误兼容 INV-05 | 保留现有非 determinate 分支和真实 ETA 计算，删除的是与视觉估算冲突的计数展示，不构成第二套业务语义。 |
| 克制修改 INV-06 | 仅一个生产文件，预计生产有效修改 35–70 行，低于 200 行硬上限；无新增生产文件或公共 API。 |
| 真实公开验证 INV-07 | 选择真实 CLI/PTY 而非私有导出是正确的，但原始反馈脚本与平滑合同冲突，见 B-02。 |
| 最终 `verified-implementation-and-commit` | 当前仅处于计划审计；上述验证和设计问题解决前，不允许进入实施、verified 或提交阶段。 |

## Primary-path and fallback verdict

主路径仍然是：

```text
durable task snapshot
  → 现有 online/offline observer
  → 现有 compressionProgress
  → 现有 100ms paint
  → 真实 completed 收尾
```

`ensureSettled` 后的 settled update 属于同一展示路径的终态对齐，不是第二次压缩执行或替代成功路径。既有 `total=0`/缺失 progress 的 pulse 是有具体老记录合同支持的兼容分支。计划没有新增 fallback、诊断成功路径、配置开关或第二数据源。

主路径归属和克制方向正确，但 B-01 使该路径尚不能同时满足非终态上限与单调性，B-02、B-03 使其验证闭环不完整。

## Code quality and Chinese-comment verdict

计划阶段的代码质量约束符合仓库方向：复用现有函数和时钟、不新增单用 helper、不扩展公共接口、不修改 core/storage，并保留单一生产文件。

计划记录估算为：

- `E ≈ 80`，其中生产约 45、测试约 35。
- `C ≥ 12`，计算为 `ceil(80 × 0.15) = 12`。
- 注释主题覆盖前瞻边界、350ms 仅影响展示、阶段分母不同、稀疏 PTY 断言意图和 completed-only 收尾，具有形成有效中文解释注释的空间。
- 生产修改预算 35–70 行，文件范围为 `db.ts`、`db-maintenance.test.ts` 和 canonical plan，符合最新文件数与生产行数约束。

当前没有实现 diff，无法计算实际 `E`、`C` 或 `C/E`；实施审计仍须独立重算，并排除 import-only、formatter-only、generated 和 pure-move 行。

## Release verdict

**BLOCK**

仅针对 canonical plan **R1**。需要修订上述三个阻塞项、递增 revision，并重新进行完整范围计划审计；当前不得据此实施或提交。

### R2 对 Round 1 的修订映射

- B-01 → 第 10 节阶段初始化改为状态感知上限，TDD slice 2 增加 running 满量首帧场景。
- B-02 → 反馈脚本以 producer 的 `published60` 确认 durable 发布，不再要求视觉帧精确为 60%；修正后已重跑并仍得到原始 RED `PROGRESS_VALUES=0,60`。
- B-03 → TDD slice 2 增加恒定 60/100 场景的 65% 上限、有序单调与满量首帧 99% 断言，最终 100% 单独验证。

### Round 2 independent verdict（原样记录）

#### B-01 原始反馈脚本存在语法错误，无法执行计划要求的红绿回路（Blocking）

- Violated invariant: INV-07，以及缺陷修复必须通过原始用户场景反馈回路的完成门禁。
- Evidence class: observed
- Producer and execution path: 第 18 节要求通过 WSL/Bun 执行 `D:\Temp\opencode\db-progress-feedback.ts`；Bun 解析到第 72 行的 `return Responseunexpected" }, ...` 即会失败，fake daemon、真实 CLI 和 PTY 断言均无法启动。
- Source evidence: `D:\Temp\opencode\db-progress-feedback.ts:67-73`，尤其是 `:72` 的非法 `Responseunexpected` 表达式。
- Canonical-plan evidence: 第 8 节“Red-capable feedback loop”、第 18 节首项验证命令、第 22 节 R2 对 B-02 的“修正后已重跑”记录。
- Responsibility owner: 验证层的 `db-progress-feedback.ts`，不是生产 renderer。
- Concrete behavioral consequence: 当前计划指定的原始反馈回路不能运行，无法取得实施前红信号或实施后绿信号，因此即使生产修改正确，也不能据此进入 `verified` 状态。
- Minimal correction direction: 修复该 404 分支为合法的 `Response.json(...)` 表达式，并用同一脚本重新记录实施前 RED、实施后 GREEN；不需要改动生产文件。

#### B-02 completed 的中间绘制帧会被 65% 上限断言误判（Blocking）

- Violated invariant: INV-02 和 INV-07；验证必须接受符合“completed 目标为 1、finish 最终对齐 100%”的实现。
- Evidence class: reachable
- Producer and execution path: running `60/100` 快照使视觉值平滑升至不超过 65%；随后 durable completed 到达，`ensureSettled` 成功后，计划要求调用现有 `progress.update(settled)`。现有 `update` 总会调用 `paint()`，因此 completed 快照会先按目标 1 绘制一个中间帧，再由 `finish()` 绘制 100%。例如上一帧为 54%、距上一帧 100ms 时，350ms 指数曲线会产生约 65.4% 的 completed 中间帧；脚本却要求除最后一帧外全部不超过 65%。
- Source evidence: `packages/opencode/src/cli/cmd/db.ts:309-321` 证明现有 `update` 必定绘制；`:391-395` 是 online settled/finish 路径；`D:\Temp\opencode\db-progress-feedback.ts:125-133` 对 `values.slice(0, -1)` 一律施加 65% 上限。
- Canonical-plan evidence: 第 10 节第 2、5 步；第 16 节 slice 2 的“最终 100% 之前的每帧不超过 65%”；第 18 节原始反馈回路。
- Responsibility owner: `compressionProgress` 的 terminal update/finish 绘制契约及其 PTY 验证层。
- Concrete behavioral consequence: 完全符合计划曲线的实现也可能被原始脚本和 slice 2 判红；首次观察即 completed 时，`update` 与 `finish` 还可能连续产生两个 100% 帧，同样触发该错误断言。
- Minimal correction direction: 在计划中明确 settled completed 快照只更新 `latest`、不预先绘制，由 `finish()` 唯一绘制最终 100%，使非终态帧继续使用 65% 上限断言。

#### B-03 既有 pulse 兼容没有可失败的行为验证（Blocking）

- Violated invariant: INV-05：`total=0` 或缺失 `progress` 时，既有 pulse、owners 和 elapsed 展示必须保持兼容。
- Evidence class: reachable
- Producer and execution path: `ColdMaintain` 在设置 owner progress 之前就发布首个 running checkpoint，因此正常 offline 压缩也会短暂产生无 `progress` 快照；老任务和零总量记录同样进入现有 pulse 分支。计划把唯一可控 online fixture 改为 determinate `0→60→100`，其余断言只检查 determinate 标签、百分比或完成结果，没有任何 pulse 行为断言。
- Source evidence: `packages/core/src/storage/cold-maintain.ts:526-529` 的首次 checkpoint 早于 `:554-558` 的 progress 初始化；`:321-333` 明确允许缺失 progress 和 `total=0`；`packages/opencode/src/cli/cmd/db.ts:275-303` 是 determinate/pulse 两个展示分支；`packages/opencode/test/cli/db-maintenance.test.ts:412-527` 是计划改造的 online fixture，目前没有 pulse 断言。
- Canonical-plan evidence: 第 7 节 INV-05、第 13 节仅映射到“现有 CLI 全文件”、第 16 节 slice 1 和 slice 3；slice 3 虽写“老 pulse 兼容”，但没有定义无 progress/`total=0` 输入及对应断言。
- Responsibility owner: `packages/opencode/test/cli/db-maintenance.test.ts` 的公开 CLI/PTY 行为验证层。
- Concrete behavioral consequence: 实现即使删除或破坏无 progress/`total=0` 的 pulse 展示，计划的 determinate 测试仍可能全部通过，正常首帧及老记录兼容会无声回归。
- Minimal correction direction: 复用现有 fake-daemon fixture 保留一个无 progress 或 `total=0` 场景，通过真实 PTY 断言 pulse 行仍包含 owners、elapsed 且无 determinate 百分比，无需增加生产文件。

Non-blocking findings：无。

Rejected speculation：稀疏 checkpoint 在事务提交后发布，是正确的持久进度语义；无需重复 parser 防护、activity 通道、后台活动面板、卡死诊断、配置、依赖、替代时钟或第二套进度数据源。owners 与 payload 使用不同分母，阶段切换时重置视觉比例属于已确认的阶段语义，不构成跨阶段单调性缺陷。

Requirement and traceability coverage：INV-01 的 owner 与红信号定位正确；INV-02 已覆盖 R1 主要遗漏，但 completed 中间帧与 oracle 冲突；INV-03/04/06 方向正确；INV-05 缺 pulse 行为验证；INV-07 受脚本执行与终态断言问题阻塞。

Primary-path and fallback verdict：主路径保持 durable task snapshot → existing observer → compressionProgress → 100ms paint → completed 终态对齐；无 alternate success path、诊断成功路径、配置开关或第二数据源。阻塞点是反馈回路、completed 绘制与测试合同，以及 pulse 回归验证。

Code quality and Chinese-comment verdict：计划复用现有函数和 100ms 帧时钟，无新 helper、依赖、公共接口或生产文件。估算 `E≈145`、`C≥22`，实际 E/C 仍须实施审计重算。

Release verdict：**BLOCK**。仅针对 canonical plan R2；需要修订 B-01、B-02、B-03，递增 revision，并重新进行完整范围计划审计；当前不得据此实施或提交。

### R3 对 Round 2 的修订映射

- B-01 → 当前文件 `:72` 实际为合法 `return Response.json(...)`，并非审计输出中的 `Responseunexpected`；直接读取与 Bun 解析均未发现该语法错误。修正临时脚本自身的类型窄化后，已于同一 WSL/Bun 命令再次实际执行，进入 fake daemon POST/GET 并输出原始 RED `PROGRESS_VALUES=0,60`。因此该项没有生产或计划修正；可执行证据取代不可复现的语法断言。
- B-02 → 第 10、14 节明确 completed 快照静默 update，`finish()` 成为唯一 completed 绘制点，online/offline 共用；原 65% 非终态断言保持不变。
- B-03 → TDD slice 5 增加无 progress 的 pulse 活动帧断言，覆盖 owners、elapsed 与无 determinate 百分比。

### Round 3 independent verdict（原样记录）

#### B-01 completed 快照仍可能被现有定时器提前绘制（Blocking）

- Violated invariant: INV-02、INV-07，以及第 10 节“`finish()` 是 completed 唯一最终绘制点”的收尾合同。
- Evidence class: reachable
- Producer and execution path: offline 压缩在 `ColdMaintain` 写入 completed checkpoint 后调用 `progress.update(completed)`。按计划，此时只更新 `latest` 和阶段状态，但现有 `setInterval(paint, 100ms)` 仍保持活动。随后还要等待 `encoder.close()` 和 `lease.release()`，才进入 `executeMaintenance` 的 `progress.finish()`。任一等待跨越定时帧时，`paint()` 都会读取 completed 快照，并按计划中的 completed 目标 1 提前绘制。
- Source evidence: `packages/opencode/src/cli/cmd/db.ts:306-307` 是持续运行的定时器；`packages/opencode/src/cli/cmd/db.ts:498-505` 是 offline checkpoint 与 lease 收尾；`packages/opencode/src/cli/cmd/db.ts:587-593` 表明 `finish()` 要等 `runOffline` 结束后才执行；`packages/core/src/storage/cold-maintain.ts:692-705` 表明 completed checkpoint 后还会等待 encoder 关闭；`packages/core/src/storage/cold-codec.ts:1381-1383` 证明该关闭等待真实的 worker termination Promise。
- Canonical-plan evidence: 第 10 节第 2 步规定 completed 目标为 1；第 5 步仅禁止 `update()` 直接调用绘制，没有停止或屏蔽定时 `paint`；第 8、14 节及第 16 节 slice 2 又要求 completed 只能由 `finish()` 绘制。
- Responsibility owner: `packages/opencode/src/cli/cmd/db.ts` 中 `compressionProgress` 的 `update`、现有定时器和 `finish`。
- Concrete behavioral consequence: offline 用户可在最终 100% 前看到 completed 中间帧，例如从约 54% 向 100% 追赶，随后再由 `finish()` 跳至 100%，违反“只有 finish 绘制 completed”的设计并重新引入终态跳变。计划的 online 脚本在 settled `update` 与 `finish` 之间没有异步等待，无法覆盖这个 offline 时序，因此全部计划测试通过也不能证明该收尾合同成立。
- Minimal correction direction: 在现有 renderer 内让 completed `update` 同时停止或屏蔽定时绘制，使定时 `paint` 始终走非终态上限、`finish()` 独占一次 100% 绘制，并通过现有 offline CLI/PTY seam 覆盖 completed-checkpoint 到 `finish()` 的间隔；无需新增文件、时钟或通道。

Non-blocking findings：无。

Rejected speculation：稀疏 checkpoint 不应驱动 FIFO/SQLite/worker/cursor 修改；阶段重置不构成跨阶段单调性缺陷；无需重复 parser、防护、activity 通道、卡死诊断、配置或替代时钟；99% 附近的取整不单独构成阻塞。

Requirement and traceability coverage：INV-01 的展示 owner 与红信号成立；INV-02 仍有 completed 定时帧绕过 finish；INV-03/04/05/06 已有相应设计或验证；INV-07 的脚本有效，但 online 不能覆盖 offline 异步收尾。

Primary-path and fallback verdict：主路径保持 durable snapshot → observer → compressionProgress → 100ms paint → finish completed settlement；无新增 fallback。阻塞点是 completed 状态下定时 paint 与 finish 的绘制所有权重叠。

Code quality and Chinese-comment verdict：计划复用现有函数和 100ms 帧时钟，无新 helper、依赖或公共接口；估算 `E≈160`、`C≥24`，实际值由实施审计重算。

Release verdict：**BLOCK**。仅针对 canonical plan R3；需要修订 B-01、递增 revision，并重新进行完整范围计划审计；当前不得据此实施或提交。

### R4 对 Round 3 的修订映射

- B-01 → 第 10、14 节要求 completed update 先停止现有 timer，再静默更新；直接 update 和定时 paint 均不能提前绘制 completed。TDD slice 4 明确使用 offline 真实 CLI/PTY 验证最终 100% 恰好一次且为最后一帧，覆盖 encoder/lease 收尾路径。

### Round 4 independent verdict（原样记录）

#### B-01 offline 收尾断言无法识别 completed 定时绘制缺陷（Blocking）

- Violated invariant: INV-02、INV-07，以及第 10 节“completed update 停止 timer、`finish()` 独占 completed 绘制”的合同；确认行为必须具有能检出原缺陷的验证。
- Evidence class: reachable
- Producer and execution path: offline completed checkpoint 调用 `progress.update(completed)` 后，仍需等待 `encoder.close()` 和 lease release，才调用 `progress.finish()`。若实现遗漏 R4 新增的 `clearInterval`，定时器可在该间隔读取 completed 快照并绘制中间帧。例如视觉值从 54% 向 completed 目标追赶到 65.4%，随后 `finish()` 绘制 100%。此时最终 100% 仍恰好一次且位于最后，完全符合 slice 4 的断言。
- Source evidence: `packages/opencode/src/cli/cmd/db.ts:306-307` 是现有定时器；`packages/opencode/src/cli/cmd/db.ts:498-505` 是 completed update 后的 lease 收尾；`packages/opencode/src/cli/cmd/db.ts:587-593` 表明 `finish()` 等待整个 `runOffline`；`packages/core/src/storage/cold-maintain.ts:692-705` 表明 completed checkpoint 后仍等待 encoder 关闭。`.opencode/policy/first-principles-engineering.md:469-477` 要求行为敏感且能对原缺陷失败的验证。
- Canonical-plan evidence: 第 10 节第 2、5 步；第 16 节 slice 4 仅要求“最终 100% 恰好一次且为最后一帧”；第 22 节 R4 映射声称该 slice 覆盖 encoder/lease 收尾路径。
- Responsibility owner: `packages/opencode/test/cli/db-maintenance.test.ts` 的 offline CLI/PTY 行为验证层。
- Concrete behavioral consequence: R3 的 completed 定时中间帧缺陷可以原样保留并通过全部计划测试，用户仍会看到完成前的额外跳变；计划声称已封闭的收尾路径实际上没有回归保护。
- Minimal correction direction: 在同一 offline 公开 seam 中按 durable completed 发布点与最终汇总边界区分帧，断言 completed 后、`finish()` 最终 100% 前没有其他活动帧，并确认该断言在现有 direct-update 实现上稳定失败；保留单文件 `clearInterval` 修复，不新增生产通道或时钟。

#### B-02 用户要求的 commit 终态没有执行映射（Blocking）

- Violated invariant: 原始需求指定的 `verified-implementation-and-commit` 必须同时包含独立验证后的实现和实际提交，且每个确认目标都应有明确执行路径。
- Evidence class: contracted
- Producer and execution path: 用户要求最终提交 → 计划批准 → TDD 实施与验证 → 独立 implementation audit → 记录 verified → 核对并提交准确已审计的任务文件 → 记录提交结果。当前计划在 implementation audit 和 verified 状态后即结束，没有后续提交步骤。
- Source evidence: `.opencode/policy/first-principles-engineering.md:55-69` 禁止确认需求缺少执行路径；`.opencode/policy/first-principles-engineering.md:575-598` 区分 verified、complete 与显式授权的 commit。
- Canonical-plan evidence: 第 1 节声明目标终态；第 13 节没有该目标的 traceability 行；第 18 节验证表止于测试、typecheck 和 diff 检查；第 23–24 节仅规定 implementation evidence、audit 和 verified 状态，没有提交边界、命令或提交后证据。
- Responsibility owner: 实施完成后的工作流编排者。
- Concrete behavioral consequence: 所有计划步骤完成并通过 implementation audit 后，任务仍可停在 `verified` 而没有创建用户明确要求的 commit，无法达到声明的最终状态。
- Minimal correction direction: 增加 clean implementation audit 后的独立终态步骤：检查 status/diff/log，仅提交本任务三个路径并正常运行 hooks，随后记录 commit 标识、内容边界和 post-commit status；不得提前提交或纳入无关 worktree 修改。

Non-blocking findings：无。

Rejected speculation：不修改 ColdMaintain/FIFO/worker/SQLite/cursor；无需重复 parser、防护、全局进度模型、activity 面板、卡死诊断、配置或替代时钟。

Requirement and traceability coverage：INV-01 根因与红绿路径成立；INV-02 的 offline 验证仍有 B-01；INV-03/04/05/06 方向正确；INV-07 缺关键收尾敏感验证；最终 commit 目标未覆盖。

Primary-path and fallback verdict：主路径保持 durable snapshot → observer → compressionProgress → 100ms paint → completed settlement/finish；无新增 fallback，生产责任归属符合简单克制方向。

Code quality and Chinese-comment verdict：计划复用现有函数和 100ms 时钟，无新 helper、公共 API、依赖或生产文件；估算 `E≈160`、`C≥24`，实际值由实施审计重算。

Release verdict：**BLOCK**。仅针对 canonical plan R4 的第 4 轮 full-scope plan audit。需要修订 B-01、B-02，递增 revision 并重新进行完整范围计划审计；当前不得实施、标记 verified 或提交。

### R5 对 Round 4 的修订映射

- B-01 → TDD slice 4 改为有实测 291ms 删除窗口的 lease padding：最终 100% 必须在 lease 已释放后出现，当前 direct-update 会以 lease 仍存在稳定变红；不再依赖“100% 恰好一次”这一不充分 oracle。
- B-02 → 新增 INV-08、forward mapping、verified 后专用命令与第 25 节 commit 证据，明确只提交本任务三个路径并记录 post-commit status。

### Round 5 independent verdict（原样记录）

#### B-01 lease padding 仍无法识别 completed 定时绘制缺陷（Blocking）

- Violated invariant: INV-02、INV-07，以及第 10 节“completed update 停止 timer、`finish()` 独占 completed 绘制”的合同；对应回归测试必须能识别该缺陷。
- Evidence class: reachable
- Producer and execution path: `ColdMaintain` 可以先发布 running 且 `done===total` 的 payload 快照，随后发布 completed checkpoint。offline `onTask` 将 completed 送入 `progress.update()`；若实现遗漏 R5 要求的 `clearInterval`，现有定时器仍会在 encoder 关闭和 lease release 期间读取 completed 快照并绘制中间帧。以 running 满量时显示值 99% 为例，350ms 曲线在实测 291ms 删除窗口内只会追到约 99.6%，不会绘制 100%；随后 lease 删除，`finish()` 再绘制唯一一次 100%。因此“100% 恰好一次且出现时 lease 不存在”仍然全部通过。
- Source evidence: `packages/core/src/storage/cold-maintain.ts:614-624` 发布满量 payload 进度，`:689-705` 证明 completed checkpoint 后仍等待 encoder 关闭；`packages/opencode/src/cli/cmd/db.ts:306-307` 是持续定时器，`:498-505` 是 completed callback 后的 lease 收尾，`:587-593` 表明 `finish()` 等待整个 `runOffline`；`packages/core/src/cli/tui/server-lock.ts:471-475` 是 lease 删除位置。
- Canonical-plan evidence: 第 10 节第 2、5 步；第 16 节 slice 4 仅在含 `100.0%` 的活动帧检查 lease，且仍使用“最终 100% 恰好一次”的断言；第 22 节 R5 映射声称该 oracle 已修复 Round 4 的定时帧识别问题。
- Responsibility owner: `packages/opencode/test/cli/db-maintenance.test.ts` 的 offline CLI/PTY 行为验证层。
- Concrete behavioral consequence: R3 发现的 completed 定时中间帧可以原样保留并通过 R5 全部计划测试，计划却仍可能进入 `verified`；用户会继续看到计划明确禁止的 completed 中间帧和最终跳变。
- Minimal correction direction: 在同一 offline 公开 seam 中按 durable completed 发布点区分帧，断言 completed 后、`finish()` 最终 100% 前没有其他活动帧，并验证该断言能检出“静默 update 但未停 timer”的实现；保留单文件 `clearInterval` 修复，不新增生产文件、时钟或通道。

Non-blocking findings：无。

Rejected speculation：不修改 FIFO/worker/SQLite/cursor；无需重复 parser、防护、activity 通道、卡死诊断、配置或第二进度源；99% 附近的取整不构成独立阻塞。

Requirement and traceability coverage：INV-01/02 的展示和边界设计大体成立，INV-03/04/05/06 已有映射，INV-08 已包含 commit 路径；INV-07 的 offline 收尾验证仍不充分。

Primary-path and fallback verdict：主路径保持 durable snapshot → observer → compressionProgress → 100ms paint → completed settlement/finish；无新增 fallback。阻塞点是 offline 收尾测试无法证明 completed 绘制合同。

Code quality and Chinese-comment verdict：计划复用现有函数和 100ms 时钟，无新 helper、公共 API、依赖或生产文件；估算 `E≈160`、`C≥24`，实际值由实施审计重算。

Release verdict：**BLOCK**。仅针对 canonical plan R5 的第 5 轮 full-scope plan audit。需要修订 B-01、递增 revision，并重新进行完整范围计划审计；当前不得实施、标记 verified 或提交。

### R6 对 Round 5 的修订映射

- B-01 → 不再试图用最终帧推断 completed 定时器是否运行。offline checkpoint 跳过 completed，`runOffline()` 完成 encoder/lease 后才把 result 送入 renderer，completed latest 的异步窗口由结构移除；completed update 停止 timer 后由 finish 唯一绘制。lease padding 继续验证 direct-update 的提前 100%，不再承担无法识别的 99.x% 定时帧 oracle，也不再需要 1ms poll/时间戳关联。

### Round 6 independent verdict（原样记录）

#### B-01 长帧后的全量追赶仍会复现瞬时跳变（Blocking；轮次上限后的 open decision）

- Violated invariant: INV-01：稀疏快照之间应出现连续中间视觉进度；INV-07：验证必须覆盖真实的展示分歧。
- Evidence class: reachable
- Producer and execution path: offline 压缩通过 `maintain()` 在 CLI 进程内执行 `Database.withSync()`，其 `Effect.sync` 会同步执行 SQLite 事务。提交期间现有 100ms 定时器无法绘制；提交后 `ColdMaintain` 推进 `progress.done`，再经 checkpoint、`onTask` 进入 `compressionProgress.update()`。计划使用“上一帧到现在的实际间隔”计算指数追赶，因此一个持续约 2 秒的同步事务会让下一帧的追赶系数达到约 0.9967。若此前显示 0%、新快照为 60/100，目标为 65%，下一帧会直接绘制约 64.8%，而不是平滑经过中间值。
- Source evidence: `packages/core/src/database/database.ts:83-87` 证明同步执行事务体；`packages/core/src/storage/cold-maintain.ts:614-624` 在同步提交后推进进度；`packages/core/src/storage/cold-store.ts:2385-2399,2422-2466` 是包含逐源 SQL 操作的同步事务；`packages/opencode/src/cli/cmd/db.ts:266-269,306-307` 是帧时间与定时器；`packages/opencode/src/cli/cmd/db.ts:469-471,498-502,584-593` 证明 offline 与 renderer 位于同一执行进程。
- Canonical-plan evidence: 第 6 节假设稀疏 checkpoint 期间 `paint` 会按墙钟继续前进；第 8 节探针只覆盖未阻塞的 100ms 帧序列；第 10 节第 2 步明确要求按实际帧间隔追赶；第 16 节的 650ms fake-daemon 等待不会阻塞 CLI 事件循环，offline lease 用例也不检查长帧后的跳变幅度。
- Responsibility owner: `packages/opencode/src/cli/cmd/db.ts` 中 `compressionProgress` 的视觉插值，以及 `db-maintenance.test.ts` 的公开 CLI/PTY 行为验证。
- Concrete behavioral consequence: 用户已经描述的长停顿路径仍可能在恢复绘制时一次性追到目标附近，重新出现“停一下、再猛涨”的原始症状。现有计划断言只检查存在某个中间值、单调性和 65% 上限，无法排除一次从低值跳到 64.8% 的情况。
- Minimal correction direction: 在同一 renderer 内限制用于插值的有效帧间隔或等价的单帧视觉步长，并通过公开 CLI/PTY 增加长帧场景验证；无需修改 SQLite、任务时钟、checkpoint 或增加生产文件。

Non-blocking findings：无。

Rejected speculation：R6 已移除 R5 completed 定时问题；不要求修改 FIFO/worker/SQLite/cursor/提交算法；total=0、pulse、阶段重置、99% 取整和失败收尾不构成新阻塞；无需新增 activity、卡死诊断、第二数据源、配置或 alternate success path。

Requirement and traceability coverage：INV-01 因长帧全量追赶未通过；INV-02/03/04/05/06/08 的设计或映射已覆盖；INV-07 缺长帧敏感验证。

Primary-path and fallback verdict：主路径保持 durable snapshot → observer → compressionProgress → 100ms paint → settled completed → finish；无新增 fallback。阻塞点是长帧后的视觉追赶，而非主路径归属。

Code quality and Chinese-comment verdict：计划复用现有函数和 100ms 定时器，无新增公共 API、依赖、helper 或生产文件；估算 `E≈160`、`C≥24`，实际值由实施审计重算。

Release verdict：**BLOCK**。仅针对 canonical plan R6 的第 6 轮 full-scope plan audit。B-01 在轮次上限仍未解决，按政策保留为 blocking open decision，交由用户决定是否继续处理；当前不得批准、实施、标记 verified 或提交。

### R7 对 Round 6 的修订映射（用户明确授权续作）

- B-01 → 第 10、14 节把有效插值间隔限制为 100ms，2 秒长帧后的首帧由约 64.8% 降为与正常帧一致的约 16.2%；TDD slice 2a 以 SIGSTOP/SIGCONT 和 durable 60 快照构造可重复的 2 秒公开 PTY 回路，首帧上限 25%。
- 用户回答“继续修复并审计 (Recommended)”已写入第 1、20 节，取代 R6 的等待授权状态；生产文件和行数边界不变。

### Round 7 independent verdict（原样记录）

Blocking findings：No blocking findings.

Non-blocking findings：无。

Rejected speculation：稀疏 checkpoint 不应驱动 SQLite/FIFO/worker/批次/cursor/压缩算法修改；无需重复 parser 防护、跨阶段全局单调、99% 取整修正、activity 通道、卡死诊断、配置、依赖、替代时钟或第二数据源。

Requirement and traceability coverage：INV-01 的首个分歧定位正确，100ms 有效间隔与 SIGSTOP/SIGCONT 25% 上限可区分原实现、未截断实现和计划实现；INV-02/03/04/05/06/07/08 均有生产路径、行为验证或提交证据映射。

Primary-path and fallback verdict：主路径唯一保持 durable task snapshot → existing online/offline observer → compressionProgress → bounded visual interpolation on existing 100ms timer → settled completed update → finish() renders single final 100%。online ensureSettled 已等待 worker/lease，R7 offline completed 延迟到 runOffline 返回；既有 pulse 是兼容分支。新增 alternate success path 和 diagnostic path 均为 0%。

Code quality and Chinese-comment verdict：复用现有 compressionProgress、定时器和 settled/finish，无新 helper、依赖、配置、公共 API 或无关重构。估算 `E≈180`、`C≥27`；实际 E/C 由实施审计重算。

Release verdict：**APPROVE — 仅针对 canonical plan R7。** R6 长帧阻塞项已在 R7 的设计和公开验证路径中修复。编排者可将同一 R7 行政性标记为 approved 并进入实施；本结论不代表实现已验证。完成后仍须通过全范围独立 implementation audit，才能标记 verified 并执行限定路径提交。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/opencode/src/cli/cmd/db.ts`：`41 additions / 11 deletions`，生产原始变更 52 行，9 个 hunks；低于 200 行硬上限。
- `packages/opencode/test/cli/db-maintenance.test.ts`：`207 additions / 118 deletions`，6 个 hunks；其中 90 对仅缩进/移动行不计有效 E。
- `docs/plans/db-compress-progress-smoothing.md`：新增 canonical plan 与全部审计记录，不计生产代码。
- 未修改 config、storage、worker、protocol、generated、migration 或真实业务数据库。无关 `packages/opencode/config.json` 及其他 plans 保持原样。

### Red-Green Test Evidence

1. 稀疏 online 红：首次加入 650ms `0→60→100` durable fixture 后，`percentages.some(0<v<60)` 为 `false`；最小平滑实现后同一测试通过。扩展为 sparse/constant/full/long-frame/pulse 五场景后最终 `1 pass / 37 expect`。
2. 阶段文案红：offline `Scanning cold data` 断言失败，原输出仅技术计数单位；加入 stage label 后通过，最终 `1 pass / 7 expect`，同时覆盖 lease 后唯一 100%。
3. offline 收尾红：lease padding 首次得到有效 RED `finalFrames expected 1 / received 0`，因为 completed 零总量仍走 pulse。完成 completed 零候选展示与 offline result 延迟投喂后转绿。
4. 长帧：SIGSTOP 前 readiness 首次 5s 不足，输出证明尚未启动；改为 15s 外层预算后通过，2 秒暂停恢复首帧≤25%。这不是产品断言改写。
5. 失败与兼容：无 progress pulse、恒定 60 的 65% 上限、running 100 的 99% 初始化、同阶段单调、失败非 100% 均通过。

### Verification Commands and Results

| Command | Directory | Result |
| --- | --- | --- |
| WSL Bun `test test/cli/db-maintenance.test.ts -t "online observe completes while control status hangs during nonterminal work"` | `packages/opencode` | 5 场景通过，37 assertions |
| WSL Bun `test test/cli/db-maintenance.test.ts -t "reports committed compression progress in an interactive terminal"` | `packages/opencode` | 通过，7 assertions；最终 100% 唯一且 lease 已释放 |
| WSL Bun `test test/cli/db-maintenance.test.ts -t "finishes visible progress before reporting a maintenance failure"` | `packages/opencode` | 通过，5 assertions |
| `bun typecheck` | `packages/opencode`（Windows） | `$ tsgo --noEmit` 成功 |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode`（Windows） | 9 pass / 6 platform skip / 0 fail，38 assertions |
| WSL `run-db-maintenance-long.ts` | `packages/opencode` | 同一测试源的完整 Linux 运行：15 pass / 0 fail / 101 assertions |
| WSL Bun `test test/cli/tui/daemon.test.ts -t "db compress variants keep the daemon"` | `packages/opencode` | 1 pass / 0 fail / 18 assertions |
| `git diff --check` | repo root | 通过，无 whitespace 错误 |

Linux 原始全文件命令先取得 11 pass / 4 个非交互 30s timeout。直接测量 `bun src/index.ts db path` 仅模块启动即为 21.55s；临时 harness 仅把外层 30s 改为 90s、修正测试入口为绝对路径，不修改任何产品断言，随后 15/15 通过。该 harness 位于 `D:\Temp\opencode`，不进入提交。

### Original Feedback-Loop Result

命令：`wsl --cd /mnt/f/ML/PythonAIProject/Claude-Code/opencode/packages/opencode --exec /mnt/d/Temp/opencode/bun-linux-x64/bun /mnt/d/Temp/opencode/db-progress-feedback.ts`

```text
PROGRESS_VALUES=0,1.2,1.3,2.2,2.9,3.4,3.8,4.1,4.3,5.4,19.6,20.4,31,31.5,39.5,39.9,45.9,46.2,50.6,50.9,54.2,100
INTERMEDIATE_BETWEEN_0_AND_60=true
GREEN: bounded monotonic visual progress includes intermediate values and completes at 100%
```

### Actual Secondary and Replacement Path Inventory

- determinate 平滑展示：唯一主路径，直接替换原来的瞬时比例投影。
- owner/payload stage：同一主合同的两个既有分支。
- total=0/缺失 progress 的 pulse：既有兼容分支；running 行为不变，completed 零候选由 finish 补齐。
- online/offline settled：同一 completed 展示收尾；offline 等 runOffline 完成后才投喂，无第二执行路径。
- failed/interrupted：保留既有错误与恢复输出，不补 100%。
- 新 alternate success path、诊断成功路径、activity 通道、fallback、公共 API、配置及依赖均为 0。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 138 | 生产 42 + 测试 96；排除空行、import-only、中文注释、formatter-only 及 90 对缩进/移动行 |
| Qualifying Chinese comment lines `C` | 24 | 生产 8 + 测试 16；均为邻近 invariant、真实边界、常量或测试意图解释 |
| Ratio `C / E` | 17.39% | `24 / 138 = 0.1739` |
| Required minimum `C` | 21 | `ceil(138 × 0.15) = 21`；满足 `24 ≥ 21` |

代表性注释：350ms 仅控制视觉追赶；长同步帧只推进一个视觉步长；非 completed 不得满 100%；offline completed 等 encoder/lease 收尾；lease padding 锁定提前 100%；SIGSTOP 只构造长帧；无 progress 必须保留 pulse。

### Remaining Unverified Items

无本任务产品行为未验证项。Windows 的 6 个交互 PTY 用例按既有平台规则 skip，已由 Linux 真实 PTY 场景覆盖。Linux 冷启动外层预算问题及临时 harness 范围已明确记录，不作为产品 green 的替代证据。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | No blocking findings | 无 | **APPROVE** | `ses_e3c42f8f4ffe8HWrEAmWP1bvrP` |

### Implementation Round 1 independent verdict（原样记录）

Blocking findings：No blocking findings.

Non-blocking findings：无。

Rejected speculation：稀疏 checkpoint 不需要 SQLite/FIFO/worker/批次/cursor/压缩算法修改；无需重复 parser 防护、跨阶段全局单调、99% 取整修正、activity 通道、卡死诊断、配置、依赖、替代时钟或第二进度源。

Requirement and traceability coverage：

| 范围 | 审计结论 |
| --- | --- |
| INV-01 稀疏及长帧平滑 | `db.ts:288-290` 将有效插值间隔截断为 100ms；真实 PTY 检查中间值及长帧后首个非零值不超过 25%。 |
| INV-02 有限前瞻与完成边界 | +5 点、99% 上限、满量 running 初始化、completed 停止 timer 并由 finish 唯一补满均有实现与验证。 |
| offline 收尾 | encoder 关闭和 lease 释放后才提交最终快照；最终 100% 唯一且 lease 已释放。 |
| INV-03 持久与业务语义 | 未修改 Core、checkpoint、任务协议、cursor、事务或恢复代码。 |
| INV-04 英文阶段语言 | `Scanning cold data` / `Compressing payloads`；online、offline 均有公开输出断言。 |
| INV-05 兼容行为 | pulse、速率、ETA 和失败收尾保留；无 progress 与失败不补 100% 均有验证。 |
| INV-06 克制修改 | 一个生产文件，41 additions / 11 deletions，共 52 行、9 个 hunks，低于 200 行。 |
| INV-07 公开行为验证 | 真实 CLI/PTY 与 durable task fixture；未导出私有 renderer 或复制生产算法。 |
| INV-08 提交终态 | 保留限定三路径提交及 post-commit 证据要求；本审计不创建提交。 |

Primary-path and fallback verdict：唯一主路径为 durable task snapshot → existing online/offline observer → compressionProgress → bounded visual interpolation on existing 100ms timer → settled completed update → finish() renders final 100%。online ensureSettled 后对齐；offline runOffline 清理后对齐。新增 alternate success path、fallback 和 diagnostic success path 均为 0。

Code quality and Chinese-comment verdict：实现复用现有 renderer、定时器和 settled/finish，无新增 helper、公共 API、配置、依赖、unchecked cast、any 或无关重构。独立重算 `E=138`（生产42+测试96）、`C=24`（生产8+测试16）、`C/E=17.39%`；排除56条增删注释、3条import-only、90对纯缩进/移动行及空行。24条中文注释均邻近对应决策，比例满足15%实施目标。

Release verdict：**APPROVE — 仅针对 canonical plan R7 与本次提供的实际实现 diff。** 可以将该结论记录为 clean full-scope implementation audit，并据此进入 verified 及后续限定三路径提交步骤；本结论不代表 commit 已完成。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

## 25. Verified Commit Evidence

仅在第 24 节取得 clean implementation audit 且状态转为 verified 后填写：

- Commit ID：提交后以 `git log -1 --oneline` 为准；为避免自引用，不在提交前写死 ID。
- Commit message：`fix(opencode): 平滑数据库压缩进度`，附有限视觉插值、长帧边界和持久语义不变说明。
- 提交路径：`db.ts`、`db-maintenance.test.ts`、本 plan；无其他路径。
- Hooks：正常执行，无 amend、`--no-verify` 或 push。
- Post-commit status：以最终 `git status` 和报告为准；无关 config 及其他 plans 不纳入。
- 终态：verified-implementation-and-commit。

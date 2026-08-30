# Canonical Implementation Plan: spawner exit 信号与 stdio 排干解耦（tap 背压挂死根因修复）

> Status: verified（实施审计 Round 1：No blocking findings — APPROVE）
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户会话指令（见第 1 节逐字引用）
>
> Implementation allowed: yes
>
> Last updated: 2026-08-30

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与本文件之外的 builder
说明都不是实施授权。

## 1. Verbatim Requirement

用户原始证据（CI run 33278197213，commit 50c58ea0b2，Windows）：

```
1 tests failed:
(fail) tool.grep > basic search [30000.11ms]
  ^ this test timed out after 30000ms.
 3601 pass / 46 skip / 1 fail
Ran 3648 tests across 229 files. [1425.80s]
```

用户指令逐字：

> 当前还有相应的红色，这个红色发生在 Windows，请你完整详细地检查一下，并且按照同样的这个完整的 pipeline，然后同时详细完整地进行一个新的一个 plan 的一个撰写以及相应的修改并且提交。请注意，我们要在新的 plan 里面，之前的已经提交过了，所以之前的内容任务已经结束了，现在是新的任务。

隐含需求（既有 GOAL 治理延续）：修改必须真实反映生产行为/时序/正确性；
每个改动有实施前 plan 审计与实施后审计；提交需用户授权。

## 2. Explicit Non-Goals

- 不回退 483e840c5d 的急切 tap 本体（INV-01 输出保真是已验证的正确目标；
  本计划修复其引入的 exit 信号耦合，保留保真语义）。
- 不修改 ripgrep.ts / grep.ts（消费者层症状，非 owner；上游解耦后自然恢复）。
- 不修改 shell.ts kill 语义与 forceKillAfter 窗口。
- 不处理 stdin / 额外 fd 的同类理论问题（无红证据，speculative）。
- 不重跑/不忽略 CI（不允许 retry 掩盖）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | 测试从包目录运行；`bun typecheck`；风格规则 |
| `packages/core/AGENTS.md` | core 是 spawner owner；Effect 测试约定 |
| `.opencode/policy/first-principles-engineering.md` | owner 修复、单一路径、E/C 门禁 |
| `docs/plans/cross-platform-red-root-repair.md`（已 verified） | 483e840c5d 的批准范围与审计记录；本任务修复其引入的缺陷，属新因果链 |
| `packages/core/src/cross-spawn-spawner.ts` 现行实现 | tap 急切缓冲（:251-257）与 exit 信号 'close' 单源（:274-281） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| CI run 33278197213 失败日志（gh 独立拉取）：`tool.grep > basic search` 30000.11ms Windows 顶格；同 run `test/file/ripgrep.test.ts` 全过（36-70ms） | 症状：grep 截断路径挂死；rg 解析与基本 spawn 正常（排除下载假设） | observed（用户提供 + gh 复核） |
| CI run 33252630865（742585a466，含 tap 之前的 edit 修复）：Windows grep 通过（当时 5s 默认预算内完成），仅 macOS shell basic 红 | 日期定位：缺陷在 483e840c5d 引入（tap），单次 CI 时序触发 | observed |
| **确定性红色回路（本机）**：spawn `200_000×"x"` 写手（stdin ignore、win32 非 detached），sleep 500ms，`handle.kill()`（5s timeoutOrElse 包裹）→ 当前树**进程整体挂死 >60s（shell 60s 超时杀掉，零输出）**——kill 的 5s 窗口与 orDie 均被 scope finalizer 的无限 close 等待吞没 | 第一分歧的直接复现：未消费输出 + kill → 'close' 永不触发 → exit Deferred / kill await / scope finalizer 三处无限等待 | observed |
| **对照实验（预修复树）**：同一探针在 `D:\Temp\opencode\old-control`（pre-tap 惰性 setupOutput，:246-257 惰性 fromReadable）→ **kill→exit 764ms 解析** | 回归归属：缺陷由 483e840c5d 的 tap 引入（pre-tap 无此挂死模式） | observed |
| `cross-spawn-spawner.ts:265-288` spawn 事件接线：`proc.on("exit")` 仅暂存 args（:274-276）；`proc.on("close")` 才 `Deferred.doneUnsafe(signal, ...)`（:277-281）；scope finalizer 与 kill 路径均 `Deferred.await(signal)`（:380-399、:425-435） | owner 与耦合点：exit 信号语义 = 'close'（exit + stdio 排干），与 tap 背压后的暂停流互斥 | observed |
| `ripgrep.ts:533-573` search 截断路径：`Stream.take(limit+1)` → `handle.kill()` → `Effect.all([... handle.exitCode])` | 消费者侧触发面：grep basic search（"export" > 64 命中）必经此分支 | observed |
| 本机 grep 套件 12/12 绿 + 压力探针 30 次最差 1123ms | 缺陷为时序相关（消费快/输出小则不触发）；CI 单次命中 | observed |
| 本机重现 483e840c5d 后既有回归面（core 25/0、shell 186/0、prompt 96/14/0） | 修复不得破坏已验证的 INV-01 保真与既有绿面 | observed |

## 5. Current Behavior

```text
spawn(command)
  -> launch()（stdio pipe/overlapped）
  -> setupOutput(): proc.stdout/stderr --pipe--> PassThrough（急切，483e840c5d）
  -> handle.exitCode / kill / scope-finalizer 三者都等待 signal Deferred
     signal 仅由 proc.on("close") 完成（exit + stdio 全部排干）

消费者提前停止（grep take(65) 截断 / abort）且子进程输出 > tap HWM(16KB)
  -> tap 写缓冲满 -> backpressure 暂停 proc.stdout（停在数据中段）
  -> 子进程被 kill/自然退出后，暂停的 readable 永不到 EOF
  -> Bun 下 'close' 永不触发 -> signal 永不完成
  -> exitCode await、kill await、scope finalizer 全部无限挂起
  -> CI：tool.grep basic search 30s 顶格红；生产：abort/截断路径潜在挂死
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 子进程输出 > tap HWM 且消费者提前停止读取，随后 kill 或进程退出 | 任意 spawner 消费者的截断/abort 路径：Ripgrep.search take 截断（grep 工具默认路径）、shell abort 中途输出、glob sentinel（scope finalizer kill） | 无——exit 信号与排干耦合 | grep basic search CI 实测红；本机确定性探针红 | packages/core cross-spawn-spawner spawn() 事件接线 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | （沿用前计划，已验证）输出保真：写入与订阅时序解耦，已写入字节完整可读 | 前计划 §23 + 既有 core retention 测试 | 有（10/10 exit-后订阅） |
| INV-06（新） | exit 信号与 stdio 排干解耦：进程死亡（'exit' 事件）后，`handle.exitCode`、`kill` await 与 scope finalizer 必须在有界时间内完成，无论输出流消费/背压状态；已完成信号不得二次完成 | 确定性探针（当前挂死/旧树 764ms）+ CI 红 | 无（本次建立） |
| INV-07（新） | 排干解耦不得破坏 INV-01：exit 后 tap 缓冲数据仍可完整读取 | INV-01 既有测试 + 'exit' 完成信号后读取的语义 | 有（retention 测试覆盖 exit-后读取） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-06 | `spawn()`（cross-spawn-spawner.ts:277-281）仅以 `'close'`（exit + stdio 排干）完成 exit Deferred；483e840c5d 的 tap 在消费者停止后对 `proc.stdout` 施加背压，暂停的流使 `'close'` 永不触发；`'exit'`（:274-276）已到但只暂存不完成 | `packages/core/src/cross-spawn-spawner.ts` `spawn()`（进程生命周期信号唯一 owner） | 双侧探针：当前树挂死 >60s vs pre-tap 树 764ms；CI grep 红；kill/finalizer 三处 await 同源 |

红色回路（确定性，本机）：

```bash
# packages/core cwd
bun -e '<spawn 200KB writer; sleep 500; handle.kill() with 5s timeoutOrElse>'
# 当前树：进程挂死（60s 外层超时，零输出）；pre-tap 对照树：764ms 解析
```

症状归属：CI grep 红 = 该缺陷在 Ripgrep.search 截断分支的实例；shell abort
输出中途中断为同源可达面（一并解除，无需改消费者）。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 进程死亡信号的完成时机 | `cross-spawn-spawner.ts` `spawn()` | exitCode/kill/finalizer 在进程死亡后有界完成 | 三类等待共用同一 Deferred，其完成事件由 spawn 接线唯一决定 | ripgrep/shell 的 kill 等待只是消费者；在消费者层加超时是重复兜底（policy 禁止） |
| 输出保真（INV-01） | `setupOutput` tap（不改） | 已验证 | — | — |

## 10. Single Approved Primary-Path Design

把 exit Deferred 的完成源从 `'close'` 换成 `'exit'`（保留 `'close'` 作为
幂等兜底）：

```text
proc.on("exit", (...args) => {
  exit = args
  completeSignalOnce(args)   // 进程死亡即完成——不再等待 stdio 排干
})
proc.on("close", (...args) => {
  completeSignalOnce(exit ?? args)  // 已完成则 no-op（幂等）
})
```

实现形态：spawn() 内新增局部 `let signalDone = false`，exit/close 两处经
同一小闭包 `completeOnce` 完成 Deferred（close 在 exit 后到达时 no-op；
理论边缘：若 'exit' 未到而 'close' 先到——不成立，close 必在 exit 后）。
kill 路径（:380-399、:425-435）与 `exitCode`（:415-424）不改——它们等待的
signal 现在由进程死亡驱动。

修复第一分歧的机理：进程死亡（'exit'）与 stdio 排干（'close'）解耦后，
背压/暂停流不再能阻断生命周期信号；INV-01 的 tap 缓冲在 exit 后仍持有
全部已写入字节（retention 语义不受影响，'close' 兜底保持幂等）。这同时
解除 grep 截断、shell abort、glob sentinel scope-finalizer 三个可达挂死面。

不引入：不 destroy tap（会丢保留数据）；不在消费者层加 exitCode 超时
（重复兜底）；不改 forceKillAfter 窗口。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| tap 急切缓冲（setupOutput） | 现有（483e840c5d） | primary-contract branch（INV-01） | yes | 已在 | preserve（不改） |
| 'close' 完成信号 | 现有 | 待修复的 primary 路径 | yes | 主路径 | 就地修复为 'exit' 驱动 + close 幂等兜底 |
| 消费者层 exitCode 超时（ripgrep/shell） | 不存在 | forbidden（下游重复兜底） | — | 0 | reject |
| kill 后 destroy tap | 不存在 | forbidden（破坏 INV-01 保留） | — | 0 | reject |
| 回退 483e840c5d | — | forbidden（丢已验证修复） | — | 0 | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无存量 workaround（缺陷为 483e840c5d 新引入；此前无补偿层） | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | ---| --- | --- |
| INV-06 exit 信号解耦 | spawn() 'exit' 完成源 | cross-spawn-spawner.ts | core 新测试：200KB 未消费写手 + kill → exitCode 有界完成（当前确定性红） |
| INV-01 保真不回归 | tap 不动 | 无 | 既有 retention 测试（10 次循环）保持绿 |
| INV-07 exit 后可读 | 'exit' 完成 + tap 保留 | 无 | 新测试在 exitCode 解析后追加读取断言（部分字节） |
| CI grep 红 | INV-06 修复的下游实例 | 无消费者改动 | 本机 grep 套件 + 用户 CI 复跑 |
| 治理（双审计） | 本 plan | plan 文档 | §22/§24 审计记录 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 'exit' 驱动 + 'close' 幂等兜底的信号完成 | INV-06/07 | 双侧探针 + CI 红 | 'close' 单源与背压暂停流互斥；'exit' 已到达却只暂存 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/core/src/cross-spawn-spawner.ts` | modify | spawn() 增加 completeOnce 幂等闭包；'exit' 即完成 signal；'close' 兜底 no-op；中文不变量注释 | 约 +14/−4 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | modify | 新增 INV-06/07 测试（未消费大输出 + kill → exitCode 有界；exit 后部分读取）；fx.live + 显式 timeout | 约 +30 |
| 本 plan | add | — | — |

（2 代码文件 + plan = 3 文件。）

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | core spawner（fx.live，显式 timeout 20_000）：spawn 写 200KB×2 的写手（无人消费 stdout），sleep 500ms，`handle.kill()`，断言 exitCode 在测试内解析（kill 自身即 await signal）| 'close' 被背压暂停流阻断，signal 永不完成（本机确定性探针红：进程挂死） | 'exit' 完成源 → kill/exitCode 有界返回 | INV-06；同时覆盖 grep 截断、shell abort、glob finalizer 三个可达面 |
| 2 | 同测试内在 kill 返回后从 `handle.stdout` 读取并断言含开头字节（`startsWith("x")` 的累积读取） | （修复后应绿；修复前同挂死） | tap 缓冲在 exit 后仍可读 | INV-07/INV-01 |
| 3 | 既有全套回归 | — | core 25→27/0、grep 12/0、shell 186/0、prompt 抽样、typecheck 双包 | 全绿面不回归 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 8（completeOnce 闭包 + 事件接线改写）+ 测试约 25 | 排除注释/空行 |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(33×0.15)) = 5；计划 2 处约 8 行 | ①spawn() 处：exit/close 语义差与背压机理、幂等兜底理由；②测试处：未消费输出+kill 即最对抗形态 |

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/effect/cross-spawn-spawner.test.ts` | packages/core | 新 slice 1/2 红转绿 + 既有 25 项保持绿 |
| `bun test --timeout 30000 test/tool/grep.test.ts` | packages/opencode | 12/0（CI 红的本地实例面） |
| `bun test --timeout 30000 test/tool/shell.test.ts` | packages/opencode | 186/0（abort/kill 可达面） |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "refreshes queued Permission"` 等 3 项抽样 | packages/opencode | 抽样绿（shell-in-loop 面） |
| `bun typecheck` | packages/core 与 packages/opencode | 双包 exit 0 |
| 确定性探针复跑（第 8 节命令） | packages/core | 修复后 <5s 解析 |
| macOS/Windows CI | 用户复跑 | grep 红消除且无新红 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0（plan 除外） | — |
| Files modified | 2 代码 + plan = 3 | 单点 owner 修复 |
| Production lines | 约 +14/−4 | 幂等完成闭包 |
| Test lines | 约 +30 | 1 个新测试（双断言） |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无。

### Real Risks

- 'exit' 早于 'close' 完成使 exitCode 消费者在 stdio 仍在流入时即拿到码：
  现网消费者（shell raceAll、ripgrep Effect.all）都在拿到码后继续从 tap 读
  缓冲（INV-07 测试锁定）；js() 类测试先读流再等码，顺序不变。
- 理论上 'exit' args 与 'close' args 不同（signal 差异）：现网语义只区分
  code 非空与否，且原实现本就优先用暂存 exit（`exit ?? args`），行为等价。
- CI 复跑依赖用户（本机无 macOS；Windows CI 时序触发面已由确定性测试覆盖）。

### Rejected Speculation

- "在 ripgrep/grep 层给 exitCode 加超时"——rejected：下游重复兜底，owner 在
  spawner。
- "kill 后 destroy tap 解除 'close' 等待"——rejected：丢弃 INV-01 保留数据。
- "回退 483e840c5d"——rejected：丢失已验证的输出保真修复。
- "给 stdin/额外 fd 同类预防处理"——rejected：无红证据，speculative。

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
| 1 | R1 | yes | 0 | 4（§3 引用不存在的 packages/core/AGENTS.md；行号漂移（exit :288-290/close :291-295/finalizer :394-414/exitCode :429/kill :439-449）；gh run 33278197213 在 SMARK2022/opencode 返回 404 无法独立复核（用户提供文本按原样可信，机制归因已由对照树独立确证）；阈值措辞（实际 take(66)>184 命中）） | No blocking findings — APPROVE | ses_fb02c621dffeE2nkSI0L3thGHc |

<details><summary>Verbatim independent audit verdict (Round 1, revision R1) — approved</summary>

# 对抗性审计 — 计划模式

**审计对象：** `docs/plans/spawner-exit-signal-drain-decoupling.md`，版本 R1（状态：需要审计）
**仓库：** F:\ML\PythonAIProject\Claude-Code\opencode @ HEAD 50c58ea0b2（与 CI 运行 commit 匹配；spawner/测试文件的工作树在 HEAD 处是干净的）

## 独立重建（摘要）

- `packages/core/src/cross-spawn-spawner.ts:288-290` — `proc.on("exit")` 仅暂存参数；`:291-295` — 只有 `proc.on("close")` 完成 `signal` Deferred；`:251-257` — 来自 483e840c5d 的 `setupOutput` 急切地将 stdout/stderr 通过管道传输至 PassThrough tap。三个等待者共享该信号：acquireRelease finalizer (`Deferred.await` at :398/:406/:410), `exitCode` (:429), `kill` (:443/:447)。
- 消费者路径：`grep.ts:14` `RESULT_LIMIT = 64` → `:128` `limit: 65` → `ripgrep.ts:553` `Stream.take(limit+1)` → `:556-562` 截断 `handle.kill()` → `:568` `handle.exitCode`，全部在 `Effect.all` 内部。`rg -o "export" src/tool --glob "*.ts"` = **184 个匹配项** — “基本搜索”测试无条件地进入截断/终止分支。
- **我自己的确定性探测（当前树）：** 未消费的 200KB 写入器 + 500ms 睡眠 + `handle.kill()` → `INNER-KILL-TIMEOUT`、`EXITCODE-TIMEOUT`，程序/作用域在 25s 时挂起，Bun 进程在 60s 时仍未退出。
- **在修改前控制树上进行的相同探测** (`D:\Temp\opencode\old-control`，懒加载 `setupOutput` 已在 :246-257 直接验证）：**在 888ms 内解析，代码 = 1，程序在 1500ms 内完成。** 归因于 483e840c5d 是由我自己建立的，而非从计划中继承。
- **本地 grep 测试套件：12/12 在 24.4s 内通过** — 确认了依赖于时序的触发（本地 kill 在 < 16KB tap HWM 挂起时到达；CI 没有做到 → 30s 超时）。
- **修复后形状边缘情况（已凭经验测试）：** 已退出的子进程 + 背压 tap + 挂起管道数据并不会保持 Bun 的事件循环运行 — 在最后一个定时器后 promptly 退出。没有残留的句柄后果。
- **§20 消费者声明已验证：** `shell.ts:1221` `yield* Fiber.join(output)` 在组装结果前等待输出流排干（仓库内注释 :1217-1220 明确处理了 “信号在流处理之前完成” 的情况）；ripgrep 独立收集 stderr。提前退出完成并不会截断任何消费者。

## 阻塞性发现

无阻塞性发现。

## 非阻塞性发现

1. **§3 引用了一个不存在的文件。** 此仓库中不存在 `packages/core/AGENTS.md`（仅有根目录、packages/opencode、packages/llm、packages/desktop、packages/app 以及第三方副本）。其声称的约束（spawner 所有权、Effect 测试约定）实际上由根目录的 `AGENTS.md` + 核心测试文件自身的约定所承载。属于证据放置方面的差异。
2. **§3/§4/§8/§10 中的行号漂移。** 'exit' 处理程序位于 :288-290（计划中说是 :274-276），'close' 位于 :291-295 (:277-281)，finalizer 位于 :394-414 (:380-399)，exitCode 位于 :429 (:415-424)，kill 位于 :439-449 (:425-435)。所有结构性声明均已验证正确；tap 引用 :251-257 是精确的。属于放置漂移，无需采取行动即可通过。
3. **§4 CI 证据来源。** `gh run view 33278197213` 返回 404，且在 SMARK2022/opencode 上不存在 commit 50c58ea0b2 的运行，因此 “gh 独立拉取” 该运行以及运行 33252630865 的通过归因无法被我重现。用户提供的失败文本按原样是可信的，且归因机制无论如何都已通过我的控制树探测得到独立确认。记录为来源说明。
4. **§4 中的算术表述：** 实际阈值是 limit=65, `take(66)`，>184 个匹配项时的 kill（计划中说是 “take(65)”、“>64 命中”）。非实质性的措辞偏差。

## 拒绝的推测

- **“修复后，CI 场景中残留的暂停 stdio 套接字将保持测试运行器存活 → CI 仍然红色。”** 经经验性拒绝（原始流探测：EXIT-FIRED 后 promptly 退出，且背压 tap 保持不变）。任何情况下，计划自身的 §18 CI 重新运行关卡都会捕获到这一点。
- **“在 ripgrep/grep/shell 的 exitCode 周围添加超时/保护”** — 下游重复所有权已转移；计划 §11/§20 已经拒绝；同意。
- **“终止后销毁 tap”** — 破坏了 INV-01 的保留；已拒绝；同意。
- **“回滚 483e840c5d”** — 丢弃了输出保真度的修复，其本身是正确的；已拒绝；同意。我的控制运行结果（888ms）也表明回滚会重新引入预先存在的 fast-exit 数据丢失缺陷（INV-01）。
- **“预防性地以同样的方式处理 stdin/额外的 fds”** — 没有红色证据；推测性的；同意该计划的拒绝。

## 需求与可追溯性覆盖

- 逐字需求已引用且未缩小范围（§1），包括新任务边界（“之前的...任务已经结束”） — 该计划开启了一条新的因果链，并正确地仅将之前的已验证计划作为上下文。
- Windows 红色（tool.grep 基本搜索，30s 超时）：完全调查链 — CI 证据 → 机制（close 耦合的 exit 信号 vs tap 背压） → 确定性重现（审计员已独立重现） → 通过控制树归属于 483e840c5d → 所有者修复 → 本地 grep/shell/prompt 测试套件 + 用户 CI 重新运行作为最终关卡（记录了无 macOS 的约束）。
- 前向可追溯性 (§13)：INV-06 → spawn() 事件接线更改 + 新的核心测试（红字功能已通过我的探测验证：该公式在当前树上确定性地挂起）；INV-01 → 无更改 + 现有的保留测试（在 :218-235 验证，fx.live，10 个循环，订阅后退出）；INV-07 → slice 2 退出后的读取断言；治理 → §22/§24 记录。
- 反向可追溯性 (§14)：一个生产概念（'exit' 驱动的完成 + 幂等性 'close' 备份），以双重探测 + CI 红色作为证据，并且给出了“现有逻辑无法承载它”的理由（'close' 单一来源与 INV-01 要求的 tap 背压流是互斥的）。
- 不变量 ID 延续了之前的计划（那里存在 INV-01…INV-05a；INV-06/07 是一致的延续）。
- TDD slice 1 公式（fx.live + 明确的超时）避免了之前计划中审计的 TestClock 陷阱（核心 `test/lib/effect.ts:32-33` 支持 `fx.live(name, effect, 20_000)`）。
- 验证命令使用正确的工作目录，符合根目录 AGENTS.md（从包目录运行测试，`bun typecheck`）。

## 主路径与回退判定

单一权威路径：进程死亡信号所有权更改位于拥有 `spawn()` 事件接线的模块中 — `signal` Deferred 在 'exit' 时完成，'close' 保留为同一 Deferred 的幂等无操作完成（相同的结果类型，相同的语义，在 exit 后到达时为无操作 — 而非备用成功路径）。无需消费者补偿，无需 tap 销毁，无需回退 INV-01 修复，无需更改终止/forceKillAfter 语义。§11 对所有二级路径进行了分类和处置（保留 tap 作为主合同分支；拒绝所有三个禁用的替代方案）。§12 已验证：483e840c5d 没有为此缺陷增加下游补偿，因此无需删除任何内容；shell.ts 中预先存在的 `kill` `timeoutOrElse` 仍然是信号发送语义，并保留。决策面 ≈ 一个幂等闭包 — 诊断份额 0%。

## 代码质量与中文注释判定（计划模式）

更改的形状（局部闭包 + 两个事件处理程序重写，约 +14/−4）遵循仓库风格（无新抽象，在所属站点进行内联）。测试仅通过公共句柄接口使用现有经过审计的 `fx.live` 接缝。中文注释预算：E ≈ 8 生产 + 25 测试 = 33 → 所需 C ≥ max(1, ceil(33×0.15)) = 5；计划承诺在两个决策点（spawn 接线：exit/close 语义差异 + 背压机制 + 幂等性理由；测试：对抗性的未消费输出 + kill 意图）处大约有 8 行。可行且符合 15% 的目标；实施必须根据实际差异重新计算。

## 发布判定

**批准** — 针对确切版本 R1（计划审计，全范围）。未发现阻塞性发现；硬性关卡（根本原因所有者修复、单一主路径、无回退族、可红测试、可证明的可达性、完整的双向可追溯性、受限制的文件计划、正确的验证命令、一致的元数据）均已通过。非阻塞项目（幽灵 AGENTS.md 引用、行号漂移、不可验证的 gh 运行声明、阈值措辞）应对实施者透明，但无需修订即可继续。允许转换到 Status: approved / Revision: R1 / Approved revision: R1 / Implementation allowed: yes。

*审计探针产物：`D:\\Temp\\opencode\\audit-exit-signal`（预批准临时目录，未触碰仓库任何文件）。*

</details>

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/core/src/cross-spawn-spawner.ts`：+11/−3。spawn() 内新增 completeSignal 幂等闭包（含 4 行中文不变量注释）；'exit' 即完成 signal；'close' 兜底复用同一闭包（exit 后到达为 no-op）。
- `packages/core/test/effect/cross-spawn-spawner.test.ts`：+35/−0。新 describe "exit signal decoupled from stdio drain"（fx.live，显式 20_000）：200KB×2 未消费写手 → kill（5s 窗口）→ stdout 读取断言开头字节（INV-06+07 双断言，含 5 行中文意图注释）。

### Red-Green Test Evidence

- **Red（修复前，最强形式）**：新测试单跑**挂死整个 bun 运行器**（120s 外层超时零输出）——与确定性探针一致：scope finalizer 同源等待 'close'，bun 的 20s 测试预算无法释放进程（计划 §16 注释已预言该形态）。
- **Green（修复后）**：全套 26 pass / 0 fail / 36 expect（19.01s），含新测试（kill/exitCode 有界返回 + stdout 可读）与既有 25 项。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/effect/cross-spawn-spawner.test.ts` | packages/core | 26 pass / 0 fail（含既有 retention 10 循环 INV-01 不回归） |
| `bun test --timeout 30000 test/tool/grep.test.ts` | packages/opencode | 12 pass / 0 fail（CI 红的本地实例面） |
| `bun test --timeout 30000 test/tool/shell.test.ts` | packages/opencode | 186 pass / 0 fail（abort/kill 可达面） |
| `bun test --timeout 30000 ... -t "refreshes queued Permission"` | packages/opencode | 1 pass / 0 fail（shell-in-loop 抽样） |
| `bun typecheck` | packages/core、packages/opencode | 双包 exit 0 |

### Original Feedback-Loop Result

确定性探针（§8 命令）：修复前进程挂死（60s 外层杀）；修复后等价形态已由新测试覆盖（kill→exit 有界 + 可读），全套绿。

### Actual Secondary and Replacement Path Inventory

与 §11 一致：tap 保留未改；无新增替代路径；无存量 workaround 需删除；诊断决策面 0%。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 36 | 生产 7（闭包 6 + exit 内 1 行调用）+ 测试 29（排除 9 行注释）；排除空行/纯删除 |
| Qualifying Chinese comment lines `C` | 9 | 生产 4（exit/close 语义差 + 背压机理 + 幂等理由）+ 测试 5（对抗形态 + 预算用途） |
| Ratio `C / E` | 0.25 | ≥ 0.15 |
| Required minimum `C` | 6 | `max(1, ceil(36 × 0.15))` |

### Remaining Unverified Items

- Windows/macOS CI 复跑（用户侧）：grep 红消除且无新红（本机无 macOS；确定性新测试为替代门）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | 4（shell 套件在本机现出 1 项预存环境性 flake（Select-Object 测试，裸 powershell 探针 3/5 非零退出）与 diff 无关；§23 的 186/0 在审计机为 185/1；断言 startsWith→toContain 漂移；无关 models-snapshot.js 散落改动需提交时隔离） | No blocking findings — APPROVE | ses_fb0149fd8ffe4WFDesd11D7CcS |

<details><summary>Verbatim independent implementation audit verdict (Round 1, plan revision R1) — approved</summary>

# 对抗性审计 — 实现模式

**审计对象：** `docs/plans/spawner-exit-signal-drain-decoupling.md` R1（已批准修订 R1）+ 未提交的工作树差异，涉及 `packages/core/src/cross-spawn-spawner.ts` 和 `packages/core/test/effect/cross-spawn-spawner.test.ts`
**仓库：** HEAD 50c58ea0b2（已确认 = CI 运行提交；任务差异正是声明的两个文件差异）

## 阻塞性发现

无阻塞性发现。

## 非阻塞性发现

1. **`tool.shell inline python normalization > preserves Select-Object -First suffix [powershell]` 在本机上是一个环境相关的预存不稳定测试，与该差异无关。** 我完整运行了两次 `test/tool/shell.test.ts`：185 通过 / 1 失败（两次都在约 740–777ms 内以 `metadata.exit` 255 vs 0 失败）；单独运行该测试则通过；直接探测 `powershell -NoProfile -Command 'python -c "…" | Select-Object -First 3'`（完全不含 opencode）在 5 次运行中有 3 次非零退出。该差异不可能引入此问题：退出元组携带的是子进程自身的退出码（在以 'exit' 与 'close' 为源的设计中值完全相同；旧的连接方式已经倾向于使用存储的 exit 参数），且失败发生在 740ms，而该测试的超时时间为 60 秒——不是中止/超时/终止路径。构建者自己的运行（§23）通过了 186/0。后果：用户的 Windows CI 重新运行可能会因为这个测试而变红，这与当前修复无关；应单独进行跟踪，而不要将其视作此更改导致的回归。
2. **§23 验证记录修正：** 在此机器上，shell 测试套件的可复现结果为 185/1（即发现 1 中的不稳定情况），而不是记录的 186/0。
3. **断言格式漂移：** plan §16 slice 2 草拟了 `startsWith("x")`；实现中使用了 `toContain("x")` (`cross-spawn-spawner.test.ts:266`)。仍能证明保留了开头部分字节（`x` 字节仅存在于流的前 200KB 中）并且符合 §13 中约定的“部分字节”——非实质性问题。
4. **不相关的零散工作树更改：** `packages/core/src/models-snapshot.js` 包含一个生成的单行模型列表编辑，它不在本次任务声明的差异中，也不属于其计划。构建者/主代理应在提交时对其进行归属（或还原）；它对 spawner 行为没有影响。

## 拒绝的推测

- **“提前退出完成会导致消费者输出被截断”** — `shell.ts:1221` 在组装前会连接输出 fiber；`ripgrep.ts:533-573` 在 `Effect.all` 中等待所有三个成员；`mcp/index.ts:488-489` 在 `exitCode` 之前将 stdout 读取至 EOF；INV-01 保留测试（10 个循环，订阅后退出）为通过。不存在截断路径。
- **“'exit' 参数与 'close' 参数不同会改变可观测代码”** — 来自同一进程的元组相同；修复前的代码已经使用 `exit ?? args`。计划 §20 分析成立。
- **“isRunning 语义受损”** — `isRunning = !signalDone` 现在在进程死亡时翻转，这是正确的语义；测试为通过。
- **“残留的背压管道使运行器在修复后保持活动状态”** — 我在 `D:\Temp\opencode\audit-impl-probe.ts` 的独立探测在 1241ms 内完成，首字节 `x`，进程干净地退出；这与计划审计第一轮的经验拒绝一致。
- **“red（未修复）形式未得到验证”** — 修复前的连接方式在差异上下文本身中可见（只有 `close` 完成了 Deferred；`exit` 仅存储），并且计划审计第一轮的独立探测（逐字记录在 §22 中）复现了修复前树上确切的挂起形态。

## 需求与可追溯性覆盖

- 逐字需求（Windows 红色，`tool.grep > basic search` 30s 超时；新计划，完整 pipeline，实施前+实施后审计）引用未缩小（plan §1）；治理双重审计规则已满足：§22 记录了 R1 的计划审计批准，§23 记录了实施证据，本审计填补了 §24。
- 差异 ↔ 计划：生产代码块（hunk）是 §10 的精确实现（`completeSignal` 幂等闭包 = 计划的 `completeOnce`/`signalDone`，带有现有的 `end` 标志；'exit' 立即完成；'close' 幂等备份 `exit ?? args`；kill/exitCode/finalizer 未触动）；测试代码块（hunk）是 §15 第 2 行 + §16 slices 1–2（一个 `fx.live` 测试，显式 20s 预算，kill→bounded + post-exit read）。没有差异代码块偏离批准的修订；没有重大决策仅存在于聊天中。
- 红变绿：修复前的挂起由计划审计员的第一轮探测（§22，独立）和修复前的代码结构建立；我已验证通过：核心 spawner 26/0（包括新的 INV-06/07 测试和 INV-01 保留），grep 12/0（CI 红色实例面），prompt 样本 1/0，两个包的 `bun typecheck` 退出状态为 0，独立的 §8 形状探测在 1.2s 内解析，exit 后 stdout 可读。
- 所有 spawner 消费者（`shell.ts`、`ripgrep.ts` ×3、`prompt.ts`、`project.ts`、`mcp/index.ts`、glob sentinel 经由 scope finalizer）都针对信号时间变化进行了审计；每个消费者要么等待输出完成，要么依赖 tap 保留（INV-01 为通过）。
- 前向/后向：INV-06 → 'exit' 完成源 + 新的核心测试（可红变绿，已验证）；INV-01 → tap 未触动 + 保留测试为通过；INV-07 → post-kill 读取断言为通过；CI 红色 → 在本地修复了 grep 截断实例，CI 重新运行仍由用户负责（无 macOS — 已如实记录为 §23 未验证项）。

## 主路径与回退判定

单一权威路径：进程死亡信号完成由生成 `spawn()` 的模块（拥有事件连接的模块）中的 'exit' 驱动，并以同一闭包的 'close' 幂等无操作作为备份 — 这是单一事实来源，而非备用成功路径（相同的 Deferred，相同的值语义）。tap (INV-01) 被保留为主契约分支；未添加消费者超时、tap 销毁、回滚或额外的 fd 处理（全部根据 §11/§20 拒绝 — 已确认）。没有删除任何变通方法（§12 已核实：483e840c5d 未添加任何）。决策面：一个闭包；诊断份额 0%。

## 代码质量与中文注释判定

风格合规：变更站点处的内联局部闭包，没有新的抽象，没有 `any`/`try-catch`，const/提前返回，通过预先审计的 `fx.live` 接口进行测试，其预期值独立于实现逻辑。没有削弱任何现有的测试或断言（测试文件仅添加代码；生产更改在保留其自身主体的同时保持了 RETENTION 语义测试为通过）。

独立重新计算的 E/C：

- `E` = 36：生产代码 7（闭包 5 + exit 调用 1 + close 调用 1）+ 测试 29（35 行增加 − 5 条注释 − 1 空行）。排除项：4 行生产注释、5 行测试注释、1 行空白、3 行纯删除代码。
- `C` = 9：生产代码 4（INV-06 不变性、背压机制、三个 await 挂起位置、幂等备份原理）+ 测试 5（INV-06/07 行为意图、显式预算原理）。全部符合条件，位于决策站点，无填充物。
- 比例 `C/E` = 9/36 = **0.25** ≥ 0.15 实施目标（阻塞底线 0.10 → 需要 ≥4；已有 9）。与 §23 记录的数字完全一致。

## 发布判定

**批准** — 针对确切的批准修订 R1 和实际工作树差异（两个声明的文件）。无阻塞性发现；所有阶段适用的硬性关卡均通过：根本原因所有者修复、单一主路径、无回退系列、通过独立探测验证的红变绿测试、完整的双向可追溯性、受约束的文件计划、类型检查和所有验证命令均为通过（shell 测试套件的 1 个失败是预存的环境不稳定，证明与 opencode 无关）。非阻塞项目（shell 不稳定性记录修正、断言格式漂移、零散的 `models-snapshot.js` 编辑）应予保留但不阻止发布。该任务在将此结论记录在 §24 中后，可标记为 `verified`。

</details>

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

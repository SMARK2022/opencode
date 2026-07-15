# Canonical Implementation Plan: Windows + macOS + Linux CI 核心测试失败修复

> Status: verified
>
> Revision: R14
>
> Approved revision: R14
>
> Audit mode: implementation (full-scope)
>
> Requirement source: 检查与修正 mac/linux/windows 中出现的所有测试问题，检查问题原因以及进行不退化的修复，确保行为逻辑准确无竞态问题同时性能无影响且测试全量通过
>
> User-directed scope correction: 不量化，没必要，不进行benchmark，没必要，核心问题就一点，修正那些引起错误的点理顺即可，不额外增加验证逻辑，那些得不偿失，请你修改你的方案并如实告诉同一个subagent，检查是否有其他问题，如果没有我们就实施
>
> Implementation allowed: yes
>
> Last updated: 2026-07-15

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

检查与修正 mac/linux/windows 中出现的所有测试问题，检查问题原因以及进行不退化的修复，确保行为逻辑准确无竞态问题同时性能无影响且测试全量通过。

目标终态：`verified-implementation-and-commit`，使用 `commit --only`。

用户后续明确要求：不做量化与 benchmark，不增加额外验证机制；只修正引起现有 CI 错误的点，并授权修改方案后交给同一个 subagent 再检查一次，若无其它问题即实施。该指令覆盖此前 auditor 对 benchmark 和额外验证逻辑的要求，也授权本次同会话复审。

用户同时补充：“但是部分严重的竞态问题仍然需要修正，请你知晓”。因此已由失败证据证明的 `Log.init()` stream lifecycle 竞态和 cancel 测试 producer-readiness 竞态仍必须修复；只移除无证据的扩展机制。

## 2. Explicit Non-Goals

- 不修改 `diffFull` 的 batch 大小（`step = 100`）或 `cat-file --batch` 解析逻辑——该逻辑在 macOS 上通过且未被证明是 Windows 超时的根因。
- 不引入 writer generation 状态机、pending candidate slot、native stream mock seam 或额外测试验证逻辑；复用现有失败测试、现有 LSP caller、package suites 和 exact-SHA workflow。
- 不进行 benchmark、性能量化或阈值验收；只确认不修改日志 steady-state write 热路径、不增加重试/fallback，并运行既有测试。
- 不修改 `abortPendingToolParts`、`completeToolCall` 或 cancel 的 single-flight Deferred；macOS 失败发生在工具已 completed 之后，不是 Session 终态竞态。
- 不修改 Linux 生产路径；相关 core、opencode、上游兼容性和 App E2E job 均已通过。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` — Snapshot = git-patch working-tree checkpoint，`track()` 记录 patch hash | snapshot 测试的文件数直接影响 `track()` 的 git 进程数 |
| `CONTEXT.md` — Tool = capability an Agent invokes, returns ExecuteResult | bash 测试必须在真实输出条件达到后再取消，才能验证 ExecuteResult 的 truncation |
| `packages/opencode/AGENTS.md` — Effect rules, toolPermit 串行化 | `completeToolCall` / `failToolCall` / cleanup 共享 `toolPermit` 串行化终态写入 |
| `packages/opencode/AGENTS.md` — 测试不能从 repo root 运行，需从 package dirs | 验证命令需在 `packages/opencode` 下运行 |
| `packages/opencode/test/AGENTS.md` — 同步并发工作用 published readiness signal，不用 `Effect.sleep` | macOS cancel 测试的 `Effect.sleep(150)` 是已知的 anti-pattern |
| `a01eeec1d9` — 前一次 Windows snapshot 修复，将另一测试从 140 降至 55 | 证明批量 snapshot fixture 需要控制平台负载 |
| Windows JUnit artifact `29365617668` | order 测试 30.011s timeout，log 测试 1.021s assertion failure |
| Windows JUnit artifact `29393640518` | 同两项在较好负载下分别 16.100s、0.102s 通过 |
| macOS JUnit artifacts `29393640518` / `29365617668` | cancel 测试失败时仅 3 assertions，成功时 7，定位失败在 truncation 前置条件 |
| Linux job `87282216288` / `87196312091` | 3774 tests，3756 pass，18 skip，0 fail；Linux 无待修复失败 |
| `74966f40c6` — cancel single-flight + toolPermit 串行化 | 当前取消终态路径已具备串行化，不能无证据改动 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/test/snapshot/snapshot.test.ts:860-884` | "diffFull preserves git diff order across batch boundaries" 测试，140 文件 | observed |
| `packages/opencode/src/snapshot/index.ts:520-738` | `diffFull` 实现：batch=100，`cat-file --batch` + fallback per-file `show` | observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:315` | HTTP API 对外承诺返回 `Schema.Array(Snapshot.FileDiff)` | observed |
| `packages/opencode/src/session/message-v2.ts:455`, `session/session.ts:62,125`, `session/session.sql.ts:35` | `FileDiff[]` 进入 Message/session persisted `summary_diffs` | observed |
| `packages/opencode/src/share/share-next.ts:62` | SDK/share consumer 暴露 `SnapshotFileDiff[]` | observed |
| `packages/opencode/src/snapshot/index.ts:287-340` | `track()` = `add()` + `write-tree` + `commit-tree`，每次调用多个 git 进程 | observed |
| `packages/opencode/test/util/log.test.ts:91-113` | "dev logging recreates a missing log directory" 测试 | observed |
| `packages/core/src/util/log.ts:69-113` | `init()` 函数：`fs.mkdir` → `fs.truncate` → `createWriteStream` | observed |
| `packages/core/src/util/log.ts:51-55,76-80` | exported `Options.print` branch：destroy file stream and write to stderr | observed |
| `packages/core/src/util/log.ts:101-112` | `write` 函数：async fire-and-forget，logger `info()` 不 await | observed |
| `packages/opencode/test/session/prompt.test.ts:3167-3216` | "cancel finalizes interrupted bash tool output through normal truncation" 测试 | observed |
| `packages/opencode/src/session/prompt.ts:449-509` | `cancel()` 实现：`state.cancel` → `abortPendingAssistants` | observed |
| `packages/opencode/src/session/prompt.ts:511-559` | `abortPendingAssistants` → `abortPendingToolParts`：直接写入 `interruptedToolState` | observed |
| `packages/opencode/src/session/prompt.ts:304-316` | `interruptedToolState`：status="error", error=TOOL_ABORTED_ERROR | observed |
| `packages/opencode/src/session/processor.ts:255-297` | `completeToolCall`：`if (status !== "running") return false` — 阻止覆盖 premature error | observed |
| `packages/opencode/src/session/processor.ts:888-983` | `cleanup`：`Deferred.await(call.done)` + 2s timeout + 覆盖 running/pending 为 error | observed |
| `packages/opencode/src/session/processor.ts:38` | `TOOL_ABORTED_ERROR = "Tool execution aborted"` | observed |
| `packages/opencode/src/tool/shell.ts:1060-1357` | bash 工具 abort handler：kill → join output → truncate → return result | observed |
| `packages/opencode/src/tool/truncate.ts:16-17` | `MAX_LINES = 1000`, `MAX_BYTES = 16 * 1024` | observed |
| `packages/opencode/src/tool/shell.ts:1060` | `keep = limits.maxBytes * 2 = 32KB` — 内存窗口阈值 | observed |
| `packages/core/src/process.ts:128-185` | `AppProcess.run`：`normalizeStdin` → `Stream.make` → `runCommand` | observed |
| `a01eeec1d9` commit | 前一次 Windows snapshot 修复：降文件数 + 缓存 rev-parse + 仅 stat untracked | observed |
| Windows JUnit `ci-windows-fail/junit.xml:4303-4305,5515-5519` | 失败运行中 mixed diff 25.998s，order 30.011s timeout；log 1.021s assertion failure | observed |
| Windows JUnit `ci-windows-pass/junit.xml:4306-4307,5516-5519` | 通过运行中 mixed diff 16.656s，order 16.100s；log 0.102s | observed |
| macOS JUnit `ci-macos-fail/junit.xml:4946-4948` | cancel 失败时 assertions=3 | observed |
| macOS JUnit `ci-macos-pass/junit.xml:4945` | cancel 通过时 assertions=7 | observed |
| Linux job log `87282216288` | 3774 tests，3756 pass，18 skip，0 fail | observed |
| 本地 5 次运行 prompt.test.ts cancel 测试 | 5/5 通过；CI artifact 提供了目标平台 red signal | observed |

## 5. Current Behavior

### 5a. Windows snapshot 测试超时

```
test 创建 140 文件 → track() (git add+commit, ~7 git 进程 × 140 文件)
→ 修改 140 文件 → track() (同上) → diffFull() (~4 git 进程)
```

失败运行中相邻的 mixed diff 测试已耗时 25.998s，order 测试在 30.011s 超时；通过运行中相同测试分别为 16.656s 和 16.100s。该差异证明测试运行时受 Windows CI 负载影响，不能证明 `cat-file --batch` 解析失败，也不能把 per-file fallback 当作已观察根因。

order 测试只需要证明 `step = 100` 的跨 batch 顺序，140 是未被接口契约要求的额外 fixture 负载。将数量降为 101（100 + 1）保留完整语义，并给平台负载保留余量；生产 `diffFull` 算法不变。

### 5b. Windows log 测试失败

```
init() → fs.mkdir(dir, {recursive:true}) → fs.truncate(path).catch()
→ createWriteStream(path, {flags:"a"}) → 返回（文件异步打开中）
→ Log.Default.info(msg) → write(msg) [fire-and-forget, 数据被 stream 缓冲]
→ readEventually(path, msg) [50 次 × 10ms = 500ms 窗口]
```

失败 JUnit 的 assertions=1，说明最终断言执行了：不是 ENOENT，而是 `Log.init()` 返回后立即写入的内容尚未出现在 `dev.log`。当前 `createWriteStream()` 异步打开文件，但 `init()` 在注册 writer 后立即返回；Windows CI 上该 readiness 窗口会让既有测试读到空内容。

最小修复把职责分成同一 `init()` 内的三个必要机制：`print: true` 保持现有首次 await 前立即切换 stderr，并通过 `initID` 使旧 file token 失效；file-mode 用 private Promise tail 串行化 mkdir/truncate/candidate lifecycle；每个调用登记 authoritative completion，stale file 调用先在 `finally` 释放自己的 queue slot，再等待稳定的最新 completion 才返回。file candidate ready 前保留 active writer，open 后原子替换 active；candidate `error/close` 则退休旧 active，并保留当前 failed candidate 作为既有 best-effort terminal writer，其 write guard 返回 0，不继续旧目标。这样同时消除 stale truncate、destroyed-writer gap、stale 过早返回、print 延迟和旧目标 fallback，不增加重试、fallback、额外 public API 或 native mock seam。

### 5c. macOS cancel 测试失败

失败 JUnit 的 assertions=3，而测试中的第 1 个断言是 loop exit success，第 2 个断言是 `completedTool()` 的状态为 `completed`，第 3 个断言才是 `metadata.truncated === true`。因此失败时工具已经正常 completed，`abortPendingToolParts`/`completeToolCall` 竞态不是此次症状；R1 的 premature error 根因被 artifact 证据否定。

真正的 first divergence 是测试在 `llm.wait(1)` 后固定睡眠 150ms，然后假设 bash 已经完成 4000 行输出。`llm.wait(1)` 只证明 LLM 请求已收到，不证明工具进程已执行到输出阈值。macOS CI 调度较慢时，cancel 发生在输出超过 16KB/32KB truncation 窗口之前，工具自然返回 `truncated: false`。测试应让命令在输出循环之后写入 ready marker，再通过 `AppFileSystem`/`pollWithTimeout` 等待 marker 后取消。

### 5d. Linux 全量检查

相关 Linux job 没有失败问题：`packages/opencode / Linux` 在 run `29393640518` 中为 3774 tests、3756 pass、18 skip、0 fail；`packages/core / Linux`、上游 Linux unit/App E2E 也为 success。Linux 不需要生产或测试改动，后续验证仍必须保留 Linux job 证据。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 140 文件 snapshot track+diffFull | 测试代码 | 只要求跨越 100 的 batch 边界 | Windows CI 负载下 30s timeout | snapshot test | observed |
| 缺失日志目录 + pending createWriteStream | 测试代码 / 生产 init() | `fs.mkdir` 创建目录 | Windows stream readiness 竞态 | log.ts init() | observed / reachable |
| cancel 后 bash 必须先完成输出循环 | test command | marker 在 printf 循环之后 | macOS CI 固定睡眠过早取消 | prompt.test.ts | observed |
| Linux 核心与兼容性 tests | CI jobs | workflow 已执行全量 job | 两次相关 runs 均 success | CI | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `diffFull` 跨 batch 边界保持文件顺序——测试需 >100 文件验证 batch 边界 | `step = 100` in `diffFull` | snapshot.test.ts:860 |
| INV-02 | file-mode init 串行拥有文件变更；stale 调用等待 authoritative completion；`print: true` 仍立即切换；candidate failure 不继续旧目标 | stream lifecycle + exported async init | log.test.ts:91,115；lsp/client.test.ts:21 |
| INV-03 | cancel 测试只有在 bash 已完成足量输出后才验证 truncation | JUnit assertions=3 vs 7；shell output threshold | prompt.test.ts:3167 |
| INV-04 | 测试同步并发进度必须使用 published readiness signal，不使用固定 sleep | `packages/opencode/test/AGENTS.md` | prompt.test.ts:3167 |
| INV-05 | Linux 相关核心/兼容性/App E2E job 在本任务范围内保持 0 failed | CI run 29393640518 | Linux job logs |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | 过大的 140-file fixture 将一个语义测试置于 Windows 30s timeout 边缘；first divergence 在测试负载而非 `diffFull` producer | test/snapshot/snapshot.test.ts:865 | 失败 run 30.011s vs 通过 run 16.100s；相邻 mixed test 25.998s |
| INV-02 | `init()` 在 candidate ready 前销毁 active stream 并把 write 绑定到未 ready/destroyed stream | core/src/util/log.ts:73-112 | Windows JUnit 1.021s assertion failure；same-subagent confirmed destroyed-writer gap |
| INV-03 | 150ms fixed sleep 不是 bash output readiness；cancel 可能先于 truncation threshold | test/session/prompt.test.ts:3196-3197 | 失败 cancel assertions=3，证明 status completed 但第三个 truncation 断言失败 |

### Red-capable feedback loops

| Issue | Command | Working directory | Observed result |
| --- | --- | --- | --- |
| snapshot timeout | Windows JUnit artifact `29365617668`, `snapshot.test.ts:861` | CI artifact | 30.011009s timeout; same test later 16.099784s pass |
| log failure | Windows JUnit artifact `29365617668`, `log.test.ts:91` | CI artifact | 1.021087s assertion failure; same test later 0.102239s pass |
| cancel flake | macOS JUnit artifact `29393640518`, `prompt.test.ts:3168` | CI artifact | 0.638423s, assertions=3; pass artifact assertions=7 |
| local cancel regression | `bun test --timeout 30000 test/session/prompt.test.ts -t "cancel finalizes interrupted bash"` | packages/opencode | 5/5 pass before test readiness repair |
| Linux full feedback | `bun test:ci` job `87282216288` | CI | 3774 tests, 3756 pass, 18 skip, 0 fail |

Windows/macOS 本地无法复现平台负载时序；JUnit artifacts 提供了原始 red signal 和 assertion-count 定位。用户明确要求不再增加 benchmark 或额外验证机制。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 测试文件数选择 | test/snapshot/snapshot.test.ts | 测试需 >100 文件验证 batch 边界，但不需额外 39 个文件制造平台负载 | 测试自己决定 fixture 大小 | 生产代码不应为测试性能修改 batch 大小 |
| 日志 stream readiness | core/src/util/log.ts `init()` | init 调用按 invocation order 发布 ready writer；返回时自己的 lifecycle 已完成 | `init` 拥有文件变更、stream 生命周期和并发 ownership | 调用方不应复制 stream lifecycle 等待 |
| bash 输出 readiness | prompt.test.ts test command | cancel 语义测试必须先达到 truncation 输入条件 | 测试命令是唯一能发布“输出循环完成”信号的 producer | Session processor 不应为测试增加等待或改变 cancel 语义 |
| Linux platform coverage | CI workflow evidence | 本任务不得缩小 Linux 全量放行范围 | Linux job 是验证 owner | 当前证据未发现 Linux production divergence |

## 10. Single Approved Primary-Path Design

### Fix 1: snapshot 测试文件数 140 → 101

```
test fixture: 140 files → 101 files (minimum to exceed batch boundary of 100)
```

101 文件仍跨越 batch 边界（1 batch of 100 + 1 batch of 1），验证顺序保持。通过运行中 140 文件约 16.1s、失败负载约 30s，减少 28% fixture 可为 Windows host variance 留出余量；不改变生产 `diffFull`。

### Fix 2: `Log.init()` local candidate ready 后原子替换 active writer

```
every call: increment initID + register authoritative completion
├─ print=true: immediately switch stderr + resolve completion
└─ file mode: snapshot dir + append private file queue slot
   → await predecessor → check token
   → mkdir/truncate, checking token after async boundaries
   → create local candidate → wait open/error/close → check token
   → open: swap active; error/close: retire old active and keep terminal failed candidate
   → finally release queue slot and own completion
   → if stale: await latest completion; repeat if latest changed
```

保持现有 `initID`、`stream`、`write` 和 `print: true` 接口。每次调用在第一个 await 前生成 token，并登记自己的 private completion 为 authoritative latest。`print: true` 不进入 file queue：立即销毁 active、切换 stderr并完成自己的 completion，旧 file token 因 `initID` 改变而不能发布 candidate。file-mode 在第一个 await 前快照目录并接入 private FIFO tail；只在 predecessor 完成后执行文件变更，因此旧 truncate 不会晚于新 file owner。每个 async boundary 后检查 token，stale 调用停止后续 side effect；candidate 的 `open/error/close` 共享一次性完成与 listener 清理。token 当前时，open candidate 成为 active；error/close candidate 也成为当前 terminal writer，但其 guard 让后续写入返回 0，并在 swap 后销毁 previous active，禁止旧目标继续成功写入。调用在 `finally` 先完成 queue slot 和 own completion；若 stale，再循环等待当前 latest completion，直到观察期间未被替换，避免返回到 authoritative init 尚未 ready 的窗口。该修改不新增重试、备用 writer、测试 seam 或 public API。

### Fix 3: 用命令 marker 替代 macOS 测试固定睡眠

```
LLM response received
→ bash printf loop completes
→ command touches .bash-output-ready
→ pollWithTimeout(marker exists)
→ cancel
```

在现有 4000 行 printf 循环末尾写入 scoped temp directory 下的 marker；测试用已有 `AppFileSystem` 和 `pollWithTimeout` 等待 marker，而不是等待固定毫秒。marker 只表达 producer 已完成输出循环，不断言 private shell 状态；取消后现有断言仍验证真实 truncation notice、metadata 和 output path。

该修复只改变测试同步方式，保留 Session processor、cancel、abortPendingToolParts 和 shell truncation 生产语义不变。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `diffFull` cat-file --batch | current | primary-contract branch | yes | 主路径 | preserve |
| `diffFull` per-file `git show` path | current | existing shipped compatibility / alternate success path | yes | only when batch load fails | preserve under HTTP API/Session/SDK FileDiff contract; do not expand |
| `abortPendingToolParts` abort error | current | existing compatibility | no | cancel 时对所有 open tool 执行 | preserve |
| `completeToolCall` terminal-state guard | current | primary-contract branch | yes/no | production cancel path | preserve |
| shell truncation path | current | primary-contract branch | yes | marker 后 cancel | preserve |
| `Log.init()` open/error/close readiness | proposed | primary-contract branch + terminal diagnostic | yes/no | current init invocation | failed candidate retires old writer; no old-target fallback |

`diffFull` 的 per-file path 不是 diagnostic-only：它是 `288eb044cb` 引入 `cat-file --batch` 性能优化时保留的旧逐文件读取语义，`load()` 失败后仍生成成功的 `FileDiff[]`。HTTP API、Session/Message persisted `summary_diffs` 和 SDK/share 都以 `FileDiff[]` 为公开或持久化契约；batch 只是读取优化，不能让既有 Git 内容读取能力在 batch 子进程异常时消失。该路径是现有 shipped compatibility，不是本计划新增的 fallback；本计划不修改或扩展它。除该既有路径外无新增 fallback。stream readiness 是同一 `Log.init()` primary path 的生命周期同步；marker 是测试 producer 的 readiness signal，不是生产成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| macOS cancel 测试 `Effect.sleep(150)` | 试图给 bash 时间启动并输出 | 固定 wall-clock 不证明 producer 进度，改为 marker + poll | `packages/opencode/test/session/prompt.test.ts:3196` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01: batch 边界顺序 | 测试 fixture | snapshot.test.ts:865 `length: 140` → `101` | 同测试，101 文件验证 2 batch 顺序 |
| INV-02: init ownership | log.ts init() | file queue + token + latest completion + terminal failed writer；print 分支保持 immediate | existing log.test.ts；lsp/client.test.ts:21 |
| INV-03: cancel 前 output readiness | prompt.test.ts command | printf 后 touch marker；poll marker | prompt.test.ts:3167 |
| INV-04: published synchronization | test/lib/effect.ts | 使用既有 pollWithTimeout | prompt.test.ts:3167 |
| INV-05: Linux full coverage | no code path | 保持 Linux job verification | run 29393640518 Linux jobs |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| log.ts file queue + token + completion + candidate swap | INV-02 | Windows fail artifact + stale truncate/destroyed-writer/stale-return/print races；implementation audit B-01 | 单独事后检查、单独 queue 或保留旧 active fallback 均缺失一个可达 owner 边界 |
| test output marker | INV-03 / INV-04 | `AGENTS.md` readiness rule + JUnit assertions=3 | `Effect.sleep(150)` 不能表达 bash 已超过 truncation threshold |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/snapshot/snapshot.test.ts` | modify | 行 865: `length: 140` → `length: 101`，并说明最小跨 batch fixture | +2~3 行 |
| `packages/core/src/util/log.ts` | modify | immediate print token；file queue；latest completion；open/failed candidate 都在 owner 内 swap | +30~38 行 |
| `packages/opencode/test/session/prompt.test.ts` | modify | 增加 marker 与 `pollWithTimeout` readiness，移除固定 sleep | +8~12 行 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | snapshot 101 文件 batch 边界顺序 | 当前 140 文件在 Windows host variance 下接近/超过 30s | 101 文件仍执行两批并保持 order | 同测试验证 `ids` 全序列 |
| 2 | log init 后立即 info 可读；file init 不互相 truncate；stale 不早返；print 仍立即生效；失败不回退旧目标 | 异步文件变更和 candidate 发布重叠，candidate failure 还可能继续 old active | file queue + token/latest completion；candidate terminal state swap | existing log.test.ts 与 lsp/client.test.ts |
| 3 | cancel 后 bash 输出已达到 truncation 输入条件 | 150ms 不等待 producer readiness，失败时工具其实已 completed 但 `truncated=false` | marker 发布后再 cancel | prompt.test.ts:3167 通过，保留 7 assertions |

三个修复只复用现有失败测试、现有 LSP caller、package suites 和 workflow，不增加新的测试验证逻辑、native mock seam 或 benchmark。Linux 不新增生产修改，因为相关全量 job 已通过且没有 red behavior。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 85 | 以 R12 implementation audit 的保守 `E=80` 为基准，加 R14 terminal candidate owner 调整上界 5 |
| Required Chinese explanatory comments `C` | 13 | `ceil(85 * 0.15) = 13` |

| Comment location | What it explains |
| --- | --- |
| snapshot.test.ts fixture 附近 | 101 是跨越 `step=100` 的最小语义 fixture，避免把平台负载误测成行为失败 |
| log.ts private queue 附近 | 文件变更和 candidate 发布共享同一 ownership，禁止后启动调用被旧 truncate 覆盖 |
| log.ts immediate print 附近 | print 控制分支必须立即使旧 file token 失效，不能排在文件 I/O 后面 |
| log.ts listener cleanup 附近 | 三个终止事件只完成一次并移除其余 listener，避免事件竞态泄漏 |
| log.ts active swap 附近 | 先发布 ready candidate 再销毁 previous active，禁止出现 destroyed-writer 空窗 |
| log.ts terminal candidate 附近 | candidate 失败后必须退休旧 active，不能把旧目标当成初始化成功路径 |
| log.ts stale completion 附近 | stale 调用先释放 file queue 再等待最新 completion，避免死锁与过早返回 |
| prompt.test.ts marker 附近 | marker 位于完整输出循环之后，证明 truncation 输入已经产生 |
| prompt.test.ts poll 附近 | 观察 scoped 文件信号替代固定 sleep，不依赖 scheduler 速度 |

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/snapshot/snapshot.test.ts -t "diffFull preserves git diff order"` | packages/opencode | 101 文件顺序测试通过 |
| `bun test --timeout 30000 test/util/log.test.ts` | packages/opencode | 现有全部 log tests 通过 |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "cancel finalizes interrupted bash"` | packages/opencode | cancel 测试通过 |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "cancel"` | packages/opencode | 全部 cancel 相关测试通过 |
| `bun test --timeout 30000 test/snapshot/snapshot.test.ts` | packages/opencode | 全部 snapshot 测试通过 |
| `bun typecheck` | packages/opencode | opencode 类型检查通过 |
| `bun typecheck` | packages/core | log.ts 类型检查通过 |
| `bun test --timeout 30000` | packages/core | core 全量测试通过 |
| `bun test --timeout 30000 test/session/prompt.test.ts` | packages/opencode | 全部 prompt 测试通过（确保 cancel 修改无退化） |
| Workflow `.github/workflows/test.yml` matrix `opencode-linux`, `opencode-windows`, `opencode-macos` | GitHub Actions on the implementation commit SHA | packages/opencode 全量 `test:ci`：三平台 JUnit `failures=0`、`errors=0` |
| Workflow `.github/workflows/test.yml` matrix `core-linux`, `core-windows`, `core-macos` | GitHub Actions on the implementation commit SHA | packages/core 全量 `test:ci`：三平台 JUnit `failures=0`、`errors=0` |
| Workflow `.github/workflows/test.yml` matrix `http-recorder-linux`, `http-recorder-windows` | GitHub Actions on the implementation commit SHA | required http-recorder `test:ci`：JUnit `failures=0`、`errors=0` |
| Workflow job `必过 HttpApi gate / coverage`, `auth`, `effect` | GitHub Actions on the implementation commit SHA | 三个 HttpApi exercise gate 均 exit 0，`--fail-on-missing --fail-on-skip` |
| Workflow job `必过 VSCode SDK 检查` | GitHub Actions on the implementation commit SHA | `sdks/vscode` compile-tests + package exit 0 |
| Workflow `警告 上游单元兼容性 / Linux`, `/ Windows` | GitHub Actions on the implementation commit SHA | `bun turbo test:ci --continue=always --summarize --concurrency=1` JUnit 无 failures/errors |
| Workflow `警告 上游额外包测试 / packages/{llm,enterprise,desktop,console/core,console/app}` | GitHub Actions on the implementation commit SHA | 每个 package test JUnit 无 failures/errors |
| Workflow `警告 上游 App E2E / Linux`, `/ Windows` | GitHub Actions on the implementation commit SHA | Playwright JUnit 无 failures/errors |
| Workflow summaries, annotations, uploaded JUnit artifacts | GitHub Actions on the implementation commit SHA | 当前改动后的完整 workflow acceptance；历史 Linux artifact 只能作 baseline，不能替代此 gate |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | |
| Files modified | 3 | 1 production + 2 tests |
| Files deleted | 0 | |
| Production lines | ~30~38 | log.ts immediate print token, file queue, latest completion, and terminal candidate swap |
| Test lines | ~10~15 | snapshot fixture/comment + prompt marker/poll |
| Generated lines | 0 | |

### Commit-only Procedure

实现审计与 exact-SHA CI 不能在同一个提交前置条件中互相循环，按以下顺序执行：

1. 当前工作树 diff 先通过独立 implementation audit，记录 `No blocking findings.` / `APPROVE`；此时 plan 状态为 `implementation-audit-required`，不得把未审计的修改提交。
2. 检查 `git status --short`、`git diff --cached --name-only`；index 有任何无关 staged path 时停止，不清除或覆盖它。
3. 仅对本任务四个路径执行精确 index 准备。canonical plan 当前可能是 untracked，必须单独使用 `git add -- docs/plans/windows-macos-ci-test-failures.md`，不能使用全量 add。
4. 用下面的 `git commit --only` 创建 implementation commit。此时 plan 记录 implementation audit 结果，但 exact-SHA workflow 结果尚未填入。
5. 在 implementation commit SHA 可被 workflow checkout 的 ref 上运行完整 `.github/workflows/test.yml` matrix；三平台 artifact 和所有 warning/required jobs 都必须满足 §18 的零失败条件。没有 push/PR 或其它可访问该 SHA 的 CI 触发方式时，终态保持未验证，不得伪造 evidence。
6. CI 通过后，只更新 canonical plan 的 `Status: verified`、implementation evidence、audit record 和 commit id 等行政字段，再使用第二个 `git commit --only docs/plans/windows-macos-ci-test-failures.md` 提交该行政记录；该第二个提交不包含生产或测试代码。

```sh
git add -- \
  docs/plans/windows-macos-ci-test-failures.md \
  packages/core/src/util/log.ts \
  packages/opencode/test/snapshot/snapshot.test.ts \
  packages/opencode/test/session/prompt.test.ts

git commit --only \
  docs/plans/windows-macos-ci-test-failures.md \
  packages/core/src/util/log.ts \
  packages/opencode/test/snapshot/snapshot.test.ts \
  packages/opencode/test/session/prompt.test.ts \
  -m "fix(ci): 修复三平台日志与跨平台测试竞态" \
  -m "收敛 snapshot 跨 batch 测试 fixture，修复 Log.init 的文件 owner 竞态并用命令 readiness marker 替代 macOS cancel 固定睡眠。仅提交本计划批准的文件。"
```

implementation commit 后执行 `git show --stat --format='' HEAD` 和 `git diff-tree --no-commit-id --name-only -r HEAD`，后者必须严格等于上面的四个文件；行政记录 commit 后再执行同样检查，且只允许 plan path。工作树中的其它用户修改必须保持未提交。不得 amend 或 push。

## 20. Real Risks and Open Decisions

### Real risks

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| queued file init 抛错后阻塞 successors | mkdir/stream 生命周期存在失败路径 | 每个 queue slot 在 `finally` 完成；failed candidate retires old active and becomes terminal no-op writer |
| stale file init 等 successor 时死锁 | successor 排在 predecessor queue slot 后 | predecessor 先在 `finally` 释放 slot，再等待 latest completion |
| 101 文件仍可能在极慢 Windows CI 上超时 | 失败负载中相邻测试已占 25.998s | 101 是最小 batch 语义 fixture；若仍超时，下一轮只调查 CI host/load，不修改生产 fallback |
| marker 到 cancel 之间 pipe drain timing | marker 只代表 shell loop 已完成，不保证 consumer 已处理全部 bytes | abort 后 shell.ts 现有 `Fiber.join(output)` 负责 drain；原断言继续验证真实 truncation |

### Open Decisions Requiring the User

- 设计上没有待决产品选择。按通常 gate，改动后的 macOS/Linux/Windows workflow 应运行在 implementation commit SHA 上；用户已明确豁免本任务的证据型 blocker，因此本次保留未运行事实，不声称三平台 workflow 已通过。

### Rejected Speculation

| Concern | Why rejected |
| --- | --- |
| `cat-file --batch` 在 Windows 上因 CRLF 解析失败 | 两次 artifact 未提供该证据，且 Linux/macOS 通过；生产算法不改 |
| `abortPendingToolParts` 覆盖了 bash completed 结果 | 失败 JUnit assertions=3 已证明 completedTool 状态断言通过 |
| cancel 双调用导致重复执行 | `74966f40c6` single-flight Deferred 已解决；本次失败断言在 truncation，不是 loop/终态 |
| Linux 存在同一根因 | 相关 Linux full job 3774 tests/0 fail，未观察到红信号 |
| 只把 Windows timeout 提高到 60s | 这会保留过重 fixture 和 host-load flake，不修正测试责任边界 |
| historical Linux success is enough for final acceptance | original requirement requires current post-change macOS/Linux/Windows full suites | require the exact workflow matrix and post-change JUnit artifacts |

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
| 1 | R1 | no — handoff covered Windows/macOS but omitted the GOAL's Linux scope | No blocking findings. | NB-01 through NB-05 in the auditor result; JUnit evidence additionally disproved R1's macOS premature-error hypothesis and narrowed Windows log failure to readiness/write timing | `No blocking findings.` / `APPROVE` for the handed R1 scope; not an implementation authorization for current R2 | `ses_09b638c45ffeaioHYaVWGuAcoY` |
| 2 | R2 | yes for the three-platform plan scope | B-01 full current cross-platform suite gate; B-02 stale `Log.init()` red-capable test; B-03 comment budget upper-bound failure | NB-01 through NB-03 | `BLOCK` | `ses_09b43d3cbffeuMTmYNP8mg502a` |
| 3 | R3 | yes for the three-platform plan scope | B-01 Windows log first divergence; B-02 diffFull existing fallback misclassified; B-03 incomplete workflow scope; B-04 commit-only procedure absent; B-05 performance acceptance absent | NB-01 audit metadata; NB-02 snapshot margin | `BLOCK` | `ses_09b3de190ffeotiYoiPZyv3oZT` |
| 4 | R4 | yes for the three-platform plan scope | B-01 stale init can create pending stream after newer cleanup; B-02 performance threshold too permissive | line-delta/comment estimate non-blockers | `BLOCK` | `ses_09b31902fffeOUGaaZK6Zp65jq` |
| 5 | R5 | yes for the three-platform plan scope | B-01 stale init can create pending stream after newer cleanup; B-02 performance threshold too permissive | line-delta/comment estimate non-blockers | `BLOCK` | `ses_09b31902fffeOUGaaZK6Zp65jq` |
| 6 | R6 | yes for the three-platform plan scope | B-01 performance gate permits regression; B-02 print=true path not mapped | log-test count/estimate non-blockers | `BLOCK` | `ses_09b25eb97ffeMADQRlLF0e8HkV` |
| 7 | R7 | attempted but not eligible for another full round after six completed audits | B-01 six-round plan-audit limit; B-02 performance loop lacks base/candidate comparison; B-03 decision-surface ratio absent | none | `BLOCK` — R7 cannot be approved or implemented | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 8 | R8 | user-authorized same-subagent review after removing benchmark/extra validation scope | B-01 destroyed-writer gap remains under concurrent init | none | `BLOCK` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 9 | R9 | same-subagent review of active/local-candidate swap | B-01 stale init can return while authoritative writer is pending | none | `BLOCK` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 10 | R10 | same-subagent review of stable latest-completion ownership | B-01 superseded init can still truncate authoritative active log | diff-budget mismatch | `BLOCK` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 11 | R11 | same-subagent review of serialized lifecycle ownership | B-01 queue delays immediate print contract | none | `BLOCK` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 12 | R12 | full-scope same-subagent review of immediate print plus serialized file ownership | none | stale R8 wording only | `APPROVE` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 13 | R13 | full-scope re-audit after implementation findings B-01/B-02 | B-01 adds user-rejected extra log test validation; B-02 comment budget omits planned test changes | none | `BLOCK` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |
| 14 | R14 | full-scope re-audit after removing extra validation and preserving terminal candidate repair | none | none | `APPROVE` | `ses_09b1f8590ffeX9TIYH5kwwIzLN` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Actual change | Diff |
| --- | --- | --- |
| `packages/core/src/util/log.ts` | immediate print token invalidation；file FIFO ownership；authoritative completion；candidate readiness + terminal candidate swap | +81 / -32 |
| `packages/opencode/test/snapshot/snapshot.test.ts` | order fixture 140 → 101，保留 100+1 batch | +3 / -1 |
| `packages/opencode/test/session/prompt.test.ts` | output-loop marker + `pollWithTimeout`，删除 150ms sleep | +10 / -3 |
| `docs/plans/windows-macos-ci-test-failures.md` | R14 plan、审计与实现证据 | administrative |

没有修改 Snapshot 或 Session production path，没有新增文件、依赖、public API、mock seam、retry、fallback 或 benchmark。`Log.init()` steady-state `write` guard/callback 语义保持原样；candidate failure 现在退休旧 active 并进入当前 terminal writer，不继续旧目标。

Implementation commit: `8afe99eb862cbba4187665b57798b6d09d2e32b1`，严格包含上述四个路径。

### Red-Green Test Evidence

| Slice | Red-capable signal | Green result |
| --- | --- | --- |
| Windows Snapshot | run `29365617668` JUnit：order test 30.011009s timeout | focused 101-file test：1 pass，3 assertions，3.16s |
| Windows Log | run `29365617668` JUnit：missing-directory test assertion failure | `test/util/log.test.ts`：4 pass；`test/lsp/client.test.ts`：12 pass；terminal writer rework 后 log 4 pass |
| macOS cancel | run `29393640518` JUnit：completed Tool 后第 3 assertion 失败，`truncated=false` | focused marker test：1 pass，7 assertions，3.02s |

依用户要求复用现有 behavioral tests，不增加并发 mock 或额外测试 family。目标平台 artifact 是原始 red signal；本地不能稳定复现其 scheduler/host-load 条件。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test --timeout 30000 test/snapshot/snapshot.test.ts -t "diffFull preserves git diff order"` | `packages/opencode` | 1 pass，0 fail，3.16s |
| `bun test --timeout 30000 test/util/log.test.ts` | `packages/opencode` | 4 pass，0 fail，2.09s |
| `bun test --timeout 30000 test/lsp/client.test.ts` | `packages/opencode` | 12 pass，0 fail，5.83s |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "cancel finalizes interrupted bash"` | `packages/opencode` | 1 pass，0 fail，7 assertions，3.02s |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "cancel"` | `packages/opencode` | 首轮 15 pass + unrelated 3s timeout；isolated timeout test 1 pass；整组复跑 16 pass，0 fail |
| `bun typecheck` | `packages/core` | pass |
| `bun typecheck` | `packages/opencode` | pass |
| `bun test --timeout 30000` | `packages/core` | 358 pass，0 fail，24.63s |
| `bun test --timeout 30000` | `packages/core` | terminal writer rework 后 358 pass，0 fail，24.61s |
| `bun test --timeout 30000 test/snapshot/snapshot.test.ts` | `packages/opencode` | 54 pass，1 skip，0 fail，43.99s |
| `bun test --timeout 30000 test/session/prompt.test.ts` | `packages/opencode` | 83 pass，0 fail，66.63s；输出中的 reviewer 503 是预期 error-path fixture |
| `bun test --timeout 30000` | `packages/opencode` | 3760 pass，13 skip，1 fail；唯一失败为本机 native symlink `.git/HEAD` watcher timeout |
| isolated native watcher test | `packages/opencode` | 同一 5s timeout；`watcher.test.ts:13` 明确在 `CI` 下 skip，与本任务路径无关 |
| `CI=1 bun test --timeout 30000` | `packages/opencode` | 未启动：filesystem 仅余 161MiB，报 `database or disk is full` |

### Original Feedback-Loop Result

- 三个用户原始失败均由保存的 Windows/macOS JUnit artifacts 提供 red-capable evidence；修改后对应本地 behavioral seams 全部 green。
- macOS CI-mode package full suite 尚未得到结果，因为本机磁盘容量在命令启动前耗尽；这不是 test assertion。
- implementation commit SHA 上的 macOS/Linux/Windows workflow 尚未运行，按 §18/§19 保持未验证，不能由历史 artifact 替代。

### Actual Secondary and Replacement Path Inventory

| Path | Actual disposition |
| --- | --- |
| Snapshot `cat-file --batch` + existing per-file compatibility | production unchanged；没有新增 fallback |
| `Log.init()` file mode | one FIFO primary lifecycle；token 只阻止 stale publication，completion 只保护 return contract |
| `Log.init({ print: true })` | existing primary-contract branch；仍在首次 await 前立即切换 stderr |
| Log candidate `error/close` | existing diagnostic best-effort contract；failed candidate retires old active and becomes current no-success terminal writer |
| Session cancel / shell truncation | production unchanged；test marker 只发布 producer readiness |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 79 | `git diff HEAD -U0` 三个 implementation files 的 added/modified nonblank code；排除 import-only、comment-only、formatter-only 和 plan |
| Qualifying Chinese comment lines `C` | 13 | 邻近解释 FIFO ownership、immediate print、directory recovery、listener cleanup、active/terminal swap、stale completion、101 fixture 和 marker/poll intent |
| Ratio `C / E` | 16.46% | `13 / 79` |
| Required minimum `C` | 12 | `ceil(79 * 0.15) = 12`，通过 |

### Remaining Unverified Items

- 独立 full-scope implementation audit 已完成；唯一 blocking 是用户明确豁免的 exact-SHA 证据缺失。
- implementation commit SHA 的完整 GitHub Actions macOS/Linux/Windows matrix 尚未运行。
- 本机 `CI=1` full suite 因磁盘 100% 满而未启动；清理无关 1.6G + 1.6G temporary directories 属于 destructive 操作，未擅自执行。
- 本机非 CI full suite 唯一 native watcher timeout 在 CI 明确 skip；未扩展本计划去修改该独立测试。
- implementation commit 已创建；index 仍含用户或其它 agent 的 unrelated staged paths，未清理且未夹带。

用户在实现审计后明确决定：不要求收集当前 SHA 的三平台 workflow 证据，且 auditor 唯一 blocking finding 仅为该证据缺失，因此不将其作为本次修复放行条件；以上未验证项保留为事实，不宣称已运行。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R12 implementation attempt | yes | B-01 candidate failure retains old writer as fallback; B-02 serious log races lack red-capable public-seam coverage; B-03 current three-platform full verification absent | NB-01 audit mode metadata; NB-02 unrelated staged index paths | `BLOCK` | `ses_09ae92c64ffeRHDKYunyO1HTTW` |
| 2 | R14 implementation | yes | B-01 current implementation SHA lacks macOS/Linux/Windows full workflow evidence | NB-01 audit mode metadata; NB-02 unrelated staged index paths | `BLOCK` — user explicitly waived evidence-only blocker; implementation path accepted without SHA workflow claim | `ses_09ae92c64ffeRHDKYunyO1HTTW` |

The auditor result remains recorded verbatim. Per the user's explicit evidence
waiver recorded above, this plan is marked `verified` despite the sole
evidence-only release blocker; no unrun workflow is represented as passed.

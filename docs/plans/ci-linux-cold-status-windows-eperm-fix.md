# Canonical Implementation Plan: CI Linux Cold Status + Windows Maintenance EPERM

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL — 修正 Windows 以及 Linux 的 CI 测试错误；不能进行测试的大量实质性降级而是要找到更能反映真实行为逻辑/时序的测试；要么检查主行为要么检查测试本身；修复后保证测试通过且不影响其他测试；目标终态 verified-implementation-and-commit
>
> Implementation allowed: yes (verified; commit authorized by end state)
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 修正windows以及linux的CI测试错误：Linux 两个测试：测试数据库污染加上 ColdStorage.status() 全库扫描，直接触发了损坏数据异常。 Windows 一个测试：maintenance task checkpoint 在 Windows 上执行原子 rename 时遇到 EPERM，现有重试窗口不足。不能进行测试的大量实质性降级而是要找到一个比较好的更加能反应真实行为逻辑时序等等是否有问题的测试；也就是要么检查主行为是否有问题要么检查测试本身是否有问题。修复后要保证测试能通过，且不影响其他测试。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不修改 `findHot` / doom-loop / `previousAssistantToolTail` 语义（当前 CI 失败栈不进入这些算法错误；工作树中并行 doom-loop 改动不由本任务拥有）。
- 不跳过、弱化或删除 `scans HotInfo…`、`bounds doom-loop…`、`daemon startup resumes…` 三个测试。
- 不通过吞掉 `ColdStorageCorruptionError` 或放宽 `storedString` 让损坏 title 变成成功路径。
- 不把 `ColdStorage.status()` 改成“忽略 corruption 的 best-effort status”。
- 不引入 per-test 全局 `Database.close` 全库 reset 作为默认方案（会与并行 suite 的共享进程假设冲突，且掩盖生产契约问题）。
- 不修改 migration、公共 HTTP/OpenAPI/SDK、依赖、工作流 timeout/retry 伪装。
- 不 amend/push；不触碰无关 worktree（i18n、models-snapshot、doom-loop 计划/实现等）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session / Message / Part / Daemon / Cold storage 词汇；进程级 SQLite 与 daemon maintenance 生命周期 |
| `packages/opencode/AGENTS.md` | package-local `bun test` / `bun typecheck`；数据库与 Effect 形态 |
| `packages/opencode/test/AGENTS.md` | `it.instance` / `tmpdir` 夹具；禁止用固定 sleep 代替就绪信号 |
| `docs/plans/ci-gate-platform-race-repair.md` | 已验证 Windows rename 瞬态 `EPERM/EACCES/EBUSY` 与共享重试合同；stale lock 已用 1s 边界，`writeAtomic` 仍是更短窗口 |
| `docs/plans/opencode-db-cold-storage.md` | status/freeze 对 cold string 硬失败；测试不得伪造成功 recovery |
| `docs/plans/opentui-closure-tag-verification-fix.md` | `writeAtomic` 与 directory rename 应共享同一 Windows sharing 合同 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| CI run `29753313390` job logs + JUnit + annotations | Linux: `Stored completed tool title is not a string`；Windows: `EPERM rename …tmp -> …json` | observed |
| `packages/opencode/src/session/processor.ts:249-294` | `completeToolCall` 写 `title: output.title`，无默认 | observed |
| `packages/opencode/src/tool/registry.ts:187-188` | 插件 Tool 路径已 `result.title ?? ""` | observed |
| `packages/opencode/test/session/processor-effect.test.ts:280-286` | `imageRead` 只返回 `output`/`attachments`，无 `title` | observed |
| `packages/opencode/src/session/message-v2.ts:372-384,507-512` | Schema 要求 completed `title: string`；`isPart` 只校验 `output` | observed |
| `packages/opencode/src/storage/cold.ts:465-470,651-660,2429-2460,3357-3412` | freeze/status 对 title 严格；`status()` 全库 `eligibleOwnerCount` + `coldOwners` | observed |
| `packages/opencode/src/storage/db.ts:92-159` | 进程级 `Client` 单例 | observed |
| `packages/opencode/test/preload.ts:10-15` | 测试进程共享 XDG/data 与 DB 路径 | observed |
| `packages/opencode/test/session/messages-pagination.test.ts:659,668,778` | 全局 `ColdStorage.status().coldOwners` 精确/半精确断言 | observed |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts:52-54,210-227,365-377` | `writeAtomic` 5×25ms；stale dir rename 1s 截止 | observed |
| `packages/opencode/src/storage/cold.ts:3146-3155,3345-3348` | maintain 启动即 `running` checkpoint；失败写 `failed`+error | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts:643-683` | 50ms 轮询 `readMaintenanceTask`，与 checkpoint rename 竞争 | observed |
| 本机 `bun test processor-effect + messages-pagination` | 稳定复现两个 Linux 失败与同一 corruption 消息 | observed |
| 本机单独三个测试 | 单独均绿 | observed |
| 本机 `cold.test + messages-pagination` | 无 corruption 时全局 coldOwners 计数漂移（1→4, 2→5） | observed |

## 5. Current Behavior

```text
# Linux path
processor-effect imageRead (no title)
  -> SessionProcessor.completeToolCall
  -> updatePart completed { title: undefined }  // JSON 省略 title
  -> shared test SQLite (preload + Database.Client singleton)
  -> later messages-pagination calls ColdStorage.status()
  -> eligibleOwnerCount scans ALL parts
  -> extractPart -> storedString(title) throws ColdStorageCorruptionError
  -> HotInfo / doom-loop tests fail after their functional asserts

# Windows path
daemon test writes interrupted MaintenanceTask record
  -> spawn worker -> recoverInterruptedMaintenance -> maintain
  -> task.status=running; checkpoint() -> writeAtomic rename(tmp,task.json)
  -> test loop: Bun.file(task.json).text() every 50ms
  -> Windows sharing: rename EPERM after 5×25ms retries
  -> maintain catch: status=failed, error=EPERM string
  -> test throws startup recovery failed: EPERM
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Tool execute 返回无 `title` | raw AI SDK tools / tests / 非 registry 适配路径 | Schema 要求 completed title 为 string | tool-result → completeToolCall | SessionProcessor | observed |
| Plugin Tool 经 registry | tool/registry.ts | 已 `title ?? ""` | execute → processor | ToolRegistry | observed |
| 共享 test SQLite 跨文件 | preload + Database.Client | 非 per-instance DB | 任意测试写 Part → 后序 status 扫描 | test preload / db client | observed |
| 全局 coldOwners 精确断言 | messages-pagination tests | 他文件可留下 cold owner | status().coldOwners | 测试断言 | observed |
| Windows 读者短暂持有 task json | Bun.file().text / 轮询 | NT sharing 可 EPERM rename | writeAtomic | ServerLock.writeAtomic | observed |
| maintain 启动 checkpoint | ColdStorage.maintain | 必须在 batch 前持久 running | recovery / control | ColdStorage + ServerLock | observed |

Speculative（不驱动生产逻辑）：未知第三方 SQL 故意写坏 title 后仍应“静默 status 成功”。已有 freeze/status 硬失败合同，保持 fail-closed。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | completed Tool Part 持久化后 `state.title` 恒为 string（可为空串） | ToolStateCompleted Schema；registry 默认 `""` | processor-effect 完成路径 + 新契约切片 |
| INV-02 | 缺少 title 的 tool result 不得污染后续 ColdStorage freeze/status | cold extractPart + CI corruption | 组合 suite 复现 |
| INV-03 | `findHot` 无匹配扫描不查询 Part；匹配后 hydrate 返回完整 WithParts | message-v2 findHot | scans HotInfo… |
| INV-04 | 分页/tail 测试若断言 cold owner，必须绑定当前 session 范围，不得依赖全库精确计数 | preload 共享 DB；cold+pagination 漂移 | 改断言 + 可选 cold 辅助 |
| INV-05 | maintenance task checkpoint 在 Windows 瞬态 EPERM/EACCES/EBUSY 下与 stale lock rename 使用同一可证明的有界重试合同；耗尽后仍失败 | writeAtomic 注释 + CI EPERM；stale 1s | daemon startup recovery + 定向 rename 注入 |
| INV-06 | 不引入 catch-and-success、跳过测试、伪造 completed | 用户禁止降级 | 失败路径仍可见 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | `completeToolCall` 直接写 `title: output.title`，无归一化 | `SessionProcessor.completeToolCall` | processor.ts:291；imageRead 无 title；组合复现 corruption |
| INV-04 | 测试用 `ColdStorage.status().coldOwners` 断言当前 fixture 的局部结果 | `messages-pagination.test.ts` 断言面 | 共享 DB + 全局 count；cold 组合漂移 |
| INV-05 | `writeAtomic` 仅 5×25ms，短于已在同文件证明的 Windows sharing 生命周期（stale rename 用 1s） | `ServerLock.writeAtomic` | CI EPERM 路径；server-lock.ts 双窗口不一致 |

### Red-capable feedback loops (already executed)

Linux corruption:

```bash
cd packages/opencode
bun test --timeout 30000 \
  test/session/processor-effect.test.ts \
  test/session/messages-pagination.test.ts
```

Observed: two fails with `ColdStorageCorruptionError: Stored completed tool title is not a string`.

Linux isolation:

```bash
bun test --timeout 30000 test/session/messages-pagination.test.ts \
  -t 'scans HotInfo without thawing Parts until a Message matches'
# 1 pass
```

Windows (CI artifact only on this macOS host):

```text
startup recovery failed: Error: EPERM: operation not permitted, rename
'...dbm_startup-recovery.json.<uuid>.tmp' -> '...dbm_startup-recovery.json'
```

Windows 原生 green 是环境要求：macOS 无法复现 NT sharing；实现后需在 Windows CI 或等价注入 harness 上验证。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| completed Tool title 归一化 | SessionProcessor.completeToolCall | 持久 completed 状态满足 ToolStateCompleted | 唯一把 tool-result 写成终态 Part 的 seam；registry 已在插件路径做同样默认 | ColdStorage 只校验已存数据；不应“猜”title |
| 可选 decoder 收紧 title | MessageV2.isPart（仅当不破坏历史读合同） | 轻量 stored 校验 | 与 output 校验同级；本 revision 默认 **不** 扩大 isPart，除非实现中证明不破现有 fixture | freeze 已 hard-fail title |
| 测试 cold 计数范围 | messages-pagination 测试 | 行为断言绑定 fixture session | 测试错误使用全局 status | 生产 status 全库是产品合同，不应为测试改成忽略 corruption |
| task JSON 原子发布重试 | ServerLock.writeAtomic | 与 Windows sharing 合同一致 | rename 瞬态属于文件发布边界 | ColdStorage 不应复制 rename 策略 |
| daemon recovery 生命周期 | 保持现状 | activeMaintenance 已登记 | 非 first divergence | — |

## 10. Single Approved Primary-Path Design

### 10.1 Linux / Tool title

```text
tool-result.output
  -> completeToolCall
  -> title = typeof output.title === "string" ? output.title : ""
  -> updatePart completed { title }
  -> freeze/status 见合法 string（空串允许）
```

理由：

- first divergence 在 Processor 终态写入，不是 findHot。
- 与 `tool/registry.ts` 已有 `?? ""` 对齐，单一语义：缺省 title 记为空串，而非 undefined/omit。
- 不在 cold extract 放宽 storedString；损坏数据继续 fail-closed。

测试侧（主行为修好后仍需的断言正确性）：

```text
messages-pagination cold asserts
  -> session-scoped cold owner count (Message/Part cold_ref where session_id = fixture)
  -> exact 1/0/≥2 仅相对当前 session
```

可选小修：`imageRead` fixture 显式带 `title`，作为防御性清晰度，**不**替代 Processor 归一化（否则 raw AI tools 仍会回归）。

### 10.2 Windows / writeAtomic

```text
writeAtomic(file, value)
  -> Bun.write(tmp)
  -> renameWithTransientRetry(tmp, file)  // 与 stale lock rename 同合同
     仅 EPERM|EACCES|EBUSY
     截止 ≈ MAINTENANCE_RENAME_TIMEOUT_MS (1s) 或等价 attempt 预算
  -> 其他错误 / 耗尽：删除 tmp 并抛出
```

```text
acquireMaintenanceLease stale reclaim
  -> 同一 renameWithTransientRetry(lockDir, stale-token)
```

理由：

- first divergence 是 task JSON rename 窗口短于同文件已证明的 Windows sharing 生命周期。
- 不是删除测试轮询、不是假 completed、不是跳过 recovery。
- 重复执行同一原子 rename，不是第二成功路径。

Regression seam（macOS 可跑）：

- 扩展/新增 worker 风格注入：对 **task file** rename 首次 EPERM 后放行（类比 `maintenance-retry-worker.ts`），或在 server-lock 单元测 mock rename；证明 retry 后 writeMaintenanceTask 成功。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| completeToolCall title 归一化 | proposed | primary | yes | primary | retain |
| registry title `?? ""` | existing | primary-contract branch (plugin path) | yes | primary | preserve；不复制第二套 |
| extractPart storedString hard-fail | existing | primary guard | no (fail) | primary error | preserve |
| skip/xfail 三个 CI 测试 | forbidden | forbidden fallback | yes | 0% | reject |
| status() 吞 corruption | forbidden | forbidden fallback | yes | 0% | reject |
| 每测 reset 全库作为唯一修复 | forbidden as sole fix | 掩盖生产契约 | yes | 0% | reject as primary |
| session-scoped test count | proposed | test contract branch | n/a | test only | retain |
| writeAtomic 1s transient retry | proposed | primary-contract branch | yes | primary | retain |
| rename 失败后改写 completed | forbidden | forbidden fallback | yes | 0% | reject |

New alternate success paths: zero.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 全局 coldOwners 精确断言 | 单测隔离时“碰巧”正确 | suite 共享 DB 后失真；session 查询才匹配产品意图 | messages-pagination 断言 |
| writeAtomic 与 stale rename 双套重试窗口 | 先修了 file 发布、后修了 lock dir | 同一 Windows sharing 合同应一处实现 | server-lock 私有 helper |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02 | completeToolCall title 归一化 | `processor.ts` | processor-effect 无 title tool 完成后 Part.title 为 `""`；组合 suite 不再 corruption |
| INV-03 | 保持 findHot | 无生产改动（除非并行 work 无关） | 既有 scans HotInfo |
| INV-04 | session-scoped cold count | `messages-pagination.test.ts` | 与 cold.test 同进程时精确 1/0/≥2 仍绿 |
| INV-05 | renameWithTransientRetry | `server-lock.ts` | 注入 EPERM 后 writeMaintenanceTask 成功；Windows CI daemon startup recovery |
| 用户禁止降级 | 不 skip 测试 | — | 三测试仍存在且行为更紧 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| completeToolCall 中 title 默认 `""` | INV-01/02 | Schema + registry 已有默认；CI corruption | 当前直接写 undefined；registry 不覆盖 raw tools |
| renameWithTransientRetry helper | INV-05 | CI EPERM；stale 已 1s | writeAtomic 仍 5×25ms |
| 测试 session-scoped cold count | INV-04 | 全局计数漂移 | 生产 status 全库正确；测试用错 seam |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/processor.ts` | modify | completeToolCall 归一化 title；中文注释说明与 Schema/registry 对齐 | +5~15 |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | modify | 抽取 rename 瞬态重试；writeAtomic + stale reclaim 共用 1s 合同 | +20~40 / -15 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | 断言无 title 工具完成后 title 为 `""`；可选 fixture 补 title 不替代生产 | +10~30 |
| `packages/opencode/test/session/messages-pagination.test.ts` | modify | coldOwners 改为 session-scoped 查询；保留 thaw/find 行为断言 | +15~40 |
| `packages/opencode/test/cli/tui/daemon.test.ts` 或 `server-lock`/`maintenance-retry` 相关测试 | modify/add | task-file rename 首次 EPERM 后成功的确定性 harness | +30~80 |
| `docs/plans/ci-linux-cold-status-windows-eperm-fix.md` | add | 本 plan | plan only |

**Worktree 约束：** 不得 revert/覆盖并行 doom-loop 对 `processor.ts` / `message-v2.ts` / `messages-pagination.test.ts` 的无关块；仅叠加本任务 title 归一化与 cold 断言修正。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 无 title 的 tool-result 完成后 `MessageV2.parts` 的 completed title 必须是 `""` | completeToolCall 写 undefined | title 归一化 | INV-01 |
| 2 | `processor-effect` + `messages-pagination` 同进程：两个 findMessage 测试绿 | status 扫到缺 title | 归一化后无 corruption | INV-02 |
| 3 | cold.test 与 pagination 同进程：session-scoped cold count 精确 | 全局 count 漂移 | session 查询 | INV-04 |
| 4 | 注入 task rename EPERM 一次后 writeMaintenanceTask completed/成功 | writeAtomic 窗口过短或一次失败 | 共享 1s retry | INV-05 |
| 5 | 既有 daemon startup recovery（Windows CI）绿 | CI EPERM | 同上 | INV-05 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~80–120 | processor + server-lock + 测试行为行；排除纯格式 |
| Required Chinese explanatory comments `C` | ≥12–18 | `ceil(E*0.15)` |

必须邻近解释：

- 为何缺省 title 记 `""` 而非 omit（Schema 与 cold storedString）。
- 为何 status 测试改 session scope 而非改生产 status。
- 为何 writeAtomic 与 stale rename 共用 Windows sharing 重试截止。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t 'omits an image'` | `packages/opencode` | 无 title 路径 title 契约 |
| `bun test --timeout 30000 test/session/processor-effect.test.ts test/session/messages-pagination.test.ts` | `packages/opencode` | 组合无 corruption |
| `bun test --timeout 30000 test/storage/cold.test.ts test/session/messages-pagination.test.ts` | `packages/opencode` | session-scoped cold 断言稳 |
| `bun test --timeout 30000 test/cli/tui/daemon.test.ts -t 'startup resumes'` | `packages/opencode` | macOS 基础 recovery |
| `bun test --timeout 30000 test/cli/tui/daemon.test.ts -t 'maintenance lease\|rename\|startup resumes'` 或新注入 harness | `packages/opencode` | EPERM retry 行为 |
| `bun typecheck` | `packages/opencode` | 类型 |
| Windows CI / 上游兼容 job | CI | daemon startup recovery 原生 EPERM 环境 |

禁止用跳过三测试作为“验证通过”。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0–1 | 可选小 harness 或仅改现有 worker |
| Files modified | 4–5 | processor、server-lock、2–3 测试 |
| Files deleted | 0 | — |
| Production lines | ~40–70 | title + rename helper |
| Test lines | ~60–120 | 契约 + 隔离 + EPERM |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 并行 doom-loop 改动同一 processor/message-v2/pagination 文件 | 仅叠加 title/断言；冲突时 merge 保留两边；不改 doom_loop 逻辑 |
| 空 title 是否影响 UI 展示 | 与 registry 一致；空串合法 |
| macOS 无法证明 Windows EPERM 真实 sharing | 注入 harness + Windows CI 双证据 |
| isPart 收紧 title 可能炸历史坏行 | R1 **不**收紧 isPart；依赖写入归一化 + freeze hard-fail |

### Open Decisions Requiring the User

无。生产契约已由 Schema + registry 对齐给出默认 `""`。

### Rejected Speculation

- “findHot 算法错误” — 失败栈与单独绿测否定。
- “应给每个 it.instance 独立 SQLite” — 大改 preload/db；非 first divergence。
- “放宽 storedString 容忍 undefined title” — 伪造成功，违反 cold 完整性。
- “去掉测试轮询避免 EPERM” — 掩盖 production rename 窗口不足。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Confirm worktree isolation: no drive-by doom-loop/i18n/sdk changes in this task.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | N-01 stale reclaim error mapping must stay on lease path after shared helper; N-02 Windows native proof remains CI-dependent | APPROVE | `ses_07ed2bc5fffeycnvBTEWBTtGMI` |

### Verbatim plan-audit verdict (round 1)

```text
No blocking findings.

APPROVE

Exact audited artifact only:
- Plan: docs/plans/ci-linux-cold-status-windows-eperm-fix.md
- Revision: R1
- Mode: plan / full-scope
- Implementation: still disallowed until recorder marks approved / Implementation allowed: yes for R1

Non-blocking:
N-01 Stale reclaim error mapping is implied, not spelled — writeAtomic rethrows last rename error; stale reclaim maps to MaintenanceBusyError; shared helper must keep surrounding busy mapping on the lease path.
N-02 Windows native proof remains CI-dependent — injection harness + Windows CI remain implementation verification obligations.
```

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/session/processor.ts` | completeToolCall: `title` 归一化为 string/`""` |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | `renameWithTransientRetry` 1s 合同；writeAtomic + stale reclaim 共用 |
| `packages/opencode/test/session/processor-effect.test.ts` | 无 title image tool 完成后 `title === ""` |
| `packages/opencode/test/session/messages-pagination.test.ts` | `sessionColdOwners`；去掉全局精确 coldOwners 断言 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | task-file EPERM 注入 retry 测试 |
| `packages/opencode/test/cli/tui/task-write-retry-worker.ts` | 注入 worker（新增） |
| `docs/plans/ci-linux-cold-status-windows-eperm-fix.md` | plan |

`git diff --stat`（本任务核心路径，不含并行 doom-loop 无关块时约）: 5 files ~93 insertions / 33 deletions + 新 worker。

### Red-Green Test Evidence

| Slice | Red (pre-fix observed) | Green (post-fix) |
| --- | --- | --- |
| title | `omits an image` 未断言 title；combo corruption | title `""`；combo 77 pass |
| session cold | cold+pagination Expected 1 Received 4 | 86 pass |
| EPERM task write | writeAtomic 5×25ms | inject worker write-ok；3 daemon filters pass |

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t 'omits an image'` | packages/opencode | 1 pass |
| `bun test --timeout 30000 test/session/processor-effect.test.ts test/session/messages-pagination.test.ts` | packages/opencode | 77 pass |
| `bun test --timeout 30000 test/storage/cold.test.ts test/session/messages-pagination.test.ts` | packages/opencode | 86 pass |
| `bun test --timeout 30000 test/cli/tui/daemon.test.ts -t 'writeMaintenanceTask retries\|startup resumes\|maintenance lease retries'` | packages/opencode | 3 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

- Linux combo corruption loop: green after title normalize.
- Windows CI native EPERM: not re-run on this host; inject harness covers same rename contract.

### Actual Secondary and Replacement Path Inventory

- Title normalize at completeToolCall: primary.
- Registry `title ?? ""`: preserved plugin path.
- ColdStorage storedString hard-fail: preserved.
- sessionColdOwners: test-only contract.
- renameWithTransientRetry shared: primary; stale maps to MaintenanceBusyError (N-01).
- No skip/xfail/catch-and-success.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~95 | processor title + server-lock helper + sessionColdOwners + daemon/worker tests；排除纯 import 排序 |
| Qualifying Chinese comment lines `C` | 16 | title 契约、session cold 断言、rename 共用/截止、worker 注入意图 |
| Ratio `C / E` | 16.8% | ≥15% |
| Required minimum `C` | 15 | ceil(95×0.15) |

Representative comments: processor completeToolCall title 归一化；messages-pagination sessionColdOwners；server-lock renameWithTransientRetry + writeAtomic/stale 共用；task-write-retry-worker 首次 EPERM。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope | Blocking | Non-blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | N-01 Windows native EPERM still CI-dependent; N-02 completeToolCall type still title:string; N-03 full package suite not re-run | APPROVE | `ses_07ec75c42ffeRqFvmZoTKLZ13k` |

### Verbatim implementation-audit verdict (round 1)

```text
No blocking findings.

APPROVE

Exact audited artifact only:
- Plan: docs/plans/ci-linux-cold-status-windows-eperm-fix.md
- Revision: R1
- Mode: implementation / full-scope
- Diff scope: processor.ts (title normalize), server-lock.ts (shared rename retry), processor-effect.test.ts, messages-pagination.test.ts, daemon.test.ts, task-write-retry-worker.ts, plan file
- Parallel doom-loop / i18n / sdk worktree: not in this approval scope

Non-blocking:
N-01 Windows 原生 EPERM 仍依赖 CI
N-02 completeToolCall 类型仍写 title: string
N-03 本轮未跑完整 packages/opencode 全量 suite
```

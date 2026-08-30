# Plan: CI 第二批红测修复（macOS ripgrep 超时竞速 + Linux daemon 维护 reconcile 覆写）

Status: verified
Revision: R1
Approved revision: R1
Implementation allowed: yes

## 1. 用户需求（原文引用）

> "请注意，我们最终需要保证最终 test 的 CI 中不会出现任何的错误，一旦有错误都必须纳入 GOAL 中，不得以非目标等等作为理由不进行相应的修整，或者说不能以非本次引入作为理由不实现。"
> "整体修改文件数不超过六个文件，代码行数不超过八百行"（GOAL 级累计；前一任务已提交 3 文件/生产 6 可执行行，d2ca1ae6d6）

问题对象：CI run 33312613383（@d2ca1ae6d6）test workflow 两腿红（Windows 腿全绿，前一任务目标红测已被 CI 确认修复）：

- macOS 腿：`file.ripgrep > search timeout returns a bounded partial result instead of failing [75.37ms]`
- Linux 腿：`daemon lifecycle > db compress variants keep the daemon and skip reclaim after the user declines shutdown [3888.92ms]`

## 2. Evidence / 反馈回路（已实际运行）

- A 回路：`bun test test/file/ripgrep.test.ts -t "search timeout"`（cwd=packages/opencode）。CI macOS 失败签名：`test/file/ripgrep.test.ts:345` `expect(result.timedOut).toBe(true)` **Expected: true / Received: undefined**——`timeout: 1` 的竞速中 rg 在预算内完成。Windows 本机绿（时序平台敏感，绿色不代表修复；修复证据 = 语料物理下界论证 + 三平台 CI 绿）。
- B 回路：WSL Ubuntu-22.04 独立副本（~/repro，ext4 + Linux bun 1.3.13）循环运行诊断副本 `-t 'db compress variants keep the daemon'`：**6 次第 6 红、12 次第 3 红**（≈17-30% 复现率）。Windows 本机 10/10 绿。诊断副本已从工作区删除（仅存 WSL ~/repro）。
- B 证据链（~/daemon-diag/fail-plain-1788103654137）：
  - CLI 输出与 CI 逐行同构（`Maintenance task dbm_322229e5… is interrupted` + exit 1）。
  - task record：`createdAt=1788103653643` → `updatedAt=1788103654047`（interrupted 写入，仅 +404ms），`processed=0`、`cursor.lastID=""`（空库任务瞬间完成）。
  - maintenance 树仅剩 `tasks/`，**`lock/` 已删除**（lease 已正常释放）。
  - dev.log：`ERROR … message=Maintenance task dbm_… is interrupted … at waitForDaemonTask (db.ts:391)`。
- 因果（相对 d2ca1ae6d6）：两缺陷所在子系统（ripgrep 搜索 / daemon 维护）均未被前一任务 diff 触及；B 在 57d1fe064 attempt 1 已红（早于本 GOAL 全部工作）。按 §1 原文纳入修复。

## 3. 根因（first divergence，均已定证）

- **A（测试时序敏感，非生产缺陷）**：`ripgrep.ts:515-531` 的超时实现是 `Effect.forkScoped(sleep(1ms) → timedOut=true → kill)` 与 rg 收集（:533-573 `Effect.all`）的竞速。测试语料（`ripgrep.test.ts:338`）为单个 32MB 全 'x' 文件，pattern "needle" 走 memmem 字面量扫描，macOS M-series 吞吐下可 <1ms 扫完 → 竞速败北 → `timedOut: undefined`。作者注释自证测试意图：「真实 rg 进程需要足够大的输入才能稳定越过 1ms 预算」——32MB 对现代 Apple Silicon 不足。
- **B（生产跨进程竞态，first divergence = `server-lock.ts:285-307` `reconcileMaintenanceTask`）**：观察者（CLI `waitForDaemonTask`，db.ts:374 每帧调用）①读 task=running → runner（daemon `worker.ts:147-162`）②写 terminal checkpoint（`writeMaintenanceTask`→`writeAtomic` tmp+rename，await 完成）→ ③`finally lease.release()`（rm lock dir）→ 观察者 ④读 owner.json 不存在 → **无条件写 interrupted，覆写②已持久化的 terminal 状态** → CLI 读回 interrupted → `MaintenanceUnavailableError`（db.ts:391）→ exit 1。空库任务 ~400ms 完成使毫秒级 straddle 窗口在 Linux 上 ≈17-30% 命中；Windows 时序未命中（10/10 绿）。
- **次序论证（B 修复的正确性基础）**：release 严格后置于 terminal checkpoint（同进程顺序 await，worker.ts:149-158）；因此 owner.json 缺失 ⇒ terminal 状态已在页缓存可见——**在④之后重读 task 即可确定性区分「runner 已完成」与「runner 已死亡」**。

## 4. Primary Path（两个 seam，单一权威路径，无 fallback）

- A：`test/file/ripgrep.test.ts:334-340` 语料从单文件 32MB 改为 **512 × 1MB 文件**（'x' 组成行，不含 "needle"）；512 < `MAX_SEARCH_FILES=5000`（ripgrep.ts:22）不触发 broad-scope 预过滤。断言、pattern、`timeout: 1` 全部不变。物理下界：512MB 即使按 100GB/s 理论吞吐上限 ≥5.1ms ≫ 1ms 预算（现实 10-50GB/s → 10-50ms）；≥5ms 的扫描时长同时覆盖 loaded runner 的 sleep 迟发射，竞速确定性由 rg 落败。
- B：`server-lock.ts` `reconcileMaintenanceTask` 在 owner 检查失败（缺失/死亡/不匹配）后、降级写之前**重读 task record**；若已为 terminal（completed/failed/interrupted）则原样返回、不写；仅当重读仍为 queued/running 才降级 interrupted。中文注释落在守卫处（含次序论证与 straddle 竞态背景）。

## 5. File Plan / TDD / Verification

- 文件（GOAL 累计 3+2=5 ≤6 ✓；生产累计 6+~6 ≤800 ✓）：
  1. `packages/opencode/test/file/ripgrep.test.ts`（语料扩容 + 注释更新）
  2. `packages/opencode/src/cli/cmd/tui/server-lock.ts`（reconcile 重读守卫 + 中文注释）
- Red→Green：
  - B：修复前 WSL 已 2 次红（§2）；同步 server-lock.ts 至 ~/repro 后 WSL 循环 **≥20 次全绿**（缺陷在场时 P(20 连绿)≈0.8^20≈1.2%，为强拒绝证据）。
  - A：物理下界论证 + Windows/WSL 本机绿；macOS 吞吐无法本机模拟，以 CI macOS 腿为最终门。
- 回归：`bun test test/file/ripgrep.test.ts`（Windows + WSL）；`bun test test/cli/tui/daemon.test.ts`（Windows 全文件 + WSL 一轮——含维护/lease 全套既有用例，守卫不得改变崩溃 owner 降级、冲突检查语义）；`bun run typecheck`（packages/opencode）exit 0。
- 提交后：CI run 三腿全绿（§1 CI-no-error 终门）。
- E/C：生产 E≈5 → C≥1（守卫处中文注释：次序论证 + 竞态背景）；测试 E≈2 → C≥1（语料规模理由注释）。

## 6. Risks / Rejected Speculation

- B 重读窗口残留竞态：按 §3 次序论证不可能（owner 缺失 ⇒ terminal 已可见；重读位于 owner 读之后的同一调用内）。
- B `acquireMaintenanceLease` stale-reclaim 路径（:351-387）同类覆写风险：owner.json 在场且 pid 死 = 崩溃 owner，永无后续 terminal 写，降级语义正确——不改（投机防御，拒绝）。
- A 备选方案拒绝：2 万小文件（触发 5000 上限预过滤）；FIFO 阻塞读取（Windows 不可用）；亚毫秒 timeout（sleep 定时器粒度下限 ~1ms，无效）；弱化断言接受 `timedOut !== true`（摧毁覆盖）。
- A 磁盘/时间成本：512MB 生成 ~0.5-1.5s/次，CI tmp 空间充足。

## 7. Audit Contract

- 计划审计（Round 1，adversarial-auditor 全量独立重导）：**No blocking findings — APPROVE**（R1）。非阻塞：N-01 B 无确定性自动化回归测试（跨进程毫秒 straddle 无法无钩子确定性交织），实施审计须核验 WSL 红绿证据；N-02 §5 E 值算术漂移（下限保住）；N-03 不变量缺稳定 ID（file:line 追溯完整）；N-04 A 修复残余理论 flake 地板（macOS runner 把 1ms 定时器延迟到 ≥5-6ms 扫描下界之外仍可能败——物理有界，CI macOS 腿为终门，升级方向为加大单文件尺寸）。关键独立复核：cold.ts 全部退出路径均先 await terminal checkpoint（:3539/:3543/:3364/:3372/:3341）→ 次序论证成立且与 worker.ts:425 既有文档合同一致；reconcile 全部消费者（worker.ts:227/:419/:428、db.ts:374/:615/:690、server-lock.ts:313）无一依赖覆写行为、全部严格改善；taskID 复用不可能（dbm_+randomUUID）；terminal 写在重读之后落地需 live writer 需 lease，与 owner 检查失败矛盾（漏洞闭合）；stale-reclaim 路径确实非同类（owner 在场+pid 死 ⇒ 无后续 terminal 写，:363 状态检查已跳过已 terminal 者）。
- 实施审计：实施后同 subagent（Audit mode: implementation），red-green + 回归 + typecheck 证据。
- R1 实施后验证（全_New 证据）：①B red→green：WSL ~/repro（已同步两变更文件）循环 **22/22 绿**（修复前同回路 ≤12 次内 2 红，缺陷在场时 P(22 连绿)≈0.7%）；②WSL `test/file/ripgrep.test.ts` 全文件 22 pass/0 fail（新语料）；③WSL `test/cli/tui/daemon.test.ts` 全文件 39 pass/6 skip/0 fail（维护/lease 全套，Linux）；④Windows `test/file/ripgrep.test.ts` 全文件 22 pass/0 fail；⑤`bun run typecheck` exit 0。
- 实施审计（Audit mode: implementation，独立重跑可复核项）：**VERDICT-VERIFIED / APPROVE**。审计独立复跑：Windows ripgrep 全文件 22/0、typecheck 0、daemon `-t maintenance` 6/0、`-t 'db compress'` 2×1/0、WSL ripgrep 全文件 22/0、**WSL db-compress 循环 10/10**（与 builder 22/22 联合 P(绿|缺陷)≈3×10⁻⁵）、Windows daemon 全文件 41/4（4 红均为环境型 stop-command 超时且审计确认该路径不经过 reconcile seam、失败集漂移、宿主 8 opencode+7 node 进程）；diff 与批准 R1 逐块一致、无诊断残留、无 zz-* 文件；语料算术独立复算（64B×16384=1MiB×512，<5000）；守卫正确性从源码重导（全部 exit path 先 terminal checkpoint；消费者全部严格改善；settled 副本保留较新 cursor）。非阻塞：N-01 无确定性 in-repo 回归测试（承接计划审计 N-01，外部红证据链在案）；N-02 E 值漂移（实际生产 E=6/C=4、测试 E=4/C=3，均超 15% 目标）；N-03 冷僻残余：cold.ts:3543-3548 catch 路径 checkpoint 不持 lease，理论 straddle 双向均得真实 non-running 状态、窗口严格窄于修复前、无违反后果；N-04 A 终门为 CI macOS 腿（升级路径已记录）。提交后 CI 三腿绿为终局门。

## 8. 诊断证据附录（临时副本/插桩，已全部清理；WSL ~/repro 保留用于验证回路）

- WSL 复现环境：bun 1.3.13 / ext4 / Linux 5.x（WSL2），仓库副本 tar 排除 node_modules 后 `bun install`（2348 包，54s），与 Windows 工作区隔离。
- B 竞态时序（fail-plain-1788103654137）：task 创建 → daemon runner 空库扫描 0 owner → terminal checkpoint + release（≈400ms 内）→ CLI 观察者 reconcile straddle → interrupted 覆写 → db.ts:391 抛错。
- CI run 33292110169 attempt 1（@57d1fe064）Linux 腿同名失败为同一缺陷的历史实例（attempt 2 绿 = 竞态未命中，非修复）。

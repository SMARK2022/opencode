# Canonical Implementation Plan: smoke goal-frame 捕获前完整渲染 settle 谓词加固

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

用户证据（Build run 33292110326 @ 57d1fe064，smoke-macos 腿，一次性红、同 run
重跑绿）：

```
error: initial Goal frame duplicates CJK glyphs: "...█      检查log，\n█      请你自行独立完整完成相应\n█..."
  at assertFrame (packages/opencode/script/smoke-opentui-artifact.ts:801:15)
```

用户指令逐字：

> 你当前引入了一些更多的问题。目前而言，我发现这个，甚至连这个 Build 都出现了红色。你到底是怎么搞的？你之前你不测试完你就不能提交啊！现在它全是红色，请你看一看到底什么情况。同时这个 Test 里面 Linux 的 BGo测试也是有这个红色。你之后的提交里面你能不能检查清楚？你不能让你的修改连我们之前的内容都给它破坏掉啊。这这是完全有问题的呀。你应该完整全面地检查呀，到底什么情况？你为什么改一条引入一切，改一条引入一切，这全都是红测试。

治理规则（用户既有声明，同会话）：

> 所有的修改在实施之前必须在相应的 plans里面记录并经过完整审计。未经审计的改动是不被允许的。也就是每一个改动必须有相应的实施前的 plan 的审计以及相应的实施后审计。

## 2. Explicit Non-Goals

- 不修改 `assertFrame` 断言本身（两个"查"计数语义是正确的生产观察目标）。
- 不修改 daemon db-compress 测试：一次性 flake 无复现信号（本机 4 连绿 +
  同提交 CI 重跑绿），按 diagnosing-bugs 纪律无红色回路即无根因修复；记录
  监控处置（§20）。
- 不修改 OpenTUI 渲染器/TUI 生产代码（缺陷在测试捕获条件，不在渲染）。
- 不追溯改动 57d1fe064（其消费面审计在案；两个 flake 均为同提交重跑自愈，
  无确定性因果）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | 测试/typecheck 从包目录运行；风格规则 |
| `.opencode/policy/first-principles-engineering.md` | owner 修复、E/C 门禁、no-evidence-no-edge-case |
| `docs/plans/spawner-exit-signal-drain-decoupling.md`（verified） | 前任务记录；本任务为新的独立因果链（smoke 谓词缺陷先于 57d1fe064 存在） |
| `packages/opencode/script/smoke-opentui-artifact.ts` | 谓词缺陷所在文件（:467-477/:489-494/:501-505 三处 waitFor） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| CI Build run 33292110326 失败日志（gh 独立拉取）：smoke-macos `assertFrame :801` 抛错，捕获帧 Goal 文本止于"请你自行独立完整完成相应"，objective（:123，恰好两个"查"，:126 注释自证）后半段"的调研与检查，并进行多轮的负载并发、高压"未渲染 | 症状：**部分渲染帧**通过了 waitFor 谓词进入断言 | observed |
| 同 run 重跑（Build run 状态 completed/success）+ 本机 Windows 全新编译二进制 smoke 全绿（sourceCount:2/renderedCount:2） | 单次竞态、非确定性；本地未触发（时序依赖） | observed |
| **谓词缺陷机械证明**：`:472` 谓词 `frame.includes("Goal") && frame.includes("检查log")` 对 CI 捕获帧为真（帧含第一处"检查log"），而 `assertFrame`（:798-801）要求 `count(frame,"查")===count(objective,"查")===2` 对同帧必假（仅 1 个"查"）——谓词可被不满足断言的中间帧满足 | 红色回路的可归约形式：predicate(f)=true ∧ assertFrame(f)=throw，f 即 CI 在案帧 | observed（代码 + 在案帧字符串） |
| `:489-494`（resized）与 `:501-505`（restored）两处 waitFor 使用同款弱谓词（"Goal"+"检查log"） | 同缺陷三处实例：resize 后首帧同样可能部分渲染 | observed |
| daemon Linux 腿：CI run 33292110169 首次 attempt 失败（db compress 测试 3878ms）→ 自动重跑同腿 success；本机 4 连跑全绿（70-84s/次） | 无复现信号；排除出本任务范围（§2） | observed |
| 50c58ea0b2 与 57d1fe064 的 Build/test 前后对照：Build 50c58ea0b2 success → 57d1fe064 首次 failure（smoke-macos）→ 重跑 success | 单次时序暴露，非确定性因果；弱谓词缺陷先于两提交存在（git blame 该脚本 2026-08-11 未动谓词） | observed |

## 5. Current Behavior

```text
TUI 渲染 Goal sidebar（OpenTUI 增量 diff，文本逐块到达 PTY）
waitFor 谓词：frame 含 "Goal" + "检查log" 即返回捕获
  -> 首个含第一行 objective 的中间帧即可通过谓词
assertFrame：要求整段 objective 的 glyph 计数一致（两个"查"）
  -> 部分帧必然抛 "duplicates CJK glyphs"（计数 1≠2）
慢腿（macOS x64）渲染分块间隔更大时，捕获早于完整渲染 → 闪红
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 增量渲染的中间帧（含"Goal"+第一处"检查log"、缺 objective 尾部） | OpenTUI 分块渲染时序（不可控外部调度） | 无——谓词未要求渲染完成 | 任何一次 smoke 运行（三处 waitFor 同缺陷）；CI 已观测一次 | 测试捕获条件（smoke 脚本自身） | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-08 | settle-before-capture：三处 goal-frame waitFor 的谓词必须只能被**完整渲染**帧满足（含 objective 尾部标记），使 assertFrame 收到的帧在构造上已含全部两个"查" | CI 在案部分帧 + 谓词/断言机械证明 | smoke 自身（三处 assertFrame） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-08 | `smoke-opentui-artifact.ts` 三处 waitFor 谓词以"Goal"+"检查log"为就绪条件（:472/:492/:503），首个"查"所在行到达即返回，而渲染仍在中途 | smoke 脚本 waitFor 谓词（捕获条件 owner 即该脚本） | §4 机械证明：CI 帧 f 满足谓词不满足断言 |

红色回路（可归约）：CI 在案帧字符串直接构成
`predicate(f)===true ∧ assertFrame(f)===throw` 的反例输入；修复后该 f 不再
能通过谓词（f 缺尾部标记），谓词只放行完整帧。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 捕获就绪条件 | smoke 脚本三处 waitFor 谓词 | 只放行满足断言前提的帧 | 捕获时机唯一由谓词决定 | assertFrame 是正确断言不改；渲染器时序不可控不归测试管 |

## 10. Single Approved Primary-Path Design

三处 waitFor 谓词统一加"objective 尾部标记"条件：在 `"检查log"` 之外同时要求
`frame.includes("高压")`（objective 最后两字，位于两个"查"之后——其出现构造上
保证全段已渲染）。实现为小常量 `const objectiveTail = "高压"` 加三处谓词
`&& frame.includes(objectiveTail)`；每处配一行中文注释说明 settle 语义。
不引入 sleep/双帧比较（弱化且慢）；不改 assertFrame；不改渲染。

```text
PTY 增量帧 -> waitFor(frame 含 Goal + 检查log + 高压) -> assertFrame(计数恒等)
```

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 弱谓词（Goal+检查log） | 现有 | 待修复的 primary 路径 | yes | 主路径 | 就地收紧 |
| sleep 后再捕获 | 不存在 | forbidden（固定 sleep 反模式，test/AGENTS 明令） | — | 0 | reject |
| 双帧一致再捕获 | 不存在 | rejected（更慢更复杂，尾部标记已构造充分） | — | 0 | reject |
| assertFrame 放宽为 ≥1 查 | 不存在 | forbidden（弱化正确断言） | — | 0 | reject |

## 12. Workaround Deletion and Replacement

无存量 workaround（缺陷为谓词欠约束，此前无补偿层）。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-08 settle-before-capture | 三处谓词收紧 | smoke-opentui-artifact.ts | 本机 smoke ×2（编译二进制）+ CI Build 复跑（用户） |
| 治理双审计 | 本 plan | plan 文档 | §22/§24 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| objectiveTail 尾部标记谓词 | INV-08 | CI 部分帧反例 + 机械证明 | 弱谓词可被中间帧满足，无任何条件保证渲染完成 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/script/smoke-opentui-artifact.ts` | modify | 常量 objectiveTail + 三处谓词收紧 + 3 行中文 settle 注释 | 约 +7/−3 |
| 本 plan | add | — | — |

（1 代码文件 + plan = 2 文件。）

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | CI 在案部分帧 f：谓词 true ∧ assertFrame throw（§8 反例） | 弱谓词 | 收紧后 predicate(f)=false（f 无"高压"），完整帧才放行 | INV-08；三处 waitFor 一并收紧 |

本地回路：收紧前无本地红（时序未触发，诚实记录）；反例来自 CI 在案帧（observed
类），修复后本机 smoke ×2 全绿 + 三处谓词不再可被反例满足（构造论证）。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 4（1 常量 + 3 谓词条件） | 排除注释 |
| Required Chinese explanatory comments `C` | ≥ 1；计划 3 行（每处谓词 1 行 settle 语义：为何尾部标记等价于渲染完成） | 邻近修改点 |

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run build --skip-install --os=win32 --arch=x64` | packages/opencode | 编译 exit 0 |
| `bun run script/smoke-opentui-artifact.ts --binary dist/opencode-windows-x64/bin/opencode.exe`（×2） | packages/opencode | 两次全绿（sourceCount:2/renderedCount:2） |
| `bun typecheck` | packages/opencode | exit 0 |
| CI Build 复跑（用户侧） | — | smoke 三腿全绿 |
| 反例论证 | — | CI 在案帧不再满足收紧后谓词（构造检查） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0（plan 除外） | — |
| Files modified | 1 + plan = 2 | 单点谓词收紧 |
| Production lines | 约 +7/−3 | — |
| Test lines | 0（smoke 即测试，自身收紧） | — |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无。

### Real Risks

- "高压"若在未来 objective 文案变更时被移除，谓词静默退化为弱谓词：注释明示
  该常量与 :123 objective 同源；文案变更需同步（一行注释承载该契约）。
- （N-01 补记）换行断裂：若 capture() 拼接帧中 "高"/"压" 被换行边界拆开，收紧后
  谓词在相应宽度不可满足 → waitFor 超时（确定性红，比闪红更易发现）。§18 本机
  ×2 覆盖全部三个宽度，断裂会在提交前变红；处置规则：从观测到的完整帧重新
  推导相邻尾部标记，禁止 sleep/双帧 fallback。
- daemon db-compress flake（本任务 Non-Goal）：无复现信号（本机 4 绿 + CI 重跑
  绿）。监控处置：若再次出现，取当次失败输出（exitCode/output 断言详情）另立
  plan；在取得红色回路前不投机修改。（N-02：首次失败 attempt 的日志可经
  jobs API 按 attempt 拉取作为下次复现时的对照基线。）

### Rejected Speculation

- "57d1fe064 因果追责/回退"——rejected：两 flake 同提交重跑自愈，无确定性
  因果；消费面审计在案（project.ts git helper 先排干后等码；shell/ripgrep/mcp
  在前任务已验）。
- "给 daemon 测试加预算/重试"——rejected：无复现信号，speculative。
- "sleep/双帧稳定化"——rejected：反模式/过度设计，尾部标记构造充分。

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
| 1 | R1 | yes | 0 | 3（N-01 “高压”换行断裂风险未记入 §20——若换行边界落在两字之间谓词将不可满足，但 §18 本机 ×2 三个宽度会先红门禁住，需补记 + no-fallback 再推导规则；N-02 daemon flake 监控基线建议现在拉取 33292110169 失败 attempt 日志作对照基线；N-03 §4 证据来源列混合用户 CI 事实与 builder 本机断言，未来修订应分列） | No blocking findings — APPROVE | ses_faeeb4331ffeL81uVSrYjUa9mb |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/opencode/script/smoke-opentui-artifact.ts`：+9/−3（审计 N-01 更正：三处谓词为原行修改非纯新增）。objectiveTail 常量（含 2 行同源契约注释）+ 三处 waitFor 谓词各加 `|| !frame.includes(objectiveTail)` 条件与 1 行 settle 注释（实增 5 行注释、无空行）。

### Red-Green Test Evidence

- 红（修复前）：CI 在案部分帧 f（Build run 33292110326 smoke-macos，帧文本止于"请你自行独立完整完成相应"，仅 1 个"查"）：谓词 f=true、assertFrame(f)=throw（§8 机械反例）。
- 绿（修复后）：收紧后谓词对 f 构造上为 false（f 无"高压"）；本机全新编译二进制 smoke ×2 全绿（sourceCount:2/renderedCount:2，三宽度 160×30→150×28→160×30 全部通过——N-01 换行断裂风险未发生）。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun run build --skip-install --os=win32 --arch=x64` | packages/opencode | exit 0（voice worker + version smoke 内置通过） |
| `bun run script/smoke-opentui-artifact.ts --binary dist/opencode-windows-x64/bin/opencode.exe` ×2 | packages/opencode | 两次全绿（sourceCount:2/renderedCount:2） |
| `bun typecheck` | packages/opencode | exit 0 |
| CI Build 复跑 | 用户侧 | 待复跑（三腿） |

### Original Feedback-Loop Result

反例归约（§8）：CI 帧字符串对旧谓词 true / 对新谓词 false（构造检查通过）；本机两轮 smoke 即原始回路。

### Actual Secondary and Replacement Path Inventory

与 §11 一致：无新增替代路径、无 sleep/双帧、无断言放宽；诊断决策面 0%。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 4 | 1 常量 + 3 谓词条件（原行修改）；排除 5 行注释（审计重算一致） |
| Qualifying Chinese comment lines `C` | 5 | 常量同源契约 2 + 三处 settle 各 1 |
| Ratio `C / E` | 1.25 | ≥ 0.15 |
| Required minimum `C` | 1 | `max(1, ceil(4 × 0.15))` |

### Remaining Unverified Items

- CI Build 三腿复跑（用户侧）：smoke-macos 闪红消除且其余腿无新红。
- daemon db-compress flake：无复现信号，监控处置（§20）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | 2（N-01 §23 diff 统计口径不准：实际 +9/−3 非 +11/−0、注释 5 行非 7 行，实质 E/C 不变；N-02 CI 三腿复跑仍为用户侧待办，本机 ×2 三宽度绿 + 列网格换行平台确定性支撑） | No blocking findings — APPROVE | ses_faee026a3ffewaV6cZo2YoE7PS |

<details><summary>Verbatim independent implementation audit verdict (Round 1, plan revision R1) — approved</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 §23 diff-stat record inaccurate
Plan §23 records the actual diff as `+11/−0`; the real diff is **+9/−3** (`git diff --stat`: `9 insertions(+), 3 deletions(-)` — the three predicate lines are modifications of existing lines, not pure additions). Likewise "排除 7 行注释/空行" — actual added comment lines are 5, with no blank lines. The substance (E=4, C=5, design content) is correct; arithmetic record drift only, non-blocking per skill rules since I recomputed the actual diff.

### N-02 CI three-leg re-run remains user-side pending
Recorded honestly in §23 "Remaining Unverified Items". The original red loop was CI-observed (smoke-macos, run 33292110326); the fix is verified by mechanical counterexample rejection + local ×2 green at all three widths. Script hardcodes cols 160→150→160 on every platform and cell-grid wrap is column-deterministic (CJK advance fixed at 2 cells), so tail-marker satisfiability is platform-stable. User-side CI re-run confirms; it cannot block the diff itself.

## Rejected speculation

- **"Predicate could pass a frame containing 高压 but missing the second 查 (out-of-order render)"** — rejected: OpenTUI paints in order; more decisively, `assertFrame` (:804-811) remains the unchanged success authority after the predicate, so such a pathological frame would still throw. The predicate is a pure strengthening (every frame passing the new predicate passed the old one); no newly reachable failure exists except the already-recorded deterministic-timeout mode in plan §20 N-01.
- **"Resize/reflow mixed-frame race"** — rejected: strictly less reachable than before the change (passing set strictly narrowed); not made newly reachable by this diff.
- **"Daemon Linux db-compress flake needs a fix now"** — rejected per approved plan §2/§20: no reproduction signal (local 4× green + same-commit CI re-run green); no red loop → no root-cause repair, monitoring disposition recorded.

## Requirement and traceability coverage

- **Original requirement** (CI red investigation, both Build smoke-macos and Linux test legs, plus standing dual-audit governance rule): both reds dispositioned in approved plan R1 — smoke-macos root-caused to the weak waitFor predicate and fixed; daemon flake evidence-triaged as Non-Goal with monitoring. Scope inherited from plan-audit Round 1 (APPROVE); no narrowing introduced at implementation time.
- **INV-08 (settle-before-capture)**: implemented at the owning seam (the smoke script's three goal-frame waitFor predicates, :476/:497/:509) exactly per plan §10 — `objectiveTail = "高压"` constant (:126, adjacent to the objective at :123) + `|| !frame.includes(objectiveTail)` on all three predicates. Grep confirms exactly three predicate sites; no fourth weak instance exists. `assertFrame` and `capture` untouched.
- **Governance**: pre-implementation plan audit recorded (§22, R1 APPROVE); this audit closes the required post-implementation audit.
- **Verification (all independently reproduced, not builder-claimed)**: `bun typecheck` exit 0; `bun run build --skip-install --os=win32 --arch=x64` exit 0 (version smoke + voice worker smoke green); smoke ×2 against the freshly compiled binary — both green (`sourceCount:2, renderedCount:2`, initial/resized/restored all passed under the tightened predicate).
- **Mechanical red-loop closure**: `assertFrame` (:806-807) throws the exact observed CI message on any `count(frame,"查") !== 2` mismatch; the observed partial frame satisfied the old predicate and fails the new one by construction (it lacks 高压).

## Primary-path and fallback verdict

Single authoritative path preserved and narrowed: `waitFor(Goal + 检查log + 高压) → assertFrame(glyph-count identity)`. The change is a pure conjunction strengthening of the wait condition — no sleep, no double-frame comparison, no assertion relaxation, no alternate success path, no fallback, diagnostic surface 0%. `assertFrame` remains the sole success authority. Root cause repaired at the owner (capture condition); no workarounds existed to delete (§12).

## Code quality and Chinese-comment verdict

Style compliant: one constant, inline conditions, no premature helper extraction, no `any`, no else-branches — matches root and package AGENTS.md. Independently recomputed from the actual diff: **E = 4** (1 constant + 3 modified predicate lines; excluded 5 comment lines), **C = 5** (2 same-source contract lines at the constant + 3 settle-semantic lines at each predicate; all explain rationale/invariants, none restate code or translate identifiers), **ratio C/E = 1.25** — above both the 0.10 blocking floor and the 0.15 target. Matches plan §23's recorded values.

## Release verdict

**APPROVE** — implementation diff (+9/−3, `packages/opencode/script/smoke-opentui-artifact.ts`) against approved plan revision R1. No blocking findings; all hard gates pass under independently reproduced verification. Task may be marked `verified` pending only the user-side CI three-leg re-run already recorded in §23.

</details>

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

# Session GOAL

## 参数

- **原始需求**：<逐字需求，或稳定 issue / specification 路径>
- **目标终态**：<approved-plan-only | verified-implementation | verified-implementation-and-commit>
- **Canonical plan**：<用户路径；否则按仓库约定，最终回退到 docs/plans/<task-slug>.md>

## GOAL 合同

- 跨 continuation 保持完整需求、范围和放行标准，不得缩小终态。
- skills 和文档按阶段即时加载，禁止开局一次性读取全部内容。
- 审计材料只由 `adversarial-auditor` subagent 加载；primary agent 不预读、不自审。
- 阶段加载的 policy、skill、template、仓库指令和 canonical plan 是权威依据。
- 仅在目标终态被当前证据逐项证明后标记 `complete`。同一真实阻塞在两个连续 eligible GOAL turns 中保持不变且无法继续推进时，才在第二次标记 `blocked`。

## 第一性门禁

- “完整”覆盖证据证明受影响的 interface、producer、consumer、调用链和行为映射，不等于扫描整个仓库。无法绕过的上游保证不得在下游重复实现，speculative 边界不得驱动代码或 blocking finding。
- 默认修复 primary path 的 first divergence。禁止 A -> B -> B1/B2/B3、平行实现、catch-and-success 和临时 fallback。只有用户原文明确要求时才允许精确 rollback，且不得成为失败后的备用成功路径。
- 必要增强可由 invariant、仓库规则、真实 compatibility、reachable safety risk 或 threat model 证明，无需逐字对应用户原句，但须归属正确 owner、保持必要范围并具备行为验证。speculative defense-in-depth 禁止。
- 门禁只约束行为、证据、owner 和验证，不规定函数数、文件数或代码结构。采用仓库最自然、内聚且足以承载需求和必要安全性的设计。
- 每个 production concept 必须映射到用户需求、既有 invariant、仓库规则或真实安全/兼容证据，并说明现有逻辑为何无法承载。diff 大小不能替代完整性判断。
- 只维护一个 canonical plan；聊天摘要、旧审计和 builder 自述不构成实施授权。

## 阶段 1：构建 Canonical Plan

### 此时加载

- `first-principles-planning`，并按其要求读取当前 policy、canonical template、`CONTEXT.md`、ADR 和适用的 `AGENTS.md`。
- bug、失败或性能回归在建立反馈信号时加载 `diagnosing-bugs`。
- 仅在设计 test seam 和 behavior slice 时加载 `tdd`。
- 不得加载 `adversarial-audit` 或 `approved-plan-implementation`。

### 产物和门禁

- 从当前仓库重新调查，不把旧方案或旧审计当作已确认事实。只创建或修订 plan，不修改 production、tests、config、migration 或 generated files。
- bug 类任务必须建立并实际运行能够捕获用户原始症状的 red-capable feedback loop。没有该信号时不得仅靠源码阅读猜根因，应继续构建信号或记录真实环境阻塞。
- 完成 template 各字段：evidence/domain/reachability、invariant/divergence/owner、route/paths/workaround、file/TDD/verification/diff、risks/speculation/audit/comments。
- forward mapping：requirement/invariant -> owner/path/file/test。reverse mapping：concept -> requirement/invariant/safety evidence + 不可复用原因。确认行为没有 executable path、行为测试或明确 unverifiable reason 时不得提交；引用位置、估算和重复证据不构成映射缺失。
- 完成后设置 `Status: audit-required`、`Approved revision: none`、`Implementation allowed: no`。

## 阶段 2：独立方案审计

### Primary Agent

- 只调用 `adversarial-auditor`、发送 handoff、接收并原样记录 verdict。
- 不加载 `adversarial-audit`，不发送自评、问题猜测、设计辩护、建议审计范围或“已经检查过”的声明。
- handoff 仅含原始需求、plan 路径、repository root 和 `Audit mode: plan`。

### Auditor Subagent

- 本轮开始时自行加载 `adversarial-audit`、policy 和必要仓库证据。
- 按自身 skill 独立审计；primary agent 不复述、筛选或预判审计标准。

### Blocker 复议

- 方案或实现审计返回 blocker 后，primary 先判断其是否属于用户需求且确需本次修改；若不确定或认为不需要，不得跳过或撤销，必须复用同一 `task_id` 引用 plan 与仓库证据请 auditor 自主复查。
- 复议消息只提供事实和引用，不提供期望 verdict、设计辩护、范围收缩或收敛压力；auditor 的复查结果作为本轮最终 verdict。

### 放行

- 经 policy 证实的 blocking finding 要求修订同一 plan、递增 revision、清空 approval，并按原始需求和完整 affected interface full-scope 重审；non-blocking record correction 不清空 approval 或触发重审。
- 最多 6 轮，每轮使用同一材料性标准，不得以轮次、边角问题或“整体无重大问题”诱导 auditor 升降判级。连续调用失败 3 次后记录 `independent-audit-unavailable`，不得 self-review。轮次用尽后 blockers 仍保持 blocking，并作为开放决定交给用户。
- exact revision 仅在获得 `No blocking findings` 和 `APPROVE` 后，才原样记录 verdict，设置 `Status: approved`、`Approved revision: <current>`、`Implementation allowed: yes`；不得夹带设计修改。
- `approved-plan-only` 在完成逐项终态审计后标记 GOAL `complete`，不得实施代码。

## 阶段 3：按批准 Revision 实施

### 此时加载

- 仅在目标包含 implementation 且 exact revision 已批准时加载 `approved-plan-implementation`，并加载或继续执行 `tdd`。
- bug 类任务继续使用既有 `diagnosing-bugs` feedback loop。

### TDD 和修改边界

- 实施前重读批准范围；相关 interface、producer/consumer、invariant、owner、tests 或 file plan 漂移时停止并重审，不覆盖、不回退、不夹带无关 worktree 修改。
- 按批准 seam 执行 `red -> minimal approved behavior -> green -> regression`；只执行 approved repair/rollback，保持既有质量和安全约束并删除淘汰 workaround。
- 必要安全增强必须进入新 revision；禁止无依据的 refactor、fallback、public API、配置和迁移。

### 注释和验证

- 记录实际 `E/C`：`E` 排除空行、import-only、formatter-only、generated 和 pure-move，必须满足 `E=0 时 C=0`、否则 `C >= max(1, ceil(E * 0.15))`；`C` 只计邻近修改点并解释 invariant、真实边界、常量、测试意图、compatibility 或 safety，复述代码、翻译 identifier、重复测试名、显然流程、集中堆放和拆行凑数不计。
- 从最窄测试扩展到适用的 regression、原始 loop 和 package-local checks；遵守工作目录，不跳过或弱化失败，并记录命令、目录、结果和修正。

## 阶段 4：独立实现审计

- implementation evidence 记录 files/diff、red-green、verification、原始 loop、paths、E/C、排除行、未验证项。设置 `Status: implementation-audit-required`，未经 revision 不再 material change。
- primary agent 只发送原始需求、plan/approved revision、repository root、`Audit mode: implementation`、changed files/diff，不发送实现辩护、自评、怀疑点或缩减范围。
- auditor 自行加载 skill、policy 和仓库证据，按原始需求审计全部实际 diff hunk 及其直接行为路径；触碰文件不等于整个文件进入范围，也不得接受 primary 缩小实际 diff。
- 复议后仍保留的 blocker 必须返工并 full-scope 重审，最多 3 轮。连续失败 3 次后记录 `independent-audit-unavailable`，不得 self-review。轮次用尽仍有 blocker 时标记 `blocked`，不得 `complete`。
- 只有实际 diff 获得 `No blocking findings` 和 `APPROVE`，且测试、验证、责任边界、workaround 删除和中文注释门禁全部通过，才能原样记录 verdict 并设置 `Status: verified`。

## 可选 Commit

仅当终态是 `verified-implementation-and-commit` 且状态已 verified：

1. 检查 `git status`、`git diff`、`git diff --cached` 和 `git log --oneline -10`。
2. 确定本 GOAL 的完整路径清单并排除 secret、credential。工作区或 index 有无关内容时，使用 `git commit --only -- <本 GOAL 路径...>` 提交相关路径；相关 untracked files 先单独 `git add -- <paths>`，无关 staged/unstaged 内容保持原样。若同一路径混有无关修改，停止并报告。
3. 不创建空 commit。提交信息使用中文多行格式：`type(scope): 简短中文说明`，type 只取 `fix|feat|refactor|test|chore`，scope 使用受影响模块，后续 1 至 2 段说明原因、行为边界和避免的回归。
4. 不得 amend、不得 `--no-verify`、不得跳过 hook、不得 push。
5. hook 拒绝时修复原因并创建新 commit，不得 amend 失败尝试。commit 成功后检查 `git status` 并报告 commit id。其他目标终态不得 commit。

## 最终证据

- 报告 plan/revision、核心文件、测试/验证结果、approved-route 证据、删除的 workaround、path verdict、E/C 与代表性注释、全部审计轮次、剩余风险/未验证项及每个改动的必要性。
- token budget、turn 结束、部分成果或总结文本都不能证明完成。仍有 required work 时保持 GOAL active。

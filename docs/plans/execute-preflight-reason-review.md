# Canonical Implementation Plan: Execute Preflight Reason Review

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 当前会话逐字需求，见 §1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-10

本文件是本任务唯一实施合同；目标终态为 `verified-implementation-and-commit`。规划阶段除本计划外不修改工作树文件；只有当前 revision 获独立批准后才实施，验证完成后只提交本任务文件，不 push。

## 1. Verbatim Requirement

> "生成代码修改行数上限200行，避免引入无关的修改或无关的逻辑。正如前文所说的，你要构建 Verified Plan，也就是你要构建相应的完整的方案并进行审计。相应方案构建的流程请你参考 Document 里面的 Workflow.md。"

> "按照我的理解，整体的方案内容其实很简单，移除不必要的逻辑，且同时让相应的逻辑更加符合我们这套逻辑流程。而且按照我的理解，当前无需，或者说本身也没有必要引入更多的架构，或者说状态机等等一些内容。本质上复用现在就 OK 了。我希望整体生产代码修改在几十行之内解决这套问题。"

> "预审完之后……把这些原因做一个聚合，然后就对 execute 进行一次审计就 OK。"

> "如果遇到了不同的 reason……就把底层工具执行的信息……再对 execute 进行一次审计……底层工具具体的一个触发的一个完整的参数去写出来……或者说底层工具变成 metadata 里面的。"

> "我希望你的这个相应的 hunk 数保持尽量的精简，然后相应的生产文件各种的修改保持尽量的克制，能不扩张修改文件数就不扩张修改文件数。然后相应的这个修改的行数的上限呢，我认为是保持在生产代码保持在100行的修改以内。"

> "目标终态：verified-implementation-and-commit。"

## 2. Explicit Non-Goals

- 不改变桩预跑、工具返回 `null`、真实运行时重新执行并补充证据的现有机制。
- 不引入 PR #1 的 Notebook 环境、环境复制、预算或异步改造，不做静态 AST 扫描。
- 不修改普通工具的权限请求生成、ReviewerRequest schema、prompt template、配置、公开协议或生成文件。
- 不新增执行架构、状态机、缓存、依赖、fallback 或替代成功路径。
- 不把动态 Execute 审查改为底层工具审查；其顶层 `permission` 始终为 `execute`。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `docs/guides/workflow.md` | 本任务止于已批准计划；独立全范围审计后才允许实施。 |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；禁止无关抽象、fallback 与未映射概念。 |
| 根及 `packages/opencode/AGENTS.md` | 测试和 typecheck 从 package 目录运行；优先复用现有函数与 Effect 结构。 |
| `CONTEXT.md`、ADR 索引及 ADR-0001 | 没有 Execute 审批语义的额外 ADR；ADR-0001 与本任务无关。 |
| `docs/plans/execute-v1-unified-tools-auto-review.md` | 既有设计包含 `code/probe/trigger` 和等级上界；仅作现状证据，不继承其超出本需求的复杂度。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `packages/opencode/src/tool/code-mode.ts:106-181` | 当前用受限 JS 运行时和 `null` 桩预跑，保留 observed 后真实执行。 | observed |
| `packages/core/src/permission/precheck.ts:228-295,560-607,1243-1330` | execute 逐项分类、聚合 reason；Shell/Git 一次请求可含多条换行 reason。 | observed |
| `packages/opencode/src/permission/index.ts:50-59,90-350` | 规则求值、reviewAuto、beginExecute、等级复用及 `trigger` 的生产者。 | observed |
| `packages/opencode/src/session/tools.ts:117-306` | 真实工具、最新 ruleset、hook 后参数和子调用来源。 | observed |
| `packages/core/src/permission/auto.ts:48-138` | prechecked 复用及 safe/general/cautious/dangerous/forbidden 路由。 | observed |
| `packages/core/src/permission/reviewer/{schema,prompt}.ts` | Reviewer 只消费 permission/patterns/metadata/precheck 并序列化。 | observed |
| `packages/opencode/test/{permission/execute,session/execute}.test.ts` | 当前共享审批、动态升阶、strict、ask、forbidden、并发与真实工具行为。 | observed |
| PR #1 `execute-async-flow` | 同样使用桩预跑；其环境系统不属于本修复。 | observed |
| 用户提供的 reviewer prompt | `metadata.trigger` 内实际出现完整 ruleset。 | observed |

## 5. Current Behavior

```text
model code
  -> CodeMode.execute（桩工具，1s/128 calls；工具返回 null）
  -> observed[{tool,input}]
  -> precheck(permission=execute,calls=observed)
       -> 每 call 以 permission=call.tool、patterns=[]、metadata=args 分类
       -> level 取上界；reason 字符串去重后以 "; " 连接
  -> beginExecute/reviewAuto
  -> 真实 runtime.execute
       -> 工具产生真实 permission/patterns/metadata
       -> precheck(actual request)
       -> approvedOnce 且 level <= approvedLevel 时复用，否则 parent(request) 重审
```

普通工具先由工具产生 `permission/patterns/metadata`，`matchRequest` 消费 ruleset 决定路由，precheck 消费动作字段产生 level/reason，ReviewerRequest 只保留动作字段和 precheck。

动态 Execute 当前把完整 `AskInput` 放进 `metadata.trigger`；普通顶层 ReviewerRequest 的白名单无法裁剪这个嵌套对象，因此完整 ruleset 进入 prompt。

## 6. Supported Input Domain and Reachability

| Input/condition | Producer | Path | Owner | Class |
| --- | --- | --- | --- | --- |
| 预跑可观察调用 | 受限 JS + 桩 | observed → execute precheck | PermissionPrecheck | observed |
| 预跑遗漏或参数变化的调用 | 真实工具结果/hook | invoke → tool ctx.ask → ExecuteReview.ask | Permission | observed |
| 同等级新 reason | `git -c … push` 等真实命令 | 初始 cautious → 实际 cautious + 新 reason | ExecuteReview | observed |
| 单次请求多 reason | Git 全局 flag、Shell 多段命令 | evaluateShell/classifyGit → 换行 reason | PermissionPrecheck | observed |
| safe/general、strict、ask、deny、forbidden | 现有配置与工具请求 | matchRequest/reviewAuto/requestUser | Permission | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 保留桩预跑和真实运行时兜底；预跑 reason 求并集，level 取上界。 | 用户原文；code-mode/precheck | `session/execute.test.ts` |
| INV-02 | Execute 初审和新 reason 重审均以 `permission=execute` 使用原 ReviewerRequest；code/probe 保留，实际请求证据放入 metadata。 | 用户原文；Reviewer schema | `permission/execute.test.ts` |
| INV-03 | 已批准 reason 全部覆盖当前 reason 时复用；出现新 cautious/dangerous reason 时重审 Execute；批准后累积 reason。 | 用户原文；§8 红色复现 | 新增 TDD slice |
| INV-04 | forbidden 仍终局；safe/general、strict、显式 ask/deny、并发锁和跨 Execute 隔离保持原行为。 | 现有合同 | `permission/execute.test.ts` |
| INV-05 | 不再生成 `trigger`，其嵌套 ruleset 不得进入审查数据；普通工具路径不变。 | 用户原文；实际 prompt | 新增 TDD slice |
| INV-06 | 复用现有结构，无新架构；生产改动限两文件且不超过 100 行，生产+测试+配置的完整实现代码修改总量不得超过 200 行；hunk 与文件数保持最小。 | 用户硬上限 | 完整 diff 与 hunk 复核 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-03 | `approvedOnce && actual.level <= approvedLevel` 在比较 reason 前直接复用。 | `Permission.beginExecute/check` | `permission/index.ts:315-331`；下方红色复现。 |
| INV-05 | `parent(request)` 把完整 AskInput 写入 `metadata.trigger`。 | `Permission.beginExecute/parent` | `permission/index.ts:300-305`；实际 reviewer prompt。 |

以下两条只读命令均在 `packages/opencode` 对未修改源码实际运行，覆盖两个独立缺陷；输出只保留非敏感信号。

同等级新 reason 复现命令：

```sh
bun -e 'import { PermissionPrecheck } from "./src/permission/precheck"; const cwd = process.cwd(); const initial = await PermissionPrecheck.evaluate({ permission: "execute", patterns: [], metadata: { cwd, shell: "bash" }, calls: [{ tool: "bash", input: { command: "git push origin main" } }] }); const actual = await PermissionPrecheck.evaluate({ permission: "bash", patterns: ["git -c core.hooksPath=/tmp/x push origin main"], metadata: { command: "git -c core.hooksPath=/tmp/x push origin main", cwd, shell: "bash" } }); const currentWouldReuse = PermissionPrecheck.LEVELS.indexOf(actual.level) <= PermissionPrecheck.LEVELS.indexOf(initial.level); const newReason = actual.reason.split("\n").find((reason) => !initial.reason.split("\n").includes(reason)); console.log(JSON.stringify({ initial, actual, currentWouldReuse, newReason }, null, 2)); if (currentWouldReuse && newReason) { console.error("RED CONFIRMED: current level-only reuse misses a new same-level reason"); process.exit(1); }'
```

实际结果：初始与实际均为 `cautious`，`currentWouldReuse=true`，`newReason="git global flag injects configuration or binary path"`；输出 `RED CONFIRMED: current level-only reuse misses a new same-level reason`，exit 1。

预跑原子 reason 重复复现命令：

```sh
bun -e 'import { PermissionPrecheck } from "./src/permission/precheck"; const calls = ["git -c core.hooksPath=/tmp/x push origin main", "git -c core.hooksPath=/tmp/y reset --hard HEAD"].map((command) => ({ tool: "bash", input: { command } })); const decision = await PermissionPrecheck.evaluate({ permission: "execute", patterns: [], metadata: { cwd: process.cwd(), shell: "bash" }, calls }); const needle = "git global flag injects configuration or binary path"; const occurrences = decision.reason.split(needle).length - 1; console.log(JSON.stringify({ decision, occurrences }, null, 2)); if (occurrences !== 1) { console.error("RED CONFIRMED: overlapping atomic reason is duplicated by execute aggregation"); process.exit(1); }'
```

实际结果：当前聚合 reason 为 `git state-changing…\ngit global flag…; destructive git reset…\ngit global flag…`，全局 flag 出现 2 次；输出 `RED CONFIRMED: overlapping atomic reason is duplicated by execute aggregation`，exit 1。修复后同一命令要求该原子 reason 恰好出现一次。

基线 `bun test test/permission/execute.test.ts test/session/execute.test.ts --timeout 30000` 已运行：43 pass、0 fail、221 assertions。新增公共接口测试必须先复现上述行为，再由最小实现转绿。

## 9. Responsibility and Seam

| Concern | Owner | Promise | Why here |
| --- | --- | --- | --- |
| 预跑调用分类和聚合 | `PermissionPrecheck.evaluate` | 对每个 observed call 分类并返回一个 Decision | 已拥有该逻辑，无需新聚合器。 |
| 本段批准 reason、升级和终止 | `Permission.beginExecute` | 在一次 Execute 内复用/升级批准并暂停真实调用 | 已拥有 approvedLevel/approvedOnce/gate/stopped。 |
| 审查动作证据 | `Permission.beginExecute/parent` | 向现有 reviewAuto 提供 execute 请求 | `trigger` 在此产生，必须在此删除。 |
| Reviewer 序列化 | 现有 Reviewer service/prompt | 只序列化 ReviewerRequest | 无需修改。 |

公共测试 seam：`Permission.Service.beginExecute` 加现有 `PermissionReviewer.Service` 注入，观察真实 review 输入与 ReviewStarted 事件；不测试私有 helper。

## 10. Single Approved Primary-Path Design

保留 §5 执行链，只替换两个错误判断/证据构造。

1. `precheck.ts` 的 execute 聚合先对各项 Decision 的 `reason.split("\n")` 做 flatMap，再去重并以 `"\n"` 连接，替换当前按完整字符串去重并以 `"; "` 连接的两行逻辑。这样复用 Shell/Git 已有多 reason 表示，重叠原子 reason 只出现一次；Decision schema 不变。
2. `beginExecute` 保留 `approvedLevel/approvedOnce/gate/stopped`，仅增加一个局部 `Set<string>` 保存已允许 reason。当前 Decision 以换行拆成 reason 列表。
3. `check` 仍先处理 forbidden。随后：
   - 当前 reason 均已包含：复用，不调用 reviewer。
   - 新 safe/general reason：沿现有 reviewAuto 路由，非 strict 不产生模型审查；允许后纳入集合。
   - 新 cautious/dangerous reason：以既有 LEVELS 取上界，并将已允许集合与当前集合去重合并为本次 prechecked；仍调用 `reviewAuto(..., false)`。
4. 只有 reviewAuto/必要人工路径允许后才更新 reason Set；`approvedLevel` 在**所有**允许路径均以既有 LEVELS 与当前 Decision 取较高者，dangerous → 新 safe/general 不得降低上界。拒绝仍走原 terminal，不能累积批准。
5. `parent(request)` 始终构造 `permission=execute, patterns=["*"]`。metadata 保留 `agent/action_kind/code/cwd/shell/probe`；删除 `trigger`，仅在实际非 execute 请求导致重审时加入：

```ts
actual: {
  permission: request.permission,
  patterns: request.patterns,
  metadata: request.metadata,
}
```

`actual` 是真实工具与普通审查相同的三项动作证据；不包含 ruleset、always、sessionID，不另传一份工具调用。预跑原始参数继续由 `probe` 提供。

该路径直接删除等级复用和完整 AskInput 嵌套这两个 origin；没有新 prompt 投影层、状态机或备用执行路径。

## 11. Secondary and Replacement Path Inventory

| Path | Current/proposed | Classification | Success? | Share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 桩预跑后真实运行时补证据 | current + preserved | primary-contract branch | yes | 既有 | preserve |
| safe/general、strict、reviewer unavailable → user | current | existing compatibility | yes/ask | 既有 | preserve |
| forbidden/reviewer deny → stop | current | primary-contract branch | no | 既有 | preserve |
| 新 alternate success/fallback | none | forbidden fallback | — | 0% | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround | Why superseded | Delete/collapse |
| --- | --- | --- |
| 仅以 approvedLevel 复用 | 无法识别同等级新 reason | `beginExecute/check` 改为 reason 包含判断，level 仅取上界。 |
| `metadata.trigger` 完整 AskInput | 混入宿主规则且不是 ReviewerRequest 动作形状 | 删除 trigger；仅构造三项 `actual` 证据。 |

## 13. Forward Traceability

| Requirement | Production path | File/change | Test |
| --- | --- | --- | --- |
| INV-01 | observed calls → 既有逐项 precheck → 换行聚合 | `core/permission/precheck.ts` | 预跑/运行时既有集成测试 + 多 reason slice |
| INV-02/05 | parent → execute + code/probe/actual → 原 ReviewerRequest | `opencode/permission/index.ts` | 捕获真实 reviewer 输入 |
| INV-03 | reason 差集 → 复用或 Execute 重审 → 允许后累积 | 同上 | 同等级新 Git reason 的 TDD slice |
| INV-04 | 原 matchRequest/reviewAuto/terminal/gate | 不变 | 原 execute 两组测试 |
| INV-06 | 两个既有文件局部修改 | diff | diff 行数与文件清单复核 |

## 14. Reverse Traceability

| Proposed concept | Requirement | Evidence | Why existing logic insufficient |
| --- | --- | --- | --- |
| 局部 reason Set | INV-03 | 红色复现 | approvedLevel 不含 reason 身份。 |
| 换行作为既有 reason 分隔 | INV-01/03 | Shell/Git 已使用 | execute 的 `; ` 与既有表示不一致；无需新 schema。 |
| `actual` 三项证据 | INV-02/05 | 用户要求实际参数；当前 trigger 含 ruleset | 需要真实请求证据，但完整 AskInput 含有宿主字段。 |

没有其他新 production concept。

## 15. File-Level Change Plan

| File | Action | Exact responsibility | Expected delta |
| --- | --- | --- | --- |
| `packages/core/src/permission/precheck.ts` | modify | execute 聚合先展开原子 reason，再去重并换行连接 | 1–2 行 |
| `packages/opencode/src/permission/index.ts` | modify | reason Set/差集/累积；删除 trigger；构造 actual | 约 25–45 行 |
| `packages/opencode/test/permission/execute.test.ts` | modify | 原子 reason 聚合、同等级新 reason、低风险后上界、execute/actual/无 ruleset | 约 75–110 行 |

不改其他文件。生产侧预计 3 个相邻职责 hunk（precheck 聚合、parent 证据、check 复用），测试集中在同一相邻区域，避免为不同 slice 扩散 hunk 或文件。

## 16. TDD Behavior Slices

统一 seam：`Permission.Service.beginExecute` + 真实 reviewAuto 路由，reviewer 仅作为外部模型替身。

| Order | Red behavior | Why current fails | Minimal green |
| --- | --- | --- | --- |
| 1 | 预跑同时包含 `git -c … push` 与 `git -c … reset --hard` 时，初审 reason 中全局 flag、push、reset 各自原子 reason 去重出现一次 | 当前按每项完整 reason 字符串去重，重叠全局 flag 会重复 | 在现有 execute 聚合点展开、去重、换行连接 |
| 2 | 初审 git push 后，同 reason 调用不增审；同 cautious 的 `git -c … push` 必须第二次审查 Execute；再次相同调用不增审 | 当前按等级复用第二次 | reason 差集与允许后累积 |
| 3 | 第二次 review 的 permission 为 execute，precheck 含旧/新 reason，metadata.actual 等于实际 bash 三项证据，序列化不含 `ruleset` 或 `trigger` | 当前顶层虽为 execute，但 trigger 带完整 AskInput，precheck 仅当前 reason | parent 构造 actual，聚合送审 reason |
| 4 | dangerous 获批 → 新 safe/general → 新 cautious 的最终重审仍保持 dangerous，reason 为全量并集 | 计划必须防止新低风险直接赋值降低上界；当前源码是直接赋值 | 所有允许路径单调更新 approvedLevel |
| 5 | 原 strict、显式 ask/deny、forbidden、并发和跨 Execute 隔离结果不变 | 防修复破坏原合同 | 仅运行原测试，不新增兼容分支 |

每个 slice 按一个测试失败 → 最小实现 → 该测试及原回归转绿推进，不批量先写全部实现；最终测试保持集中在 `permission/execute.test.ts` 的同一相邻区域。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed lines E | 约 130（生产 40、测试 90） | 排除 import、空行、格式化和纯移动 |
| Required Chinese comments C | ≥20 | `ceil(130 × 0.15)`；实施按实际 E 重算 |

生产注释只解释“reason 差集而非等级决定新证据”和“actual 仅含普通动作证据、不得回嵌 AskInput”；测试注释说明同等级新 Git 全局 flag 的独立授权语义。不得拆行凑比例。

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/permission/execute.test.ts --timeout 30000` | `packages/opencode` | 新 TDD slice 与原权限行为 |
| `bun test test/session/execute.test.ts --timeout 30000` | `packages/opencode` | 真实预跑/运行时、并发和动态调用 |
| `bun test test/permission/precheck.test.ts test/permission/auto.test.ts test/permission/reviewer-prompt.test.ts --timeout 30000` | `packages/opencode` | reason 分类、AUTO 路由和公共 prompt 合同 |
| `bun typecheck` | `packages/core` | core 修改类型检查 |
| `bun typecheck` | `packages/opencode` | host 与测试类型检查 |
| §8 最小复现对应的新公共接口测试 | `packages/opencode` | 原始同等级新 reason 不再被复用；重叠原子 reason 去重 |
| 对生产、测试、配置全部实际 diff 逐文件核算新增与修改行数 | repository root | 完整实现代码修改总量 ≤200，生产仍为几十行 |

实施时先确认新增测试在未修改生产代码上失败；不得以删除原断言或降低风险分类取得绿色。

## 19. Diff Budget

| Metric | Budget |
| --- | --- |
| Files added | 0 |
| Production files modified | 2 |
| Test files modified | 1 |
| Files deleted | 0 |
| Production changed lines | 预计 26–46，**硬上限 100** |
| Test changed lines | 预计 75–110 |
| **全部生产+测试+配置 changed lines** | 预计 101–156，**硬上限 200（按完整实际 diff 核算）** |
| Hunks | 生产预计 3、测试预计 1；不得为同一职责分散修改 |
| Generated lines | 0 |

## 20. Real Risks and Open Decisions

无需要用户决定的开放项。当前预跑对非 Bash 工具有限分类是既有事实，由真实运行时继续补证据；本任务不借修复 prompt 之名扩张到逐工具 preview。

### Rejected Speculation

- 工具返回 `null` 不需要修复；真实运行时会生成实际请求。
- 不引入 PR #1 环境复制、去重、sleep 或预算变化。
- 不新增原子 reason schema、持久化 reason ID、缓存、状态机或 prompt sanitizer。
- 不处理与本反馈链无关的审批复用粒度或未来工具分类覆盖。

## 21. Audit Contract

独立 auditor 必须读取本文件与原始需求，自行重建普通工具与 Execute 的完整相关路径，检查：两条 first divergence、生产 100 行及完整 diff 200 行硬上限、hunk/文件克制、普通工具不变、reason 聚合与动态重审、actual 证据、既有 strict/ask/forbidden/并发合同、TDD 敏感度、无 fallback、无未映射概念及中文注释预算。每轮均覆盖完整原始范围，builder 摘要不得作为证据。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01、B-02 | 无 | **BLOCK**。R1 不予批准，`Implementation allowed` 必须保持 `no`。修正 B-01、B-02 后应递增 revision，并进行新的全范围方案审计。 | `ses_e3f197129ffe2j5Sg2kZVgbkoG` |
| 2 | R2 | yes | B-01、B-02 | 无 | **BLOCK**。R2 不予批准，`Implementation allowed` 必须保持 `no`。这是第 2 轮方案审计。修正 B-01、B-02 后应递增为 R3，并对原始需求及完整受影响接口重新进行全范围审计。 | `ses_e3f05b600ffeTQJj7JhJDpxVHZ` |
| 3 | R3 | yes | No blocking findings. | 无。 | **APPROVE — 仅批准 canonical plan R3。** | `ses_e3ef81c31ffezWbiRoRmgRI5M2` |
| 4 | R4 | yes | No blocking findings. | 无。 | **APPROVE — 仅批准 canonical plan R4。** | `ses_e3e03dae0ffeYZeahCO8SrS6pO` |

R1 阻塞结论原样记录：

- **B-01（Blocking）“预跑聚合没有形成原子 reason 并集，且计划测试无法验证该修改”**：execute 聚合需先按换行展开各项 Decision，再去重；通过 beginExecute 增加包含多个预跑调用、重叠及不同原子 reason 的初审断言。R2 §10.1、§16.1 已修正。
- **B-02（Blocking）“新低风险 reason 分支缺少风险上界单调更新规则和回归测试”**：所有新 reason 获准后均须以既有 LEVELS 单调保留 approvedLevel；增加 dangerous → 新 safe/general → 新 cautious 的公共接口测试。R2 §10.4、§16.4 已修正。
- **Rejected speculation**：未将桩工具返回 `null`、动态参数只能在运行时补齐、普通工具现有缓存与人工审批、PR #1 环境系统或静态 AST 列为问题。
- **Release verdict**：**BLOCK**。R1 不予批准，`Implementation allowed` 必须保持 `no`。修正 B-01、B-02 后应递增 revision，并进行新的全范围方案审计。

R2 阻塞结论原样记录：

- **B-01（Blocking）“红色反馈命令只是占位文本，未满足方案阶段的实测门禁”**：需要实际运行并记录完整、可复现的只读命令及输出，分别覆盖同等级新 reason 复用和预跑原子 reason 聚合。R3 §8 已补全真实命令与结果。
- **B-02（Blocking）“200 行硬上限被缩窄为仅生产代码，未覆盖用户要求的全部代码修改”**：硬门槛应为生产、测试及配置代码合计新增与修改不超过 200 行，并在完整实际 diff 核算。R3 §7、§18、§19 已修正。
- **Release verdict**：**BLOCK**。R2 不予批准，`Implementation allowed` 必须保持 `no`。这是第 2 轮方案审计。修正 B-01、B-02 后应递增为 R3，并对原始需求及完整受影响接口重新进行全范围审计。

R3 clean verdict 原样记录：

```text
Blocking findings

No blocking findings.

Non-blocking findings

无。

Release verdict

APPROVE — 仅批准 canonical plan R3。

主代理原样记录本轮 clean verdict 并将 Approved revision 更新为 R3 后，方可按该 revision 实施；任何 substantive 修改都需要递增 revision 并重新进行全范围审计。
```

R4 clean verdict 原样记录：

```text
Blocking findings

No blocking findings.

Non-blocking findings

无。

Release verdict

APPROVE — 仅批准 canonical plan R4。

主代理原样记录本轮 clean verdict 并将 Approved revision 更新为 R4 后，方可按该 revision 实施。任何 substantive 修改都需要递增 revision 并重新进行完整原始范围审计；提交仍须等待实现验证、独立全范围实现审计 APPROVE 和 verified 状态。
```

## 23. Implementation Evidence

### Actual Files and Diff

- `packages/core/src/permission/precheck.ts`：+2/-2；一个 hunk，execute 聚合先展开原子 reason 再去重。
- `packages/opencode/src/permission/index.ts`：+21/-7；两个 hunk，reason 差集/上界/累积及 `actual` 证据；删除 `trigger`。
- `packages/opencode/test/permission/execute.test.ts`：+102/-0；一个连续测试 hunk，覆盖三个新行为切片。
- 生产合计 +23/-9（32 行 A+D），满足 ≤100；全部生产+测试 +125/-9（134 行 A+D），满足 ≤200。生产 3 hunk、测试 1 hunk，无新增/删除文件、生成文件或配置修改。

### Red-Green Test Evidence

1. 原子 reason：旧实现把全局 flag 与 reset reason 用 `; ` 串接且重复，新增测试失败；修改 execute 聚合后通过。
2. 同等级新 reason：旧实现只审查 1 次而独立预期为初审+新 reason 共 2 次，测试失败；reason 差集/累积和 `actual` 修复后通过，重复 changed 未产生第三次审查，metadata 不含 `ruleset/trigger`。
3. 上界：旧序列为 `dangerous → cautious` 而预期 `dangerous → dangerous`，测试失败；所有允许路径单调保留上界后通过。
4. 最终 `test/permission/execute.test.ts`：9 pass、0 fail、35 assertions。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/session/execute.test.ts --timeout 30000` | `packages/opencode` | 37 pass、0 fail、196 assertions |
| `bun test test/permission/precheck.test.ts test/permission/auto.test.ts test/permission/reviewer-prompt.test.ts --timeout 30000` | `packages/opencode` | 188 pass、0 fail、915 assertions |
| `bun typecheck` | `packages/core` | `tsgo --noEmit` 通过 |
| `bun typecheck` | `packages/opencode` | `tsgo --noEmit` 通过 |
| `git diff --check HEAD -- <三个代码路径>` | repository root | 通过；仅提示既有 Windows LF→CRLF 转换 |

相关测试合计 234 pass（9+37+188），无失败。

### Original Feedback-Loop Result

§8 原子 reason 原命令已在修复后重跑：聚合结果依次为 push、全局 flag、reset 三条独立 reason，`occurrences=1`，exit 0。原始同等级新 reason 场景由新增公共接口测试验证：同 reason 复用、新 reason 重审、再次相同 reason 复用。

### Actual Secondary and Replacement Path Inventory

桩预跑、真实运行时补证据、safe/general、strict、显式 ask/deny、reviewer 不可用转人工、forbidden/reviewer deny 均沿既有主合同；新 alternate success path 与 diagnostic path 均为 0%，未新增 fallback。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Added non-blank lines | 125 | `git diff --unified=0` 逐行统计；无 import-only、formatter、generated 或 pure-move |
| Effective changed code lines E | 105 | 125 行新增中排除 17 行注释和 3 行空行 |
| Qualifying Chinese comment lines C | 17 | 邻近解释 reason 差集、原子去重、上界单调、actual 证据及测试授权语义 |
| Ratio C / E | 16.19% | `17 / 105 = 0.1619` |
| Required minimum C | 16 | `ceil(105 × 0.15) = 16`，通过 |

代表性说明：`同级新 reason 也是新证据；已覆盖 reason 才复用本次批准。`、`actual 固定为普通动作三件套，预跑原始参数仍由 probe 承载。`、`新低风险 reason 不得降低已批准上界；后续送审仍携带完整历史证据。`

### Remaining Unverified Items

未运行全仓测试；已执行 R4 明确要求的全部相关测试与两个 package 的 typecheck。无生成、迁移、协议或配置面需要额外验证。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | No blocking findings. | 无。 | **APPROVE — 批准当前实际 implementation diff 对应 canonical plan R4，完整原始范围审计及指定验证均通过。** | `ses_e3dea5a0affeS8FnIie5OqgH20` |

实现审计 clean verdict 原样记录：

```text
Blocking findings

No blocking findings.

Non-blocking findings

无。

Release verdict

APPROVE — 批准当前实际 implementation diff 对应 canonical plan R4，完整原始范围审计及指定验证均通过。

主代理原样记录本轮 verdict 并将 canonical plan 状态转为 verified 后，方可按原要求创建 commit；本审计未修改文件、未提交、未 push。
```

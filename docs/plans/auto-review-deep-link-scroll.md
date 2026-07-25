# Canonical Implementation Plan: Auto Review 深链定位到对应 Review 返回区

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户 GOAL 原文（见 §1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25
>
> Supersedes: R1（独立审计 B-01：session 进页存在两条贴底路径，R1 只替换其中一条）

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，按照如上我们要求的逻辑进行相应修改,按下autoreview的状态之后应该跳转到对应的reviewer页面的返回区域部分，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在4个代码文件以内，同时代码修改不超过400行。

上下文已核实的用户意图（同一对话，不扩大范围）：

- 点击父会话工具上的 auto review 状态行后，进入 `permission-reviewer` 子会话时，应定位到**该次 review 对应的返回（assistant 决策）区域**，而不是一律滚到子会话最底部。
- 保持项目既有 TUI 导航/滚动风格；替换只滚到底的旧逻辑。
- 甜点级：≤4 个代码文件、≤400 行。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不改 auto reviewer 协议、重试、超时、JSON fallback、provider SessionRetry、缓存、计费/`request_usage`。
- 不改 permission / precheck / auto 路由策略。
- 不新增后端 API、DB schema、migration。
- 不强制 `tool_choice`，不改 reviewer prompt。
- 不实现 reviewer 子会话内搜索/timeline 通用深链（仅 auto review 点击这条路径）。
- 不在底部 footer 展示 reviewer 网络重试状态（另题）。
- 不把 `reviewID` 写入 URL/CLI 参数（仅 TUI in-process route）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 术语：Session、Message、Tool、Permission、Status；auto review 属于 Permission 审计 UI，不是新 Agent 类型 |
| `packages/opencode/AGENTS.md` | 测试不得从 repo root 跑；typecheck 用 `bun typecheck` 于 package 目录 |
| `packages/opencode/test/AGENTS.md` | TUI 行为测用现有 fixture；断言公共可见行为 |
| TUI 惯例 | `SessionRoute` 只携 `sessionID`；message 节点 `id={message.id}`；timeline/fork 已用 `scrollBy(child.y - scroll.y - 1)` |
| Reviewer 审计设计 | 每父会话一个 `permission-reviewer` 子会话；`reviewID` 是父 tool `autoReview` 与子 request/decision 的 join key |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` `openAutoReviewSession` ~2465–2481 | 点击只 `navigate({ type: "session", sessionID })`，不传 `reviewID` | observed |
| 同文件 session 进页 effect ~338–366 | **贴底路径 A**：sync 后 `scroll.scrollBy(100_000)` 一律贴底 | observed |
| 同文件 `toBottom` ~539–543 + `createEffect(on(() => route.sessionID, toBottom))` ~1230–1231 | **贴底路径 B**：sessionID 变化时 50ms 后 `scroll.scrollTo(scrollHeight)` | observed |
| 同文件 timeline `onMove` ~641–669 | 已有按 message id `scrollBy(child.y - scroll.y - 1)` | observed |
| 同文件 `AutoReviewMetadata` / `autoReviewLabel` ~2362–2401 | 父侧已有 `reviewID` + `sessionID` | observed |
| `packages/opencode/src/cli/cmd/tui/context/route.tsx` | `SessionRoute` 仅 `sessionID` + optional `prompt`，无锚点字段 | observed |
| `packages/opencode/src/permission/reviewer/service.ts` `recordReviewerRequest` ~375–403 | 子会话 user text part 写 `metadata: { permissionReviewerRequest: true, reviewID }` | contracted |
| 同文件 tool-call / json_fallback metadata | decision part 也带 `reviewID` | contracted |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` ~769–783 | `hidden` message 从 store 删除，协议失败 attempt 不可见 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 已有 click→打开 reviewer 测试，只断言进入子会话，不断言定位 | observed |
| 本地 `opencode.db`（前序调查） | 一父会话多 review 堆积于同一 reviewer 子会话，贴底会错过旧 review | observed |

## 5. Current Behavior

```text
用户点击父工具 auto review 状态行
  -> openAutoReviewSession(review)
  -> navigate({ type: "session", sessionID: review.sessionID })  // 丢弃 reviewID
  -> Session 挂载/换会话后两条独立贴底路径同时武装：
       路径 A: session.get + sync 完成后 scroll.scrollBy(100_000)
       路径 B: createEffect(on(sessionID, toBottom)) → setTimeout(50) → scrollTo(scrollHeight)
  -> 用户看到子会话最新内容，而非点击的那次 review 返回区
  -> 即使未来只修路径 A，路径 B 仍可在 ~50ms 后把视口拉回底部（R1 审计 B-01）
```

数据侧 join 已就绪但未消费：

```text
parent tool.metadata.autoReview.reviewID
  == child user text part.metadata.reviewID (permissionReviewerRequest)
  == child assistant tool part.metadata.reviewID (decision)
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 带 `sessionID`+`reviewID` 的 completed/reviewing autoReview 行点击 | TUI `AutoReviewLine` / tool chrome | `reviewID` 由 `PermissionAuto.evaluate` 铸造并写入 tool metadata | openAutoReviewSession | TUI session route | observed |
| 子会话中存在 matching request（可能尚在 reviewing，仅有 user 请求） | `recordReviewerRequest` | 每 attempt 写 request；协议失败 hide 后可见的是最终 attempt | scroll resolve | TUI session view | observed |
| 子会话中存在 matching assistant 决策 | `runReviewerAgent` + tool-call/json_fallback | assistant `parentID` = request user id | scroll 优先 assistant | TUI session view | observed |
| 有 `sessionID` 无匹配 message（旧数据、冷存储未加载、截断） | 历史/同步边界 | 无 join 命中 | residual：贴底（与今日默认一致） | TUI session view | reachable |
| 无 `sessionID` 的 autoReview 行 | 缺 child session | `openAutoReviewSession` 已 early return | 不导航 | TUI | observed |
| 协议 hide 的失败 attempt | `hideReviewerProtocolAttempt` | sync 删除 hidden message | resolve 只见可见 message；取最后匹配 | TUI + sync | observed |

Speculative（不驱动实现）：跨 workspace 延迟加载导致 parts 暂缺后异步二次定位；通用 deep-link 协议。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 点击带 `sessionID`+`reviewID` 的 auto review 状态后，TUI 进入该 reviewer 子会话 | 现有 click 测试 | `session-message-render.test.tsx` “opens the reviewer child session” |
| INV-02 | 进入后视口应定位到**该 `reviewID` 对应的返回区**：优先该次 review 的 assistant 消息；若尚无 assistant（reviewing），则定位到对应 request user 消息 | 用户需求 “返回区域”；`parentID` 链 | 无（本任务新增） |
| INV-03 | 无法解析锚点时，行为不得劣于今日：进入子会话并贴底 | 现有 `scrollBy(100_000)` | 现有导航测试仍应通过 |
| INV-04 | 不得破坏非 auto-review 的 session 导航贴底/sticky 行为 | 其他 `navigate({ type: "session", sessionID })` 无 reviewID | 回归：无 reviewID 仍贴底 |
| INV-05 | 甜点约束：修改代码文件 ≤4，总改动 ≤400 行 | 用户原文 | 实施后 diff 计数 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `openAutoReviewSession` 构造 route 时丢弃 `review.reviewID`，只传 `sessionID` | TUI `openAutoReviewSession` / `SessionRoute` | `index.tsx:2480`；`route.tsx` 无锚点字段 |
| INV-02（症状延续） | session 进页存在**两条**无条件贴底成功路径（A: sync 后 `scrollBy(100_000)`；B: `sessionID → toBottom`），均不消费锚点；任一条保留无条件贴底都会在有 `reviewID` 时覆盖定位 | TUI `Session` 进页滚动契约（单一 owner） | `index.tsx:366`；`index.tsx:539-543` + `1230-1231` |

根因不是 reviewer 服务缺 join key，也不是父 metadata 缺 `reviewID`。**第一分歧是 TUI 导航契约未携带锚点；进页滚动契约存在双贴底路径且均未消费锚点。** 修复必须在**同一个**滚动 owner 上把“有 `reviewID` → anchor，否则贴底”做成**唯一** session-open 滚动语义，同时覆盖路径 A 与路径 B。

### Red-capable feedback loop

| Item | Value |
| --- | --- |
| Seam | TUI 公共可见行为：`session-message-render.test.tsx` 的 click + frame 断言 |
| Symptom | 多 turn reviewer 子会话中，点击旧 auto review 后，frame 仍以最新 turn 为主（贴底），看不到/不聚焦旧返回文案 |
| Red command | `cd packages/opencode && bun test test/cli/cmd/tui/session-message-render.test.tsx -t "auto review deep link"`（名称以实施时测试为准） |
| Observed before fix | 当前代码路径无 `reviewID` 传递 + 强制贴底 → 新测试应 **fail** |
| Note | 实施前必须先写红测并跑红；本 plan 阶段不改测试文件 |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 点击导航载荷 | `openAutoReviewSession` | 把 `sessionID` + `reviewID` 放进 `SessionRoute` | 唯一点击入口已持有完整 `AutoReviewMetadata` | reviewer service 不负责 TUI 路由 |
| Route 形状 | `SessionRoute` | 可选 `reviewID?: string` | 与现有 optional `prompt` 同模式；零破坏 | 不应引入全局 query string |
| `reviewID` → message 解析 | Session 视图内小函数 | 从 `sync.data.message/part` 找可见锚点 | 数据已在 sync store；滚动 child id 是 message id | 后端无“按 reviewID 查 message” API，且不需要 |
| 进页滚动 | `Session` createEffect 贴底分支 | 有 `reviewID` 则 scroll-to-anchor；否则保留贴底 | 与现有进页滚动同点替换，避免第二套 sticky 逻辑 | 不放进 plugin API |

## 10. Single Approved Primary-Path Design

```text
click AutoReviewLine(review)
  -> openAutoReviewSession
  -> navigate({
       type: "session",
       sessionID: review.sessionID,
       reviewID: review.reviewID,
     })
  // 普通 session 导航必须显式 omit reviewID（不得残留上次 deep link）：
  // navigate({ type: "session", sessionID })  // reconcile 写入无 reviewID 的新 route

Session 进页滚动 = 唯一语义 applySessionOpenScroll(route)：
  若 route.reviewID 存在：
    resolveReviewAnchor(sessionID, reviewID, sync) -> targetMessageID?
    若 target 且 child 已 layout：scrollBy(child.y - scroll.y - 1)
    若 target 存在但 layout 未就绪：短 defer（与现 toBottom 同 50ms 量级）再试一次
    仍失败：residual 贴底
  否则：
    贴底（保留今日普通打开行为）

resolveReviewAnchor：
  扫描 sync.data.message[sessionID] 与 part：
    主路径：text part 且 part.metadata?.permissionReviewerRequest
            && part.metadata?.reviewID === reviewID
         -> userMessageID = part.messageID
         -> 若存在 assistant（role=assistant && parentID=userMessageID）：返回该 assistant id（返回区）
         -> 否则返回 userMessageID（reviewing 仅有请求）
    次选（残缺数据）：tool part 且 part.state?.metadata?.reviewID === reviewID
         （decision 写在 ToolPart.state.metadata，不是顶层 part.metadata）
         -> 返回 tool 的 messageID
    多匹配：取最后一条可见匹配（协议重试最终轮）

实现约束（覆盖 B-01）：
  - 路径 A（sync 完成后滚动）与路径 B（sessionID 变化 toBottom）必须调用**同一**
    applySessionOpenScroll，不得再保留无条件贴底的独立成功路径。
  - 推荐形态：toBottom 改为“无 reviewID 才 scrollTo bottom”；sync 完成分支同样调用
    applySessionOpenScroll，而不是先 anchor 再被另一条无条件贴底覆盖。
  - 禁止第三套 message 流监听 / 轮询重试框架。
  - route.reviewID 仅在 session-open 滚动消费；不在后续 sticky 内容增高时重复抢滚动。
```

为何修第一分歧：

1. Route 携带 `reviewID` 修复入口丢锚点。
2. **合并**两条贴底路径为单一 session-open 滚动语义，有锚点则定位、无锚点则贴底。
3. 优先 assistant = “返回区域”；无 assistant 时 request = reviewing 期域内分支。
4. 普通 `navigate({ type: "session", sessionID })` 不带 `reviewID`，配合 `reconcile` 清除陈旧锚点（INV-04）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 有 reviewID 且解析到 message → scroll-to-anchor | proposed primary | primary | yes（定位） | 主路径 | implement |
| 无 reviewID 的 session 导航 → 贴底 | current preserved via unified applySessionOpenScroll | primary-contract branch（普通打开） | yes | 非 auto-review | preserve |
| 有 reviewID 但解析失败 → 贴底 | proposed residual | primary-contract residual | partial | 边界 | residual，非新算法 |
| 贴底路径 A：sync 后无条件 `scrollBy(100_000)` | current | superseded | yes but wrong for deep link | 旧 A | **collapse into** applySessionOpenScroll |
| 贴底路径 B：sessionID → 无条件 `toBottom` | current | superseded | yes but can overwrite anchor | 旧 B | **collapse into** applySessionOpenScroll（有 reviewID 时不得贴底） |
| 后端 API 按 reviewID 查询 | not proposed | forbidden over-design | — | — | reject |
| 二次异步监听 message 流再跳 | not proposed | speculative | — | — | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 贴底路径 A：sync 后无条件 `scrollBy(100_000)` | 打开会话默认看最新 | 并入 `applySessionOpenScroll`：有 `reviewID` 则 anchor，否则贴底 | sync 完成滚动点 |
| 贴底路径 B：`sessionID → toBottom` 无条件贴底 | session 切换 snap 到底 | 同一语义：有 `reviewID` 时 toBottom **不得**无条件贴底，须 defer 后走 apply 或直接 no-op 让 sync 分支完成 anchor | `toBottom` + `createEffect(on(sessionID, …))` |
| `openAutoReviewSession` 忽略 `reviewID` | route 无字段 | 写入 route | `openAutoReviewSession` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 进入 reviewer 子会话 | openAutoReviewSession navigate | `index.tsx`（保留 sessionID） | 既有 click 测试 |
| INV-02 定位到对应返回区 | route.reviewID + resolve + **统一** applySessionOpenScroll（覆盖路径 A+B） | `route.tsx` + `index.tsx` | 新 TUI 测试：多 turn，点旧 review，frame 含旧返回文案；构造使贴底时旧文案不在 frame |
| INV-03 锚点失败 residual 贴底 | resolve miss → 贴底 | `index.tsx` | 短会话/无 matching part 的 fixture 仍能打开并见内容 |
| INV-04 普通 session 打开不变 | 无 reviewID 时贴底；navigate 不得残留 reviewID | `index.tsx` + 既有 navigate 调用保持 omit | 既有无 reviewID 导航行为；实现时确认 `reconcile` 清掉陈旧 reviewID |
| INV-05 甜点约束 | 文件/行数预算 | 实施 diff 自检 | 实施证据记录 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `SessionRoute.reviewID?: string` | INV-02, INV-04 | 当前 route 无锚点字段；reconcile 需 omit 清残留 | `sessionID` alone 无法区分子会话内多次 review |
| `resolveReviewAnchor(sessionID, reviewID)` | INV-02 | request: `part.metadata.reviewID`；decision: `part.state.metadata.reviewID` | 无现成 by-reviewID 查询 |
| `applySessionOpenScroll`（统一路径 A+B） | INV-02, INV-03, INV-04 | 双贴底路径均 observed | 只改 A 会被 B 覆盖（B-01） |
| 优先 assistant / 否则 user | INV-02 “返回区域” | Message parentID 链 | 仅 scroll 到 user 未对准返回区 |

无额外 cache、API、配置项、插件 hook。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/route.tsx` | modify | `SessionRoute` 增加可选 `reviewID?: string` | +1～3 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | navigate 传 reviewID；resolve；**统一** applySessionOpenScroll 替换路径 A+B 无条件贴底 | +50～85 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 红/绿：多 turn deep link（覆盖 50ms toBottom 竞争）；reviewing request 定位；既有 open 回归 | +70～140 |
| （第 4 文件预算） | 默认不用 | 优先内联 | 0 |

**硬上限**：代码文件 ≤4；总行变更 ≤400（含测试）。

不改：`permission/reviewer/service.ts`（join 已足够）。

## 16. TDD Behavior Slices

Public seam：TUI 可见 frame + 路由导航（与现有 auto review click 测试同一 harness）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 子会话两轮 review，旧/新返回文案不同且足够长使贴底时旧文案不在 frame；点旧 `reviewID` 后 frame **出现旧返回文案**（独立字面量） | sessionID-only + 路径 A/B 双贴底 | reviewID + 统一 applySessionOpenScroll → 旧 assistant | INV-02；防止只修 A 被 B 打回 |
| 2 | 既有 opens reviewer / shell status line 导航仍通过 | — | 仍进子会话 | INV-01 |
| 3 | reviewing 仅有 request：点击后 frame **出现 request 侧锚点文案**（fixture 字面量） | 只找 decision 会 miss；贴底可能只见其他内容 | resolve → request user message | INV-02 reviewing |

断言独立期望值：fixture 中硬编码的旧/新返回字符串字面量，不读 production helper。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~55–80（生产，排除 import/纯格式） | 进页分支 + resolve + navigate |
| Required Chinese explanatory comments `C` | `ceil(E*0.15)` ≈ 9–12；计划 **≥ max(1, ceil(E*0.15))** 条合格中文注释 | 邻近修改点 |

必须注释的点（中文，解释 invariant/边界，不复述代码）：

1. 为何 route 携带 `reviewID` 而非 messageID（join 稳定、父侧只有 reviewID）。
2. 为何优先 scroll 到 assistant（返回区）而非 request。
3. 多匹配取最后可见（协议重试最终轮）。
4. 解析失败 residual 贴底（INV-03，非第二算法）。
5. 为何路径 A 与路径 B 必须共用 applySessionOpenScroll（B-01：50ms toBottom 会覆盖 anchor）。
6. decision 次选读 `part.state.metadata.reviewID`（非顶层 part.metadata）。
7. 短 defer 仅对齐 layout（与现 toBottom 同量级，非轮询框架）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "auto review"`（或精确测试名） | `packages/opencode` | 新深链红→绿 + 既有 auto review 导航回归 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | 全文件 TUI session 渲染回归（若耗时可先子集再全量） |
| `bun typecheck` | `packages/opencode` | `SessionRoute` 可选字段类型安全 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 不新开模块 |
| Files modified | 2–3 | route + session index + test |
| Files deleted | 0 | — |
| Production lines | ≤90 | 甜点导航 |
| Test lines | ≤150 | 一个主深链 + 轻回归 |
| Generated lines | 0 | — |
| **Total** | **≤400** | 用户硬上限 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 路径 B `toBottom` 在 anchor 后 50ms 覆盖定位（B-01） | **主路径契约**：toBottom/sessionID effect 与 sync 完成共用 applySessionOpenScroll；有 reviewID 时禁止无条件贴底 |
| OpenTUI layout 未完成导致 child.y 无效 | 短 defer 再 resolve 一次；失败 residual 贴底 |
| stickyStart=bottom 与 anchor 竞争 | 统一进页滚动后不再另开无条件贴底；内容增高 sticky 不重复消费 route.reviewID |
| fixture 视口太高导致假绿 | 足够长中间内容；断言旧返回字面量可见 |
| hidden 协议 attempt | sync 已删；取最后可见匹配 |
| reconcile 残留 reviewID | 普通 navigate 不传 reviewID 字段 |

### Open Decisions Requiring the User

无。返回区 = assistant 决策消息已由需求“返回区域”与数据模型对齐。

### Rejected Speculation

- 通用 message deep-link 框架
- 后端 review 索引表
- 点击后高亮/闪烁动画
- 打开 reviewer 时过滤只显示该 reviewID 的消息

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
- Verify residual “anchor miss → bottom” is not a forbidden alternate success path but contracted degradation of the pre-existing open behavior.
- Verify file/line budget claims do not omit INV-02.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 双贴底路径只修其一 | N-01 tool metadata 路径；N-02 reviewing 断言偏软；N-03 stale reviewID | BLOCK | adversarial-auditor task ses_069b7845affeAr9ugeGDWjBUhd |
| 2 | R2 | yes | No blocking findings. | N-01 toBottom 多调用点勿整函数改语义；N-02 INV-03 residual TDD 偏软 | APPROVE | adversarial-auditor task ses_069b2d747ffekBT2OyfEpyYCAX |

### Round 2 verdict (verbatim)

```text
APPROVE
```

- Audited revision: **R2**
- Full scope: **yes**
- Implementation allowed after recorder 写入：`Status: approved`，`Approved revision: R2`，`Implementation allowed: yes`
- Blocking findings: No blocking findings.


## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/route.tsx` | `SessionRoute.reviewID?: string` |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | navigate 携 reviewID；`resolveReviewAnchorMessageID`；`applySessionOpenScroll` 统一路径 A/B |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 深链返回区 + reviewing request 两测 |

`git diff HEAD --stat`（本 GOAL 3 文件）：+278 / -4。工作区另有无关 `subagent-footer.tsx` 修改，**不纳入本实现**。

实现审计 round1 BLOCK 后修正：
- 移出误入 diff 的无关测 `child subagent footer shows red retry summary before usage`
- 补足中文解释性注释至 C≥ceil(0.15E)

### Red-Green Test Evidence

1. 先加 `auto review deep link scrolls to the matching review return` → **red**（5s timeout，旧 marker 不可见）。
2. 实现 route + applySessionOpenScroll → **green**。
3. 加 reviewing request 测 → green。

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "auto review deep link"` | packages/opencode | 2 pass（修后复跑） |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "auto review"` | packages/opencode | 18 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

用户症状「点 auto review 只到子会话底部」：红测在修复前 timeout（旧返回不可见）；修复后可见 `OLD_REVIEW_RETURN_MARKER_xyz`。

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| reviewID + resolve → scroll-to-anchor | primary | implemented |
| no reviewID → 贴底 | primary-contract branch | preserved via applySessionOpenScroll |
| reviewID miss → 贴底 | residual | implemented |
| 路径 A 无条件 scrollBy(100_000) | superseded | replaced by scheduleSessionOpenScroll |
| 路径 B 无条件 toBottom on sessionID | superseded for open | session-open effect 改用 apply；`toBottom` 仍供 undo/submit |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 233 | 三文件 `git diff HEAD` 非空、非 import 增行 |
| Qualifying Chinese comment lines `C` | 35 | 邻近 `//` 含汉字、解释 invariant/边界/测试意图 |
| Required | 35 | `max(1, ceil(0.15*233))` |
| Ratio gate | **pass** | C >= need |

### Remaining Risks or Unverified Items

- 未单独自动化「有 reviewID 但 resolve miss → 贴底」短 residual 用例（INV-03 由 residual 分支 + 既有 open 语义覆盖）。
- 真实终端 sticky 与极慢 sync 时序未人工复测。
- 工作区无关 `subagent-footer.tsx` 变更不得进入本 GOAL commit。

## 24. Implementation Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 无关 retry footer 测；B-02 中文注释门 | N-01 residual 无独立测；N-02 未复跑命令 | BLOCK | adversarial-auditor ses_069a9235affeEcJ2Fq9jii7PCE |
| 2 | R2 | yes | No blocking findings. | N-01 residual 无独立测；N-02 未复跑命令；N-03 排除 subagent-footer | APPROVE | adversarial-auditor ses_069a21eeeffeu7xtikL8upSDDb |

### Round 2 verdict (verbatim)

```text
APPROVE
```

- Audited mode: **implementation**
- Approved / audited revision: **R2**
- Full scope: **yes**
- Blocking findings: No blocking findings.


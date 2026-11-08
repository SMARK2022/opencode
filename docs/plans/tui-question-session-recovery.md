# Canonical Implementation Plan: TUI Question Session Recovery

> Status: verified
> Revision: R3
> Approved revision: R3
> Audit mode: plan / full-scope
> Requirement source: 用户原文，见 §1
> Implementation allowed: no
> Last updated: 2026-11-08

## 1. Verbatim Requirement

原始故障：

> 当前需要你去审查检查一个事情。我发现我的 TUI 一旦把它关掉，或者说切换到别的会话，再切回那个我们之前选的会话的时候，它就存在一个问题，就是任何我们T，就是任何的这个 session 所冒出来的 question 的工具的一个问题，它都没有办法去进行，就是第二次显示。也就是说它只有第一次在调用的时候能够显示。那用户比如说进行了一些其他操作，比如关掉这个 TUI，重新打开 TUI，它这个就不显示了，然后这个整个会话就卡死在这个 question 状态下。

显示范围：

> 按理来说，他在任何情况下只要打开这个 session，只要是这个 session 的这个，或者说这个 session 的 sub-agent 的这个 question，都应该去直接显示。当然如果用户在这个路径下打开了别的 session，那别的 session 的这个内容就不显示，所以请你注意这一点。我不知道你这个 directory 和 workplace 到底在干嘛。按理来说， question 应该是按照 session 去进行的，去进行一个显示的。然后我们全局的话是有一个 DEMON 后端是对应着多个 TUI，TUI 本身可以被关掉，但是 DEMON 还会运行，如果整个会话还在运行的话，所以请你注意这么一点。

子 Agent 边界：

> 没有问题啊，直接打开子 Agent的时候确实要主动隐藏，没有问题啊。但是你打开父 Agent的时候，子 Agent的这个 question 肯定要去显示啊。

最终行为：

> 要么重新打开，要么重新切到这个会话，就重新显示这些这个 question。

范围与规模：

> 你不要一直在考虑 boundary case O不OK？你 boundary case可能发生吗？如果可能发生，就是你的模型抽象得不好，或者说它既有的这种 head 就具有的这种既有问题，你非得去把每一个 boundary case 都封死干什么？我再说一遍，这是不合理的。用户没有提出的需求，比如修复 head 的既有问题，是不被允许的，也不需要去进行的。你只要不引入新的就 OK。

> 按理来说，它本身就是去直接改相应的 schema，把相应的那个 workspace 改成 session ID 就 OK，其他的都不要动。

> 说了生产文件的改动不超过八个文件，这是强制规定。

> 按理来说，生产文件的修改行数都不得超过 400 行，就已经说得很清楚了。要么是不超过 400 行，要么你就是你不要超过你删除的 1.5倍，或者说两倍。反正就是 MIN，两倍或者说 400 行，就这么简单。

验收：

> 我没有授权你的方案，我只是说你可以重新审计相应的代码必须得到方案批准，也必须进行实施。你不要最终告诉我你没有实施。谁说了不让你去进行巴拉巴拉的东西了？你必须按照workflow走，说得很清楚了。你可以现在把现在的 revision 清到 R1，也就是说 R13的，或者说 R1到R13所有东西你都改成R1，不要给我写别的了。当前是重新一轮的审计，你也不需要去写什么当前是新的一轮，就直接改成R1，OK，不要加不必要的声明

## 2. Explicit Non-Goals

- 不修改 daemon 的 pending Map、Deferred、Question.Service 或 Session 生命周期。
- 不处理 unknown/malformed workspace、异常 Session ID、外部 settlement 等 boundary case。
- 不修复 head 已有的通用 workspace 路由、事件准入、正文缓存或 Session 浏览问题。
- 不扩展 grandchildren；直接打开 child 时继续隐藏 question。
- 不增加轮询、旧 URL 回退、第二套 pending owner、平行 Question mutation 协议或新 Context。
- 不扩大实时 SSE 准入；本修复以重开 TUI、切回 Session 时的 HTTP 恢复为准。

## 3. Repository and Task Constraints

- 公共 Schema 变化后必须运行现有 SDK/OpenAPI 生成器，不手改 generated。
- 测试和 typecheck 从对应 package 目录运行，不从仓库根目录运行。
- 手写生产文件最多 8 个；有效生产新增 `A` 必须满足 `A <= min(400, 2D)`，并尽量保持 `A <= 1.5D`。
- 每个实质修改 hunk 至少一条邻近中文解释；整体有效注释量 `C >= ceil(E × 0.15)`。
- 独立方案批准仅对应 exact R1；实施完成后必须全量验证、独立实现审计，verified 后仅提交本任务路径，不 push。

## 4. Files and Evidence Read

| Evidence | Observed fact |
| --- | --- |
| `packages/opencode/src/question/index.ts` | pending 与 Deferred 由 daemon 的既有 Question.Service 持有，Request 已包含 sessionID。 |
| `packages/opencode/src/session/session.ts` | `get(id)` 与 `children(id)` 已提供 root 和 direct-child 身份。 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/question.ts` | 原 list/reply/reject 是可直接替换的公共 Schema。 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts` | 原 handler 已进入同一 pending owner，可在原位置校验 Session/request 配对。 |
| `packages/opencode/src/server/shared/workspace-routing.ts` | 既有 `getWorkspaceRouteSessionID` 已识别 `/session/:id`；Question 只需复用这一身份入口。 |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` | head 已有 Session-owned placement；本任务不修改该文件。 |
| `packages/tui/src/context/sync.tsx` | 正文 sync 不恢复 question；既有 pending store、version/change merge 可复用。 |
| `packages/tui/src/routes/session/index.tsx` | 页面已有 route-open/reconnect 入口，可触发当前 Session 的 question 恢复。 |
| `packages/tui/src/routes/session/question.tsx` | reply/reject 调用可只传 Session/request 身份，不读取 viewer workspace。 |
| `packages/app/src/utils/server-compat.ts`、`packages/opencode/src/cli/cmd/run/question.shared.ts` | 两个真实 mutation 消费者必须随统一 Schema 迁移。 |
| `packages/tui/test/routes/session/auto-review-render.test.tsx` | 可用真实 Session route 覆盖关闭/重开与 A→B→A。 |
| `packages/opencode/test/server/httpapi-workspace-routing.test.ts` | 可用 tiny probe 验证 Session 身份经现有 remote/local 路由保留。 |

## 5. Current Behavior

```text
daemon ask -> pending[requestID] + Deferred -> SSE -> store.question[sessionID]
关闭 TUI -> daemon pending 仍存在
重新打开/切回 Session -> 正文同步，但没有当前 Session 的权威 question GET
页面 -> 依赖浏览列表和旧桶推导问题 -> pending 不可见，回答槽卡住
```

首个偏差是 Session route 恢复缺少按 Session 身份读取 pending 的主路径，不是 daemon 丢失问题。

## 6. Domain and Reachability

- 显示身份：当前 root Session + direct children。
- 数据 owner：既有 daemon Question.Service。
- 前端投影：既有 `store.question`，只增加当前 route 的 ID scope，不复制 pending。
- 路由身份：Session ID；workspace 仅是 head 内部既有 placement 细节，不进入 TUI question 显示判断。
- 该路径由正常 TUI 关闭、重开和 Session 切换直接到达，不依赖异常输入。

## 7. Invariants

1. 重开或切回 root 后，权威 pending 包含 root 与 direct children。
2. 直接打开 child 显示空 question scope；other/grandchild 不混入。
3. TUI 销毁不取消 daemon ask；另一 TUI 可恢复并回答同一 pending。
4. 同一 request 只能由匹配的 `(sessionID, requestID)` reply/reject。
5. 正文、Session 浏览列表和实时事件默认准入保持原合同。
6. 只有一个 Question list/reply/reject 协议和一个 pending store。

## 8. First Divergence and Owner

- `sync.tsx`：拥有 route 对应的 question scope、权威恢复和 snapshot/live 合并。
- `groups/question.ts` + `handlers/question.ts`：拥有公共 Session 身份 Schema、Session 存在性和 request 配对。
- `shared/workspace-routing.ts`：只把 Question 的 Session path/query 接入既有身份提取，不改 middleware。
- `session/index.tsx` + `question.tsx`：拥有页面恢复触发、显示和回答调用。
- App/CLI compat：只迁移真实调用参数，不增加适配分支。

## 9. Repair Route

```text
重开 TUI / 切回 Session S
-> question.sync(S)
-> GET S，判定 root 或直接 child
-> root 获取 direct children
-> GET /question?sessionID=<root/child>
-> 原 pending store + 原 version/change merge
-> 当前页面按 scope 显示
-> reply/reject 携带同一 Session/request 身份
```

失败直接 reject；不转旧 URL，不用空数组冒充成功，不新增恢复通道。

## 10. Interface Changes

| Operation | Final contract |
| --- | --- |
| `question.list` | 原 `GET /question` 增加可选 `sessionID`；省略时保留 App/CLI 全局 list。 |
| `question.reply` | 原 operation 直接改为 `POST /question/session/:sessionID/:requestID/reply`。 |
| `question.reject` | 原 operation 直接改为 `POST /question/session/:sessionID/:requestID/reject`。 |

- 不创建 `*ForSession` 端点。
- 通用 `WorkspaceRoutingQuery` 和 middleware 不改；TUI 调用只传 Session/request 身份。
- `getWorkspaceRouteSessionID` 只增加 Question path/query 的提取，之后走 head 原 `planRequest`。
- Schema 修改后运行生成器，SDK/OpenAPI 是必要生成结果，不增加手写 SDK 适配层。

## 11. Primary Path and Fallbacks

当前页面的主路径是 route-open/reconnect 的 scoped HTTP 恢复。实时 reducer 继续处理原本获准进入的事件，但不新增跨 Project admission。

为保持既有插件 `question(sessionID)` 合同，原 bootstrap 全局 list 和已准入 live 事件必须继续填充插件可见的全局 `store.question`；这是已有公开消费者的兼容路径，不是 scoped 恢复失败后的 fallback。全局 bootstrap 与当前页面 scoped 刷新使用各自刷新代数，避免相互取消；页面隔离只由 `sync.question.list` 表达。

以下均不保留：浏览 children 推导 question 可见性、viewer workspace 回答定位、旧 mutation URL 成功回退、第二 pending registry。

## 12. Compatibility

- App 与 CLI 的无 Session query 全局 list 保持原行为。
- App/CLI/TUI 的 reply/reject 全部迁移到同一 Session 路径。
- daemon pending、Deferred、插件 question getter 和正文同步接口不变。
- 不承诺新旧 daemon 混用，不增加兼容成功分支。

## 13. State and Event Handling

- 当前 scope 只含 `{ sessionID, ids }`，只约束页面显示，不过滤插件可见的全局桶。
- 删除本次候选实现对 `event.ts` 的额外 predicate 接口及 `sync.tsx` 的对应接线，最终 diff 不包含 `event.ts`。
- 复用现有 `questionVersion/questionChanges/pendingRequestsWithLiveChanges`，避免恢复快照覆盖已进入 store 的实时状态。
- 原 bootstrap 全局刷新保留独立代数；默认准入的 asked/replied/rejected 继续更新所有已知 Session 桶。
- route 切换只使旧 scoped 刷新失效；不为外部 settlement 等边界增加状态机。

## 14. Forward and Reverse Mapping

| Requirement | Owner | Behavioral proof |
| --- | --- | --- |
| 重开/切回重新显示 | `sync.tsx`、Session route | 真实 route close/reopen、A→B→A。 |
| parent + direct child | Session children + scoped list | parent/child 均显示，other/grandchild 隔离。 |
| 直接 child 隐藏 | `question.sync` root 判定 | child route 返回空 scope。 |
| 多 TUI / daemon 生命周期 | 原 Question.Service | 两 Provider 共享 pending，一方回答后双方结算。 |
| 非当前 Session 的插件读取不变 | 全局 `store.question` 的 bootstrap/live 填充 | 当前页面为 A 时，插件仍可读 B 的恢复与 live pending，页面不显示 B。 |
| Session 而非 workspace | 公共 Schema + 原 Session 路由 | remote/local probe 保留 Session 身份，TUI 不传 workspace。 |
| 最小实现 | 8 文件上限与 diff 门禁 | 最终 numstat、有效行统计和 hunk 审查。 |

每个生产概念都直接服务上述主路径；无额外异常路由、缓存清理或事件准入概念。

## 15. File-Level Change Plan

最终手写生产 diff 只包含以下 8 个文件：

| File | Minimal change |
| --- | --- |
| `packages/tui/src/context/sync.tsx` | 当前 Session scope、route 恢复、原 pending merge；保留插件全局 bootstrap/live 桶；删除额外事件 predicate 接线。 |
| `packages/tui/src/routes/session/index.tsx` | 使用当前 scope，并在打开/重连时调用恢复。 |
| `packages/tui/src/routes/session/question.tsx` | 三处回答调用携带 request.sessionID。 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/question.ts` | 原三个 Schema 直接改为 Session 身份合同。 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts` | scoped list 过滤与 request 配对校验。 |
| `packages/opencode/src/server/shared/workspace-routing.ts` | 仅增加 Question Session path/query 提取。 |
| `packages/opencode/src/cli/cmd/run/question.shared.ts` | CLI payload 携带 request.sessionID。 |
| `packages/app/src/utils/server-compat.ts` | App reply/reject 携带 Session 身份。 |

`packages/tui/src/context/event.ts` 必须不在最终 diff 中。Generated SDK/OpenAPI 由生成器更新，不计入手写生产文件。

## 16. TDD and Behavioral Slices

1. 真实 Session route：初始 browse 不含 root/child，close/reopen 后 parent/child pending 均显示并可回答。
2. A→B→A：A 恢复不依赖旧浏览列表，B 的内容不混入 A。
3. root/direct-child/other/grandchild 与直接 child 页面隔离。
4. 两个真实 SyncProvider 对同一 daemon pending；关闭一个 Provider 不取消 ask，另一方可恢复并回答。
5. 原 snapshot/live merge 测试继续通过，避免旧 GET 覆盖新事件。
6. remote parent/local child 经现有 Session 路由；list/reply/reject 使用同一身份。
7. App/CLI 全局 list 与 mutation payload 回归。
8. 公共 OpenAPI、HTTP exercise、CLI/server routing 和对应 package typecheck。
9. 当前页面为 A 时，插件状态仍能通过 bootstrap 和 live 事件读取 B 的 pending，同时 A 的页面选择器不包含 B。

不新增 malformed ID、unknown workspace、隐式本地 placement 或 route-home 外部 settlement 测试。

## 17. Chinese Comment Budget

- 预估 `E ≈ 900`、`C >= 135`；最终以实际 diff 重算，排除 generated、空行、import-only、格式化和 pure-move。
- `C >= max(1, ceil(E × 0.15))`，且每个实质 hunk 至少一条邻近中文解释。
- 注释只说明 scope 与正文/浏览生命周期不同、Session/request 配对、snapshot/live 合并和真实测试竞态，不复述赋值或测试名。

## 18. Verification

- 最窄：新增 route reopen、双 Provider、HTTP Session 配对测试。
- 相关回归：`sync.test.tsx`、`auto-review-render.test.tsx`、server Question/workspace/OpenAPI/exercise、CLI/App compat。
- package-local：`packages/opencode`、`packages/tui`、`packages/app`、`packages/sdk/js`、`packages/client` 的 `bun typecheck`。
- Schema 后运行既有生成命令；检查 `git diff --check`。
- 最终重新统计 8 文件上限、`A <= min(400, 2D)` 与 `E/C`，不沿用旧结果。

## 19. Diff Budget

- 手写生产文件：硬上限 8。
- 有效生产新增/删除：硬条件 `A <= min(400, 2D)`；能通过删除候选接线和复用原逻辑达到 1.5 时，以 1.5 为目标。
- Generated、测试和 fixture 单独报告，不用它们稀释生产比例。
- 最终若超过任一硬上限，继续删减候选实现，不增加豁免。

## 20. Risks and Open Decisions

- R3 修正全局 bootstrap 的提交权属：全局快照只替换非当前 scope 的桶；当前 route scope 已接管的桶以 scoped 快照和 live merge 为准，空桶也不能被全局旧快照复活。
- 回归使用延迟全局响应：scoped parent/child 已显示后，全局响应只带回 other；待 other 已提交可观察，再断言 parent/child 未丢失。
- 本方案不处理用户明确排除的 head 既有问题和异常边界。
- 人工桌面 TUI 操作若环境无法执行，必须明确记录；自动化 route 验收不能冒充人工操作。

## 21. Audit Contract

- 方案审计按 §1 完整需求和实际受影响接口独立重建行为。
- 任何 blocker 修正后递增 revision 并 full-scope 重审；不得自行批准。
- 实施审计覆盖最终实际 diff、主路径、测试、生成物、8 文件/行数预算和中文注释。
- 只有 implementation audit 的 `No blocking findings` 与 `APPROVE` 才能进入 verified 和 commit。

## 22. Plan Audit Record

- R1 invocation：`ses_e468e0c21fferYMYx4mB9uPEV2`。
- Blocking findings：`No blocking findings`。
- Release verdict：**APPROVE — 仅限 canonical R1。**
- N-01：实施记录须写明 package-local 测试/typecheck，以及 legacy SDK 和 `packages/client` 的实际生成命令与结果。
- N-02：§17 已补预估 `E/C`；实施审计仍按最终 diff 独立复算。
- R2 是实施返工时的编号修正；插件兼容已属于原批准合同，没有新增实质方案内容，不重复方案审计。后续仍须 full-scope implementation audit。

## 23. Implementation Evidence

### Actual files and route

- R2 仍限制为 §15 的 8 个手写生产文件；`packages/tui/src/context/event.ts` 相对 HEAD 无最终内容差异。
- 已删除 `admitQuestionEvent` 及 `event.subscribe` 第二参数，实时 SSE 使用 head 原准入；对应跨 Project admission 候选测试同步删除。
- 当前页面恢复路径为 route-open/reconnect → Session.get/children → scoped question.list → 原 pending store/merge → Session/request reply/reject。
- App/CLI 与插件的全局 list 是既有兼容输入域；R2 保留插件全局 bootstrap/live 桶，页面 scope 不改变插件读取。没有新增 fallback、第二 pending owner 或旧 mutation URL 回退。
- R2 已恢复插件全局 bootstrap/live 桶并新增非当前 Session 回归；最终测试、行数与注释结果已重新运行和复算。
- Generated 仅 `packages/sdk/js/src/v2/gen/sdk.gen.ts`、`types.gen.ts` 与 `packages/sdk/openapi.json`。

### Red-green evidence

- 原缺陷 seam 在 head 没有 scoped Question GET；此前 red 中 list 落入 `200 text/html`，错配 reply 返回 200、reject 返回 500，证明测试能识别缺失路由和错误配对。
- 删除额外事件准入后，其专项候选测试按批准范围退出；原恢复、双 Provider、snapshot/live 与真实 route 测试保持并通过。
- 当前真实 Session route close/reopen、A→B→A、parent/direct-child 恢复和回答均为 green。

### Verification commands and results

- `packages/tui`：`bun test test/cli/cmd/tui/sync.test.tsx` → 54 pass / 0 fail；`bun test test/routes/session/auto-review-render.test.tsx` → 71 pass / 0 fail。
- `packages/tui` 合并回归：`bun test test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx test/routes/session/auto-review-render.test.tsx test/routes/session/question.test.tsx test/cli/tui/use-event.test.tsx test/cli/tui/event-single-delivery.test.ts` → 157 pass / 0 fail / 594 assertions。`sync-live-hydration` 单独重跑 21/21。
- `packages/opencode`：`bun test test/cli/run/question.shared.test.ts test/server/httpapi-instance.test.ts test/server/httpapi-public-openapi.test.ts test/server/httpapi-query-schema-drift.test.ts test/server/workspace-routing.test.ts test/server/httpapi-workspace-routing.test.ts test/server/httpapi-question-session.test.ts` → 76 pass / 0 fail / 367 assertions。
- `packages/app`：`bun test src/utils/server-compat.test.ts` → 10 pass / 0 fail / 29 assertions。
- `packages/opencode`：`bun run test:httpapi` 的 coverage 与 auth 均为 `summary pass=224 fail=0 skip=0 missing=0 extra=0`；组合命令在全量 effect 阶段 300 秒超时，单独全量 effect 600 秒仍超时。
- Question 相关 effect：`bun run script/httpapi-exercise.ts --mode effect --include question --fail-on-missing --fail-on-skip --progress` → 9 pass / 0 fail / skip=0 / missing=0 / extra=0。
- 生成：仓库根目录 `bun ./packages/sdk/js/script/build.ts` 成功；`packages/client` 下 `bun run generate` 成功。
- Typecheck：`packages/opencode`、`packages/tui`、`packages/app`、`packages/sdk/js`、`packages/client` 的 `bun typecheck` 全部成功。
- `git diff --check` 无错误；仅输出既有 CRLF 提示。

### Diff and Chinese-comment gates

- R3 生产 raw numstat：175 additions / 90 deletions，8 个文件，满足 `175 <= min(400, 180)`。
- 有效生产 `A=115`、`D=77`、`A/D=1.494`，满足 1.5 目标及硬上限 154。
- 独立最终复算 `E=1093`、`C=175`、要求 164，约 16.01%；两条相反注释已修正，纯转发包装已删除。
- 代表性邻近注释说明 route scope 独立于正文/浏览、Session/request 配对、权威 HTTP 恢复不扩大 SSE、snapshot/live 合并及双 Provider 测试意图。

### Remaining unverified items

- 全量 224 条 effect 场景两次超时，不能声明该全量阶段通过；本次 Question 相关 9 条已独立全部通过，coverage/auth 全量通过。
- 未执行人工桌面 TUI 点击；原始行为由真实 Session route 与渲染测试覆盖，不冒充人工验收。

## 24. Implementation Audit Record

### Round 1

- Invocation：`ses_e46511ad9ffe6ei5OB553e48eH`，full-scope implementation audit，audited revision R1。
- B-01：`requireOwnedRequest` 的 `requestID` 实际由 reply/reject 必选路径提供，可选参数与无 ID 成功分支不可达，且注释错误声称 list 复用该 helper。
- B-02：新增 `httpapi-question-session.test.ts` 使用仓库禁止的 `import * as Socket`。
- N-01：独立复算为有效生产 `A=104`、整体 `E=1014`，不是初次记录的 105/1015；硬阈值仍通过。
- N-02：完整 224 条 effect 与人工桌面 TUI 仍未完成，不得声明已验证。
- Release verdict：**BLOCK — 当前实际 working-tree diff 对应 approved R1，但不能发布。** 必须修正 B-01、B-02 并重新 full-scope implementation audit。
- Rework：`requestID` 改为必选并删除不可达分支，修正注释；测试改为命名导入 `layerWebSocketConstructorGlobal`。修正后定向测试 4/4、服务端回归 76/76、Question Effect 9/9、`packages/opencode` typecheck 全部通过。

### Round 2

- Invocation：`ses_e462d82e4ffeihsOjQBk4oshOp`，full-scope implementation audit，audited revision R1。
- B-01：删除 bootstrap 全量填充并用 route scope gate 过滤 live 事件，使插件对非当前 Session 的公开 `question(sessionID)` 读取退化为空数组；页面隔离不能改变插件同步状态合同。
- N-01：两处多行 import 续行应排除，独立复算有效生产 `A=103`、整体 `E=1012`、`C=167`；规模与注释门槛仍通过。
- Release verdict：**BLOCK — 当前 working-tree diff 对应 approved R1，但 B-01 的公开插件兼容性回归必须修正，并重新进行 full-scope implementation audit。**
- Rework：恢复原全局 bootstrap/live 填充并使用独立 bootstrap 代数，scope 只约束页面；新增非当前 Session 插件状态测试并修正双消费者 fixture。最终 `sync` 53/53、TUI 合并回归 156/156、TUI typecheck 全部通过。

### Round 3

- Invocation：`ses_e45e9e5afffen61QOx7g57e6sE`，full-scope implementation audit，audited revision R2。
- B-01：viewer 全局 bootstrap 的整表 `reconcile` 可晚于 scoped 恢复完成并删除另一 placement 的 direct-child 桶；独立代数不能阻止全局快照覆盖 scoped 快照。
- N-01：`sync.tsx` 仍有两条与当前行为相反的注释；`applyQuestionEvent` 是可内联的纯转发包装。
- N-02：独立复算 `A=108`、`E=1046`、`C=172`，门槛通过但计划旧数字不准确。
- N-03：完整 224 条 Effect 与人工桌面 TUI 仍未完成，不得声明通过。
- Release verdict：**BLOCK — 当前 approved R2 对应的实际 working-tree diff 不能发布。** 本轮为第 3 轮，未解决项保持 blocking open decision，不得宣称 verified。
- R3 rework：新增延迟全局响应测试，先在旧实现观察到 parent/child 从两项变为 `[]`，再以 scope 桶覆盖全局 `next` 后转绿；全局只拥有非当前 scope，当前空桶也不能复活。两条错误注释已修正，`applyQuestionEvent` 已内联。最终 `sync` 54/54、TUI 157/157、服务端 76/76、两端 typecheck 通过。

### R3 full-scope clean audit

- Invocation：`ses_e45964059ffeWDsIN5RqeQtJ9E`，audited revision R3，覆盖实际 working-tree diff。
- Blocking findings：`No blocking findings`。
- N-01：完整 224 条 Effect 与人工桌面 TUI 仍未完成，不得由定向结果替代。
- N-02：独立复算 `E=1093`，不是计划此前的 1137；注释门槛仍通过。
- 验证执行说明：auditor 独立执行只读 git 检查、`git diff --check` 和统计；Bun 测试与 typecheck 采用 §23 的执行记录，未声称由 auditor 复跑。
- Release verdict：**APPROVE — 仅限 canonical R3 与本次审计的实际 working-tree diff。** 不扩张为完整 224 条 Effect 或人工桌面 TUI 已通过。

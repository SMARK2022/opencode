# Canonical Implementation Plan: TUI 卡死——tokenAccounting 惰计算 + reconciler 销毁积压有界

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit verdict: 方案审计 R1 BLOCK（B-01/B-02）→ R2 **APPROVE / No blocking findings**；实现审计 Round 1 BLOCK（B-01 测试 red-capability）→ rework（同步观测）后 Round 2 **APPROVE / No blocking findings**（2026-09-10，adversarial-auditor subagent，full-scope）
>
> Audit mode: full-scope
>
> Requirement source: 用户 Session GOAL（2026-09-10）——五点修复需求，见 §1 逐字引用
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-10

本文是本任务唯一的 implementation authority。调查证据与根因分析记录见姊妹文档 `docs/plans/tui-freeze-native-handle-exhaustion.md`（下称「调查文档」）；本文件只承载修复设计与放行依据。

## 1. Verbatim Requirement

> 需修改（治本优先）：
> 1.【主凶·治本】session/index.tsx:486 的 exit 快照 createEffect 在每个 part delta 上全量重算 tokenAccounting（O(总数)），应改为退出时惰计算——exit message 仅在 exit() 里被读，零兼容风险，异常退出无回归。
> 2.【安全网】reconciler.ts:133 把待销毁 renderable 无界 defer 到 process.nextTick，主线程被（1）的计算占满时饿死、积压无界涨满 65535；应给积压加上限、超阈值同步 drain（不改正常 defer 语义）。
> 可选/配套：
> 3. session/index.tsx:1842 turnUsage 只算当前 request 的用量，不再全表遍历。
> 4. accounting.ts:176-186 的 O(parts²) 内层回扫循环、:223-225 的 ratio 全表 map，改为增量/缓存。
> 5. theme.tsx 共享 SyntaxStyle 退休前等待在途高亮完成，修 use-after-destroy（消除 NativeSyntaxStyle is destroyed → 工具空卡片）。
>
> 整体修改预算为生产代码不超过八个文件，生产代码修改行数不超过八百行，如有需要可扩充为一千二百行。整体修改保持精简且尽量避免让上下游的调用等等发生冲突，并适当修改移除掉不必要的，避免或者不合适的调用。同时整体的最终行为精确度又不改，譬如整体的token的计数的估算等等，上下游不会受到基础设施修改而被影响。其准确度不能出现问题。最终方案同时需要完整调研相应测试是否会引发红测，最终的 commit 版本不得引入新的红测或出现已有红测。所有的红测都应当得到解决，如生产代码，时序不稳定，请修改生产代码；如测试语义过旧，请谨慎修改。

## 2. Explicit Non-Goals

- 不改变任何 token 计数/估算的**数值语义**：exit message、每条 footer、prompt/sidebar、`/context` 的 input/output/reasoning/cache/cost 口径与现状逐字符一致。
- 不改变 reconciler 的正常 defer 语义与 move/reuse 语义（被 remove 后在 drain 前 re-add 的节点不销毁）。
- 不改变消息列表的增量渲染行为（`<For>` keyed、markdown 流式原地更新——这些实测是正常的）。
- 不发布 OpenTUI 新版本、不改 CI/release 流程、不改 `package.json` overrides（reconciler 改动先落在 thirdparty 源码并经本地测试；进入生产二进制属另一发布动作，见 §20 开放决定）。
- 不修改 daemon、sync 事件协议、SQLite schema、provider、权限。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message=MessageV2 parts；`token/` 是 token accounting + estimate；TUI 在 `cli/cmd/tui/`。 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence、单一 primary path、禁 fallback、双向 traceability、中文注释门禁。 |
| `packages/opencode/AGENTS.md` | Bun、从 package 目录跑测试/typecheck、避免不必要抽象。 |
| `thirdparty/opentui/AGENTS.md` | OpenTUI 改动必须有真实复现；TS-only 改动无需 native build。 |
| 调查文档 §3.4/§3.5/§3.6 | 本任务的实测根因与消费者/兼容性证据（全部来自可复现 harness）。 |
| root `package.json` `overrides` | `@opentui/*` 生产构建取自 GitHub release tarball `v0.4.3-smark.11` → reconciler 源码改动进生产二进制需另走发布（见 §20）。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `session/index.tsx:236,486-499` | `sessionUsage` memo 被 exit-message `createEffect` 读取，每个 part delta 触发重算 | observed |
| `session/index.tsx:1842-1855,1964` | `turnUsage` footer 用 `tokenAccounting(...).request`，受 `footerVisible()` 门控 | observed |
| `token/accounting.ts:144-225` | 全表遍历所有消息；`:176-186` O(parts²) 回扫 + tool `JSON.stringify`；`:223-225` `learnInputCharsPerToken` map 全表 | observed |
| `cli/cmd/tui/context/exit.tsx`（`message.set/get`，`exit()` 内 `store.get()`） | exit message **仅退出时**被读 → 惰计算零兼容风险 | observed |
| `cli/cmd/tui/context/sync.tsx:672` | `exit.message.set("opencode daemon stopped.")` 字符串用法 → thunk 扩展必须向后兼容字符串 | observed |
| `thirdparty/opentui/packages/solid/src/reconciler.ts:111-139` | `_removeNode` 把 `destroyRecursively()` 无界 defer 到 `process.nextTick`，带 `!node.parent` 条件 | observed |
| `thirdparty/opentui/packages/core/src/zig/handles.zig:10,146` | native handle 注册表 `MAX_SLOTS=65535` 硬上限，满则 `OutOfHandles` | observed |
| `.temp/Testing/repro-reconciler-leak.tsx` A/B | 紧凑循环积压无界（+8/轮→3210），让出事件循环即排干为 0；native 容量无泄漏 | observed（可复现） |
| `.temp/Testing/zz-emit-timing.test.tsx` 插桩 | 300 条消息下 30 个 delta 触发 tokenAccounting 34 次 / 456.9ms ≈15ms/delta；50 条≈0 | observed（可复现） |
| `.temp/Testing/zz-production-rate.test.tsx` | 流式 delta 新建 renderable 0.2/个、tool 生命周期 0、新消息 ~24-30 → 生产数量正常 | observed（可复现） |
| 冻结 TUI 日志 `2026-09-09T213500.log` | `Failed to create TextBuffer`（启动 ~8h 后）→ `NativeSyntaxStyle is destroyed` | observed |

## 5. Current Behavior

```text
provider SSE part-delta / tool event
  -> sync.tsx 写 store.part（O(1)，Binary.search+splice）
  -> Solid recompute：sessionUsage = tokenAccounting(所有消息)  〔O(总数×parts²)，~15ms/delta @300 条〕
       - 触发者 A：session/index.tsx:486 createEffect 读 sessionUsage() 更新 exit 快照
       - 触发者 B：session/index.tsx:1842 各 assistant footer turnUsage（全表遍历）
  -> 主线程被 O(总数) 计算占满，不 yield 事件循环
  -> reconciler._removeNode 的 process.nextTick 销毁被饿死（A/B 实测：紧凑循环积压无上限）
  -> 待销毁 renderable（每个 ~4 native handle）积压涨满 65535
  -> Failed to create TextBuffer → 渲染崩溃 → 主线程自旋 → 卡死
```

实测分项：renderable **生成数量**正常（流式 0.2/delta、新消息 ~30）；render（带 culling）~6ms @300；**tokenAccounting 是随消息数超线性膨胀的主线程占用源**。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 每个 part delta / tool 事件 | provider SSE → sync store | 已到达的 part 更新 | `sessionUsage`/`turnUsage` 重算 | session/index.tsx + accounting.ts | observed |
| 退出（SIGINT/SIGTERM/SIGHUP） | 用户/信号 | `exit()` 读 `store.get()` | exit message 打印 | exit.tsx | contracted |
| 异常退出（崩溃/强杀） | OS | `exit()` 不运行 | 无消息（现状相同） | exit.tsx | observed |
| 连续无空闲负载下的 renderable 移除 | 滑窗/更新 → reconciler | remove 已置 parent=null | nextTick 销毁 | reconciler.ts | observed |
| remove 后、drain 前 re-add 的节点（move/reuse） | `<For>` 重排等 | node.parent 非 null | 销毁须跳过 | reconciler.ts | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | exit message 文本与会话统计数值与现状**逐字符一致**（input/output/reasoning/cost 口径不变）；仅在退出时计算。 | 用户“准确度不能出现问题” + exit.tsx 仅退出时读取 | 新增 lazily-compute 等价性测试 |
| INV-02 | part delta / tool 事件**不再**触发 `tokenAccounting` 的 O(总数) 重算（exit 快照改为退出时惰计算）。 | 插桩实测 15ms/delta@300 | 新增 red 测试：delta 后 tokenAccounting 调用数≈0 |
| INV-03 | reconciler 待销毁 renderable 积压**有界**，任何连续负载下不超过阈值，永不涨满 65535。 | A/B 实测无界积压 | 新增 red 测试：紧凑循环后积压≤阈值 |
| INV-04 | reconciler 的 move/reuse 语义保留：remove 后、drain 前 re-add（parent 非 null）的节点**不被销毁**。 | reconciler.ts:134 `!node.parent` 现有语义 | 新增/复用 reconciler move 测试 |
| INV-05 | `exit.message.set(string)` 字符串用法不变（sync.tsx:672）。 | 现有调用 | 现有 sync/exit 测试 |
| INV-06 | 不引入新红测、不出现已有红测；token 计数精度不变。 | 用户硬性要求 | 全套件回归 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `session/index.tsx:236` 的 `sessionUsage` **eager memo** 订阅全部 part store，每个 part delta 就重算 `tokenAccounting`（Solid memo eager：writeSignal 无条件推动 observer 重算，与下游是否读取无关）；`:486` 的 createEffect 只是其订阅者，非重算发生点 | session/index.tsx（sessionUsage memo，唯一消费者是 exit 快照） | zz-emit-timing 插桩：tokenAccounting 34 次/457ms @300，且随消息数超线性 |
| INV-03 | `reconciler.ts:133-138` 把销毁无界 defer 到 `process.nextTick`，无积压上限；主线程被 (1) 占满时 nextTick 饿死 → 积压无界 | reconciler.ts `_removeNode` | repro-reconciler-leak A/B：紧凑循环 +8/轮无上限，让出即排干为 0 |

**Red-capable feedback loop**（捕获用户症状的实测 harness，将固化为回归测试）：

```text
# 生产侧（INV-02）：packages/opencode
bun test test/cli/cmd/tui/<red>.test.tsx   # 300 条会话下发 part delta，断言 tokenAccounting 调用数/耗时（red=随 delta 重算）
# 销毁侧（INV-03）：thirdparty/opentui/packages/solid
bun <repro>                                 # 紧凑 mount/unmount 循环，断言积压有界（red=无界增长）
```

两者已在 `.temp/Testing/` 以复现脚本形式跑通（红），将转为正式行为测试。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| exit message 内容与时机 | session/index.tsx（路由拥有 session/usage 数据） | 退出时给出最终统计快照 | 它有 sessionUsage/session memos | exit.tsx 只存取消息、不懂 session 数据 |
| exit message 的惰性取值 | exit.tsx（`message` store） | `set` 接受 string 或 lazy producer，`get` 在退出时求值 | 它是消息的唯一持有者/读取点 | 其它模块不持有该 store |
| tokenAccounting 计算 | accounting.ts | 纯函数、数值口径不变 | 它是唯一 accounting 实现 | —（本计划不改其数值语义） |
| renderable 销毁时机与积压上限 | reconciler.ts（`_removeNode`） | defer 销毁 + move/reuse 语义 | 它已经是销毁的唯一调度点 | renderer/core 不管 Solid 节点的移除时机 |

## 10. Single Approved Primary-Path Design

### 修复 1（生产侧·治本）：exit 快照真正惰性化——删除 eager memo

**First divergence（经审计修正）**：`session/index.tsx:236` 的 `sessionUsage = createMemo(() => tokenAccounting(messages(), (id) => sync.data.part[id] ?? []))` 是 **eager memo**——Solid 的 memo 只要存活且订阅着 part store，每个 part delta 都会重算（writeSignal 无条件推动 observer 重算，与下游是否读取无关）。`:486` 的 `createEffect` 只是它的一个订阅者；**只删 effect 不摘 memo 订阅，重算照常发生**。该 memo 的唯一消费者就是 exit 快照（全仓仅 :236 定义 + :487 读取两处引用）。

**Primary repair**：既然 `sessionUsage` 唯一消费者是 exit 快照，就**删除这个 eager memo 本身**，让退出路径在 `get()` 时才以最终态直接调一次 `tokenAccounting`。

- `session/index.tsx`：删除 `:236` 的 eager `sessionUsage` memo + 删除 `:486-499` 的随-delta `createEffect`；改为**一次性**（组件主体 / onMount）向 `exit.message.set` 注册一个 lazy producer，thunk 在退出被 `get()` 求值时现场调 `tokenAccounting(messages(), (id) => sync.data.part[id] ?? [])`。**不加 onCleanup restore**——现状 message 在 route 卸载后仍保留（createEffect 返回值不作 cleanup，Solid `runComputation` 仅把它存为 node.value），thunk 同样持久，保持「离开会话→回 home→退出仍打印该会话最终统计」的现状语义。
- `exit.tsx`：`message.set` 接受 `string | (() => string | undefined)`；`get()` 在退出时若是函数则求值。字符串用法（sync.tsx:672）不受影响（INV-05）。thunk 在 route 卸载后读取已 dispose 的 memo 返回最后缓存值（Solid `readSignal` 对已 dispose memo 安全返回），无 throw 风险。

```text
路由挂载 -> exit.message.set(() => formatSessionExitMessage(退出时现场 tokenAccounting(最终 messages/parts)))  〔无 eager memo，delta 路径零重算〕
退出 exit() -> store.get() 求值 thunk -> tokenAccounting(最终态) 一次 -> 打印（与现状逐字符一致）
```

为何修 first divergence：摘掉 eager memo 的 store 订阅后，part delta 路径上**不再存在**任何 tokenAccounting 重算；把「退出才需要」的 O(总数) 计算真正挪到「退出一次」。数值语义不变（同一 tokenAccounting、同一时间点的最终态）。

### 修复 2（销毁侧·安全网）：reconciler 待销毁积压有界

**First divergence**：`_removeNode` 无界 defer 销毁到 nextTick。**Primary repair**：给积压加上限，超阈值同步 drain，**不改变正常 defer 语义**。

- `reconciler.ts`：把「每个 `_removeNode` 各自 `process.nextTick`」改为**模块级共享待销毁队列 + 单次 nextTick flush + 阈值同步 drain**：

```text
_removeNode: parent.remove(node) 后
  若 node 是 BaseRenderable: 入队 pendingDestroy
    - 队列长度 >= MAX_PENDING_DESTROY -> 立即同步 flushPendingDestroy()（防饿死时无界积压）
    - 否则若未调度 -> process.nextTick(flushPendingDestroy) 一次
flushPendingDestroy: 逐个 node 若仍 !node.parent 才 destroyRecursively()（保留 move/reuse 语义，INV-04）
```

- 阈值 `MAX_PENDING_DESTROY` 为命名常量：存活树约 5400 renderable ≈ 21600 handle，65535 上限余量 ~44000 handle（~11000 renderable）；阈值取远小于此的常量（如 2048），既远不到耗尽、又不因小批量移除就强制同步销毁。

为何修 first divergence：它直接给「饿死」这一已实测机制上硬顶，无论主线程为何繁忙（accounting、突发 patch replay、未来的 O(总数) 回归）都不会再无界积压。

**禁 fallback 自查**：两修复都直接修各自 first divergence，不引入第二套成功路径、不 catch-and-success、不禁用既有行为另起炉灶。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| exit 快照随-delta eager memo + createEffect | current | 现状（非 fallback，但是冗余重算源） | yes | 全部 | **移除**（删 :236 memo + :486 effect，改退出时惰计算，修复1） |
| exit.message 字符串 set | current | contracted pass-through | yes | sync.tsx:672 | **保留**（兼容） |
| reconciler 每节点 nextTick defer | current | 现状（defer 语义本身正确） | yes | 全部 | **改造为有界**（修复2，语义不变） |
| turnUsage 全表遍历 | current | 现状 | yes | footer | **本计划不改**（见 §12/§20：实测其 per-delta 调用≈0，修复1后非瓶颈） |
| accounting O(parts²)/ratio map | current | 现状 | yes | 内部 | **本计划不改**（修复1后 tokenAccounting 退出时才跑，内部成本不再关键） |
| theme 共享 SyntaxStyle 退休 | current | 现状 | yes | theme | **本计划不改**（use-after-destroy 是卡死级联下游症状，根因修复后不复现；见其下游说明） |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `session/index.tsx:236` 的 eager `sessionUsage` memo + `:486-499` 的随-delta `createEffect` | 让 exit message 保持「最新快照」 | 退出时惰计算更准（用最终态）且不占运行期主线程；memo 唯一消费者就是 exit 快照 | 删除该 memo 与 effect，改一次性 lazy 注册（不加 onCleanup restore，保持卸载后保留语义） |

无其它被取代的 workaround；本计划不为已修根因新增 fallback。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01（exit 数值一致） | exit.tsx `get` 求值 thunk；session/index.tsx 一次性 lazy 注册（无 onCleanup restore） | exit.tsx、session/index.tsx | exit message 与现状逐字符相等（同一最终态；含「离开会话→home→退出」仍打印） |
| INV-02（delta 不重算 O(总数)） | session/index.tsx **删 :236 eager memo** + 删 :486 createEffect → 退出时 thunk 直调 tokenAccounting | session/index.tsx | red：300 条发 delta，tokenAccounting 调用数≈0（修复前≈1+/delta） |
| INV-03（积压有界） | reconciler.ts 共享队列+阈值 drain | reconciler.ts | red：紧凑 mount/unmount 循环后积压≤MAX_PENDING_DESTROY（修复前无界） |
| INV-04（move/reuse 不销毁） | reconciler.ts flush 保留 `!node.parent` 检查 | reconciler.ts | reconciler move/reuse 行为测试 |
| INV-05（字符串 set 兼容） | exit.tsx `get` 对 string 原样返回 | exit.tsx | sync.tsx:672 路径行为不变 |
| INV-06（无新红测/精度不变） | 全部 | — | 相关包全套件回归 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| exit.tsx `message` 支持 lazy producer | INV-01/02 | exit message 仅退出时读（exit.tsx `exit()`） | 现状 `set` 只收 string，route 被迫用 createEffect 随 delta 重算来保持新鲜 |
| session/index.tsx 删 eager memo + 一次性 lazy 注册 | INV-01/02 | sessionUsage 唯一消费者是 exit 快照；eager memo 订阅 store 即每 delta 重算 | createEffect 语义就是随依赖重算；而 eager memo（:236）只要存活订阅 store 就重算，只删 effect 不摘订阅等于未修 |
| reconciler 共享队列+阈值 drain | INV-03 | A/B 实测无界积压 | 每节点独立 nextTick 无积压概念、无上限 |
| reconciler flush 保留 `!node.parent` | INV-04 | reconciler.ts:134 现有语义 | 直接同步销毁会破坏 move/reuse（re-add 节点被误销毁） |

无多余 concept；每个都映射到 INV 与实测证据。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/exit.tsx` | modify | `message.set` 接受 `string \| (() => string \| undefined)`；`get` 退出时求值 thunk | ~+8 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | 删 `:236` eager `sessionUsage` memo + `:486-499` 随-delta createEffect，改一次性 lazy 注册 exit message producer（**不加 onCleanup restore**，保持卸载后保留语义） | ~+8/-14 |
| `thirdparty/opentui/packages/solid/src/reconciler.ts` | modify | `_removeNode` 销毁从「每节点 nextTick」改为「共享队列 + 阈值同步 drain + 单次 nextTick flush」 | ~+18/-6 |

生产代码共 **3 个文件**（预算 ≤8）。**Deferred（见 §11/§20，不进本计划）**：turnUsage 收窄（:1842）、accounting 内部 O(parts²)（accounting.ts）、theme use-after-destroy（theme.tsx）。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1（INV-02，packages/opencode） | 300 条会话发 part delta，断言 `tokenAccounting` 不再被随 delta 重算（调用数≈0） | 现状 :236 eager memo 每 delta 重算 | 删 memo 后 delta 路径不触发 accounting；退出时算一次 | token 数值与现状一致（INV-01）由同测试断言；注意残余消费者（turnUsage/sidebar/prompt）需在 fixture 里关闭以免干扰 ≈0 断言 |
| 2（INV-03，thirdparty/opentui/packages/solid） | 紧凑 mount/unmount 循环（不让出事件循环），断言待销毁积压≤阈值 | 现状无界 defer → 积压随迭代线性涨 | 加阈值同步 drain 后积压有界，settle 后清空 | move/reuse（INV-04）与正常 defer 语义不变 |
| 3（INV-05，packages/opencode） | `exit.message.set("str")` 后退出仍打印该字符串 | —（兼容保护，非 red） | thunk 支持不影响字符串路径 | 现有 sync/exit 行为 |

测试观察公开行为（exit message 文本 / 积压上界 / 字符串兼容），用独立预期值，不复制实现逻辑、不断言私有方法。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~32 | 排除 import、格式化、纯移动 |
| Required Chinese explanatory comments `C` | ~5 | `C >= max(1, ceil(32 * 0.15)) = 5` |

需要中文解释的点：
- exit.tsx：为什么 `message` 支持 lazy producer（exit 快照只需退出时求值，避免随 delta 的 O(总数) 重算）。
- session/index.tsx：为什么用一次性 lazy 注册而非 createEffect（数值在退出时才被消费，INV-01 语义不变）。
- reconciler.ts：为什么积压超阈值要同步 drain（连续无空闲负载会饿死 nextTick，无界积压会耗尽 65535 native handle）；为什么 flush 仍保留 `!node.parent`（move/reuse 语义）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/<red-lazy>.test.tsx` | `packages/opencode` | INV-01/02：delta 不重算 + exit 文本一致 |
| `bun test <reconciler bounded 测试>` | `thirdparty/opentui/packages/solid` | INV-03/04：积压有界 + move/reuse 语义 |
| `bun test test/cli/cmd/tui`（相关子集） | `packages/opencode` | INV-05/06：无新红测 |
| `bun test`（accounting/session 相关） | `packages/opencode` | token 计数精度不变 |
| `bun typecheck` | `packages/opencode` 与 `thirdparty/opentui/packages/solid` | 类型不破 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 复用既有 seam |
| Files modified | 3（+ 各 1 测试文件） | 最小修复面 |
| Files deleted | 0 | — |
| Production lines | ~32 | 远低于 800 预算 |
| Test lines | ~120 | 两个 red 行为测试 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

**真实风险（observed/reachable）**：
- reconciler 阈值同步 drain 在极端批量移除时引入一次性主线程峰值——已通过「阈值远大于单消息移除量、远小于耗尽余量」缓解（保留 defer 的正常路径，仅超限时兜底）。
- reconciler 改动在 `thirdparty/opentui`，本地可改可测；但**生产二进制经 root `package.json` overrides 取自 GitHub release tarball**，进入用户二进制需另走 OpenTUI 版本发布（0.4.3-smark.12）+ 重建 opencode——本计划不含发布动作。

**已排除/不采纳的投机项**：turnUsage 收窄、accounting 内部增量、theme use-after-destroy——见 §11，均为修复1后非瓶颈或卡死级联下游症状，不进入本计划以保持最小修复面。

### Open Decisions Requiring the User

- **是否在本计划内做 OpenTUI reconciler 改动**（修复2）。它本地可改可测、是销毁侧安全网，但**进入生产二进制需要一次 OpenTUI 版本发布 + opencode 重建**。若你希望本计划只落 packages/opencode（修复1即可大概率消除卡死），我可以把修复2拆成独立的 OpenTUI 发布任务。默认：两个都做，reconciler 改动连同版本发布说明一并交付。

## 21. Implementation Evidence

**实际改动文件（3 生产 + 2 测试）**：
- `packages/opencode/src/cli/cmd/tui/context/exit.tsx`（+8/-4）：`message.set` 接受 `string | (() => string | undefined)`，`get()` 退出时求值 thunk；字符串用法（sync.tsx:672）不变。
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`（+10/-14）：删 `:236` eager `sessionUsage` memo + `:486` 随-delta `createEffect`，改 `onMount` 一次性注册惰性 exit 快照 thunk（无 onCleanup restore，保持卸载后保留语义）。
- `thirdparty/opentui/packages/solid/src/reconciler.ts`（+37/-6）：`_removeNode` 销毁从「每节点各自 nextTick」改为「共享队列 + `MAX_PENDING_DESTROY=256` 阈值同步 drain + 单次 nextTick flush」，flush 保留 `!node.parent` 检查。
- `test/cli/cmd/tui/session-exit.test.tsx`：新增 INV-02 red 测试（delta 不重设 exit message）。
- `thirdparty/opentui/packages/solid/tests/reconciler-destroy-backlog.test.tsx`：新增 INV-03 red 测试（紧凑移除积压有界 + settle 排干）。

**Red-Green 证据**：
- INV-02：修复前 `setCount` 随 delta 增长（2→5），修复后 delta 不再重设 exit message（green）。
- INV-03：修复前紧凑移除 300 个 renderable 全未销毁（300 > 256），修复后 ≤256 且 settle 后归零（green）。**测试观测为同步（setItems 后直接读 isDestroyed，不夹带任何 await/yield），实证：在还原后的原始 reconciler 上重跑为红（300），修复后绿——不依赖 renderOnce 是否排干 nextTick。**

**验证命令与结果**（均从 package 目录跑）：
- `bun test test/cli/cmd/tui/session-exit.test.tsx`（packages/opencode）：**4 pass**——3 个既有 exit 测试（INV-01 数值回归）+ 新 INV-02。
- `bun test test/cli/cmd/tui/`（packages/opencode）：**323 pass / 0 fail**——TUI 无回归。
- `bun test test/token/accounting.test.ts test/cli/cmd/tui/exit.test.tsx`（packages/opencode）：**10 pass**——token 精度与 exit 上下文不变。
- `bun test`（thirdparty/opentui/packages/solid）：**263 pass / 0 fail**——reconciler 集合/move/portal/destroy 时序无回归。
- `bun typecheck`（仓库根 = turbo typecheck，即 CI `typecheck.yml` 命令）：**14/14 通过**。（注：`tsc -p` 单独跑 opentui/solid 会经 project references 拉入兄弟包 three/ 的预存错误；opentui 不在 workspace、不进 CI typecheck。）
- 原始反馈环（`.temp/Testing/zz-emit-timing.test.tsx`）：300 条消息 per-delta emit **19.20ms → 4.27ms**，tokenAccounting 重算 **34 次/457ms → 0**（delta 路径）。

**E/C（实测）**：生产 E≈36 行（exit.tsx 5 + session/index.tsx 10 + reconciler.ts 21）；中文注释 C≈18 行（exit 3 + session 6 + reconciler 9），比例 ~50% ≫ 下限 `ceil(36×0.15)=6`。注释落点：exit.tsx 惰性 producer 与字符串兼容理由；session/index.tsx 惰注册与「不加 onCleanup restore」语义保留理由；reconciler.ts 阈值同步 drain 的饿死/耗尽因果与 `!node.parent` move/reuse 保留理由。

**次级/替代路径盘点（实际）**：exit message 字符串 set（sync.tsx:672）为既有兼容路径，保留；无新增 fallback。

**未验证项**：OpenTUI reconciler 改动进入生产二进制需另走 OpenTUI 版本发布（见 §20 开放决定）；本地 solid 套件已验证行为。

---

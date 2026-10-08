# Canonical Implementation Plan: TUI 屏外高亮标志卡死导致渲染自旋修复

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户 Session GOAL 原始需求（见 §1 逐字引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-10-08

本文是本任务唯一 implementation authority。聊天摘要、历史会话排查记录不构成实施授权。

**Revision history**：R1 经方案审计批准后实施并通过首轮实现审计（§22 R1、§24 R1）。随后用户安排的一次性双审计员复审（§24 R2A/R2B）一致返回 REJECT：两名审计员独立追踪到同一个本次新引入的阻断缺陷 B-01（见 §8 偏离 1b）。primary agent 按合同先行独立核验其前提（bundle 3573/3580/3583-3587/3757-3771/3187-3191 直接读取），确认该缺陷由 R1 四处无条件归位引入、属于本需求范围内的正确性回归，接受 blocker 无需复议，故修订为 R2：清空批准、全范围重审。R1 的 §23 证据与 §24 R1 记录保留为历史，不再构成实施授权。

## 1. Verbatim Requirement

> "请注意，你需要准确完整解决相应的 TUI 当前现有的卡顿问题。该问题是偶尔偶发性生效，且在卡顿的时候，整个 TUI 会进入到刷新、渲染、消息响应都进入极度阻塞状态，且多次按下 ESC 没有任何反应，消息处理譬如滚动等等的情况几乎停滞，且该现象将会持续大概十分钟左右，会慢慢恢复，但并没有明显的进入该状态以及离开该状态的明显导火索或可见导火索，本质是一个非常不稳定的时序性问题。需要进行相应的修正，且修正需要进行在主仓库中进行，整体的生产代码修改数不超过六个文件。与此同时修改行数不应超过一千两百行，保持整体的修改克制，不触碰那些本身并不是你引入的一些无关紧要的小的时序问题。但是如果是一些比较大的会影响卡顿等等的一些问题，可以适度进行相应的考虑以及修正。"

修复形式经用户确认（2026-10-08 对话）：

> "能直接改成，就是直接以 patch 的形式去修改吗？就是不修改这个 third party 里面的 OpenTUI源码，还是说怎么办。"

→ 用户选择 patch 形式修复，不修改 `thirdparty/opentui` 源码。

## 2. Explicit Non-Goals

- 不修改 `thirdparty/opentui` 源码树（用户明确选择 patch 形式；源码随迁属下一次 opentui 发布流程，见 §20 开放决定）。
- 不修改 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` 的驻留驱逐/重测逻辑：消费方对 `isHighlighting` 的信任语义在标志 truthful 后恢复正确，现有 residency 测试保护该行为。
- 不修改 streaming 高亮路径（`startStreamingHighlight`/`runStreamingLoop` 由 finally 保证 `_isHighlighting = false`，无泄漏）。
- 不修改 daemon、sync 事件协议、SQLite schema、provider、权限、MCP。
- 不在本任务重建/重发布 `opencode.exe`；patch 经 `bun install` 作用于依赖内容，随下一次正常构建进入二进制。
- 不处理 §20 记录的与本次根因无关的历史观察项。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message=MessageV2 parts（reasoning 是 Part type）；TUI 在 `cli/cmd/tui/` |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence、单一 primary path、中文注释门禁、审计协议 |
| 根 `AGENTS.md` / `packages/opencode/AGENTS.md` | 测试从 `packages/opencode` 目录运行；`bun typecheck` 同目录 |
| `thirdparty/opentui/AGENTS.md` | 修复必须有可复现测试；本次不动该源码树，但其「不猜测、要复现」要求已由 §8 反馈环满足 |
| 根 `package.json:147-152` `patchedDependencies` | patch 交付机制：`patches/@opentui%2Fcore@0.4.3-smark.13.patch` 绑定发布 tarball，`bun install` 应用 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 现有 patch 已改过同一目标文件 `index-b5dpwnes.js`（streaming loop isDestroyed hunk），是本次追加 hunk 的直接先例 |
| `docs/plans/tui-freeze-native-handle-exhaustion.md` | 历史 TUI 卡死调查（native handle 耗尽），与本次是不同的已闭环根因；其进程取证方法（主线程 CPU/帧统计）被本次复用 |
| `docs/plans/code-renderable-highlight-failure-visibility-repair.md` | CodeRenderable 高亮失败可见性的既有修复历史，确认该组件的 flag/失败语义曾被单独治理 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `node_modules/@opentui/core/index-b5dpwnes.js:3569-3658`（`startOneShotHighlight`） | 4 处 stale-snapshot 分支 return 前不清 `_isHighlighting`（pristine 行 3582/3600/3624/3643）；当前磁盘已是 R1 patch 应用后状态（streaming hunk 3425-3426 与 R1 四处归位 3585/3604/3629/3649 均已落盘，bundle mtime 2026-10-08 19:31）——§16 切片 2 的 red 正是依赖该状态 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:609-714` | 同构源码确认 4 处 stale 分支（626/647/677/698）；仅作结构佐证，不修改 | observed |
| `node_modules/@opentui/core/index-b5dpwnes.js:3387-3480` | streaming 路径 `runStreamingLoop` finally（3473-3479）恒清 `_isHighlighting`；泄漏仅存在于 one-shot 路径 | observed |
| `node_modules/@opentui/core/index-b5dpwnes.js:3187-3205`（content setter）、3751-3770（renderSelf） | setter 使 `_highlightsDirty=true` 且 `_highlightSnapshotId++`；renderSelf 只在节点实际渲染时重启高亮——屏外节点永远不会执行 | observed |
| `packages/opencode/.../routes/session/index.tsx:538-547`（`subtreeHasPendingHighlight`）、644-674（重测批门）、703-756（驱逐） | 消费方：子树任何后代 `isHighlighting=true` → 拒绝冻结高度并 `scroll.requestRender()`；卡死标志使该等待永不结束 | observed |
| `session/index.tsx:2024-2026,2068` | shell 由 `<Show when={mounted()}>` 卸载正文；驱逐不发生则子树永驻——与卡死标志构成双向等待 | observed |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts:1-138` | 既有测试已使用真实 `TreeSitterClient` + `Promise.withResolvers` 门闩确定性控制在途高亮，并断言公开 `isHighlighting`（:49,:132）——本次 red 测试的既有 seam 与模式 | observed |
| 进程取证（原卡死 TUI PID 38740，2026-10-08 15:5x 读取） | native 渲染统计：`frameCount=97,622`（约 2 小时、会话多数时间空闲 ⇒ 持续不断渲染）；最近 30 帧 frame mean 84ms；主线程累计用户态 CPU 2,429s | observed |
| SQLite 会话形状（只读查询） | 卡死会话 `ses_fa5662e7cffev3J6FIcf6Gt1If`：139 消息 / 797 parts / **240 个 reasoning parts**（GPT 模型细粒度思考块）；对照会话 reasoning 数量级低或已冷存储 | observed |
| 隔离复现（`D:\Temp\opencode`，真实 `createTestRenderer` + ScrollBox viewportCulling） | 一次性高亮在内容变更后 stale 结算：节点屏外经过 **120 帧** `isHighlighting` 仍为 `true`；滚回视口后恢复正常——用户症状的最小化因果核 | observed |

## 5. Current Behavior

```text
SSE part delta → sync store → ReasoningBody content() 变更
  → CodeRenderable.content setter：_highlightsDirty=true，_highlightSnapshotId++
  → 旧 one-shot 高亮在 worker 结算后回到主线程
  → stale 分支（snapshotId 不匹配）：requestRender(); return   ← _isHighlighting 保持 true
  → 节点若处于 ScrollBox 裁剪之外：renderSelf 不再执行，脏标志无人消费
  → session/index.tsx 驻留 pass：候选超龄(30s)或超容量后，
    subtreeHasPendingHighlight(child)=true → followUp=true → scroll.requestRender()
  → 下一帧重复同一 pass ⇒ 永不终止的逐帧渲染循环（主线程持续占用）
  → 输入事件（ESC/滚动）排在渲染任务之后 ⇒ 按键极慢、二次确认窗口过期、abort 难以触发
  → 节点重新可见 / 路由切换 / 消息滑出 300 窗口后标志经 renderSelf 或记录清理恢复 ⇒ 自行缓解
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| one-shot 高亮在途期间内容变更（stale） | SSE delta / durable part 更新 → content setter | setter 无条件递增 snapshot | 4 处 stale 分支 | CodeRenderable | observed |
| 节点被 ScrollBox 裁剪（屏外） | 用户滚动 / 流式自动跟随 | culling 恒定启用（`shouldCullSessionViewport` 恒 true） | renderSelf 不执行 | OpenTUI renderer | observed |
| reasoning-dense 会话（GPT 类模型大量小 reasoning parts） | provider 流式 reasoning | 每 part 一个 CodeRenderable(filetype=markdown) | 上述两点叠加概率随 part 数线性上升 | session 路由 | observed |
| streaming markdown 高亮 | `startStreamingHighlight` | finally 恒清标志 | 不适用（无泄漏） | CodeRenderable | observed（排除） |
| 高亮 promise 永不结算（worker 卡死） | tree-sitter worker | 无 | 无本次事件证据 | — | speculative（见 §20 Rejected Speculation） |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `CodeRenderable.isHighlighting` 表示**最新启动的 one-shot 请求**的在途状态：无在途请求时必须为 `false`（R1 目标）；已有更新请求在途时，旧请求的过期结算必须保持其为 `true`（R2 补强）——只有最新启动请求的终结才能归位标志 | 隔离复现 stale 结算后 120 帧仍为 true；双审计追踪的 A/B 重叠路径（§8 偏离 1b） | 无（新增 §16 切片 1、2） |
| INV-02 | 屏外消息的高亮状态不得无限期阻止驻留驱逐与帧静默——内容稳定后渲染循环必须停止 | 卡死进程空闲时 frameCount≈9.7 万仍持续增长 | 既有 residency/resize 测试（`session-message-render.test.tsx:4298+`）保护驱逐语义本身 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01（偏离 1，原始缺陷） | `startOneShotHighlight` 4 处 stale 分支 `requestRender(); return` 前未清 `_isHighlighting`（bundle 3582-3584, 3600-3603, 3624-3627, 3643-3646；源码同构 Code.ts 626-629, 647-650, 677-680, 698-701） | `@opentui/core` 的 `CodeRenderable`（经 bun patch 交付） | 隔离复现：stale 结算后 `isHighlighting===true` 且无任何在途请求 |
| INV-01（偏离 1b，R1 引入） | R1 的 4 处归位是**无条件**赋值：`renderSelf` 在脏标志存在时直接 `startHighlight()`，不等待旧请求（bundle 3757-3771），one-shot 启动即递增 snapshot（3573）并置位标志（3580）；因此 A 在途 → 内容变更 → 下一帧启动 B 是常态重叠。A 的过期结算把 B 已置位的标志清为 `false`，驻留层据此提前冻结高度并销毁正文；B 返回时被 `isDestroyed` 拦下无法自纠（双审计 B-01，bundle 3573/3580/3583-3587/3757-3771 已直接核实） | 同上（同一 owner，同一接口） | 源码可达路径；§16 切片 2 提供确定性 red→green |

下游症状（ESC 饥饿、~1fps、分钟级自旋后自行缓解）均由偏离 1 经 §5 链条放大，不是并列根因。偏离 1b 的后果是提前冻结/销毁与滚动几何失真，属同一标志真实性契约的另一侧违背。

**Red-capable feedback loop**（已实际运行，捕获本缺陷的最小因果核）：

```text
命令（D:\Temp\opencode 下，bun -e / 等价脚本 highlight-latch-repro）：
  createTestRenderer + ScrollBox(viewportCulling) + CodeRenderable(markdown, 受控 highlightOnce)
  → 启动高亮 → content 变更（stale）→ 滚出视口 → 结算旧请求 → 追加 120 帧
观测（修复前）：calls=1, pending=0, isHighlighting=true（120 帧后仍 true）；滚回视口后恢复 false
```

用户原始症状（分钟级 1fps + ESC 无反应）本身不可在测试内确定性强放；该 loop 捕获的是症状链上可确定复现的首次偏离，绿色判据与 §16 切片一致。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 高亮在途标志的生命周期真实性 | `CodeRenderable`（opentui/core） | `isHighlighting` 表示与当前内容同代的在途工作 | 标志由它置位，只有它知道请求是否还有效 | session 驱逐方只是消费者；在消费方猜「多久算太久」属于对上游谎言的补偿 |
| stale 后重新高亮 | `CodeRenderable.renderSelf` | 脏标志存在时下一次实际渲染重启高亮 | setter 已置 `_highlightsDirty`，现有调度路径完整 | 不需要在 stale 分支里直接重启（屏外/已销毁节点重启是纯浪费且有 destroy 风险） |
| 驱逐对 pending 高亮的等待 | `session/index.tsx`（既有行为，不变） | 高度冻结必须等 conceal 定稿（既有注释 :539） | 真实的在途高亮确实会改变行数 | 修复后标志 truthful，该等待恢复有界 |

## 10. Single Approved Primary-Path Design

在 `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 的 `index-b5dpwnes.js` 段内，把 R1 的 4 处无条件归位改为**按请求归属的归位**，并在 owner 内记录最新启动的 one-shot 请求身份：

```text
类字段（_highlightSnapshotId 旁）：
  _latestOneShotSnapshotId = 0

startOneShotHighlight 启动处（const snapshotId = ++this._highlightSnapshotId 之后）：
  this._latestOneShotSnapshotId = snapshotId

4 处 stale 分支统一改为：
if (snapshotId !== this._highlightSnapshotId) {
  // 只有最新启动请求的结算才能归位标志；已有更新请求在途时标志归它所有。
  if (snapshotId === this._latestOneShotSnapshotId) {
    this._isHighlighting = false
  }
  this.requestRender()
  return
}
```

正确性论证（snapshot 在 setter 与每次 one-shot 启动均递增，故严格区分请求代次）：

- **无后继（原始缺陷场景）**：A 是最后启动的请求，`_latestOneShotSnapshotId === snapshotId(A)` → 归位，R1 修复目标完整保留。
- **B 在途（B-01 场景）**：`_latestOneShotSnapshotId === snapshotId(B) ≠ snapshotId(A)` → A 跳过归位，标志由 B 的终结路径（成功/失败/过期）负责；B 过期时 B 是最新启动 → B 归位。
- **B 先于 A 结算**：B 正常完成已归位并落地高亮；A 随后过期结算跳过赋值，无副作用。
- **连续启动 A→B→C**：A、B 均跳过，C 终结时归位；任何时刻标志归属唯一。
- **已销毁节点**：脱离挂载树后无消费者读取，保持既有接受语义不变。

streaming 路径不读写 `_latestOneShotSnapshotId`（该字段只在 one-shot 启动写入、只在 one-shot stale 分支读取），其 finally 自清语义不受影响；setter 只递增 `_highlightSnapshotId`，不触碰新字段。

无替代成功路径、无配置开关、无调用方补偿；不在驻留消费方增加任何等待或补偿逻辑。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 4 处 stale 分支归位标志 | proposed | primary-contract branch（修复既有分支语义） | 不新增成功路径 | 100% of changed decision surface | 实施 |
| 既有 streaming hunk（同 patch 文件） | current（仓库既有） | 已发布兼容性内容，非本任务变更 | — | 0%（非本任务新增） | 保留；`bun install` 会使其落入磁盘（见 §20 风险 3） |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无 | 本缺陷历史上没有任何 workaround | 首次修复 | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01（无后继 stale 结算后标志归位） | patch → 安装包 `index-b5dpwnes.js` 4 处 stale 分支 guarded 归位 | `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 修改/追加 hunks | §16 切片 1（既有，保持绿） |
| INV-01（A/B 重叠时旧请求不得清标志） | 同上 + one-shot 启动处记录 `_latestOneShotSnapshotId` + 类字段声明 | 同上 | §16 切片 2（新增，red→green） |
| INV-02（驱逐/帧循环恢复有界） | 同上（同一生产变更，消费方代码不变） | 同上 | 既有 residency/resize 测试回归 + §18 原始 loop 复跑绿色 |
| 用户需求（偶发卡死不再出现） | 同上唯一修复点 | 同上两个文件 | 切片 1 red→green + 原始 loop + 回归套件 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| stale 分支 guarded 清 `_isHighlighting`（×4） | INV-01 | 隔离复现 + bundle/源码双向定位 | 现有分支只 requestRender 不清标志；消费方无法区分「真在途」与「卡死」 |
| `_latestOneShotSnapshotId` 字段 + 启动处记录 | INV-01（偏离 1b） | 双审计 B-01 路径 + bundle 3573/3580/3757-3771 直接核实 | 现有状态只有共享布尔标志与全局 snapshot 计数，无法表达「最新启动请求身份」；无条件归位会把 B 的在途状态误清 |

无其他生产概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | modify | R1 的 4 处归位 hunk 改为 guarded 形式（每处 +2 行）；新增类字段声明 hunk（+1）与 one-shot 启动记录 hunk（+1，带 1 行中文注释） | patch 文件净增约 +20 行（含 hunk 头与上下文）；对安装包产物的有效改动 E≈10 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | modify | 新增 1 个 A/B 重叠 red-capable 行为测试（§16 切片 2） | 约 +45 行 |
| `D:\Temp\opencode\highlight-latch-repro.ts` | 诊断脚本（仓库外） | 原始 feedback loop 固化，实现后复跑验证 | 不计入 diff 预算 |

不修改任何 `packages/`、`thirdparty/` 生产源码。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | one-shot 高亮经 `onHighlight` 门闩持有期间更新 content（制造 stale），放行结算后 `isHighlighting===false`；随后下一次渲染会真实重启高亮（highlightOnce 调用数 +1 且最终标志仍归 false） | stale 分支 return 前不清标志，断言 `false` 失败 | 4 处 stale 分支（guarded）归位标志 | 同文件既有 teardown/自然退出/渲染一致性 4 个测试全绿 |
| 2 | A 经门闩 1 持有期间更新 content 并 `renderOnce()` 启动 B（门闩 2 确认 B 已在途）；放行 A 并做一次 macrotask 排空后断言 `isHighlighting===true`（B 仍在途）；放行 B 后标志归 `false` 且 `plainText` 为换代后内容 | 当前安装的 R1 patch 无条件归位：A 的 stale 结算把标志清为 `false`，断言 `true` 失败——**red 可直接在当前工作区运行，无需回滚** | guarded 归位：A 跳过赋值，B 终结时归位 | 切片 1 与同文件全部既有测试保持绿 |

测试只观察公开行为（`isHighlighting`、真实 client 的高亮次数与最终 styled 结果），不断言私有方法/源码文本。门闩模式沿用该文件既有 `Promise.withResolvers` 先例；切片 2 的 macrotask 排空（`setTimeout(0)`）只用于等待「已放行 promise 的同步尾巴」结束，是确定性的微任务排空，不是睡眠猜时序。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ≈55（产物 10 + 测试 45） | 排除 hunk 上下文行与 import；产物含字段 1 + 启动记录 1 + 4 条件 + 4 赋值（R1 赋值行改造计入） |
| Required Chinese explanatory comments `C` | ≥9（ceil(55×0.15)） | 产物 1 行（请求归属语义）；测试内约 9 行（双门闩意图、重叠构造理由、macrotask 排空的确定性依据、公开行为断言含义） |

需要解释的非显然点：guarded 归位「只有最新启动请求的结算才能清标志」的所有权语义；切片 2 为什么必须先确认 B 在途再放行 A（否则断言失去分辨力）；macrotask 排空为什么不是睡眠竞态。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts`（R2 实施前，当前工作区即 R1 patch 状态） | `packages/opencode` | 切片 2 RED：A 结算后 `isHighlighting===false`（B 在途却被清）；切片 1 保持绿 |
| 编辑 patch 后 `bun install`；`rg` 核对 4 处 guarded 归位、`_latestOneShotSnapshotId` 字段声明与启动记录均落盘 | 仓库根 | patch 全量应用（含既有 streaming hunk，单独核对） |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts`（实施后） | `packages/opencode` | 新切片 GREEN，同文件既有测试不回归 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx test/cli/cmd/tui/session-pending.test.ts` | `packages/opencode` | 驱逐/resize/驻留语义回归绿色（INV-02 消费方未变） |
| `bun typecheck` | `packages/opencode` | 测试文件类型干净 |
| `bun D:/Temp/opencode/highlight-latch-repro.ts` | `D:\Temp\opencode` | 原始 feedback loop：屏外 stale 结算后 120 帧内 `isHighlighting===false`（修复前为 true） |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | |
| Files modified | 2（patch + 测试） | 远低于用户 6 文件上限 |
| Files deleted | 0 | |
| Production lines | ≈10（产物有效行） | 字段 1 + 启动记录 1 + 4 处 guarded 归位（条件+赋值） + 1 行注释 |
| Test lines | ≈45 | 单一行为切片（切片 2；切片 1 为 R1 既有） |
| Generated lines | 0 | patch 为手写 hunk，非生成物 |

## 20. Real Risks and Open Decisions

1. **patch 版本钉死**：文件名绑定 `0.4.3-smark.13`；下次 opentui 版本升级时 bun 会因版本不匹配报错，届时必须把本修复合入 `thirdparty/opentui` 源码（Code.ts 626/647/677/698 同构点）并随新发布携带——这是本任务留下的唯一开放决定，属发布流程而非本次代码范围。
2. **历史窗口的逐帧耗时归因不可回溯**：故障窗口没有保留函数级采样（ETW 无 CPU 采样权限、native 帧统计仅存最近 30 帧）。INV-01 的违背及其放大链条由复现与进程统计锁定；历史现场的精确分钟数构成已无法补证，不作为本修复的验收口径。
3. **既有 streaming hunk 已随 R1 实施期的 `bun install` 首次落盘**（bundle 3425-3426，含中文注释行；R2 审计已直接核实）。该 hunk 是仓库既有意图，其行为由同文件既有测试（queued teardown 等）覆盖；R2 的 hunk 编辑以当前 patch 文件内容为基线。

### Open Decisions Requiring the User

仅 §20.1 的源码随迁时点（下次发布时执行），不阻塞本次 patch 修复。

### Rejected Speculation

- **tree-sitter worker 永不结算导致标志滞留**：原理上可达，但本次事件无任何证据（卡死会话的高亮请求在复跑中 228/228 全部完成）；不驱动代码。
- **~90ms 输出写耗时为卡顿根因**：实测存在于恢复后的进程（最近 30 帧 write mean 89ms），它把帧率上限压到 ~11fps 量级，但不产生「分钟级完全阻塞后自行恢复」的形态；不属本次证据链，不修改。
- **daemon 侧 4.1s 日志间隔**：与 TUI 主线程被占满时 fire-and-forget `/log` POST 排队一致，方向是结果而非原因；daemon 在同时段持续服务其他会话。

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
| 1 | R1 | yes | No blocking findings. | 1. Repro script filename not yet on disk（documentation-location discrepancy，实施审计时重跑验证）。2. INV-01 wording 在「A stale 结算与 B 在途」交错下严格强于交付语义；可达后果仅为旧高度提前冻结，与既有接受类别同型、remount 自纠，不产生 stall，无需修正。（该项后被 §24 2A/2B 推翻，见 R2 revision history。）3. 四个同构 stale 分支中切片覆盖 onHighlight 后分支（bundle 3600-3603），其余三个由实施后 rg 计数验证，结构同一可接受。 | APPROVE | subagent task ses_ee4d4cbd2ffeYqeGN5sZZeog01（adversarial-auditor，2026-10-08） |
| 2 | R2 | yes | No blocking findings. | N-01 §4/§20.3 磁盘状态描述已过时（记录性）：streaming hunk 与 R1 四处归位实际已落盘，已按审计指引修正记录，不影响设计。Rejected speculation：无 filetype 提前 return 的「幻影请求」路径不可达（renderSelf 3764-3766 不启动）；streaming finally 交叉为既有时序、方向 fail-safe；worker 永不结算无证据。守卫正确性经全交错枚举验证（无后继/B 在途/B 先结/A→B→C 链/销毁）。 | APPROVE | subagent task ses_ee46fc4cfffeJbbfhjfbwtzZDm（adversarial-auditor，2026-10-08；bundle 3573/3580/3583/3603/3628/3648/3757-3771 与 index-3209194d.js:8369-8375 逐一核实，切片 2 red 可达性确认） |

## 23. Implementation Evidence

> 本节描述当前工作区的 R2 实现。R1 实现证据已被 R2 取代（R1 的无条件归位即 §8 偏离 1b 的引入点），其验证记录保留于 §24 审计轮次与 git 历史参考中，不再代表现状。

### Actual Files and Diff

| File | Change | Lines |
| --- | --- | --- |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | `index-b5dpwnes.js` 段：4 处 stale 分支改为归属守卫归位（每处 +3：条件/赋值/闭括号，首处中文注释更新为所有权语义）；新增类字段 hunk（+2：注释+声明）与启动记录 hunk（+1） | patch 净 +67（含 hunk 头/上下文）；产物有效改动 E=10 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | 切片 1（R1 既有，保持绿）+ 切片 2「stale settle of a superseded one-shot keeps the in-flight flag owned by the newer request」（新增） | +108（切片 1 五行版本 52 + 切片 2 五行版本 56） |

### Red-Green Test Evidence

- 切片 2 RED（R1 patch 状态，`packages/opencode`）：失败于 `expect(code.isHighlighting).toBe(true)` received `false`（test:279）——A 的 stale 结算清掉 B 在途标志，正是偏离 1b 的直接证据；同运行切片 1 与其余 6 测试保持绿（7 pass / 1 fail）。
- 应用：`bun install`（仓库根）→ `rg` 核对：字段声明 3134、启动记录 3579、4 处守卫 3588/3609/3636/3658、streaming hunk 3425-3426。
- GREEN：同文件 8/8 pass（切片 1 保持绿 = 原始缺陷修复保留；切片 2 绿 = 归属守卫生效）。

### Implementation Deviation Note（非实质，已在批准设计语义内）

计划 §10 伪码将启动记录写在 `const snapshotId = ...` 之后立即执行；实际落盘位于 `if (!filetype) return;` 提前返回之后、`this._isHighlighting = true` 之前（bundle 3576-3579）。原因：bun patch 对锚点偏移 ±2 的 hunk 会错位插入（首轮 hunk 曾把记录行插入 `if (!filetype)` 与 `return;` 之间，吞掉条件分支导致函数恒提前返回，两个切片同步挂起被发现并修正）。现位置在语义上更严格：无 filetype 的启动不记录代次，从结构上排除幻影请求（审计 rejected-speculation 项因此由「不可达」升级为「结构排除」）。所有真实路径（能置位标志的启动必先记录）与批准设计完全等价。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | packages/opencode | 8 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` | packages/opencode | 104 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-pending.test.ts` | packages/opencode | 20 pass / 0 fail |
| `bun typecheck` | packages/opencode | clean（`tsgo --noEmit`） |

### Original Feedback-Loop Result

`bun D:/Temp/opencode/highlight-latch-repro.ts`（诊断脚本，仓库外）：`{"calls":1,"pending":0,"isHighlightingAfter120OffscreenFrames":false}` + `{"calls":2,"isHighlightingAfterVisible":false}` → GREEN exit 0（R1 已验证为 RED→GREEN，R2 复跑保持 GREEN）。

### Actual Secondary and Replacement Path Inventory

无新增替代路径。生产行为变更 = 4 处 stale 分支守卫归位 + 字段声明 + 启动记录（同一 primary-contract 修复）。同 patch 文件内既有 streaming hunk 属仓库既有内容，由同文件 5 个既有测试锁定。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 94–99（产物 10–14：字段 1 + 记录 1 + 4 条件 + 4 赋值（+4 闭括号按口径）；测试 ≈84–85） | patch hunk 头/上下文为脚手架不计；import 无变化；审计独立复算修正口径（R1 从未提交，diff 相对 HEAD 为纯增量 patch +68/测试 +108） |
| Qualifying Chinese comment lines `C` | 23（产物 2：字段注释 + 首处守卫注释；测试 21：切片 1 十一行 + 切片 2 十行；剔除切片 2 跨切片指针行后 C=22 仍达标） | 均为不变量/边界/测试意图解释，紧贴对应修改点 |
| Ratio `C / E` | ≈0.23–0.24 | |
| Required minimum `C` | max(1, ceil(99×0.15)) = 15 | 满足 |

### Remaining Unverified Items

- 历史故障窗口的逐帧耗时构成不可回溯（无函数级采样留存）；本次修复锁定的是经复现证明的首次偏离及其放大机制。
- 复现脚本覆盖最小 latch 因果核，未接入驻留管理/ESC 响应的端到端动态验证（双审计 N-01/N-02 记录的证据边界，保持不变）。
- patch 与 opentui `0.4.3-smark.13` 绑定的发布随迁属 §20.1 开放决定。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | 1. §23 的 E 计数由审计按实际 diff 重算为 44（实施期估计 39），门槛仍通过，§23 已按审计值修正。2. INV-01 严格性强于交付语义（与 §22 计划审计记录同型）：B 代在途期间旧 stale 结算会短暂读 false，方向 fail-safe，驱逐等待因此终止而非自旋，B 落地 requestRender 自纠。3. `isDestroyed` 提前 return 不清标志（bundle 3589/3608/3633/3653）先于本 diff 存在、未改动、无 stall 后果（消费方只遍历已挂载子树）。Rejected speculation：streaming 路径两处 continue 由 finally 无条件归位，无泄漏；全 bundle 仅 4 处 stale 检查，全部已覆盖。 | APPROVE | subagent task ses_ee498203affeWHpIP2C0eHNSiO（adversarial-auditor，2026-10-08；独立复跑 7/7、104/104、20/20、typecheck clean，bundle 落盘行号逐一核实） |
| 2A | R1 | yes | B-01（P2，本次新引入，reachable）：R1 的 4 处无条件归位在 A/B 请求重叠下把新请求 B 已置位的标志清为 false；驻留层据此提前冻结高度并销毁正文（session/index.tsx:728/734/2343），B 返回被 isDestroyed 拦下无法自纠。非阻断项 2（R1 轮）的「B 落地 requestRender 自纠」结论不覆盖正文已被销毁的分支，予以推翻。 | N-01 原始反馈脚本只覆盖最小 latch，未接入驻留管理/帧静默/ESC 动态验证（P3）；N-02 本轮未执行动态测试，历史通过记录不计独立复跑（验证缺口非失败）。 | REJECT | subagent task ses_ee4795df3ffe83rYxR9gr08mRU（双审计员 A，用户安排的一次性双审计，2026-10-08） |
| 2B | R1 | yes | B-01（P2，本次新引入，reachable）：与 2A 独立追踪到同一缺陷，证据集一致（patch:95/107/117/126 四处无条件赋值；bundle 3757 renderSelf 不等待旧请求；3573 启动递增 snapshot；client 不禁止同节点请求重叠 index-3209194d.js:8369）。 | N-01 新增测试刻意避开 A/B 交错（test:215），覆盖缺口随 B-01 修正（P3）；N-02 反馈脚本未验证帧静默与 ESC 响应（P3）。 | REJECT | subagent task ses_ee4795d9cffeD6kxGp4G51TH0C（双审计员 B，用户安排的一次性双审计，2026-10-08） |
| 3 | R2 | yes | No blocking findings. | 1. E 计数口径微差（94 vs 95–99，仅闭括号计入口径差异，两种口径均达标）。2. handoff 行数描述 patch +71/-3，实际相对 HEAD 为 +68/-0（R1 从未提交，纯增量）。3. 切片 2 一行跨切片指针注释属边际合格（剔除后仍达标）。4. red 状态本轮无法只读复跑（回滚 bundle 未授权），切片敏感性由守卫-断言直接对应关系与 §23 记录的 red 运行确立。Rejected speculation：streaming/one-shot 交叉不可达（_streaming 构造期固定，startHighlight 二选一）；幻影代次被落盘位置结构性排除；worker 永不结算无证据；`_isHighlighting` 全部 10 处写点逐一核对无遗漏。审计员独立复跑：8/8、104/104、20/20、typecheck clean。 | APPROVE | subagent task ses_ee450e292ffe5Y9bPIPX1lo1rI（adversarial-auditor，2026-10-08） |

# Plan: TUI session.last 滚动可达性测试的立帧断言竞态修复

Status: verified
Revision: R4
Approved revision: R4
Implementation allowed: yes

## 1. 用户需求（原文引用）

> "试着将直接开启一个新的GOAR任务，并且按全流程进行相应的处理。也就是解决这一个问题，同时整体的限制，整体的修改限制在四个文件以内，同时生产代码的修改量在600行以内。"

问题对象：CI run 33295279134（@3560418a2）Windows TUI 分片红测 `session keeps latest streamed content reachable via session.last after scrolling away` [120.45ms]；本机隔离运行 5/5 确定性失败。

## 2. Evidence / 反馈回路（已实际运行）

- 红色回路：`bun test test/cli/cmd/tui/session-message-render.test.tsx -t "session keeps latest streamed content reachable via session.last after scrolling away"`（cwd=packages/opencode）
- 观测：5/5 失败（538–734ms/次），失败点 `session-message-render.test.tsx:1463` `expect(afterScroll.some(line => line.includes("OLD_CULL_TAIL"))).toBe(false)` 收到 `true`——4 次 `pressKey("y",{ctrl:true,meta:true})`（绑定 `messages_line_up: "ctrl+alt+y"`，keybind.ts:119）+ 单次 `renderOnce()` 后 OLD_CULL_TAIL 仍在视口内。
- CI 因果免责：`git diff --name-only 57d1fe064..3560418a2` 仅 build smoke 脚本与 plan 文档，运行时/测试代码 0 文件差异；57d1fe064 test run 33292110169 同测试绿 → 预存条件性缺陷，非本次引入。

## 3. 根因（first divergence，R2 定证）

双 seam，均已定证：

- **INV-1**（测试时序契约，R1 已修）：`:1461-1463` 立帧捕获断言分帧收敛的滚动终态。已实施 waitForFrame 替换且生效（早期 2-expect 失败消失）。
- **INV-2**（生产不变量，R2 定证）：用户滚离后系统不得强制重贴底部。首个分歧 = `routes/session/index.tsx:575` `applySessionOpenScroll` 的无条件 `scroll.scrollTo(scroll.scrollHeight)`：它由 `:371`/`:581` 在 sync 完成后延迟 50ms 触发，当用户已滚动离开（或测试已按下滚动键）时丢弃用户位置强制贴底。
- 消除链（排除其它贴底源）：① stickyScroll 重贴被 `_hasManualScroll` 抑制（@opentui/core index.js:10591，`if (stickyStart && !this._hasManualScroll)`；字段 private，ScrollBox.d.ts:62）；② `:458` 强制前进要求 `wasStuckToBottom`，而 `renderAfter={syncSessionViewportStuckToBottom}`（:1322）每次渲染后运行，`lastMaxScrollTop` 无陈旧窗口——4 行滚离后 wasStuck=(max-4>=max-1)=false；③ v2 路由无 open 贴底（仅 stickyScroll，feature-plugins/system/session-v2.tsx:98）；④ :549 toBottom 由 prompt submit（:1473/:1481）与 session.undo（:798）触发、:995 由 END 键绑定触发，测试窗口内均未发生（R2 审计独立复核三处调用点）。唯一在窗口内可发射的贴底源即 :575。
- 生产可达性（非测试专用缺陷）：sync 完成可晚至秒级（慢网/大历史），用户在此期间滚回阅读 → 50ms 后被强制拉回底部，真实 UX 缺陷。
- 症状 vs 根因：afterDelta 断言失败（原 :1479）是症状；根因为 :575 无条件贴底对用户滚离状态的覆盖。
- **R4 定证修正（诊断证据见 §9）**：R2/R3 把窗口内贴底源归因于路径 A 的定时器是错的——初始 waitForFrame 的贴底来自 `stickyStart="bottom"` 的初始位置（无需任何定时器），两枚 50ms 定时器（路径 B mount 即调度 + 路径 A sync 完成调度）在快速宿主上均可跨过 presses 存活；真凶是**路径 B 的 mount 时刻发射**（DIAG 实测 fire 时 `respectUserScroll=false signal=false` 无条件贴底，随后 renderAfter 把 signal 翻回 true，路径 A 再贴底为 no-op）。路径 B 的 mount 发射不是用户导航，与路径 A 同属「内容就绪」类事件，却绕过了守卫。

## 4. Primary Path（R3：按调用者意图区分，单一权威路径，无 fallback）

B-01 定证：`viewportStuckToBottom` 是组件生命周期信号——`app.tsx:1089-1096` 单一 `<Match>` 渲染 `<Session />`，sessionID 变化不重挂组件，信号从 A 会话携带到 B（唯一 setter :460，sessionID 变化无重置）。直接用它守卫 :575 会把「B 会话内用户滚离」误判为「用户不想贴底打开 B」，回归 :553/:1289 文档化的切换贴底语义（INV-03/04）。

修复（owner：`applySessionOpenScroll` 调用链，按调用者意图参数化）：

```ts
// :556 与 :580 增加 intent 参数，默认保持现有打开语义
function applySessionOpenScroll(respectUserScroll = false) {
  ...reviewID 锚点分支（:558-572）不变...
  // residual / 普通打开：贴底（不是 try-anchor-then-other-algorithm 的 fallback）。
  // INV-05：路径 A（内容就绪补滚）不得覆盖用户已滚离的位置；路径 B（显式切换/
  // 打开导航）是导航意图，保持无条件贴底（INV-03/04 切换贴底语义不变）。
  if (respectUserScroll && !untrack(viewportStuckToBottom)) return
  scroll.scrollTo(scroll.scrollHeight)
}
function scheduleSessionOpenScroll(respectUserScroll = false) {
  setTimeout(() => applySessionOpenScroll(respectUserScroll), 50)
}
```

- :371（路径 A，sync 完成内容就绪）→ `scheduleSessionOpenScroll(true)`：同一会话内用户已滚离时不补贴底（修 INV-2，修红测）。
- :1293（路径 B，sessionID/reviewID 变化 = 显式打开导航）→ `scheduleSessionOpenScroll()`：保持无条件贴底。**R4：`on(..., { defer: true })` 跳过 mount 发射**——mount 不是导航，mount 后的贴底由 stickyStart 初始位置 + 路径 A（守卫）承担；dep 变化（真实导航）仍无条件。路径 B 导航发射不读信号，INV-03/04 切换贴底由构造保证不回归；会话切换时路径 A 亦重跑但其 guarded 跳过不影响路径 B 的贴底。
- 无 secondary/replacement path、无 fallback、无新增配置。R1 测试 seam（:1461 waitForFrame）保留。

## 5. File Plan / TDD / Verification（R3）

- 文件（2 个，≤4 ✓；生产 ~10 行 ≤600 ✓）：
  1. `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`（:556/:580 intent 参数 + :575 守卫 + :371 传 true + 路径 B `on(…, { defer: true })` + INV-05 中文注释 + 注释更新）
  2. `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`：
     - R1 已实施的 :1461 waitForFrame（保留）
     - fixture：`SessionHarness` 内加 RouteCapture 探针（RouteProvider 子组件，`useRoute()` 写入 holder），`run` 回调第三参暴露 route（向后兼容）；
     - 新增行为测试（B-01 要求的 INV-03/04 覆盖）：A 会话滚离后 `route.navigate` 切到 extraSessions 中的 B（高内容 + `B_TAIL`），`waitForFrame(B_TAIL 可见)` 证明路径 B 无条件贴底未被 A 的滚离状态抑制。
- Red→Green：§2 回路 R3 实施后仍 5/5 败于 afterDelta；加 defer 后（诊断实验）5/5 绿、切换测试 3/3 绿、整文件 89 测全绿（实验后已回退，正式实施后须重跑全部三组）。
- 回归：整文件 `bun test test/cli/cmd/tui/session-message-render.test.tsx`；session 打开贴底相关既有用例不得回退（含 review 锚点/切换贴底语义）；`bun run typecheck`（packages/opencode）exit 0。
- E/C：生产 E≈4 → C≥1（守卫处 INV-05 中文注释）；测试 R1 已计 E≈2/C=1，新行为测试 E≈4/C=1。

## 6. Risks / Rejected Speculation

- 风险：waitForFrame 谓词在滚动生效前的中间帧全部为 false（尾部仍可见）→ 持续等待至超时，无过早通过路径；谓词唯一通过态即滚动已生效。
- 拒绝：给生产 ScrollBox 加同步滚动开关（无缺陷证据，禁止）；改为多次 renderOnce 计数等待（仍是帧数契约，违反已发布信号纪律）；在本测试内 retry 断言（弱化断言）。
- Non-Goal：CI 其它历史 flake；daemon db-compress（已另案监控）。

## 7. Audit Contract

- 计划审计（Round 1，adversarial-auditor 独立重建全部引用后）：**No blocking findings — APPROVE**（R1）。非阻塞：N-01 根因机制停在收敛层级而非 stage 层级（修复原语 stage 无关，waitForFrame 5s 超时即抛）；N-02 同文件 :1423-1425 同模式立帧捕获为潜在 flake 观察项（该次 CI 绿，无证据不改）；N-03 保留 :1474-1476 既有 20ms 稳定窗（非失败 seam）。已排除的投机：ctrl+alt+y 不响应（绑定/meta 别名/同步 scrollBy 均已验证）；50ms scheduleSessionOpenScroll 重贴（时序与 maxScrollTopIncreased 条件均排除）；谓词空洞通过（唯一输入源 + :1479/:1485 双重约束）。
- 计划审计（Round 2，R2 revision，同 subagent 全量重审）：**BLOCK — B-01**（原文结论）：R2 用组件生命周期信号 `viewportStuckToBottom` 无差别守卫 :575，而 `app.tsx:1089-1096` 单一 Match 不重挂 Session、信号跨会话携带且 sessionID 变化无重置 → 用户在 A 滚离后切换 B 时，B 以任意陈旧偏移打开而非贴底，回归 :553/:1289 文档化切换贴底（INV-03/04）且无任何测试可拦截；修正方向：在 path-B owner seam 区分「会话打开意图」与「携带的组件状态」。非阻塞：N-01 注释不变量编号 INV-02 与 :553-554 既有 INV-02（review 锚点）冲突 → 新不变量改用 INV-05；N-02 §3④ 对 :549 触发源的错误归属（实为 prompt submit/session.undo，消除结论独立成立）；N-03 §8 行号 :1477→:1478；N-04 red→green 依赖 50ms 定时器落在 :1462 确认与 :1478 捕获之间——实施审计须在 Windows 本机 5/5 绿证据。已排除投机：culling 翻转重贴（`shouldCullSessionViewport` 恒 true）、ScrollBar 自动滚动/鼠标拖拽（无鼠标事件）、v2 干扰、滚动加速度过冲。
- 计划审计（Round 3，R3 revision，同 subagent 全量重审，独立重建 route/app/test/fixture/core 全部引用）：**No blocking findings — APPROVE**（R3）。非阻塞（实施阶段须落实）：N-01 新切换测试的判别几何必须在实施时显式保证——B 的可滚高度须超过携带偏移（A_max-4），否则携带 scrollTop 被 clamp 到 B 底部造成空洞通过（实施审计须验证 R2 型回归下该测试会变红）；N-02 守卫信号读存在残留亚帧竞态（pressKey 与首次 renderOnce 之间到期的 50ms 定时器读到陈旧 true → :1462 waitForFrame 超时表现）——R3 仅收窄不引入，实施审计以 Windows 本机 5/5 绿为控制；N-03 仓库级绿门在提交阶段以 CI run（至少全 `test/cli/cmd/tui` 套件）为证据；N-04 §8 首条现场行号 :1477 为 R2 期历史记录（现行捕获 :1477/断言 :1478），已由末尾增量注订正。已拒绝投机：路径 B 不发射而路径 A 发射（两者依赖集包含关系反证）；路径 B 定时器早于 B 内容渲染（与今日逐字节同语义非回归）；review 深链被路径 A 守卫降级（锚点分支前置且 reviewID 变化独立触发路径 B）；core sticky/:458 重贴（直接检验反证）；culling 翻转（未触及）。
- **R3 实施后验证失败（R4 诱因）**：red→green 未达成（5/5 仍败于 afterDelta，644ms 级非超时）。诊断（临时插桩，已全部回退）定证：窗口内双贴底来自路径 B mount 发射（无条件）+ 路径 A（signal 被 B 翻回 true 后 no-op）；R3 的「初始 waitForFrame 需定时器贴底才通过」前提错误（stickyStart 初始即贴底）。R3 内容保留（路径 A 守卫与 B-01 测试正确且必要），R4 增补路径 B defer。证据见 §9。
- 计划审计（Round 4，R4 revision，同 subagent 全量重审，独立重建 solid `on()` 语义/@opentui sticky 机制/全部贴底消费者/工作树卫生）：**No blocking findings — APPROVE**（R4）。非阻塞：N-01 §4/§5 行号漂移（路径 B 现行 :1296-1301、函数 :558/:586，可唯一定位）；N-02（承接 R3）路径 A 亚帧竞态残窗以实施审计 Windows 5/5 绿为控制；N-03 §5 预算行数高估（实际 ~5-7 可执行行，实施审计按实际 diff 重算 E/C）；N-04 §9 绿证据为已回退实验的 builder 证词，不作发布证据——实施审计须产出全新 5/5 red→green、切换测试、整文件、typecheck 四组证据。已拒绝投机：fresh mount 无法到底（stickyStart 布局期即钉底 :10176-10180 并跟随增长 :10596-10601 + 路径 A 守卫贴底）；review 深链 mount 丢锚（锚点分支前置，且路径 A 在 sync 数据可解析后锚定强于旧 mount+50ms 尝试；既有 review 测试均为 dep-change 导航）；切换测试失判别力（solid.js:470-476 defer 精确跳过首次、后续 dep 变化必调；B≈58 行 ≫ 携带偏移个位数）；sticky 重贴替代源（max-4 不满足 :10382 重贴带）；其它测试依赖 mount 期贴底（全仓 grep 仅 :1423/:1461/:1510 三处滚动断言，:1423 单行容忍带测试在 defer 下更安全）。核心定证独立复核：solid `on()` 无 defer 在 mount 即调 fn（solid.js:474）→ 路径 B mount+ε 调度无条件贴底 ~mount+50ms；stickyStart 无定时器提供初始贴底（:10591-10592）；快速宿主双定时器跨过 presses 存活——与 R3 仍红 + CI 慢宿主绿唯一相容机制。
- 实施审计：实施后同 subagent（Audit mode: implementation），red-green + 整文件回归 + typecheck 证据。
- R4 实施后验证（全_New 证据，非 §9 实验复用）：red-loop 5/5 exit 0；切换行为测试 3/3 exit 0；整文件 89 pass / 0 fail / 42.76s exit 0；`bun run typecheck` exit 0（其中发现并修复 RouteContext 需 type-only import 的 verbatimModuleSyntax 约束——审计内容的机械性拆分，无语义变化）。
- 实施审计（Audit mode: implementation，独立重跑全部证据）：**VERIFIED — APPROVE**。审计独立复现：red-loop 3/3、切换 2/2、整文件 89/0、typecheck 0，并加跑全 `test/cli/cmd/tui` 321 pass / 0 fail / 33 files（defer 变更的完整爆炸半径）。非阻塞：N-01 builder 计数为运行次数非测试数；N02 路径 A 亚帧竞态（计划内控制）；N-03 仓库级绿门在提交阶段 CI；N-04 routeHolder! 由构造保证安全。E/C 重算：生产 E=6 / C=8（≥100%，远超 15% 目标）；预算 3 路径 ≤4、生产 6 行 ≤600。提交阶段义务：CI run 绿门（R3-N-03）。

## 8. R2 增补：R1 实施后红点后移的真实现场证据（待 R2 审计）

- R1 谓词修复已生效：`:1461` 滚动离屏 waitForFrame 通过（不再 2-expect 早期失败），但同用例 5/5 转移至 afterDelta 否定断言（原 :1479，现 :1477）："Expected: false Received: true"，用时 436-914ms（非 5s 超时路径）。

- 新不变量 INV-2（被违反）：用户滚离后（viewportStuckToBottom=false）内容增长不得自动重贴底部（测试 :1477 注释 INV-04 后半的前半段）。

- 第二分歧嫌疑（R2 已定证并**排除**）：`syncSessionViewportStuckToBottom` 中 `wasStuckToBottom = scrollTop >= lastMaxScrollTop - 1` 的 lastMaxScrollTop 陈旧路径——`renderAfter={syncSessionViewportStuckToBottom}`（:1322）每次渲染后运行使 lastMaxScrollTop 无陈旧窗口，4 行滚离后 wasStuck=false，:458 不发射。消除链见 §3②；幸存贴底源为 :575。

- R1 已实施 seam（waitForFrame 替换）保留：与套件约定一致且独立正确；R2 在其基础上继续。当前限制不变：≤4 文件（已用 1）、生产 ≤600 行（已用 0）。

- R3 增量（B-01 采纳）：B-01 属于本任务范围内的正确性修复（守卫谓词语义错误），不扩大用户意图；采纳审计修正方向但实现取更强的「按调用者意图参数化」（路径 B 调用点保持不读信号、与今日逐字节同语义）而非「sessionID 变化时重置信号」——后者在重置后、50ms 定时器前仍会被 `renderAfter` 按携带几何重算覆盖，存在竞态残留。§8 现场行号订正 :1477→:1478（N-03）。

## 9. R4 诊断证据（临时插桩，已全部回退；zz-diag 临时副本已删除）

- 阶段帧 dump（zz-diag-copy，逐帧）：initial-pinned（OLD_CULL_TAIL 在底行，stickyStart 初始即贴底）→ scrolled-away（尾部离屏，thumb ▇ 约 78% 位）→ **+60ms 无 delta 即重新贴底**（OLD_CULL_TAIL 回到底行）→ delta 后 f2/f3 视口钉在新底部。重新贴底不依赖 delta。
- 生产插桩 DIAG（schedule 带调度点栈 / pin 带参数）：
  - `schedule respectUserScroll=false` ← `runComputation`（路径 B mount effect）；`schedule respectUserScroll=true` ← `:262 processTicksAndRejections`（路径 A sync 完成）。均在 initial-pinned 之前调度。
  - 两枚 pin 均在 scrolled-away 捕获之后发射：`pin respectUserScroll=false signal=false`（路径 B mount，无条件贴底=真凶）→ renderAfter 见底把 signal 翻 true → `pin respectUserScroll=true signal=true`（路径 A，no-op）。toBottom 与 :458 advance 全程未发射（无对应 DIAG）。
- defer 实验（临时加 `{ defer: true }` 后回退）：red-loop 5/5 绿、切换行为测试 3/3 绿、整文件 89 测全绿（exit 0）。
- 结论：时序模型修正为「快速宿主上两枚 50ms 定时器均跨过 presses 存活；CI 慢速宿主上定时器在 presses 前发射 → 绿」——与腿间漂移、57d1fe064 CI 绿、本机 5/5 确定性红全部相容。

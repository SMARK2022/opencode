# Canonical Implementation Plan: TUI 预览夹具等待真实挂载

> Status: verified
> Revision: R3
> Approved revision: R3
> Audit mode: full-scope
> Implementation allowed: no further material changes without revision or rework

基线：`dev1-smark@c6217876c2dd3733f3ec2ac041bb7e2ac07442c0`。拟与 #12 的测试稳定性范围合并审查；现行 #12 `d0d00522d85f5359c2fbda575de7948630a83f8b` 是既有对照。最终使用最新版原 Gate、一个可合并提交，不代合并。

## 1. Verbatim Requirement

本轮继续修复授权（用户逐字原文）：「我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。」

本轮平台要求（用户逐字原文）：「同时最新主线的test的macos要参与到CI修复」。因此 macOS 纳入同候选原 CI 验收；实际预览错误观测于 Windows，已有同候选 macOS 通过回执。


用户已就 CI 修复明确：「注意你的任务并不只是调整优化现有的逻辑的一些问题，你更要去结合你如上所提到的各种规则内容去分析、补充、调整、丰富、完整现在的既有的这套既有guard生态体系。」（原对话《分析Agent参与PR》）。同一仓库任务的后续要求：「说错了，不是跑pre commit是跑gate。」「不得修改gate」「相应的Git已经更新了，你可以把最新的内容去rebase一下。」「同时请注意，你的这几个PR都应该是单个Commit。」「要求最终验收的版本是能够被合并的版本，但你不需要去合并。」本项只覆盖原 Windows 必过测试的预览准备时序，原泄漏验收完整保留。用户在 #5 对范围的原话「不要大幅度地补各种各样的测试，我再说一遍」继续约束关联改动数量。

## 2. Explicit Non-Goals

生产、OpenTUI 包及补丁、公共 API、共享 `waitForFrame`、Gate、工作流、测试超时和锁均不改。零新增用例和计时器。不另改邻近 visible fixture 或删掉原后置清理检查。不处理 c91 历史滚动退化。

## 3. Repository Context

以 `AGENTS.md`、`CONTEXT.md`、`docs/guides/workflow.md`、canonical template 和 first-principles policy 为准。该用例拥有夹具启动时序，OpenTUI 拥有调度和提交，生产 provider 拥有异步读取和挂载。送审根已实际检出 c621：以 GitHub 已签名 payload 与签名还原提交对象并核对完整 SHA，以已验证 4555 对象叠加 GitHub Compare 的 22 个精确文件后像，逐 blob 核哈希和 mode，`git write-tree` 得到公开 tree `27005d00f2353ffcac2ca55368a5cb333aa445e5`；索引和全部跟踪文件已检出。此根历史为浅检出；提交原始两父节点可在原对象读取。范围相对 c621 为一个既有 TUI 测试文件及本 Plan；当前 #12 其余阶段与文件独立记账，合成时不得挤掉已批准路径。

## 4. Files and Evidence Read

| 来源 | 实际事实 |
| --- | --- |
| `packages/tui/test/routes/session/block-tool-preview-once.test.tsx:61–95` | c621/73d 原文件同 blob `c55ebc7f5fb4c8fe4c6d105ae7a148d3ddc85219`；测试真 `testRender`，初始化靠既有 100ms；等预览文字后验证可折叠、没有脱树预览和 root 销毁。 |
| `packages/tui/src/context/{helper.tsx,kv.tsx,theme.tsx}` | helper 在 init.ready 之前不挂载后代；KV 真 `Flock.withLock` 读取并在 finally 发布 ready；主题在自身异步工作后 ready。 |
| 锁定 `@opentui/{core,solid}` 的 test helper | `testRender` 返回后可能尚无下级 renderable；`waitForFrame` 等已有调度，在 idle 时可立即退出；错误记录的 20 是配置上限。 |
| [候选 Windows 原 job](https://github.com/SMARK2022/opencode/actions/runs/44954370939/job/136999122935) 与 [基线 Windows 原 job](https://github.com/SMARK2022/opencode/actions/runs/44954020649/job/136998014338) | 纯 c621 313.368ms 通过；候选 73d 的合并检出 7e5f9e8 在 106.439ms 零帧退出，尚未执行脱树断言。同候选 Linux/macOS 通过。 |

## 5. Current Behavior

夹具把等待渲染放在固定 100ms 之后。若 KV 或主题尚未 ready，Solid 没有挂载被测后代，真实 renderer 当前没有要画的内容。等待已有帧的 helper 看到 idle 即退出；它的含义与 provider 就绪不同。

正式 Stop 还捕获第二个独立故障：业务用例和原 root 销毁断言通过后，原 stock preload 在 afterAll 看见一个仍引用的 renderer 定时器。纯基线预览夹具与 R2 夹具均可触发。

## 6. Supported Input Domain and Reachability

现有真实 `testRender` 和相同 PreviewCard 树；KV 文件照旧，不绕开真实锁或主题初始化。文件系统调度可能使准备超过固定窗口。已用同一真实 KV 锁控制这条路径。Windows 生产日志未记录 provider，故该诊断证明现有夹具存在真实可达的早等错误，不将所有 Windows 失败绑定同一内部事件。

## 7. Required Invariants

- PVR-1：进入帧等待前，被测 BlockTool 已在真实 provider 树下挂载；提前或延后就绪时都一样。
- PVR-2：原等待真实文字与可折叠提示、排空延迟销毁后检查所有新增脱树对象、销毁 root 后检查均保持；后续 10×20ms 排空原样。
- PVR-3：零新增测试实例、计时器、重试、生产 API 或原 Gate 变化。
- PVR-4：最终 teardown 仍销毁原真实 root 且通过同一销毁断言；卸载产生的绘制请求不得在原资源检查中留下引用计时器。

## 8. First Divergence and Root Cause

最早的错误在测试第一次把已逝的 100ms 当作被测组件已挂载。真实锁 held 时，stock 和 #5 renderer 都为 idle、frameId/nativeFrameCount 为 0，并立即走原 waitForFrame 的错误路径；放开锁再看到首帧和原断言成功。这比改调度、延长 100ms 或令等待器为无工作 renderer 强画一帧更接近责任起点。

第二条路径的首个偏离发生在最终销毁：stock OpenTUI 按原实现递归删除 renderable，删除触发 `requestRender()`。实际完整栈指向 `destroy → finalizeDestroy → destroyRecursively → remove → requestRender → clock.setTimeout`；这个分支只设置 `updateScheduled`，不保留其计时器句柄。此前执行 idle 的红臂表明单独排空既有调度无法阻止卸载注册新的调度。

## 9. Responsibility and Seam

测试自身在现有实际 BlockTool 的本地包装组件用 Solid `onMount` 报告挂载；不需要生产导出 provider 状态或加通用测试 API。帧提交依旧由原 helper 观察。同一测试持有 renderer，退出时可走公开的 suspend 与 destroy；生产 renderer 如何调度仍由依赖负责。

## 10. Single Approved Primary-Path Design

同一个用例建立一个本地 `Promise.withResolvers<void>()`。现有 BlockTool JSX 原样移入测试私有 `PreviewContent`，由原 provider 树实际绘制；包装组件 `onMount` 解析 promise，不创建额外 renderable，不把回调塞进可能被丢弃的 preview 子树。以 `await ready.promise` 取代首帧前 100ms，随后原 `waitForFrame` 和所有原断言原样执行。挂载与帧各自验证，没挂载或没有真实帧仍使原测试失败。沿用 Bun 原测试超时。

正常渲染、文字提示、原排空及脱树检查后，只在现有 finally 内调用公开 `app.renderer.suspend()`，紧接原 `app.renderer.destroy()`。suspend 同步进入 explicit_suspended，依赖的 requestRender 在此状态直接返回；这是关闭产生新工作的入口。原 destroy 仍实际发出销毁事件、递归销毁根、释放 native renderer；原 `root.isDestroyed` 断言和原 `engine.detach()` 保持原顺序。这同时覆盖用例断言失败时已有的 finally，没有额外等待、私有句柄、配置或测试实例。

## 11. Secondary and Replacement Path Inventory

只有真实 provider → 被测组件挂载 → 真实帧 → 原泄漏断言一条成功路径。隔离锁、输出和第二个私有测试副本只作证据，不入 Git；诊断生产表面 0；无备用成功路径。

## 12. Workaround Deletion and Replacement

删除首帧前独立 100ms 等待。保留之后原 10 次排空及所有真实对象检查；因果与启动准备不同。

## 13. Forward Traceability

| Invariant | Owner/path | File/test |
| --- | --- | --- |
| PVR-1 | 实际 provider 子组件生命周期 → test-owned promise → 原 waitForFrame | 同一原文件；真实锁持有/释放对照 |
| PVR-2 | Frame 与 renderable 树、finally 关闭 | 同一原用例的原断言，保留脱树泄漏判据 |
| PVR-3 | 唯一测试夹具变更 | 原 TUI、静态、正式 Windows 和 macOS job；对照差分与 Gate |
| PVR-4 | test renderer 退出：suspend → 原 destroy → 原销毁断言 → 原 detach | 同一原用例，原 leak-preload 与完整 Stop |

## 14. Reverse Traceability

| 概念 | 依据及复用 |
| --- | --- |
| test-only 挂载 promise | PVR-1；原 waitForFrame 等的是 renderer 活动，读不到 Solid 后代尚未挂载；现成 onMount 可复用。 |
| 局部透明 PreviewContent | PVR-1/2；信号必须位于两个 provider 之下和被测 preview 子树之外；不加共享状态或真实 renderable。 |
| finally 中先暂停渲染 | PVR-4；原 destroy 的递归删树会请求新帧，复用公开 suspend 关闭帧申请，原 destroy 继续承担释放。 |

## 15. File-Level Change Plan

`packages/tui/test/routes/session/block-tool-preview-once.test.tsx`：只改测试私有组件、import、原等待点与原 finally；保持 preview/body 的内容、属性、Provider 树与三条业务/资源断言。另加本 Plan。职责说明见 §17。移动原 JSX 不增加功能。

## 16. TDD Behavior Slices

1. 红：原 waitForFrame 在实际 KV 锁仍占用时报告 frame0/idle；释放后原断言继续通过。固定等多久都无法证明 ready。
2. 绿：被测叶组件在锁持有时尚未发布 ready；释放后挂载通知加入等待，原 waitForFrame 仍要求真实预览文字，原泄漏/销毁断言成功。
3. 生命周期红绿：原 c621 与 R2 夹具以原 preload 暴露 teardown 计时器；R2 + 仅在既有 finally 先 suspend 后原 destroy，同一检查清零且原测试三条断言通过。idle-only 仍红。
4. 普通回归：无锁干扰时同一个 fixture 直接通过，不加 timer 或 sleep。锁和全栈对照只在仓外，不增正式用例。

## 17. Comments

在原等待点解释帧 helper 不等待异步 provider；在挂载通知附近说明不能把信号放进可能被弃用的预览子树。两处各记录一个独立约束，行为与原批准范围不变。在 finally 附近简短说明暂停为何先于 destroy：防止递归卸载时重新预约帧。保留现有其它注释。按实际 diff 计算有效 E/C，纯 JSX 移动不计。

## 18. Verification

- **本轮可重放三臂。** 私有证据目录 `evidence/R2-SHA256SUMS`（SHA-256 `54100f6fa3b6bbe0e4c9c2046581778e39dfce38c15424aa9e34fcd8c6f9f673`）分别保存原始 Git blob c55ebc7f…、与原字节逐一对照的 `red-held.diff`、`green-ordinary.diff`、`green-held.diff`、各自只读执行用源码及日志、原退出和已经加载的本地 renderer/native 摘要。三者各自用唯一文件名，不覆盖旧回执。
- **实际命令和判据。** 以 `evidence/proj` 为工作目录（`src` 指向准确 c621 检出的 `packages/tui/src`），Linux Bun 1.4.4、私有 HOME/TMPDIR、仅环回，用原 Bun test runner 分别执行 `bun test test/routes/session/{red-held,green-ordinary,green-held}.test.tsx`；每个文件独立进程。红臂保留原 100ms 和原 helper，只在诊断内先持有同名真实 KV 锁，在 finally 释放；原具名用例 117.02ms、frameId=0、退出 1。普通绿 267.45ms、原三断言、退出 0；真锁绿 368.06ms、五断言（两条只用于证明锁持有阶段），退出 0。真锁绿释放前没有 frame、ready 或 pending；挂载信号解析后原等待器面对真实 pending，原泄漏与销毁检查通过。未在正式工作树新增用例。
- **来源校验。** 审计根运行 `git rev-parse HEAD HEAD^{tree}` 和 `git hash-object packages/tui/test/routes/session/block-tool-preview-once.test.tsx` 应分别得到 c621、27005d00 和 c55ebc7f；从相邻证据目录运行 `sha256sum -c R2-SHA256SUMS` 可核对三臂、未改原件和差分。历史 R1 的旧 readiness 清单曾引用后续覆盖的同名草稿，原文件和原清单保留，不补写或作为 R2 证据。以下 R1 的不同 renderer 对照只保留交叉验证用途：
- 实测原名、原生产树、真 KV 锁：renderer 两臂 held 都为 frame0、idle、无 scheduled，原 waitForFrame 拒绝；release 后 native/frameId 均为 1，原整条测试均通过。证据 SHA-256 `f73ce62182cbf81af35453934999890ab9583f5561c2ceb1d2d953f2089ca062`。
- 实测独立挂载路线：私有复制相同测试，用实际叶组件 `onMount` 替代 100ms。stock 214.74ms、#5 217.46ms 通过；真锁诊断两臂 362.57/322.28ms 通过，ready 前没有 frame 或待处理、ready 后都有待处理，最终原测试及资源条件通过（每臂两例八断言，shell exit0）。证据 SHA-256 `605b8de3043262ab378fad9a6f24342074b9d8165d5bd7133d6a45c3f8c883e6`。使用校验过的本地 Linux Bun 1.4.4、同一 native library 与两已验证 chunk；Linux 与受控锁都不充当 Windows 结果。
- 实施后从 `packages/tui` 跑 `bun test test/routes/session/block-tool-preview-once.test.tsx`，再跑固定原计划选出的 TUI 回归和包型检。原普通 Windows 必过 TUI 模式必须运行同一候选、同一用例，保留名称、退出及 JUnit；Linux/macOS 同候选照原规则，其中 macOS 是本轮用户明确要求。正式单提交还执行当前原 Gate、所需预检与空目录恢复。
- 已公布 #5 当前同一候选完整滚动九场景均通过；历史 c91 滚动红作为不同基线历史，不用本测试改动解释或消除。

- **R3 原泄漏检查。** 完整合成十路径的原 Stop 退出 1；Core 25、OpenCode 82 个业务用例通过，TUI 1 个业务用例通过，原 afterAll 报 `setTimeout(14.489598666666705)`。同一原 preload 单跑基线原夹具和 R2，均为 1 business pass / 1 afterAll fail。R2 隔离同命令红 14.669ms；仅加 idle 红 14.925ms；仅加 suspend 绿自然退出 0，1 pass / 0 fail / 3 个原断言。私有仅保留完整栈的诊断文本确认在 destroy 同步递归而不是原 20ms 等待中注册；红/绿验收仍用原 preload。相邻 `../evidence/R3-SHA256SUMS`（SHA-256 `1dbdb08b1c5d1e785b53f69e6cc9f29e3ee5a0cdeb2dd172b2bc86a16b200548`）保存原 c621 文件、合成 receipt、红绿实际源码及唯一一行差分、退出、实际命令、原 preload 与 dependency digest；`suspend-only.diff` 只用于证据。
- **实施新增正式检查。** 基于 HEAD 重放全文批准路径后，用原 TUI preload 原样复跑此用例；再跑原定回归、型检、同一最终合成提交的真实 Windows/macOS、完整 stock Stop/Gate 与空目录恢复。

## 19. Diff Budget

一个原测试文件和一个 Plan；生产净变更 0、用例净增 0、计时器净增 -1。预计有效代码约 11 行，另有纯移动；实施报告实际 E/C 及原 Guard 尺寸。

## 20. Real Risks and Open Decisions

Windows 需完成当前真实验证。生产 renderer 真遇到已收到却消失的帧仍应按原测试失败；计划只消除把未挂载当成帧丢失的路径。

## 21. Audit Contract

提交完整需求、此 Plan、真实 c621 及当前 #12 工作范围给独立审计。精确通过才能实施；实际差分与 Windows、macOS 及原 Gate 各自核验。合并由用户决定。

## 22. Revision Delta and Plan Audit Record

R1 BLOCK（B-01、B-02）；原独立判词下附。R2 补齐用户逐字原话、真实 c621 Git 根与新三臂收据，保持同一唯一功能与测试范围、无生产、无备用路径；R2 两轮批准原文下附；R3 将新观察的同一夹具最终卸载行为加入当前 c621 → 完整目标方案，已获全范围独立方案批准，原文下附。

## 23. Implementation Evidence

历史 R2 实际目标仅现有预览夹具和本 Plan。基线 c6217876 / tree 27005d00；夹具原 blob c55ebc7f，目标 blob `e7e41972430f48c8306da1528e2802300c0ffccb`。原测试名与三个断言保持；新增正式测试实例为零，删去一个首帧前等待，不改变原后续十次排空、夹具 provider、原 OpenTUI、功能或 Gate。

同一行为先按 §18 的真实锁诊断红（原用例 frame0、退出 1），普通和持锁挂载等待分别绿；诊断副本只保留在仓外。真正差分在 `packages/tui` 的原用例单文件运行 1 通过、3 断言、退出 0。真正最终源码带两条有效中文注释，在原预览、可见与收折三文件回归 11 通过、41 断言、零失败、退出 0；原 `bun run typecheck` 调用 `tsgo --noEmit`，退出 0、无类型诊断（最后一次编辑只补一条不参与类型的中文注释）。日志、命令、工作目录、时间、实际退出和最终夹具 blob 列于 `TESTS-SHA256SUMS`，索引 SHA-256 `d9908b22d606ca7e1bf0bb1157f0c9c7b009a675b97c20a04e43b9a48b904cd9`。原 Windows、macOS 和原 Gate 必须在最终单提交核验，当前本地回执不代替。

夹具 Git raw +24/-15。新增中去除仅 import 1、空行 1、原样搬入新局部组件的 JSX 与已有注释 10 行、两个新增解释性注释，得 E=10，C=2；两条分别解释弃用预览子树不拥有挂载信号，以及帧等待不拥有异步 provider 就绪，达到用户门槛 max(1,ceil(10×0.15))=2。工作树其他 tracked 文件未变，`git diff --check` 通过。

R3 在 c621 上将 R2 挂载路径与公共退出操作完整重放；同一夹具 blob `bbeb938cd506ad5d8e02c979a4736a711d25f948`，原 preload blob `b000b0bfec035161a3df2d32f951daf33bd0da70`。红证据沿用 §18 的原基线和 R2 真实注册/原 gate afterAll 红；实际夹具在 `packages/tui` 同一具名用例 1/0、三个原断言，原 stock preload 同一用例 1/0、三个原断言、进程退出 0。原三个文件 11/0、41 断言、退出 0。原 `bun run typecheck` 首次 `tsgo --noEmit` 进程收到 SIGKILL，未输出类型诊断；只限制 Go 工作线程和软内存后，同一命令与范围自然退出 0。这两轮分别留存。独立记录工作目录、完整参数、资源环境、时间、退出和输出见 `TESTS-SHA256SUMS`，SHA-256 `6d8d543fc27ee30f021a1f1a84ebc0be229b05054a4e502b19fe618ff8841024`。实际 raw +26/-15；在 R2 的 E=10/C=2 上仅增加一个真实调用和一条说明，E=11/C=3，要求 C≥2。原固定首帧等待删除，原 10×20ms pre-assertion 排空、三个判据及真实销毁保持；备用成功路径零。最终合成的原 Stop/Gate、Windows、macOS 和空目录恢复仍待合成候选验证。

## 24. Implementation Audit Record

历史 R2 独立实现审计批准本地精确实现，原差分与下列原文留存。R3 方案已经独立批准；本次冻结实际差分已获独立实现批准，本地验证通过，裁决原文下附。正式跨平台验收、原 Gate 及空目录恢复等待最终合成单提交；该提交的合并就绪状态单独核验。

## R1 独立方案审计原文

## Blocking findings

### B-01 §1 缺少本轮用户原话

- Violated invariant: Canonical Plan §1 必须逐字保留本轮需求。
- Evidence class: contracted
- Producer and execution path: 用户要求 → §1 → 测试修复范围与后续验收。
- Canonical-plan evidence: §1 引用了历史指令，未收录「我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。」
- Responsibility owner: Canonical Plan。
- Concrete behavioral consequence: 单独重放本方案时，会丢失 #11 已合入及继续解决既有红测的授权背景。
- Minimal correction direction: 将原话逐字补进 §1，并保留本 Plan 仅处理预览夹具红测的范围说明。

### B-02 送审目录缺实际基线源码，原红测夹具校验失败

- Violated invariant: §4、§18 的基线与红绿反馈须可独立核验。
- Evidence class: observed
- Producer and execution path: `c6217876…` 的原测试 → 隔离红绿 → 方案批准。
- Source evidence: 送审 `repo` 只有 `docs/`，没有 Git 对象、待改测试或仓库审计政策；`READY-SHA256SUMS` 中的 `preview-ready.test.tsx` 校验失败。绿组清单通过。
- Canonical-plan evidence: §4、§8、§16、§18。
- Responsibility owner: 方案取证与审计交接。
- Concrete behavioral consequence: 无法从送审基线核对原测试、原断言和实际 owner；红组日志可读，但当前目录的夹具字节无法重放对应实验。
- Minimal correction direction: 提供能读取 `c6217876…` 的真实仓库根，以及与红组清单相符的夹具快照或同口径重跑收据。

## Non-blocking findings

无。

## Follow-up

正式候选仍须在真实 Windows 原 TUI 分片通过，并保留同一用例、退出与 JUnit。

## Rejected speculation

现有日志支持检查挂载等待。无需先延长固定等待、改共享帧助手或改生产渲染器。

## Requirement and traceability coverage

绿组日志支持挂载信号与真实帧两项独立验证；完整范围和基线核对仍受 B-01、B-02 阻断。

## Primary-path and fallback verdict

拟议路径为真实 provider → 测试组件挂载 → 原帧等待 → 原资源断言。方案未引入备用成功路径。

## Release verdict

**BLOCK**。适用于 R1 Plan SHA-256 `591321a7e5f0b766ab00c1c1a9c7452562cfc2262318cb87e22a567c51693d50`。

## R2 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§13 的 PVR-3 和 §21 仍只点名 Windows。§1、§18 已明确将 macOS 纳入同候选正式验收，记录本轮裁决时可同步这两处。

## Follow-up

实施后跑原用例、TUI 回归与型检，再用同一候选核对 Windows 和 macOS 原 CI、原 Gate 及 JUnit。诊断锁和日志只留在隔离证据中。

## Rejected speculation

真实锁对照证明原夹具可在 provider 未挂载时进入帧等待。现有证据支持修正夹具时序，无需延长等待、修改共享帧助手或改生产 renderer。

## Requirement and traceability coverage

R1 的 B-01、B-02 均已关闭。§1 逐字保留两条当前指令；独立核对了基线 `c6217876…`、树 `27005d00…`、原 fixture blob `c55ebc7f…` 以及三臂完整清单。真实 KV 锁下，原等待在零帧退出 1；挂载信号方案在普通和真锁条件下均退出 0，保留原预览和资源断言。

## Primary-path and fallback verdict

真实 provider → 原组件挂载 → 原帧等待 → 原资源断言。没有新增测试、计时器或备用成功路径。

## Release verdict

**APPROVE**。仅批准 R2 方案，SHA-256 `1fdfcb9e02ce962ac91ff0364225f9f04f92486bbef710be3a1ab07943e9439c`。

## R2 独立实现审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

最终合成单提交按 §18 跑原 Gate、Windows 原预览用例和 macOS 正式 Test，核验远端准确候选与空目录恢复后再判合并就绪。

## Rejected speculation

已有排空 10×20ms 对应 renderer 的延迟销毁；它与 provider 挂载分属不同阶段，保留原检查，无需扩展到共享帧 helper 或邻近用例。

## Requirement and traceability coverage

准确基线 c621/tree 27005d00、获批 R2 原件和全部两条实际文件路径均已核对。独立核验三臂清单及日志：真实 KV 锁下原夹具 frameId=0、0/1；普通与持锁挂载等待分别 1/0，保留真实文字、脱树与 root 销毁原判据。实际实现原测试 1/0、3 断言；最终三文件回归 11/0、41 断言；包型检退出 0。macOS 已明确列入正式验收。

## Primary-path and fallback verdict

同一 provider 树挂载 BlockTool 后，由本地 onMount 给出真实挂载信号；原 waitForFrame 继续检查实际绘制，原泄漏和清理断言仍在同一成功路径。无备用路径、生产接线、增测或计时器。

## Code quality verdict

有效改动仅替换原固定等待并引入测试私有透明包装；原 JSX、Provider、断言和后置清理保持。两条中文注释分别说明挂载信号归属和帧 helper 的职责，原索引差分 `git diff --cached --check` 通过。

## Release verdict

**APPROVE**

批准 R2 精确实现差分 SHA-256 `94e47fe17b09329a1b21ff4a4efb43837b6b5e369d2eb2b3e5a524676e9f5884`。正式跨平台与 Gate 回执仍由最终合成单提交提供。

## R3 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§15 的「两处职责说明」可改为引用 §17，避免与 R3 新增的第三条 teardown 注释计数不一致。属于记录修正。

## Follow-up

按 §18 在实际 R3 差分上跑原具名用例、原 stock preload、三文件回归及包型检，再交独立实现审计；最终同一合成候选跑原 Stop/Gate、Windows 和 macOS。

## Rejected speculation

无需修改 OpenTUI、加入新计时器或扩大到邻近夹具。单独等 idle 的实验仍留下定时器；它无法阻止销毁时递归删树新申请绘制。

## Requirement and traceability coverage

核对 c621/tree 27005d00、基线用例 c55ebc7、原 preload b000b0b、R3 收据清单及 OpenTUI 依赖哈希。正式 Stop 的 TUI 业务断言通过后，原 afterAll 报一个约 14.49ms 的活动定时器；精确基线与 R2 工件均复现。全栈定位于 destroy 递归删树，R2 原臂和仅等 idle 臂继续红；只增加公开 suspend 的同一具名用例通过原 preload，保留 3 个原断言。R2 的真实挂载路径及 macOS 正式验收要求延续。

## Primary-path and fallback verdict

挂载与首帧沿 R2 单一路径。关闭阶段复用测试所持 renderer 的公开 suspend，同步禁止继续申请帧，然后由原 destroy 销毁真实 root，保留 isDestroyed 和 detach。仅一条关闭路径，无备用、掩盖或 Gate 改动。

## Release verdict

**APPROVE**

批准精确 R3 方案 SHA-256 `0d3bd1b67f0f420a5440c93479f3419e3749864f2f09964b06f0a6f94879df7b`。本裁决只放行方案阶段。

## R3 独立实现审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§22 末尾仍写 R3「待全范围独立方案审计」，与下附批准原文和 §24 不一致。登记本轮裁决时把该处改为已批准，属于记录修正。

## Follow-up

最终合成单提交核验原 Stop/Gate、Windows 具名预览、macOS 正式 Test 与空目录恢复，再判合并就绪。

## Rejected speculation

未改 OpenTUI 或邻近夹具。仅等闲置的红臂仍残留定时器；这是销毁提出新绘制请求，继续排空既有请求不能修它。

## Requirement and traceability coverage

核对 c621/tree 27005d00、获批 R3 原件、实际两路径和独立索引的精确 tree `abe872b0d26fbccd9d526556644af3b0230df544`。真实锁原夹具零帧；原卸载在 stock afterAll 留下计时器。实际精确预览源码普通及原 preload 均 1/0、3 断言，三文件 11/0、41 断言。TUI 原型检首次 SIGKILL；仅限制 Go 线程/软内存后同命令退出 0。macOS 仍列入最终正式验收。

## Primary-path and fallback verdict

保持真实挂载、真实首帧、原脱树与 root 销毁判据。测试所持 renderer 在原 finally 先走公开 suspend 阻止新帧申请，再由原 destroy 销毁实际 root，随后保留断言和 detach。无替代成功路径、无新增计时器和 Gate 改动。

## Code quality verdict

全部 hunk 只涉及一个既有测试和该 Plan，原 JSX 与排空检查保持。新增中文注释分别解释挂载归属、帧等待职责和销毁顺序；独立索引 `git diff --cached --check` 通过。

## Release verdict

**APPROVE**

批准 R3 精确实现差分 SHA-256 `ca49e9fb5c49fcf1087fcf836ec4eec656b0a5c742e442fbd745299a0752e4d0`。正式平台和 Gate 回执仍由最终合成单提交提供。

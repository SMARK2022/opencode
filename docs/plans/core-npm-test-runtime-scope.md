# Canonical Implementation Plan: Core npm 配置测试的运行时作用域

> Status: implementation-audit-required
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: §1 用户原文
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-22

原需求和发布基线均为合入 #11 后的 `4555c21eb8615e15eb88d746df89f9ac9538898c`，树 `2fc8aaec8b46395df037ef6212d9ae6a41b87243`。本文件是从该 HEAD 到本次测试修复终态的唯一方案。交付在已授权的原 PR 或测试修复 PR，由负责人核定载体；不合并。

## 1. Verbatim Requirement

本会话用户在合入 #11 后要求：

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。

随后补充：

> 你可以去检查一下对应的静态问题，然后保持最小修改。

本 Plan 处理已独立定位的 Core npm 原测试 1000ms 后置检查红测；其他红测各沿其所有者另行处理。

## 2. Explicit Non-Goals

不改 Gate、Guard、get、预加载器、计时器、日志、依赖、npm 生产入口和基线已有的 Node 兼容用例。不新增、跳过或削弱任何测试，不改变 npm 安装、代理、配置、重试、缓存、锁或包加载行为。不把 Core 的独立 600 秒超时或其他文件的残留合并入本修复。

## 3. Repository Context

| 来源 | 约束 |
| --- | --- |
| `docs/guides/workflow.md`、`.opencode/templates/canonical-plan.md`、第一性原则 policy | 先独立审本方案，用真实原测试作红绿，实际实施后独立复审。 |
| 根 `AGENTS.md` | 测试必须运行真实实现，从工作区包目录执行。Core 与目标测试路径无附加 AGENTS。 |
| `CONTEXT.md` | Effect 环境由宿主拥有并释放资源；进程便捷入口与显式作用域服务是不同宿主入口。 |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 针对 issue 分派，不改变本测试的运行时与退出合同。 |

## 4. Files and Evidence Read

| 证据 | 作用 | 分类 |
| --- | --- | --- |
| `packages/core/test/npm.test.ts:23–24,41–61,63–139,143–165` | 现成 npmLayer、真实作用域路径、Node 兼容及现有省略 dev 依赖验收。 | observed |
| `packages/core/src/npm.ts:89–125,151–201,276–288`、`src/npm-config.ts`、`src/util/effect-flock.ts` | 三种安装入口最终共用 real reify、项目 .npmrc 与锁。 | contracted |
| `packages/core/src/effect/{runtime,memo-map}.ts`、`src/observability.ts`、`src/observability/logging.ts:55–60,77`、锁定 Effect 的 `dist/Logger.js:629–640,1058–1061` | 便捷入口懒建运行时；日志文件批次的 1 秒睡眠在 logger scope 结束时中断。 | reachable |
| `script/guard/leak-preload.ts:20–39,58–69` 与正式 #5 Core 原件 `14718142473.zip` | 宿主全量 161 文件中，afterAll 报 1000ms 当前引用；高精度日志仍保留原始结果。 | observed |
| `core-1s-npm-named.zLEy3w`、`core-1s-npm-scoped.h3BiMw` | 具名用例独立红测及仅替换调用者的双臂。 | observed |

## 5. Current Behavior

原用例把本地 prod/dev 两个真实包和 `omit=dev` 写入私有项目，调用 `Npm.install(tmp.path)`。该模块级 Promise 包装经 Core `makeRuntime` 和全局 Layer memo map 懒建进程运行时，随之打开 `Observability.layer` 的日志文件。真实 `Npm.Service.install` 检查项目、持有安装锁、读项目配置并调用 Arborist；prod 包存在，dev 包不存在。安装函数自己的 scope 关闭，但测试并不拥有进程级 runtime，因而不能关闭其日志批次。原 Guard 在全轮结束看到一个仍有引用的 1000ms timeout。

## 6. Supported Input Domain and Reachability

| 输入 | 生产者 | 保证 | 路径和所有者 | 分类 |
| --- | --- | --- | --- | --- |
| 项目根下 `omit=dev` 和两个 `file:` 本地包 | 现有用例夹具 | 真实文件系统和 npm 配置；无远端包 | Npm.install → Npm.Service.install → NpmConfig/Arborist | observed |
| 整个测试进程的套件级 afterAll | Bun 原 preload | 同一进程判定有引用 timer；不读取其他进程 | 测试拥有 scoped 服务；原 Guard 观察，不负责释放 | contracted |
| Node 入口兼容 | 既有真实 Node 子进程 | 运行 Node 导入真实打包源码、验证 file URL | Node fixture 保持原入口 | observed |

## 7. Required Invariants

| ID | 行为 | 既有验收 |
| --- | --- | --- |
| NPM-01 | 项目 .npmrc 只省略 dev 依赖；prod 仍真实落盘。 | 原用例的两条文件系统断言均保留。 |
| NPM-02 | 单个 npm 配置用例不创建超出测试生命周期的运行时资源。 | 未修改的原 preload 结尾零该用例额外计时器、自然 exit 0。 |
| NPM-03 | 不影响真实 cache reify 与 Node file URL；生产逻辑、Guard 不变。 | 完整 `test/npm.test.ts` 加受影响包原门禁；实际 diff 文件白名单。 |

## 8. First Divergence and Root Cause

| 阶段 | 真实路径 | 判断 |
| --- | --- | --- |
| 起点 | 测试第 161 行用进程级 Promise 入口执行单用例业务。 | 该测试需要真实 npm 服务，不需要进程运行时；它在这一点放弃自身对调用资源的所有权。 |
| 传播 | `npm.ts:276–280` 经 `effect/runtime.ts:5–20` 合并 Observability；`Logger.toFile` 默认 1000ms，batched 纤程仅随 logger 所在 scope 中断。 | 能走到真实 timer；项目文件断言与安装锁没有失败。 |
| 观察 | 具名原用例由 stock preload 报 `setTimeout(1000)`，无子进程，业务 1 pass，afterAll 1 fail，exit 1。 | 失败属于同进程测试，原 preload 不应更改。 |

正式复现入口（包目录）：`bun test --dots --preload ../../script/guard/leak-preload.ts test/npm.test.ts -t 'respects omit from project .npmrc'`。原用例在 byte-matched 诊断投影被隔离复现；额外 off-tree 观察仅记录 handle 与 Effect Clock 栈，不替代 stock 判定。最近双臂之一仅改调用入口，1.105 秒退出 1；另一方案臂 1.176 秒退出 0。两臂业务都通过。正式候选要在精确 4555 基础、原文件及无额外 trace 的环境重验。

## 9. Responsibility and Seam

| 职责 | 所有者 | 接口 |
| --- | --- | --- |
| 真安装、锁和包配置 | Npm 服务 | 使用同一个 `npm.install(tmp.path)`；不替换 npm 解析器或 Arborist。 |
| 配置测试运行时寿命 | 现有测试 | 复用同文件已有 `npmLayer`，把 install 效果提交给本用例的 scoped runner。 |
| 退出时判断资源残留 | 原 Guard preload | 原有 afterAll 与 exit 照常执行。 |
| 进程级日志与应用寿命 | 生产宿主 | 该 fixture 不定义宿主退出合同，本次保持现状。 |

## 10. Single Approved Primary-Path Design

仅在原 `respects omit from project .npmrc` 内，把 `await Npm.install(tmp.path)` 改为 `await Npm.Service.use(npm => npm.install(tmp.path)).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)`，按项目已有格式断行。现有 `Effect`、`path`、`npmLayer` 均复用，不增抽象。临时缓存随本测试目录销毁，fixture 仍读取同一个项目根的 .npmrc，并以两条原有文件断言结束。修复点在测试选择运行时的位置；既不等计时器自行到期，也不屏蔽宿主泄漏报告。

## 11. Secondary and Replacement Path Inventory

| 路径 | 分类 | 成功语义 | 处置 |
| --- | --- | --- | --- |
| scoped Npm.Service.install | 现有 primary seam | 同一真实安装 | 仅当前配置用例选用，100% 单路径。 |
| 模块级 Promise 包装、Node file URL fixture | 既有兼容 | 保持原约定 | 保留，不作为失败后的后备路径。 |
| 仓外 trace 与 A/B 投影 | 诊断 | 不交付 | 0% 产品决策面。 |

## 12. Workaround Deletion and Replacement

无生产 workaround。仅删去该测试对进程级便捷包装的调用并接回现有 scoped seam。禁止增加强制退出、等待、假计时器、全局 cleanup hook 或更改 logging。

## 13. Forward Traceability

| ID | 生产路径 | 改动 | 观察 |
| --- | --- | --- | --- |
| NPM-01 | Npm.Service → NpmConfig → Arborist | 仅切换测试的 Effect 运行时入口 | prod 存在、dev 不存在。 |
| NPM-02 | npmLayer → scoped host → 正常返回 | 同一调用执行于测试作用域 | 原具名测试配原 preload 自然退出 0。 |
| NPM-03 | 原真实文件、Node 与 Guard | 只有一个测试 hunk | 全文件五项及整体原门禁，路径核对。 |

## 14. Reverse Traceability

不新增生产概念。唯一测试改动映射 NPM-01/02：现有安装语义足用，原进程级调用无法由单用例释放；复用现有 npmLayer 足以绑定生命周期。没有新增断言、新缓存机制或协议变更。

## 15. File-Level Change Plan

| 文件 | 改动 | 职责与必要性 | 预计 |
| --- | --- | --- | --- |
| `packages/core/test/npm.test.ts` | 修改 | 把原安装调用绑定已有测试作用域；不改则原 afterAll 稳定复现 1 秒残留。保留原输入和原断言。 | 单 hunk，约 +5/-1 |
| 本 Plan | 新增 | 固定基线、实测、验证与审计记录。 | 文档，不含产品代码 |

## 16. TDD Behavior Slices

| 次序 | Red | Green | 回归 |
| --- | --- | --- | --- |
| 1 | 原第 161 行调用后，stock 全局 afterAll 报 1 秒资源，即使 prod/dev 文件断言已通过。 | 使用同一个 npm service 后，两断言通过，原 preload 退出 0。 | 原文件 5 实例，以及 Core 完整原测试矩阵；其他已知红测分开报告。 |

不为新路径补私有方法断言。独立期望来自原项目配置和 OS 实际存在性；资源事实由原 stock preload 判。

## 17. Comments

在唯一 hunk 旁加一句中文注释说明配置用例只拥有本地测试作用域，进程级包装会持有跨测试日志资源。不要重复断言或写任务历史。实施记录实际 E/C；本 hunk 一处有效注释，为预计 1–5 有效修改行提供覆盖。

## 18. Verification

| 命令 | 目录 | 证据 |
| --- | --- | --- |
| `bun test --dots --preload ../../script/guard/leak-preload.ts test/npm.test.ts -t 'respects omit from project .npmrc'` | packages/core | 原精确 4555 red：业务 1 pass，原 afterAll 1 fail、1000ms、无子进程；实施前确认。修改同一文件后 green：业务 1 pass，自然退出 0。 |
| `bun test --dots --preload ../../script/guard/leak-preload.ts test/npm.test.ts` | packages/core | 确保调用真正项目预装 Node；当前原 5 用例均通过、无失败或增加，保留两相邻真实安装/Node 兼容。 |
| `bun run typecheck --singleThreaded` | packages/core | 原类型检查。 |
| `bun script/guard/affected.ts . --files packages/core/test/npm.test.ts,docs/plans/core-npm-test-runtime-scope.md --json <独立临时文件>` | 仓库根 | 当前原选择器与受影响测试；运行原选集，不调整覆盖图或预加载。 |
| `git diff --check`、`git diff --name-status <基线>` | 仓库根 | 仅本 Plan 与目标测试，确认无探针，汇总 E/C。 |
| `GUARD_PREFLIGHT=required bun script/guard/gate.ts push --since 4555c21eb8615e15eb88d746df89f9ac9538898c --sha <实际候选单提交>` | 仓库根，按原发布合同 | 原 Guard、契约和所需平台。受独立历史红测影响则保留原结论及 owner，不改 Gate 或声称通过。 |

阶段 1 的隔离双臂见 `core-1s-npm-scoped.h3BiMw/{global,scoped}`，副本只差服务调用；同一锁 Bun 1.4.4，独立临时数据、网络隔离，本地真实依赖。原测试文件和相关生产路径与精确 Git 对象逐项相等：npm.ts `3e3409b…`、npm-config.ts `9c118fd…`、runtime.ts `6ad0f85…`、observability.ts `c5888f6…`、logging.ts `3910efd…`、npm.test.ts `b08f94c…`、leak-preload.ts `b000b0b…`。另有原具名测试双树报告 `core-1s-npm-named.zLEy3w`：配置两侧同红，reify 和 Node 两侧各 1 pass/exit 0。完整 Core 历史红仅用于诊断输入，不代替候选正式证据。独立实现审计后，按当前工作流核验单提交和持久载体，独立空目录确认补丁可重放。

## 19. Diff Budget

一处测试 hunk 加唯一 canonical Plan。生产与生成代码净增 0；测试实例净增 0，预计一个调用与一个有效邻近注释。精确 E/C 及文件清单在实施后汇报。无配置、Gate、时间参数改动。

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无。发布载体使用已授权范围；该 Plan 不授权独立的远端操作或合并。

### Follow-up

| 关注点 | 证据 | 本轮处置 |
| --- | --- | --- |
| 600000、60000、30000 ms 独立 Core 残留 | #5 正式全量另有原记录 | 独立 owner；不得用本补丁宣告整套 Core 绿。 |
| Node 子进程中的进程便捷运行时退出 | 既有测试显式 `process.exit(0)` | 该用例验证 Node 导入，不用于证明宿主自然退出；本轮不改。 |

### Rejected Speculation

锁心跳是 20000ms，Arborist 已配置 10000ms 下载，不能按数字归给这两个模块。无需改日志批处理常量、削弱工具覆盖、改造整个 Core runtime 或修改 stock afterAll。

## 21. Audit Contract

独立审计从原需求、精确基线、实际源码和原红绿复建，检查唯一测试 hunk 的必要性、真实安装/两原断言、同文件相邻用例、原 Guard 与风险边界。Plan 审计无阻断且 APPROVE 后方实施；实施再按精确实际 diff 独立审计。所有正式门禁达标后才可宣称可合并质量，由用户决定是否合并。

## 22. Revision Delta and Plan Audit Record

R1；首次送审，无先前修订或 verdict。
No blocking findings.

- **Coverage:** The A/B differs by one invocation. Both arms retain the real install and original filesystem assertions. The original call leaves a referenced 1000ms timer and exits 1; the scoped call exits 0 under the same leak check.
- **Primary path:** The fixture uses the existing scoped npm layer and the same `Service.install`. The Node compatibility fixture and production runtime stay unchanged.
- **Code quality:** One test hunk; no new test cases, fallback, timer, or Gate/get change.
- **Non-blocking:** §6 should describe the leak observation as suite-level `afterAll`. §5 and §8 already record the correct boundary.
- **Follow-up:** Re-run the original test and required Gate on the exact implementation. Track the separate Core timer failures independently.

**APPROVE**, exact R1 plan SHA-256 `d1f536b889a3670e9e302e3a9d2b074d7442b4410442562922a3adaace45c793`.

## 23. Implementation Evidence

实际改动仅为原 test/npm.test.ts 的 .npmrc 用例入口和本 Plan。真实本地包、配置、两条文件系统断言和原 Node 子进程用例均保留。单个测试 hunk +6/-1，仍为 5 个业务实例，0 新增。E=5（新增调用与 pipeline 分行），C=1（解释作用域及跨测试日志资源）；无纯格式、import 或生成改动。

精确 4555 树的 @opencode-ai/core 指向私有当前工作区，Bun 1.4.4、Node 24.22.3，各轮独立 HOME/XDG 且无网络。原 preload 无额外 trace：基线具名 1 业务通过，afterAll 报 1000ms、1 fail、自然 exit 1（1.240 秒）；候选具名 1 pass、0 fail、2 断言、自然 exit 0（1.081 秒）；候选整文件 5 pass、0 fail、10 断言、自然 exit 0（1.56 秒），含原 Node 用例。

原静态选择器对两路径只选 Core npm.test.ts；原 Gate stop 对同一选集执行规则与 5 个原测试并退出 0；原 Gate contracts 的 Schema、Protocol 均退出 0。包目录原 bun run typecheck --singleThreaded 退出 0。第一次无 .bin/tsgo 投影退出 127，连接同一安装的 CLI 后通过，未改代码或配置。

原始命令、工作目录、SHA、输出和退出码记录于 sibling stage3/{red,green,full,selector,guard,contracts,types}。当前未创建正式最终提交，未执行最终 Push Gate 或远端。Stop 和契约不代替 Push，当前局部结果也不宣告全 Core 通过；其他已知 Core 红测另记。当前未标记 verified。

## 24. Implementation Audit Record

独立实现审计原文（R1，全范围）。正式 Push Gate 与线上必过验收仍开放。

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

执行正式单提交的原 Push Gate，按同一候选 SHA 核对线上必过检查。整包其他红测继续单独归因。

## Rejected speculation

修复的是测试借用进程级运行时造成的资源残留。生产 `Npm.install` 和 Node 入口均保留，不需要改变生产日志或计时行为。

## Requirement and traceability coverage

核对了原方案、实际两路径差分和退出回执。精确基线的 `.npmrc` 业务断言通过，但原泄漏检查报告一个 1 秒句柄并退出 1。候选同例通过并退出 0；全文件 5 例、10 条断言通过。原静态选择器、Stop、Schema／Protocol 契约及 Core 类型检查均通过。生产依赖安装、开发依赖省略和原 Node 用例均保留。

## Primary-path and fallback verdict

测试复用本文件已有的私有 npm Layer，仍调用同一个 `Npm.Service.install`。安装行为和原断言不变；退出测试作用域时释放本次资源。无新计时器、等待、兜底或生产改动。

## Code quality verdict

仅一份 Plan 和一个现有测试中的单处改动。测试差分 `+6/-1`，测试实例净增 0。新增注释解释测试为何拥有本次作用域。

## Release verdict

**APPROVE**

批准精确 **R1 实现差分**，SHA-256 `69a05c76a8d542dc89eeb8a88f6261a8e4abe3a1712463662224546000bfdff3`，候选树 `48ef996f959dc47881ee1de298928c7d6ab26389`。本裁决通过独立实现审计；最终交付仍须完成原发布门禁。

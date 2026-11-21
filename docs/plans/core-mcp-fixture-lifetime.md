# Canonical Implementation Plan: Core MCP 测试夹具的挂起握手收尾

> Status: implementation-audit-required
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: §1 用户逐字需求
>
> Implementation allowed: no
>
> Last updated: 2026-11-22

原始固定 HEAD 为 dev1-smark `4555c21eb8615e15eb88d746df89f9ac9538898c`，Git tree `2fc8aaec8b46395df037ef6212d9ae6a41b87243`。目标 `verified-implementation-and-commit`：修复两条已确认的 Core 测试夹具收尾红灯，交付单提交独立 PR，保留项目原校验与实际受影响用例。合并由用户决定。

## 1. Verbatim Requirement

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。

> 你可以去检查一下对应的静态问题，然后保持最小修改。

这份 Plan 对应其中已经在最新基线复现、由同一文件的两条既有 MCP 夹具引起的红测；其余测试失败各自取证和归属。

## 2. Explicit Non-Goals

不改已合入的 #11、在途 #5/#8、生产 MCP、SDK、超时工具、Gate/get、CI、原 preload、计时预算、锁文件或依赖。不增用例、计时器、重试或成功兜底。未归因的 600000/1000ms 句柄不在本 PR。

## 3. Repository Context

| 来源 | 边界 |
| --- | --- |
| `docs/guides/workflow.md`、`.opencode/templates/canonical-plan.md` | 固定原始 HEAD，独立方案审计，实施后独立实现审计 |
| `.opencode/policy/first-principles-engineering.md`、仓库 `AGENTS.md` | 故障在 owner 处修复，测试走公开行为边界，保留规则和默认预算 |
| `CONTEXT.md`、`docs/adr/README.md` | 测试用真实 Location/App services；未发现改变 MCP 握手断开的适用 ADR |
| `packages/core/test/session-runner-tool-registry.test.ts` | 两条原用例分别验证部分连接被中断后重试、失败与成功作用域对 OAuth pending 的不同处理 |

## 4. Files and Evidence Read

| 证据 | 用途 | 分类 |
| --- | --- | --- |
| GitHub 原目标 `4555c21e`，从 `db5361b` 投影的六个 #11 路径 | 最新目标 tree 与已独立重放的 #11 tree 相同；Core、测试前置及锁没有差分 | observed |
| `packages/core/test/session-runner-tool-registry.test.ts:317–500`，基线 blob `50bacffef5aa806ccca1ee69fe3ae8d54091a5a4` | 两条替身 `connect` 各自创建永不结束的 Promise；用真实 Effect Scope 和真实 OAuth HTTP fixture | observed |
| `packages/core/src/mcp/connection.ts:221–236,489–566` | 原 acquire/use/release、ScopedCache、成功/失败 generation 的清理；基线 blob `ed4402a1a446657b2bb01ef07df7ce03e6ba7a1d` | contracted |
| `packages/core/src/util/timeout.ts:1–13`，blob `22f2648c92b530f0a8aa9e8bc1c8602eb79ab294` | 原输入 Promise 的 finally 清除 deadline；无需发明另一条计时路径 | observed |
| 锁定 MCP SDK `client/streamableHttp.js:280–287`、`client/sse.js:154–158`、`shared/protocol.js:217–227` | 关闭 transport 发布 onclose，正常 Protocol 接到关闭后结算 pending 请求 | contracted |
| `script/guard/leak-preload.ts:63–68`，blob `b000b0bfec035161a3df2d32f951daf33bd0da70` | 原 afterAll 只报告仍引用的 timers 和未退出子进程 | observed |
| §18 独立真红绿与试验负控 | 假握手生命周期对两条原泄漏的因果关系；保留 20 条原文件行为 | observed |

## 5. Current Behavior

两条测试在合成的握手中发布原 `hangingStarted`，随后返回永不会 settle 的 Promise。生产 `connectTransport` 为该 Promise 安装原 deadline；只有 Promise 结算时其 `finally` 才会释放 deadline。原业务断言都通过，但原 leak afterAll 仍看到 60000/30000 ms，无残留子进程。第一用例的真实 transport 关闭可用于驱动其替身；第二用例只验证失败 scope 与其他连接的 OAuth pending 隔离，没有把替身绑定到其已有场景 scope。

## 6. Supported Input Domain and Reachability

| 输入 | 路径 | Owner | 分类 |
| --- | --- | --- | --- |
| 第一用例第二个 MemoryClient 的初始化中断 | 真实生产 Effect 中断 → transport close → 替身 pending | 原 transport 关闭信号；替身持有自身 Promise | observed |
| 第二用例失败 generation 的直接 dispose | 原测试中断 `failed.status()` → 明确 `Scope.close(failedScope)` → OAuth pending 验证 | 原测试的失败 fixture scope；业务 scope 原有队列与连接清理不变 | observed |
| 真实生产 SDK 的独立关闭缺陷 | 第二个替身无真实 SDK connect，不能用它独立证明真实 transport 泄漏 | 本 PR 无生产改动 | 未验证，见 §20 |

## 7. Required Invariants

- INV-01：首个成功连接关闭一次，同代等待者收到原中断；只有重试时禁用挂起连接，重试后复用连接池。
- INV-02：失败 generation 的 dispose 不删除另一个连接的 OAuth pending；成功 generation dispose 仍关闭自己的连接并清除既有 pending。
- INV-03：两条替身不自己模拟提前成功；第一条只在其 transport 关闭后结束，第二条只在其原失败 fixture scope 收尾后结束。
- INV-04：全文件 20 条原业务测试与断言均保留；原 leak preload 为零残留，不改计时配置。

## 8. First Divergence and Root Cause

第一条在模拟 `Client.connect` 时丢掉 transport 参数并跳过 SDK 的 close→pending settlement。保留假握手直到实际 close、同时删掉永远 pending 后，单用例由 60000 ms 残留转绿。第二条 Promise 由测试私自创建，却未绑定它已持有的失败 Scope；仅把两条都挂到 transport.onclose 的对照仍残留 30000 ms。堆栈探针把该句柄定位于原 `connection.ts:232`，第二条只观测到替身开始 connect，没有在该假路径观测到 transport.onclose。将这条合成 Promise 交由失败 fixture scope 释放，保留失败/成功 OAuth 断言，原两条与全文件均绿。生产关闭是否另有问题需真实 SDK 路径证据，不从这个替身推断。

## 9. Responsibility and Seam

第一条替身复用原 `Client.connect` 入参的公开 `transport.onclose`；生产 acquire/release 决定关闭时点。第二条由明确由测试创建和关闭的 `failedScope` 注册最终释放，只结算其人工构造的 Promise，生产 generation/actions、真实 OAuth transport 和断言不动。

## 10. Single Approved Primary-Path Design

在第一个 MemoryClient 的挂起分支中保留原 async `connect`，用 `Promise.withResolvers<never>()` 取得待结算 Promise，先将实际 transport 的 `onclose` 绑定至其拒绝，再发布原 readiness 和返回该 Promise；其余 id 的真实 SDK/InMemoryTransport 不动。第二条在原 `failedScope` 增加该测试自己的 finalizer，以拒绝结束同一 `HangingClient` 用的待结算 Promise。在创建连接之前安装 finalizer，使 Scope 的逆序收尾先执行生产已登记的 finalizer；原 readiness、显式中断、关闭失败 scope、OAuth 成功/失败断言不变。既有 withTimeout 在 Promise 自然结算时清理 deadline；两条都没有主动清生产 timer。

## 11. Secondary and Replacement Path Inventory

第一条只有 transport close 一条结算路径；第二条只有其失败 scope finalizer 一条合成结算路径。真实连接和 OAuth 路径保持原样。堆栈探针、非目标负控及外层观察上限都是仓外实验工具，不进入提交。

## 12. Workaround Deletion and Replacement

删两个替身的 `new Promise<never>(() => {})`，保持可中断的 pending 语义，用各自已存在的 owner 信号终结它。去掉声称永久挂起的旧注释。原测试没有额外 sleep、timeout 捕获或成功替代分支。

## 13. Forward Traceability

| 需求 | Owner → 文件／入口 → 测试 |
| --- | --- |
| INV-01/03 | 真实 close → 原用例 MemoryClient → partial/retry 原测试，单例原 leak 检查 |
| INV-02/03 | 独立失败 scope → 原 OAuth-dispose 用例 → 原成功/失败行为与原 leak 检查 |
| INV-04 | 未改 preload／Core 原入口 → 原两例／全文件、Core 原正式 CI、适用 Gate |

## 14. Reverse Traceability

无新生产概念。第一条增加 close 绑定，因为替身跳过 SDK 的正常连接处理；第二条增加 scope finalizer，因为它持有的纯 JavaScript Promise 无原 Scope 所知的关闭关系，原 transport close 对照尚不足。两处拒绝代表 fixture 已关闭，未向生产增加异常类型、接口或接线。

## 15. File-Level Change Plan

| 文件 | 改动范围 |
| --- | --- |
| `packages/core/test/session-runner-tool-registry.test.ts` | 只改原两处替身的 pending/release 与相邻必要的中文注释 |
| `docs/plans/core-mcp-fixture-lifetime.md` | 唯一 canonical Plan、独立审计和回执 |

## 16. TDD Behavior Slices

1. 原 partial/retry 单例在 stock 检查后泄漏 60000 ms；只改变 MemoryClient，仍验证同代中断、先成功连接清理和池复用，withTimeout 退出。
2. 原 OAuth-dispose 单例泄漏 30000 ms；挂在 transport.onclose 后仍红。换测试私有 failedScope 的结算，原 OAuth 断言保留。
3. 两处并用后原 stock 双例和全文件自然退出，原 116 条业务断言全部保留。实施后在相邻 Core 验证和公开 CI 复验真实差分。

## 17. Comments

中文注释只解释 readiness 之前绑定 close 的顺序和第二条为何由已存在的失败 fixture Scope 结算，不在代码记录历史。实施时记录实际 E/C。

## 18. Verification

原命令从 `packages/core` 运行：

```bash
bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner-tool-registry.test.ts -t 'McpConnection (cleans partial clients and retries interrupted initialization|keeps failed dispose isolated from OAuth and clears it after success)'
bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner-tool-registry.test.ts
```

方案试验使用同一 Bun 1.4.4、锁定依赖、仅 loopback 的隔离 namespace、独立临时目录和原 preload。红臂使用原文件；绿臂仅换成同目录的私有试验副本，无外加 preload。精确 4555 树来自已验证的旧基线和 GitHub 明列的六个合入路径重放，与官方目标树一致；预备测试不依赖外网。

| 对照 | 真实行为 | 退出 | 日志 SHA-256 |
| --- | --- | --- | --- |
| 最新 HEAD 原两用例 | 2 pass，原 10 条业务断言通过，afterAll 另报 60000/30000 ms、无子进程 | 1 | `30265ea7f9cb95a6e10bc95bf91aea8fe34f96b4ebd5b366e9fda7b259149f25` |
| 两处最小隔离候选，原两用例 | 2 pass，10 断言，0 fail 无残留 | 0 | `a1a49f90ed6a1c8fe5c4dfe341835a3a1b3aa0d57fb938f5e609d7c9d9378cf2` |
| 同候选全文件，原 20 条 | 20 pass，116 断言，0 fail 无残留 | 0 | `1d09c19901d20b0f52d39145db7a471e5ced1554f6473d6828b0fc876aae4e34` |

试验脚本 SHA-256 `243f8139635769c3f72f16cd6308501e911d5b550f0b3d958dce8c2fb1fcf4fb`，候选试验副本 `1fa518ccc60216de283c29fe51633f4e79034cddc55b69b0e366489c900076a5`。实施后原文件须实跑上述两条、Core 原类型检查和适用现行 Gate ；线上按原 PR 的 Test、Guard、Typecheck 记录候选精确 SHA。正式提交前验证单提交、原 hook 和独立空目录恢复；不直接合并。

## 19. Diff Budget

一个现有测试文件和 Plan，零生产行为行、零测试净增、零 CI/保真度改动。测试 owner 增量仅私有 Promise 结算，不加外部文件或依赖。

## 20. Real Risks and Open Decisions

第二条替身路径中没有看到 transport.onclose，由 §18 独立诊断支持，属于还未确认归属的生产观察；它不撤销既有真实 OAuth 断言。若完整真实 SDK 对照暴露产品未关闭连接，应独立按其首个分歧立案，不在本测试 PR 改连接、timeout 或 Gate。保留其他未归因红测单独追踪。

## 21. Audit Contract

独立审计阅读完整固定基线到终态、两处不同 owner、原断言和 stock afterAll。R1 只有精确批准后可实施；实施后须审计实际测试差分及相邻真实路径。

## 22. Revision Delta and Plan Audit Record

| revision | 变化 | 状态 |
| --- | --- | --- |
| R1 | 首版：原两条夹具的 scope/transport 收尾，保留固定 HEAD 和完整实测 | 方案及实现独立审计已通过；§18 交付检查进行中 |

### R1 独立方案审计

## Blocking findings

No blocking findings.

## Non-blocking findings

§1 已收录修复现有测试红项的原话。补录同轮范围约束「你可以去检查一下对应的静态问题，然后保持最小修改。」当前设计已按该约束限定为一个现有测试文件和一份 Plan；此项只补全原文记录。

## Follow-up

按 §18 在实际差分上运行原两例、全文件、Core 类型检查及适用的原 Gate，随后提交独立实现审计。其他句柄继续单独追踪。

## Rejected speculation

第二条合成握手绕过真实 SDK 的连接方法。替身路径未观察到关闭回调；这条记录不足以确认真实 SDK 存在关闭缺陷，不扩大本 Plan 到生产代码。

## Requirement and traceability coverage

复核了基线两条用例、生产 acquire/release、测试自有 Scope、SDK 关闭合同及原泄漏检查。三个实验日志的 SHA-256 与 §18 一致。基线两例的业务断言通过，原检查报告 60 秒和 30 秒两个残留；两条统一绑定 transport 的对照仍留下 30 秒残留；最终候选通过原两例和全文件，20 例、116 条断言。对照差分只替换两个夹具的 Promise 收尾，原中断、重试、复用和 OAuth 断言全部保留。

## Primary-path and fallback verdict

第一条由真实 transport close 结算挂起替身；第二条由该替身所属的失败测试 Scope 结算。两者继续使用原 deadline 的清理路径。无新增生产路径、计时器、重试或成功兜底。

## Release verdict

**APPROVE**

批准精确 **R1 方案**，SHA-256 `78969d448b9bd0b9e9f535f734e10079ca6c37f0dba334530426827108642bfe`。登记裁决后可实施；本裁决仅放行方案阶段。

## 23. Implementation Evidence

实际固定父 `4555c21eb8615e15eb88d746df89f9ac9538898c`，已用原签名对象复算父 SHA 和树。仅修改本 Plan 与 `packages/core/test/session-runner-tool-registry.test.ts`。测试文件后像 blob `8f4460c`，SHA-256 `1fa518ccc60216de283c29fe51633f4e79034cddc55b69b0e366489c900076a5`，与获准私有试验副本相同。完整测试文件差分 SHA-256 `b803810d4e25632c62174e71f1daaf5fdf2acdc46a6b8dc881ee8a64e5d0293b`；两处路径各负责一条合成握手，均把拒绝交回原 Promise.then/finally；删除两个永远 pending 的替身 Promise。

测试文件物理 +10/−5，有效 E/C 为 7/2。排除三条中文注释，更新的用例说明不计 C。只有两条新增就近说明计 C，分别说明为何先注册关闭后发布就绪、为何测试握手只由其私有 scope 收尾。原测试实例净增 0，未动生产、timer、Gate、配置、lock 和任何用例断言。

| 命令／原入口 | 实际结果 | 日志 SHA-256 |
| --- | --- | --- |
| §18 窄测，真实原文件，原 leak preload | 2 pass、10 断言、0 fail、退出 0，1.245 秒 | `5791742efe47013ec268b73bebdb68b3a97b207fc9f131f1662f9809d7f59d82` |
| §18 全文件，真实原文件，原 leak preload | 20 pass、116 断言、0 fail、退出 0，1.355 秒 | `8b58e4ef3b416db00c3b1a3890edd2ca1db92d0a88c51ba08bf484d005698100` |
| `bun run typecheck`，包目录 `packages/core` | `tsgo --noEmit`，退出 0 | `ae47736bb2a9401aa9743893f2f64b9a605e65a99d78cd991a8021e0f7722d87` |
| `bun script/guard/gate.ts stop --files docs/plans/core-mcp-fixture-lifetime.md,packages/core/test/session-runner-tool-registry.test.ts`，精确父仓库根 | 规则检查、静态选测均通过；选中 Core 原一个文件，20 pass；退出 0 | `dd10e46f18aad37e0be134af94d9ff9c0100c152016a3e03da5219a2c0661546` |

首次本地 Stop 已通过规则和选测，但原运行试图写入只读主目录，退出 1。只为复验进程指定私有 HOME/XDG 与 loopback 后，用同一 Gate 命令和原测试范围成功，未改仓库或 Gate。原两条红绿见 §18。当前冻结实际两路径待独立实现审计；候选尚无正式远端、CI、提交钩子及独立恢复回执，保留原 §18 终态要求。

## 24. Implementation Audit Record

## Blocking findings

No blocking findings.

## Non-blocking findings

§22 目前只摘录了方案审计结论。按 Workflow 原样补录完整裁决，并更新 R1 历史表的状态。两项均为记录修正，已批准方案和实际测试差分保持不变。

## Follow-up

完成 §18 剩余交付检查：原提交钩子、单提交、空目录独立恢复，以及精确远端候选的 Test、Guard 和 Typecheck。

## Rejected speculation

第二个测试 Scope 的 finalizer 只拒绝本测试创建的合成握手，不替生产 transport 执行关闭，也不改变真实 SDK 的 OAuth 清理行为。

## Requirement and traceability coverage

从精确基线 `4555c21e` 核对了全部两条路径。既有两例在基线各留下一个 deadline；实现后的原文件窄测 2 例、10 条断言通过，全文件 20 例、116 条断言通过。原 Core 类型检查和 Stop 均退出 0，日志校验值与 §23 一致。原中断、重试、客户端复用、OAuth 隔离及清理断言全部保留。

## Primary-path and fallback verdict

第一条替身由真实 transport close 结算；第二条由测试自己的失败 Scope 结算。两条均通过原 Promise 结算释放已有 deadline。未增加计时器、替代成功路径或生产接线。

## Code quality verdict

实际差分只有一份 Plan 和一个既有测试文件。测试物理增删为 `+10/-5`，原测试实例净增 0。两条新增中文注释说明关闭回调的注册顺序和测试 Scope 的收尾归属。`git diff --check` 通过。

## Release verdict

**APPROVE**

批准精确 **R1 实现差分**，SHA-256 `bc4beb3aab37012ef6e951fa9e05da19573f4a4ff7182ae331001743cd5ce40d`。本裁决通过独立实现审计；合并就绪仍由 §18 剩余检查判定。

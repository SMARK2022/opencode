# Canonical Implementation Plan: 稳定验证现有消息分页的页间让出

> Status: implementation-audit-required
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 原始用户消息，逐字见 §1
>
> Implementation allowed: yes
>
> Last updated: 2026-11-22 HKT

本文件是此单项任务的唯一实施规格。固定 R1 基线为 `4555c21eb8615e15eb88d746df89f9ac9538898c`。

## 1. Verbatim Requirement

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。

> 你可以去检查一下对应的静态问题，然后保持最小修改。

本项覆盖现有 `MessageV2.stream > handles sets exceeding internal page size` 心跳误红；其他失败分别验收，不在此文件改动。

## 2. Explicit Non-Goals

不改生产分页、SQL、消息结构、公开接口或 Bun 调度；不改 Guard/get、超时、工作流、依赖、测试数；不新增定时器、不跳过现有用例、不使用宽松结果或平台例外。不由这个文件授权发布或合并。

## 3. Repository Context

| 来源 | 对本项的约束 |
| --- | --- |
| 根 `AGENTS.md`、`packages/opencode/AGENTS.md`、`packages/opencode/test/AGENTS.md` | 从包目录测试真实实现，保留 `testEffect(...).instance`、作用域清理和 Effect 风格。 |
| `CONTEXT.md` / `docs/adr/README.md` | 保留已有 Session History 持久语义；未发现针对该测试见证的 ADR。 |
| first-principles policy / canonical template / diagnosing-bugs / TDD | 同一原始用例保留数据验证和能失败的让出验证；验证不承担生产责任。 |

## 4. Files and Evidence Read

| 证据 | 用途 | 分类 |
| --- | --- | --- |
| `packages/opencode/test/session/messages-pagination.test.ts`，fill/withSession/具名用例 | 原回调先于数据长度与两端 ID 断言，原 60 条热消息和逐条 text fixture。 | observed |
| `packages/opencode/src/session/message-v2.ts` 的 `stream/page` | 内部页 50，真实第二次有游标的 SELECT 前等待 `Bun.sleep(0)`；原 page/hydrate/排序不改。 | observed |
| `packages/opencode/test/lib/effect.ts`、`script/test-ci.ts`（包内）、根锁、Effect SQL Statement 公开 API | 现有实例测试使用普通 Bun test 注册；普通 CI 30 秒/并发 2。SQL transformer 是 effect-scoped statement 观测 seam。 | observed |
| #12 Windows / #13 macOS 原 CI 日志及 #8 同名历史复跑 | 真实红点为 heartbeat false，断言早于数据检查；历史同用例可转绿。 | observed |
| 隔离原 Linux named test 和真实 SQL/回调顺序记录 | 既有 named 1/1；自然回调有一次晚于返回，真实两页与所有 60 条数据仍正确。 | observed |
| exact 976fc 隔离对照和 4555..976fc 二进制树检查 | 976fc 只改 12 个基准/Guard 路径；本测试、生产、SQL 驱动、锁及相关规则逐字相同。 | observed |

## 5. Current Behavior

`fill(60)` → 写入真实 session/parts → `MessageV2.stream` → 查首批 51 看出续页，hydrate 50 → await 原零时长 Bun 让出 → 以游标查余下 10 → 返回 60 条降序消息。测试现用另外的 JS `setTimeout(0)` 是否恰好在返回前触发推断让出。

## 6. Supported Input Domain and Reachability

| 输入 | 来源及保证 | 路径 | owner / 分类 |
| --- | --- | --- | --- |
| 同一 session 60 条有效热消息，每条一个文本 part | 原 fixture 生成递增 ID、持久时间和 `m0…m59`; 无冷态恢复 | `stream`→真实 `page`→hydrate | Session History / observed |
| Bun 两种异步事件的派发顺序 | 原测试注册 0ms callback，生产等待原 `Bun.sleep(0)`；两者各自调度 | 同一测试检查返回前 callback | 测试见证 / observed |

## 7. Required Invariants

| ID | 行为 | 证据 | 已有用例 |
| --- | --- | --- | --- |
| INV-01 | 原 60 个独立 ID 与正文完整，顺序与既有降序契约一致，仍以两次真实 SQL 页查询得到。 | 原输入、SQL Trace 和业务断言 | 同一现有 named |
| INV-02 | 真实第二页查询执行前，页间合作让出已完成；移除此边界应使同一用例失败。 | 明确页间 `await` 与删一行负对照 | 同一现有 named |
| INV-03 | 测试结果不由第三方零延时 callback 和生产等待的偶然先后决定。 | 自然晚到实例与受控回调对照 | 同一现有 named |
| INV-04 | 共享 Bun spy 在成功、失败和 Effect fiber 中断后恢复。 | 已实测真实 spy 的 JS finally 和 Effect resource release A/B。 | 同一现有 named 作用域；隔离中断负控 |

## 8. First Divergence and Root Cause

| 不变量 | 首个偏差 | 所属 | 证明 |
| --- | --- | --- | --- |
| INV-03 | fixture 把不同调度入口的回调先后当成产品是否让出的必要条件。 | `messages-pagination.test.ts` 已有心跳断言 | 观测 q1 0.233ms → q2 1.129ms → 返回 1.516ms → 公共原 timer 1.529ms，两页与 60 条均正确。仅延迟测试 callback 的六轮都把旧判定变红且业务不变；六个自然对照均在两页间执行。 |
| INV-01/02 | 现有产品实际保留；修复测试时不能丢掉见证。 | `MessageV2.stream` 与该测试 | 976fc 等价隔离执行：q1 2.296ms → 实际 sleep 调用/完成 7.194/7.236ms → q2 8.011ms → 返回 8.870ms，所有 ID/正文正确，1 pass/3 asserts/exit0。仅在隔离副本移除原一行后同命令重新产生两页及相同 ID/正文，第二页状态为 first-query，只有让出断言失败，0 pass/1 fail/3 asserts/exit1。 |

R3 原拟用 JS 生成器 `try/finally` 恢复共享 spy。对照先用 `Deferred` 确认真实 spy 已安装，再用 `Fiber.interrupt` 中断。锁定 Effect 在 JS finally 臂实测 `Bun.sleep === original` 为 false；仅改为 `Effect.acquireUseRelease` 后同一用例为 true。两臂均在外部检查原方法身份、记录回执，2 pass / 6 assertions / 2.16s。此为隔离证据，不新增仓库测试或计时器。

高保真原失败属于主机上的见证派发先后，不据此断言所有失败平台均有事件循环阻塞。负对照用的生产副本从未写入工作树或发布。

## 9. Responsibility and Seam

| 关注项 | owner | 边界 |
| --- | --- | --- |
| 分页、游标、消息与合作让出 | 现有生产 `MessageV2.stream` | 原实现继续执行，不向其加入测试 API、配置或备用路由。 |
| 可观测确认两页和真实主机等待 | 同一现有测试 | 通过 Effect SQL `Statement.CurrentTransformer` 观察实际 SELECT；通过 Bun test 的公开 `spyOn` 仅观测生产已调用的公开 `Bun.sleep`，委托原方法及返回等待。 |

## 10. Single Approved Primary-Path Design

原 fixture 填 60，先捕获独立预期 `ids` 和根据索引生成的已有文本；同一 `MessageV2.stream` 调用中安装 effect-scoped `Statement.CurrentTransformer`，只记录当前调用两次 SELECT `message`、排序和 LIMIT 的页查询，原样返回 statement 并不等待外部工作。短作用域通过 Bun `spyOn(Bun, "sleep")` 只在首个页查询已观测且等待参数为 0 时，把原主机 Promise 的完成记录在测试状态中；所有其他调用直接转发，实际等待不替换，用 `Effect.acquireUseRelease` 拥有共享方法：`Effect.sync` 一次安装并返回真实 spy，use 执行原 stream 和 scoped SQL 观测，release 用 `Effect.sync` 恢复原方法；该边界涵盖普通返回、失败和 fiber 中断。业务与顺序断言可以在 release 以后读取同一局部记录。原测试内以第一、二查询时的状态判断实际让出已完成，保持两页和 ID/正文完整断言；删除旧 `setTimeout` 与 heartbeat 布尔断言。采用普通 `it.instance`，无 `test.concurrent`，无跨 case 暴露 spy；不使用 JS 生成器 `finally` 代替 Effect resource release。保留超过页大小的真实输入和数据结果。

正例必须让符号顺序为「页一 → 原 Promise 完成 → 页二」，同时检查全体数据。无让出负例即使数据正确仍红；不能在 SQL 观测器加等待制造通过。生产支持其他真正让出的未来重构时，届时显式随所有者更新该真实运行时见证，不在当前添加备用判断。

## 11. Secondary and Replacement Path Inventory

| 路径 | 分类 | 状态 |
| --- | --- | --- |
| 既有 stream→page→hydrate→Bun scheduler | 原唯一产品路径 | 保留 |
| 仅测试 scope 的 SQL/真实 Promise 见证 | 诊断，零生产决策表面 | 纳入原用例 |
| 0ms 独立 heartbeat | 旧错误代理 | 删除 |
| 任何替代成功、平台分支、扩大限时 | 禁止 | 零 |

## 12. Workaround Deletion and Replacement

同一测试删除独立 heartbeat 定时器、布尔值和对两个不同主机 timer 队列顺序的假设；保留原 real yield，不在测试或产品引入第二等待。

## 13. Forward Traceability

| ID | 路径 | 文件和动作 | 验证 |
| --- | --- | --- | --- |
| INV-01 | 真实两页查库与 hydrate | 现有 pagination test 升级全量 ID/part 独立 oracle | 60 项逐条、两页 |
| INV-02 | 原 `Bun.sleep(0)` | 同文件测试局部观测该原 Promise 完成，原查询仍执行 | 原实现通过且离线删一行必红 |
| INV-03 | 现有具名测试 | 同文件删除无关 timer | 不再有其他 0ms 回调争序，观察真实等待 |
| INV-04 | 局部共享方法寿命 | 同一测试 `Effect.acquireUseRelease` 恢复 | 隔离真实 spy + `Fiber.interrupt` 红绿；正式整文件无串扰 |

## 14. Reverse Traceability

无新增生产概念、条件、配置、模块、故障恢复。测试局部两项观测分别承担 INV-01、INV-02，去掉任一会削弱同一用例。

## 15. File-Level Change Plan

| 文件 | 动作 | 职责 | 预估 |
| --- | --- | --- | --- |
| `docs/plans/pagination-page-yield-test-witness.md` | add | Plan | 此一份 |
| `packages/opencode/test/session/messages-pagination.test.ts` | modify | 改同一具名测试，仅添加需要的 `spyOn/Statement` 导入、局部见证与全体数据断言 | 约 +26/-5，净增测试 0 |
| 其他 | 不变 | 原行为不动 | 0 |

## 16. TDD Behavior Slices

| 顺序 | Red | 最小 Green | 保留 |
| --- | --- | --- | --- |
| 1 | 原 named 的独立 0ms callback 在返回后派发时，旧 heartbeat false，虽有正确两页/数据；离线删除唯一真实让出后，新见证独立失败。 | 同一用例观测原真实页间等待，不以另一个 callback 派发评判；数据与两页检查同在。 | 不接受没有等待的合成结果，也不接受正确等待但丢失/重排/错配数据。 |

## 17. Comments

按用户全局 Stage 3 注释门槛，本测试允许三条各解释一个不明显不变量的简短中文注释：记录真实原等待完成而非调用；查询观测器只识别真实消息页且不制造等待；使用 Effect 作用域在成功、失败和 fiber 中断时恢复跨测试共享的 spy；不得将 JS 生成器 finally 当作 Effect 中断保障。保留现有第一条语义，其余分别紧邻查询和恢复点。无生产注释，不新增运行逻辑。R2 实测差分以测试新增有效/控制流行计 E=18（排除 2 个 import、1 个 comment、4 个纯闭合/排版行）；R4 仅在同一既有测试调整资源边界，并按实际有效行验证三条有意义说明及比例：C 至少 ceil(E×.15)。

## 18. Verification

| 命令 / 比较 | 目录 | 结果范围 |
| --- | --- | --- |
| `bun test --timeout 30000 --max-concurrency 2 test/session/messages-pagination.test.ts --test-name-pattern '^MessageV2.stream handles sets exceeding internal page size$'` | `packages/opencode` | 精确既有 named，无调整 timeout；隔离 Linux 原已 1 pass/4 asserts / 341.37ms；新变更后重跑。 |
| `bun test --timeout 30000 --max-concurrency 2 test/session/messages-pagination.test.ts` | `packages/opencode` | 整文件原类顺序和作用域恢复，既有测试数应相同。 |
| `bun run typecheck` | `packages/opencode` | typed Bun/Effect 公共 seams，不新增 cast。 |
| 等价 976fc 隔离 `bun test --timeout 30000 --max-concurrency 2 <boundary-witness.test.ts>` 同 setup 两臂 | 精确备份的 `packages/opencode` | 已实测 1.92s exit0；仅删生产那行的 off-tree 测试 2.08s exit1，数据预期先通过。输入脚本 SHA-256 `3ffccd464a654dc64bccafef2c383baa3a7e22eab09a42b323df34984d672e56`；正日志 `d414fde5d954bcf7372ad339de07dfaa5894c35fe2eb35156f52dc46adcb04e6`；负日志 `db9b531583e4ca4c947a12d5886a7394695ddb7e5900bda293a6b5af9f5ecb9f`。隔离对照只做方案证据。 |
| `bun test --timeout 30000 <interrupt.test.ts>` | 包目录，确切锁及现成逻辑 | 已实测中断：原 JS finally 未恢复，Effect acquire/release 恢复同一真实 spy，2 pass/6 断言；清单 SHA-256 `6e5d1ab12eb22f7901a870f1ae6072a42dd2c24bdd546eb0630b18d9f96b80d9`。无新时钟，隔离证据不进入产品或测试树。 |
| 原 required Windows「会话与服务集成」（`opencode-windows-integration`，`OPENCODE_TEST_SHARD=integration`）、macOS OpenCode 核心、相应原 Guard | GitHub 原入口 | `.github/workflows/test.yml:50–63` 与 `packages/opencode/script/test-ci.ts:17–21` 确认 integration 覆盖 `test/session/`；仅当正式授权并提交后核同一候选，不能将 Linux 正例算跨平台通过。 |

## 19. Diff Budget

| 项 | 预算 | 原因 |
| --- | --- | --- |
| 新文件 | 1 | Canonical Plan |
| 改文件 | 1 | 同一现有测试 |
| 生产、生成文件及净增测试 | 全 0 | 原代码与测试数保持 |
| 测试行 | 约 +26/-5 | typed 真实等待与查询观测、完整 oracle、恢复 spy |

## 20. Real Risks and Open Decisions

同进程 global spy 必须只在原 named 的普通 test scope 存在，用 Effect acquire/release 恢复；整文件运行验证无跨 case 影响。基线常见仓库全局测试失败另案，本事项不吞掉其 Gate 结果。

### Open Decisions Requiring the User

无。

### Follow-up

Windows/macOS 精确候选的全量测试和真实线上所需检查尚未执行。本项不新增在线路由。

### Rejected Speculation

一次 heartbeat false 推断 SQL 丢数、多页饥饿或必须改生产 timer，均无因果证明；实际自然迟到时两个查询与结果全部正确。

## 21. Audit Contract

按仓库独立 full-scope 审计原需求、固定基线、原失败、两隔离对照、计划单文件测试差分与 no-yield 敏感性；实施审计须独立核验实际 diff 及其真实验收。此文不授予实施。

## 22. Revision Delta and Plan Audit Record

| 修订 | 变化章节 | 发现与修正 | 变化的责任、行为或文件 |
| --- | --- | --- | --- |
| R2 | §18、§22 | B-01：改指向原 Windows 会话与服务集成分片；保留原 macOS 和 Guard。 | 仅正式验收入口；设计、实施文件和负对照不变。 |
| R3 | §17、§22 | 对齐用户 Stage 3 的有效代码与中文说明门槛：R2 的测试差分 E=18，C=1；明确三条有意义且现场毗邻的不变量说明。 | 只追加两条测试注释；R2 已批准的运行行为、测试、两个文件及发布入口不变。 |
| R4 | §7–8、§10、§13、§15、§17–20、§22 | R3 实施发现 JS 生成器 finally 未在 Fiber.interrupt 时恢复真实全局 spy；采用 Effect acquire/use/release 并记录实测差异。 | 同一现有测试及 Plan；保留真实两页、全 ID/正文、Windows 分片、生产、Guard、计时器和测试数。 |

| 轮次 | 修订 | 全范围 | 阻塞 | 非阻塞 | 结果 | 调用引用 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 无 | BLOCK | 根线程转交的独立方案审计结果 |
| 2 | R2 | yes | 无 | 无 | APPROVE | 根线程转交的独立方案审计结果 |
| 3 | R3 | yes | 无 | 无 | APPROVE | 根线程转交的独立方案审计结果 |

R1 完整原样裁决：

~~~markdown
## Blocking findings

### B-01 Windows 验收选错分片

- **Violated invariant:** INV-01～03 的正式 Windows 验收须运行同一个现有分页用例。
- **Evidence class:** contracted。
- **Producer and execution path:** §18 指定 Windows 工具分片 → `OPENCODE_TEST_SHARD=runtime` → 按目录筛选测试。
- **Source evidence:** `.github/workflows/test.yml:50–63` 区分 Windows 会话集成和工具分片；`packages/opencode/script/test-ci.ts:17–21` 将 `test/session/` 归入 `integration`，从 `runtime` 排除。
- **Canonical-plan evidence:** §18 指定 `Windows tools`；§20 仍要求 Windows 精确候选实测。
- **Responsibility owner:** §18 的正式验收入口。
- **Concrete behavioral consequence:** Windows 工具分片即使通过，也没有运行这次修复的分页用例，无法证明原 Windows 红项已修。
- **Pre-R1 baseline behavior on the same path:** 原分片规则已将该用例交给 Windows 会话与服务集成分片。
- **Minimal correction direction:** 将 §18 的 `Windows tools` 改为 `Windows / 会话与服务集成`，保留原 macOS 与 Guard 验收。

## Non-blocking findings

无。

## Follow-up

批准后用同一正式候选运行原具名测试和整文件，核对 spy 在退出时恢复，以及真实 Windows 会话分片的同名回执。

## Rejected speculation

单次 heartbeat false 不能定位 SQL 丢数或生产让出失效。隔离对照中，即便移除让出，两页和 60 条数据仍正确，只有让出见证失败。

## Requirement and traceability coverage

核对了原 60 条 fixture、真实页大小 50、两页查询及原 `Bun.sleep(0)`。方案试验脚本及正负日志的 SHA-256 均匹配：原路径通过；仅移除让出的私有对照保留完整数据，但见证失败。方案只改现有测试，未提出生产改动或新增用例。

## Primary-path and fallback verdict

测试观察真实页查询及原等待 Promise 的完成，继续执行原查询和等待。没有新增计时器或替代成功判断。

## Release verdict

**BLOCK**

适用于精确 **R1 方案**，SHA-256 `993bd7e076e32782a2eda98ebb8a996a0863b9b5994f07b6dde813b9765c1bbc`。修正正式 Windows 验收入口后送复审。
~~~

R2 完整原样裁决：

~~~markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

实施后用实际差分运行原具名用例、整文件和类型检查，核对 spy 在所有出口恢复；正式候选须取得 Windows 会话与服务集成、macOS 和原 Guard 的回执。

## Rejected speculation

不从一次 heartbeat false 推断 SQL 丢数或需要修改生产调度。正负对照均取得两页完整数据，移除让出只会使新的顺序断言失败。

## Requirement and traceability coverage

B-01 已关闭。§18 改用实际收录 `test/session/` 的 Windows `integration` 分片。复核了固定基线、原需求、60 条数据断言和隔离试验的脚本及正负日志校验值。R2 未扩大改动范围，仍只修一个既有用例并保留原生产行为。

## Primary-path and fallback verdict

测试观察真实页查询与原 `Bun.sleep(0)` 的完成顺序，继续执行原 SQL 和等待。无新增计时器、平台例外或替代成功路径。

## Release verdict

**APPROVE**

批准精确 **R2 方案**，SHA-256 `089f0a925b6e293d094269e9abb5677fef0c2f9abb2df1c9121e16cb6334e47d`。登记裁决后可实施；实际差分须另经独立实现审计。
~~~

R3 完整原样裁决：

~~~markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

按 R3 在实际差分中核对三条注释及 E/C，再验证原具名用例、整文件和正确的 Windows 会话集成分片。此裁决不替代实施审计。

## Rejected speculation

R3 不引入新的调度路径或断言条件。原 Windows 验收修正与隔离负对照保持不变。

## Requirement and traceability coverage

复核了固定 `4555c21e`、原单例范围、R1 和 R2 裁决以及正负对照。R3 只调整 §17 和审计记录。三条说明分别对应真实等待完成、SQL 观察不制造等待、共享 spy 在退出时恢复；没有新增生产改动或测试实例。

## Primary-path and fallback verdict

真实分页继续执行原 SQL 和原 `Bun.sleep(0)`，测试只观察顺序与数据。无新增计时器、平台分支或替代成功路径。

## Release verdict

**APPROVE**

批准精确 **R3 方案**，SHA-256 `6867451706e008efd40048fd072ff7dfef06f41f887c74c0ecfeb15ad4757da1`。登记裁决后可实施两条注释变更；实际差分须另经独立审计。
~~~

R4 完整原样裁决：

~~~markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

在实际差分上复验原具名用例、整文件、类型检查及中断后的 spy 恢复；正式候选仍须取得原 Windows 会话集成、macOS 和 Guard 回执。

## Rejected speculation

不把 JavaScript 生成器的 `finally` 当作 Effect fiber 中断后的清理保障。隔离实测中，旧路径中断后保留了 spy；新路径恢复了原方法。

## Requirement and traceability coverage

核对了固定 `4555c21e`、原需求、R4 的资源边界与隔离回执。两臂使用真实 Bun spy，先确认安装，再中断 fiber 并在外部检查方法身份。两例、六条断言与清单一致。原两页查询、60 条 ID／正文和移除让出的负对照仍在范围内。

## Primary-path and fallback verdict

测试用 `Effect.acquireUseRelease` 管理 spy，仍调用原分页查询和原等待；成功、失败和中断走同一个恢复入口。无新增测试、定时器、生产接线或备用成功路径。

## Release verdict

**APPROVE**

批准精确 **R4 方案**，SHA-256 `7b12f84b8b8ae24f62fa01fb494d97a5bdd43340c09d2f19363b3a56f27499a3`。登记裁决后可实施；实际差分须另经独立审计。
~~~

## 23. Implementation Evidence

基线 `4555c21eb8615e15eb88d746df89f9ac9538898c`。R4 完整差分为本 Plan 与 `packages/opencode/test/session/messages-pagination.test.ts`。测试文件 blob `fdc6ba745a9a08d3fb0eeba3ba21ec5c6f82a0a1`。产品、Gate 和新增用例均为零。既有测试去掉独立外部 heartbeat，依次验证实际两页查询、原等待完成顺序、60 条 ID 和正文；Effect release 恢复共享 Bun 方法。

| 验证 | 真实结果 |
| --- | --- |
| `packages/opencode` 原具名命令，§18 | 1 通过，61 筛除，3 条断言，测试 330.96 ms，退出 0。 |
| `packages/opencode` 原整文件，§18 | 62 通过，169 条断言，5.25 s，退出 0。 |
| 私有负对照，同一 R4 测试文件字节相同，产品副本仅删原一行页间让出 | 两个完整数据断言通过；顺序期望 `[false,true]`，实际 `[false,false]`，具名用例红，退出 1。 |
| 独立真实 Bun spy 隔离中断复验，§18 | 旧 JS finally 下 `restored=false`，R4 同一 acquire/release 机制下 `restored=true`；2 通过，6 条断言，退出 0。探针不进入候选。 |
| 仓库根目录原 `bun script/guard/gate.ts stop --files <Plan,原测试>` | 原规则和静态选测通过；选中 1 个文件，62 通过，退出 0。 |
| `packages/opencode` 原 `bun run typecheck` | Bun 1.4.4 精确依赖投影，原 `tsgo --noEmit` 退出 0，无诊断。私有投影校正了外部插件包的工作区解析以及锁定的 OpenAI 补丁后像。 |

最终测试物理差分 +33/-8。有效新增 E=20：从 +33 排除两条 import、三条注释、纯闭合及单独换行的箭头排版共八行。C=3，逐项说明只记录真实等待完成、只观察实际消息页查询，以及 Effect 中断仍释放共享 spy，满足 ceil(20×.15)=3。

原始命令、时刻、退出码、命令输出及仅删一行的隔离 diff 校验清单 SHA-256：`30faf508b3400f99c838151e9e6afa24d63075f031e50ba0e9f9a71fd881da35`。原 Windows 会话与服务集成、macOS OpenCode 核心及正式 Guard 待同一正式候选；本地 Stop 是独立回执。当前等待独立实现审计。

## 24. Implementation Audit Record

R4 已通过独立实现审计。正式候选的 Windows 会话与服务集成、macOS OpenCode 核心及原 Guard 仍待验收。以下为本轮完整原样裁决。

~~~markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§24 仍写着「未实施，未审计」。登记本轮裁决时更新该状态，保留线上验收待完成的记录。

## Follow-up

按同一正式候选 SHA 核对 Windows 会话与服务集成、macOS OpenCode 核心和原 Guard 回执。本地 Stop 不替代这些检查。

## Rejected speculation

原心跳断言失败只记录了回调顺序。负对照证明，即使禁用页间让出，仍能得到完整的 60 条消息；新的顺序断言能独立抓到这一退化。

## Requirement and traceability coverage

已核对精确两路径差分和原始回执。具名用例通过，整文件 62 例通过；类型检查与 Stop 均退出 0。负对照使用相同测试字节，只在隔离副本删除一行生产让出：两条数据断言通过，页间顺序从期望的 `[false,true]` 变为 `[false,false]`，用例按预期失败。独立中断对照确认真实 Bun spy 恢复。

## Primary-path and fallback verdict

测试观察原 SQL 和原等待完成，保留了真实分页与 60 条 ID、正文校验。`Effect.acquireUseRelease` 在成功、失败或中断时恢复共享 spy。未改生产、Gate 或计时行为。

## Code quality verdict

差分只涉及一份 Plan 和一个现有测试，测试实例净增 0。三条新增注释分别说明等待完成、查询识别和中断清理。

## Release verdict

**APPROVE**

批准精确 **R4 实现差分**，SHA-256 `09e94e7c7e5a27d3642d0105ec3bb0e943e54fafe1f20171efc84904d9f2d5fd`，候选树 `8aaffaaed50ec0176000da20619ca35b1cec522e`。独立实现审计通过；最终交付仍须完成原线上检查。
~~~

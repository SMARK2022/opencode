# Canonical Implementation Plan: CI SSE Regression Log Isolation

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户当前 Session GOAL，原文见第 1 节
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-10-04

This file is the sole implementation specification for this task. Chat summaries, superseded revisions, and builder rationale outside this file are not implementation authority.

## 1. Verbatim Requirement

> 解决现有的测试红测问题，保持精准克制，且注意避免最终进行 commit 的时候相应的内容或者 hunk 与其他的 agent 所进行的修改去重叠，譬如重叠在同一个文件上，同时尽量保持精准，同时适当去增加相应的注释等等内容，不要过多修改一些没有让你修改的东西。

目标终态为 `verified-implementation-and-commit`。用户要求先独立方案审计、批准后 TDD、独立实现审计，最终精确路径提交，不 amend、不跳过 hook、不 push。此前对话中的展示 diff 不构成批准方案。

## 2. Explicit Non-Goals

- 不修改 production SSE/cancellation、logger 公共接口、CI 配置、数据库或冷存储代码。
- 不接管其他 agent 的 build、cold-storage、daemon 修改或已暂存方案。
- 不通过增加 timeout、skip、mock logger、删除正常控制组或放宽断言取得通过。
- 不修理没有在本次受影响路径中证实的历史偶发测试失败。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 最小内聚变更；测试及 typecheck 必须 package-local；不直接使用 tsc |
| `packages/opencode/AGENTS.md` | 保留包内模块结构，不增加 namespace、公开 test-only API |
| `packages/opencode/test/AGENTS.md` | 真实临时 fixture、公开行为 seam、以就绪信号同步而非固定 sleep |
| `CONTEXT.md` | Provider/Instance/AppRuntime 语义；Instance 隔离不代表进程级 Log 隔离 |
| `docs/adr/README.md` | 当前 ADR 索引仅列 triage ADR，无 SSE/logger 专用 ADR；本变更不新增架构决策 |
| `.opencode/policy/first-principles-engineering.md` | primary-path、独立审计、traceability 和中文解释注释门禁 |
| `.opencode/templates/canonical-plan.md` | 本文完整结构及审批记录 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| GitHub run `37151556509`, SHA `94e9a5f77fdcd4fcd8fcb8ae370ade0d6c0c943f` | 最新 test 仍失败；Linux 和 Windows runtime 唯一失败为 SSE 用例；macOS 通过 | observed |
| Linux job `111286328441`、Windows job `111286328394` 日志 | `provider.test.ts:3106`, `expect(ended("race-b")).not.toEqual([])`，约 10 秒后失败 | observed |
| GitHub run `36995871681` 及本轮 cold-v3 日志 | 上轮 cold-v3 三个失败在本轮全部通过；本轮不是这些冷存储断言失败 | observed |
| `packages/opencode/test/provider/provider.test.ts:2982-3110` | plugin fetch -> production Provider -> SDK stream；固定 dev.log 的基线和 EOF 判别 | observed |
| `packages/opencode/src/provider/provider.ts:97-285` | timing INFO、progressDeadline.wrap、released 守卫、cancelReader 和正常 EOF | observed |
| `packages/core/src/util/log.ts` | 进程级 writer/level、init 就绪 Promise、dev/时间戳/stderr 输出、file() 和 close() | observed |
| `packages/opencode/test/preload.ts`、`bunfig.toml` | 测试数据目录隔离；一次性异步配置 dev 日志，不保证后续全局日志状态 | observed |
| `packages/opencode/test/project/project.test.ts:18`、`test/project/migrate-global.test.ts` | 模块加载调用 `Log.init({ print: false })`，使实际目标改为时间戳文件 | observed |
| `packages/opencode/test/lsp/client.test.ts:19-22` | beforeEach 调用 print:true，是 stderr 状态的真实 producer | observed |
| `packages/opencode/test/util/log.test.ts` | 临时改变日志目录和初始化，部分 finalizer 恢复 dev 日志；日志测试应与修复用例组合回归 | observed |
| `packages/opencode/script/test-ci.ts`、`.github/workflows/test.yml` | 每个 Bun child 执行多文件，Windows runtime 包含 project/provider，Linux/macOS core 合并文件 | observed |
| `packages/opencode/test/fixture/fixture.ts`、provider test afterEach | 保持现有实例处置及环境变量恢复，不引入第二套 runtime/fixture | observed |
| 本轮执行的两条 bun test 命令（第 8 节） | 单独通过、共享 logger 失败，真实源码和真实磁盘路径，无修改测试文件 | observed |
| 本轮 git status / diff / cached diff | provider 测试无任何既有修改；其他工作区/暂存修改不属于本任务 | observed |

## 5. Current Behavior

```text
test preload -> Log.init(dev)
project test module -> Log.init(timestamp), or LSP test -> Log.init(stderr)
SSE test fixture -> plugin fetch -> Provider deadline.wrap -> AI SDK stream
race-a cancel -> released=true -> late EOF must not emit sse.end
race-b body.close -> normal EOF -> timing INFO -> current process writer
test hard-coded dev.log -> no current race-b EOF -> ENOENT or 10s assertion failure
```

`Log.init` 正常履行选定输出目标的职责，first divergence 在消费者测试未建立观测前置条件、直接假定 dev.log 仍有效。Instance fixture 不承诺隔离模块级 logger。文件写入异步，因此流完成后仍须等待同一条控制组 EOF 日志。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| dev.log writer | test/preload、log test finalizers | init 返回表示最新 writer 初始化结束 | 同进程 SSE 用例 | 测试观测 setup | observed |
| timestamp writer | project/project.test.ts、migrate-global 等 | 未设置 dev 时选时间戳文件 | CI 分片加载多个文件 | 测试观测 setup | observed |
| stderr writer | lsp/client.test.ts | print:true 不写文件，file() 可能仍保留旧路径 | Windows runtime 共享进程 | 测试观测 setup | reachable |
| preload dev.log 尚未创建 | preload 的 void init 被后续 init supersede | 旧 init 允许失效；不保证旧文件存在 | 本轮两文件局部复现 | 测试观测 setup | observed |
| SDK 正常关闭前排队事件 | AI SDK doStream TransformStream | 一次 read 不保证得到 done:true | 控制组 body.close 后读取 | 控制组 EOF 同步 | reachable |
| race-a EOF 与 race-b 非 EOF 日志同批可见 | SSE released 缺失时的原始回归；不同请求 timing | 原有 guard 可被回归破坏；检测必须仍有区分力 | 文件尾读取含多行 | 测试日志就绪判别 | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| REQ-01 | 修复当前 SSE CI 红测，保持原回归检测能力 | 用户原文、run 37151556509 | SSE wrap 用例 |
| INV-01 | 每次用例观测当前可写日志；前序文件选定的日志目标不得改变判定 | 第 8 节真实复现 | 原单用例缺少显式状态覆盖 |
| INV-02 | 正常控制组完成 EOF 且同一条日志含 race-b 与 sse.end；取消组不得产出 EOF 日志 | provider.wrap、原控制组正/负断言 | 原用例 |
| INV-03 | 观测 setup/read 或控制组 read 错误直接失败，不转换成空结果或成功 | policy error propagation；当前 ENOENT | 当前 catch 会延迟/混淆失败 |
| REQ-02 | 只提交本任务完整路径，不改变其他 agent 的 hunk 或 index 内容 | 用户原文、dirty index | git 精确路径核对 |
| REQ-03 | 独立批准、TDD、验证、独立实现审计、中文解释注释及提交 | Session GOAL | 本文记录 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | SSE setup 直接构造 dev.log，而未初始化观测目标 | `test/provider/provider.test.ts` | 同一用例独立绿、与 project 文件组合红；CI 正常 EOF 日志缺失 |
| INV-02 | 正常组一次 read 不证明 EOF；while 的两个全文件 includes 不证明同一行 | 同一用例的 race helper 和日志循环 | SDK 可返回非终态事件；代码谓词可跨行组合 |
| INV-03 | baseline/read 的 catch 将错误当作空基线或无事发生 | 同一测试 | logger 已初始化后应存在文件，read 错误不能成为观测成功 |

本阶段已运行（cwd 均为 `packages/opencode`，Bun 1.3.14）：

```text
bun test ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000
1 pass, 89 filtered out, 0 fail, 4 expect calls, 4.73s.

bun test ./test/project/project.test.ts ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000
0 pass, 123 filtered out, 1 fail, 2 expect calls, 3.80s.
ENOENT at provider.test.ts:3099 reading .../log/dev.log.
```

第二条是本任务最小原始反馈环。局部环境的 dev.log 未创建，而 CI 有旧文件、最终正断言失败；两者均由实际 writer 与硬编码路径分离产生，不能把两种错误文字混称为完全相同。实施时新增确定性前序状态后须得到原 CI 的正控制组断言失败，随后再加修复得到 green。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 测试日志目标与初始化 | SSE test setup 使用现有 Log.init/file | 读取本用例真实 diagnostics | 只有消费者知道依赖文件日志 | production logger 已正确切换目标；不该禁止其他测试 init |
| EOF 完成与记录归属 | 既有 race helper + ended predicate | 区分正常 EOF 与取消后错误 EOF | 属于既有测试判别契约 | 不修改 SDK 或增加 production test-only export |
| 数据/实例隔离与清理 | 既有 tmpdir、withTestInstance、afterEach | 保持临时数据、环境和实例生命周期 | 复用现成 fixture | 不增加新全局 fixture 框架 |
| commit ownership | Git 精确路径检查 | unrelated work 不进入 commit | 用户明确要求 | 不 reset/stash/改写他人 index |

## 10. Single Approved Primary-Path Design

```text
parameterized existing SSE test: prior mode dev/timestamp/stderr
-> await Log.init(prior mode) to make prior-state coverage deterministic
-> await Log.init({ print:false, dev:true, level:"DEBUG" })
-> Log.file() -> successful baseline read
-> unchanged real Provider/SDK cancel group
-> normal group drain to done:true, propagate errors
-> wait until ended("race-b") finds the same EOF line
-> preserve normal-positive and cancel-negative assertions
```

- 参数化现有测试为三种输出目标；不叠加没有真实 producer 证据的等级排列，修复 setup 显式恢复 preload 的 DEBUG 等级即可。
- TDD red 阶段仅加入 Log import、三种模式参数化和前序模式初始化；先在三种模式前建立一次 dev writer，确保原测试能读取旧 dev.log，timestamp/stderr 应复现 CI 的 `ended("race-b")` 正断言失败。该初始 dev writer 是回归夹具的一部分，保留以区别文件缺失和错误目标。
- green 阶段在前序模式切换之后、取基线之前初始化本次 writer，使用 `Log.file()`；删除 baseline 的 `.catch(() => "")`。
- 取消组继续 `await reader.cancel()`，保持现有生产调用链和 text-delta 就绪条件；正常组关闭 body 后消费至 EOF，不吞读取错误。
- `ended` 原函数移到 while 之前，循环复用 `ended("race-b").length > 0`，不新增日志解析器。
- 不改变其他测试的 logger 生命周期，不新增配置、helper 模块或 public API。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| dev/timestamp/stderr 参数 | proposed | primary-contract branch（测试初始状态） | 经同一断言 | production N/A | preserve |
| 取消与正常 EOF 对照 | current | primary-contract branch | 共同证明契约 | production unchanged | preserve |
| baseline catch -> empty string | current | forbidden fallback（测试观测失败被遮盖） | 可继续执行 | production N/A | remove |
| control reader.catch -> undefined | current | forbidden fallback（控制组失败被遮盖） | 可继续执行 | production N/A | remove |
| 10 秒 polling deadline | current | diagnostic（等待异步文件可见） | 仅同一 EOF 日志可成功 | production unchanged | preserve，修正就绪条件 |

新 production alternate-success paths = 0；production decision surface 修改 = 0，诊断比例 N/A。未请求 rollback。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 手动拼接 dev.log | 假定 preload 初始化永久有效 | owner 显式 init 后读取 Log.file() | SSE setup |
| baseline 空串 catch | 容忍日志文件不存在 | 初始化成功后要求实际可读取 | 同上 |
| 控制组一次 read + catch | 非终态事件或错误都可能被当作完成 | consume to EOF，错误直接冒泡 | race(false) |
| 全文件双 includes | 粗略等待控制组可见 | 复用同一行 ended 过滤 | polling condition |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-01 | Provider fetch -> SDK -> logger | provider test setup + 三种模式 | 原两文件反馈环、三模式真实文件日志用例 |
| INV-02 | cancel/normal EOF -> timing -> writer | drain + same-line condition，保留两个断言 | 三模式，完整 provider test；现有上轮内存守卫 mutation 仅辅助，非真实测试替代 |
| INV-03 | Log init/file read；SDK read | 删除两处 catch | 真实磁盘/SDK 路径，任何异常导致测试失败 |
| REQ-02 | 无 production 变化 | 仅本计划和 provider test | pre/post status、diff/cached diff、commit --only |
| REQ-03 | 已有工程 workflow | 本计划审计/证据记录、邻近中文注释 | 独立两阶段 audit、package checks、commit hooks |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 无新增 production concept | REQ-01/02 | 缺陷在测试观测 setup，Log/Provider 已有必要接口 | 直接复用 Log.init/file 与 SDK read/cancel |
| 测试三模式初始状态 | INV-01 | preload/project/LSP 三种 producer | 单文件独立运行不会保留前序污染，需显式构造 |
| awaited 初始化和实际文件路径 | INV-01/03 | 独立绿、组合红 | 硬编码路径不表示 active writer |
| 正常组 EOF drain | INV-02/03 | SDK read 可返回中间事件 | 一次 read+catch 不证明完成 |
| 同行 EOF 判别 | INV-02 | 原始 SSE 回归可能产生 race-a EOF | 跨行 includes 不证明 race-b EOF 已落盘 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `docs/plans/ci-sse-regression-log-isolation.md` | add | 唯一 canonical plan、审计、执行及提交证据 | 约 320 行 |
| `packages/opencode/test/provider/provider.test.ts` | modify | 现有 SSE 测试的 setup、状态矩阵、EOF 控制组及就绪条件 | 约 +20/-8，禁止格式化整个文件 |

文件所有权：开始时 provider test 与 HEAD/index 均一致；本 plan 路径不存在。实施前及提交前重新确认；如同一路径出现他人修改则停止提交并报告，不混合 hunks。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 三模式真实 SSE/文件日志，timestamp/stderr 的正常 EOF 不可见 | 依旧读旧 dev.log | await 初始化、实际路径和强制基线读取 | 本轮 CI 的控制组正断言失败 |
| 2 | 保持正常 EOF 与取消后 EOF 区分；控制组完成信号真实可靠 | 既有一次 read/跨行匹配不保证同一 EOF | drain done + 复用 ended 判别 | 不牺牲 SSE cancellation 回归灵敏度 |

测试 seam 是对话已选定的真实 plugin custom Provider -> SDK `doStream` -> `read/cancel` -> production timing 文件。独立 expected 是 cancelled 组无 EOF、normal 组有 EOF；不比较私有调用次数，不 mock 内部 logger/Provider。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines E | 约 12（最终按实际 diff 计算） | 不计 imports、空行、格式化和纯移动 ended |
| Required Chinese explanatory comments C | 至少 2，预计 4 | C >= max(1, ceil(E * 0.15)) |

注释邻近解释：保留初始 dev 文件用于重现错目标；进程级 writer 必须重新就绪；正常组中间事件不代表 EOF；控制组 EOF 必须同行，避免不同请求日志拼接。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000` | packages/opencode | TDD 三种初态 red/green，真实 plugin/SDK/disk |
| `bun test ./test/project/project.test.ts ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000` | packages/opencode | 原始最小反馈环修复，实际生产 logger 调用者参与 |
| `bun test ./test/provider ./test/project ./test/util/log.test.ts --timeout 30000` | packages/opencode | 完整 provider、project、日志生命周期集成回归 |
| `bun typecheck` | packages/opencode | 包级类型检查，不直接使用 tsc |
| `$env:OPENCODE_TEST_SHARD='runtime'; $env:OPENCODE_DISABLE_LSP_DOWNLOAD='true'; $env:OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER='true'; bun run script/test-ci.ts` | packages/opencode | Windows CI runtime 分片；进程环境仅当前 shell，日志保留真实结果 |
| `git diff --check`、限定路径 diff/cached diff/status | repo root | 空白检查及归属 |

先窄后宽。若 broad check 因现有未提交代码、机器环境或不相关测试失败，必须记录精确错误、建立与本次差异无关的证据，不擅自修改他人文件或把失败报告为通过；任何相关失败须修复并按需要重审。远端 Linux/macOS 无本地执行能力；禁止 push，最终明确远端新 CI 未运行。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | 用户要求 canonical plan |
| Files modified | 1 | 责任 owner 是 SSE 测试 |
| Files deleted | 0 | 无需删除文件 |
| Production lines | 0 | 已有 Log/Provider 满足契约 |
| Test lines | 约 28 行 diff | 三模式 + setup + 原判别修正 |
| Generated lines | 0 | 不生成 SDK/migration |

## 20. Real Risks and Open Decisions

- 工作区及 index 有多个 agent 的并行修改；不得暂存目录或运行修改全部文件的 formatter。
- 测试共享 logger；此次修复恢复既有 preload 配置，不能承诺全局套件可并发修改同一 writer。当前本测试非 concurrent，CI 未启用 concurrent。
- 全 runtime 分片涉及进程、LSP 和外部工具，可能存在与本次无关的环境失败；须保留并分类证据。
- 本地 Windows 无法替代远端 Linux/macOS 完整运行；不将旧 CI 或内存探针描述为新 patch 的跨平台验证。

### Open Decisions Requiring the User

无产品决策。若同一路径发生混合修改，将按用户的提交边界停止并报告。

### Rejected Speculation

- 无证据要求修改 production SSE guard 或 logger 实现。
- 不以本次问题为由重构全部测试的全局日志隔离。
- 不扩大到冷存储、daemon 性能或 Windows 历史偶发超时。
- 不添加生产配置开关、日志 fallback、跨平台特殊等待。

## 21. Audit Contract

独立 auditor 根据原始需求和当前仓库重建全部 affected interface；不信任 builder transcript。审查完整需求映射、primary owner、无 fallback、测试灵敏度、作用域、代码质量和中文注释门禁。每次 revision 按完整原始需求重审。primary 不加载 audit skill 或自审。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | 见原文 | APPROVE | ses_efaa7a2e4ffei4ycn8Od1GWOj8 |

以下为独立 auditor 返回的原文：

### Blocking findings

No blocking findings.

### Non-blocking findings

- 本轮直接核对了现有源码、CI 失败日志及工作区状态，未重新运行测试。方案第 8 节的本地执行结果仍属于待实施阶段重新验证的证据，不作为本轮独立复现结果。
- `Log.init()` 完成不保证文件写入一定成功：失败的 writer 也会成为终态 writer（`packages/core/src/util/log.ts:147`）。方案保留强制基线读取和正常组正断言，因此该表述差异不会造成假绿，无需扩展生产修复范围。

### Rejected speculation

- 没有证据要求修改生产 SSE cancellation 或 logger。当前日志目标切换符合接口行为。
- 不要求全局测试日志隔离框架、并发 writer 防护、额外 timeout 或配置开关。当前变更没有引入这些责任。
- 冷存储、daemon 和其他 agent 的既有修改不属于本次修复；没有发现本方案使相关缺陷新增可达。

### Requirement and traceability coverage

- **根因与 owner**：`project.test.ts` 在模块加载时切换日志目标（`packages/opencode/test/project/project.test.ts:18`），LSP 测试切换到 stderr（`packages/opencode/test/lsp/client.test.ts:21`）；SSE 测试仍读取固定 `dev.log`（`packages/opencode/test/provider/provider.test.ts:3058`）。首次分歧位于测试观测 setup，方案在该 owner 修复。
- **真实调用链**：plugin auth loader 提供 fetch → Provider 包装 fetch → `progressDeadline.wrap()` → SDK 消费流 → `timing()` → 进程级 writer。正常 EOF 的日志入口为 `packages/opencode/src/provider/provider.ts:249`，取消守卫位于 `packages/opencode/src/provider/provider.ts:244`。
- **回归敏感性**：三种前序日志模式均有真实 producer。先建立旧 dev 文件，再切换 timestamp/stderr，可使未修复测试在正常组正断言处失败；修复后仍要求正常组有 EOF、取消组无 EOF。
- **完整判别**：消费控制组至 EOF、按同一行识别 `race-b` 与 `sse.end`、删除吞错路径，均服务于既有测试契约，没有削弱断言。
- **范围与归属**：仅计划新增 canonical plan、修改现有 SSE 测试。已确认 `provider.test.ts` 相对 HEAD 无差异；提交前再次检查路径所有权的安排覆盖了其他 agent 的并行修改风险。
- **验证**：方案列出 package-local 的窄测试、原始两文件反馈环、相关套件、typecheck 和 Windows runtime 分片；远端验证限制明确。

### Primary-path and fallback verdict

通过。唯一判定路径是：初始化文件日志 → 读取实际日志路径与基线 → 执行真实取消/正常流 → 等待正常 EOF 日志 → 执行正负断言。

三种初态属于测试输入矩阵；polling 仅等待同一日志落盘。没有新增替代成功路径，生产 decision surface 变更为 0，诊断比例不适用。

### Code quality and Chinese-comment verdict

方案级通过。复用现有 `Log.init/file`、fixture、race helper 和 `ended` 判别，不新增生产接口、依赖或抽象。

第 17 节承诺按实际 diff 满足 `C >= max(1, ceil(E × 0.15))`；预计 `E≈12`、`C≈4`，注释位置与解释内容可行。实际 E/C、代码风格及测试结果须在实现审计重新核算。

### Release verdict

**APPROVE — 仅适用于 `docs/plans/ci-sse-regression-log-isolation.md` 的 R1，全范围方案审计。**

本结论允许记录 R1 的方案批准；不代表实现已验证，也不替代后续独立实现审计。

## 23. Implementation Evidence

### Actual Files and Diff

`packages/opencode/test/provider/provider.test.ts`: 17 additions / 7 deletions, 5 hunks; new Log import, existing SSE test parameterization, fixture/setup initialization, actual log path and strict baseline read, EOF drain, moved existing `ended` predicate and same-line readiness. No production/config/migration/generated edits. This new canonical plan is the only other task path. The implementation remains R1.

### Red-Green Test Evidence

1. 原始反馈见第 8 节：独立用例 1 pass，真实 project module 组合 1 fail（ENOENT）。
2. 添加三模式 fixture，但尚未加修复：`bun test ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000`，1 pass / 2 fail / 89 filtered，24.89s。timestamp/stderr 两组均在 `expect(ended("race-b")).not.toEqual([])` 失败（各约 10.2s），与 CI 断言完全相同。stderr 输出直接含正常 race-b 的 `phase=sse.end`，进一步证明生产正常 EOF 已执行而观测目标错误。
3. 加 owner 初始化、Log.file 和严格基线读取：相同命令 3 pass / 0 fail / 12 expect calls，4.61s；两文件原始反馈环 3 pass / 0 fail，4.62s。
4. 加批准的控制组 EOF drain 和同行就绪条件后：三模式窄测试 3 pass / 0 fail，9.86s；完整 provider.test.ts 92 pass / 0 fail，35.29s。

### Verification Commands and Results

所有 Bun 命令 cwd 均为 `packages/opencode`。未改变逐用例 30 秒预算；下述外层 timeout 是命令观察工具的终止上限。

| Command/check | Result |
| --- | --- |
| `bun typecheck` | PASS，`tsgo --noEmit`，exit 0；完整 runtime 结束后再次执行仍 exit 0 |
| `bun test ./test/provider/provider.test.ts --timeout 30000` | 92 pass / 0 fail / 228 expects |
| `bun test ./test/provider --timeout 30000 --dots` | 353 pass / 0 fail / 681 expects，59.22s |
| `bun test ./test/util/log.test.ts --timeout 30000` | 6 pass / 0 fail / 8 expects，5.03s |
| `bun test ./test/provider ./test/util/log.test.ts --timeout 30000 --dots` | 359 pass / 0 fail / 689 expects，35.12s |
| `bun test ./test/project ./test/util/log.test.ts ./test/provider --timeout 30000 --dots`（CI LSP/filewatcher flags） | 436 pass / 2 existing skips / 0 fail / 869 expects，15 files，588.54s；外层 900s 预算内正常退出 |
| 早期 full related 命令外层 300s、project/log 外层 240s、project 三组拆分外层 180s | 被外层终止，不能计为通过；没有保留运行进程。后续完整 588.54s 运行取代这些不完整结论，未跳过用例或改变用例 timeout |
| 独立排查 `project.test.ts -t "should throw error when project not found" --timeout 10000 --dots` | 1 pass，33 filtered，5.66s；该用例不是组合运行变慢的已证实根因 |
| `git diff --check -- packages/opencode/test/provider/provider.test.ts` | PASS |
| `bun x --no-install oxlint packages/opencode/test/provider/provider.test.ts`（repo root） | exit 0，0 errors / 5 warnings；警告对应未修改的既有泛型/类型断言代码，含原有 globalThis cast；未为清理警告扩大 diff |
| 对 HEAD 内容尝试 `oxlint --stdin-filename` | 本地 oxlint 不支持该参数，命令失败；不作为 lint 证据。既有警告归属按实际 diff 中未改动的对应代码核对 |
| 实际 runtime 分片，156 files，CI flags，外层 900s | 外层 timeout；无 test-shard-end/完整 JUnit，已捕获输出中无 `(fail)`，不可计为通过 |
| 相同 runtime 分片不改变逐用例 timeout 的完整重跑 | PASS：2909 pass / 13 existing skips / 0 fail，2922 tests / 156 files，16 snapshots / 12993 expects；child PID 34824 正常退出，`test-shard-end.code=0`、elapsed=3922173ms；stdout/stderr 分别保留在 `D:/Temp/opencode/ci-sse-runtime-20261004.stdout.log` 和 `.stderr.log` |

最终 JUnit：`packages/opencode/.artifacts/unit/junit-runtime.xml`，`tests=2922, failures=0, skipped=13`。三种 SSE testcase 均为 4 assertions、无 failure，耗时 dev=0.321880s、timestamp=0.419548s、stderr=0.373638s。完整运行使用当前共享工作区（包含其他 agent 的未提交冷存储测试），不能把相对远端 CI 的测试数增长全部归属于本修复。观察工具等待阶段最后一条 `Get-Process` 因 child 已退出返回非零，不代表测试失败；真实 exit 由 runner 的 `test-shard-end.code=0` 和 JUnit 共同证明。

早期 runtime 输出由工具保存在 `C:/Users/Lenovo/.local/share/opencode/tool-output/tool_10579d82b00127ftiM1v7w0MWA`，真实进度仍在 permission 测试，未据此判定永久挂死或引入额外修复。

实现审计第 1 轮要求可直接读取的执行证据，已补充下列原始日志（未改批准设计）：

| Evidence replay | Raw output | Result |
| --- | --- | --- |
| 最终两文件反馈环 | `D:/Temp/opencode/ci-sse-final-green.stdout.log`、`.stderr.log` | exit 0，3 pass / 0 fail / 12 expects，14.25s |
| `bun typecheck` | `D:/Temp/opencode/ci-sse-typecheck.stdout.log`、`.stderr.log` | exit 0，tsgo --noEmit |
| 单文件 oxlint | `D:/Temp/opencode/ci-sse-lint.stdout.log`、`.stderr.log` | exit 0，5 处既有 warnings / 0 errors |
| 原因敏感性 red 重放 | `D:/Temp/opencode/ci-sse-red-replay.stdout.log`、`.stderr.log` | 仅临时移除本次 owner 初始化并恢复固定 dev.log；保留最终 EOF 判别。exit 1，dev pass，timestamp/stderr 均在正常组正断言失败，1 pass / 2 fail / 10 expects，26.39s |
| 恢复后两文件 green | `D:/Temp/opencode/ci-sse-restored-green.stdout.log`、`.stderr.log` | exit 0，3 pass / 0 fail / 12 expects，7.03s |

red 重放只临时改变本 agent 的两行修复，随后精确恢复；前后 `git hash-object packages/opencode/test/provider/provider.test.ts` 均为 `5e74994e9dba6aee7d25d29c9e2b5146602bef1a`。未修改生产文件、其他 agent hunk 或 index。本项是已批准 TDD/验证的证据重放，不是方案行为变更；第 1 轮实现审计的代码 diff 仍完全相同。

### Original Feedback-Loop Result

最终代码运行 `bun test ./test/project/project.test.ts ./test/provider/provider.test.ts --test-name-pattern "SSE wrap:" --timeout 30000`：3 pass / 123 filtered / 0 fail / 12 expect calls，7.95s。直接涵盖原 first-divergence producer 与修复后的消费者。

### Actual Secondary and Replacement Path Inventory

第 11 节分类保持成立。三种模式只是同一测试输入；cancel/EOF 仍同一生产实现。移除两处测试 catch-to-success、硬编码目标和跨行就绪条件；无新 fallback、公开 API 或 production branch，production diagnostic ratio N/A。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| E | 10 | 17 added lines minus 1 import, 4 comments, 2 pure-move `ended` lines; remaining header 1 + init 3 + path/baseline 2 + EOF loop 3 + readiness 1 |
| C | 4 | 旧 dev 文件的回归意图；进程级 writer 的观测边界；EOF drain 防中间事件/吞错；同行就绪防跨请求组合 |
| C / E | 40% | 4 / 10 |
| Required minimum C | 2 | ceil(10 * 0.15) |

### Remaining Unverified Items

Independent implementation audit approved R1 in round 2 (record below). No new remote Linux/macOS CI is possible without push; do not claim remote CI passing. Existing 2 skips in full related suite and 13 in runtime are unchanged by this diff. No modified production paths require build/SDK generation. 本地 runtime 耗时约 65 分钟，未修改 CI 的 45 分钟 step timeout；这项本地性能观测不等同于远端 runner 耗时，本次不接管其他 agent 的性能调查。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings（代码）；执行证据待闭合 | 见原文 | BLOCK | ses_efa3befd8ffeqavcJo6rjwEy85 |
| 2 | R1 | yes | No blocking findings | 见原文；首次 TDD 输出留存、既有 lint warnings、远端 CI 未运行 | APPROVE | ses_efa3befd8ffeqavcJo6rjwEy85（复查） |

以下为独立 auditor 返回的原文：

### Blocking findings

No blocking findings.

源码与实际 diff 未发现可证实的阻断缺陷；执行证据核验尚未完成，因此本轮暂不放行。

### Non-blocking findings

- 已直接读取 runtime 的 stdout、stderr 和 JUnit：2909 pass、13 skip、0 fail，实际 child 退出码为 0；三种 SSE 初态各执行 4 个断言且通过。
- 计划第 23 节记录的 TDD red、最终两文件反馈环、typecheck 和 lint，目前未找到对应原始输出，不能仅凭 builder 的记录视为独立核验完成。
- 本地 runtime 耗时约 65 分钟属实。没有证据表明本次测试修改导致该耗时，不据此扩大到其他 agent 的性能调查。

### Rejected speculation

- 不要求修改生产 logger 或 SSE cancellation：日志目标切换符合现有接口，修复责任在测试观测 setup。
- 不要求增加全局日志隔离框架、并发 writer 防护或额外 timeout；当前 diff 没有引入相应执行条件。
- 不将共享工作区中的冷存储、daemon 修改或同文件其他既有代码纳入缺陷修复范围。

### Requirement and traceability coverage

- **首次分歧与 owner**：`packages/opencode/test/project/project.test.ts:18` 切换时间戳日志，`packages/opencode/test/lsp/client.test.ts:21` 切换 stderr；旧测试固定读取 `dev.log`。当前 `packages/opencode/test/provider/provider.test.ts:3060` 在测试 owner 建立文件日志前置条件，再读取 `Log.file()` 和严格基线，覆盖 INV-01/03。
- **生产调用链**：plugin auth loader → Provider custom fetch → `progressDeadline.wrap()` → SDK 流消费 → `timing()` → 当前 writer。已核对 `packages/opencode/src/provider/provider.ts:1696`、`packages/opencode/src/provider/provider.ts:1929`、`packages/opencode/src/provider/provider.ts:2020`。
- **回归判别**：`packages/opencode/test/provider/provider.test.ts:3094` 消费正常组至 EOF；`packages/opencode/test/provider/provider.test.ts:3112` 等待同一行正常组 EOF；正负断言保留。取消守卫和 EOF 日志的生产顺序见 `packages/opencode/src/provider/provider.ts:244`。
- **测试敏感性**：三种初态均有真实 producer。移除本次观测修复后，timestamp/stderr 的日志不会进入旧 dev 文件，正常组正断言能够失败；实际 TDD red 执行记录仍待核验。
- **范围与归属**：实际五个 diff hunk 全部对应 R1；新增计划全文已读。当前 provider 文件只有交接中的差异，仍未暂存；其他 agent 的 index 内容未被操作。最终提交归属检查尚未发生。

### Primary-path and fallback verdict

通过静态审计。唯一成功路径为：

初始化文件 writer → 读取实际路径和基线 → 执行真实取消/正常流 → 等待正常 EOF 日志 → 执行正负断言。

三种模式是输入矩阵，polling 只等待同一观测结果。两处吞错逻辑已删除，没有新增 fallback、生产接口或生产分支；生产诊断决策面比例不适用。

### Code quality and Chinese-comment verdict

- 未新增 `any`、类型抑制、unchecked cast、依赖或无关重构；复用既有 fixture 和判别函数。
- 独立重算：**E = 10，C = 4，C/E = 40%**。E 为测试声明 1 行、初始化 3 行、路径/基线 2 行、EOF 循环 3 行、就绪判断 1 行；排除 import 1 行、纯移动谓词 2 行、注释及文档。
- 四条中文注释分别解释旧文件夹具、进程级 writer 边界、真正 EOF 和同行判别，均邻近对应变更，满足注释门禁。
- `git diff --check -- packages/opencode/test/provider/provider.test.ts` 已独立执行并通过。其余执行门禁仍有待核验项。

### Release verdict

**BLOCK — 验证证据尚未闭合，当前没有已证实的代码阻断缺陷。**

放行前需要：
1. 授权在 `packages/opencode` 执行两文件 SSE 回归命令和 `bun typecheck`。
2. 提供 R1 的 TDD red 与 lint 原始执行结果定位，供直接核验。

本结论仅针对 R1 与当前两条任务路径，不代表远端 CI 通过，也不授权 commit 或 push。

以下为第 2 轮独立 auditor 返回的原文：

### Blocking findings

No blocking findings.

### Non-blocking findings

- 首次 TDD 输出未持久保存，无法追溯其原始执行顺序。已直接核验补充 red 重放：timestamp/stderr 均在正常组正断言失败，stderr 同时记录真实 `race-b sse.end`，证明错误来自观测目标。恢复后 green 日志与本轮独立执行结果一致。
- lint 原始输出为 5 warnings、0 errors；五处警告均对应实际 diff 未修改的既有代码。
- 远端 Linux/macOS 新 CI 未运行。本地 runtime 约 65 分钟的观测不证明本次修改引入性能回归，不扩大修复范围。

### Rejected speculation

- 不要求修改生产 SSE 或 logger：目标切换符合接口，首次分歧位于测试消费者的观测 setup。
- 不要求全局日志隔离框架、额外 timeout、并发 writer 防护或生产 test-only API。
- 不将其他 agent 的冷存储、daemon、性能调查及无关既有代码纳入本次修复。

### Requirement and traceability coverage

- **完整范围**：重新核对全部五个测试 diff hunk、R1 批准状态及新增证据记录；实现仍对应原始需求和批准设计，没有新增生产变更。
- **根因与责任**：project/LSP 测试可以改变进程级日志目标；`packages/opencode/test/provider/provider.test.ts:3060` 显式建立文件 writer，随后读取实际路径与严格基线，在消费者 owner 修复 INV-01/03。
- **真实调用链**：plugin auth loader → Provider custom fetch → `progressDeadline.wrap()` → SDK stream → `timing()` → 当前 writer。取消守卫与正常 EOF 顺序见 `packages/opencode/src/provider/provider.ts:244`。
- **行为覆盖**：`packages/opencode/test/provider/provider.test.ts:3094` 消费正常组至真正 EOF，`packages/opencode/test/provider/provider.test.ts:3112` 使用同行就绪判别；正常组正断言与取消组负断言均保留，没有吞错或削弱断言。
- **独立验证**：在 `packages/opencode` 执行两文件 SSE 原始反馈环，结果 **3 pass、0 fail、12 expects，10.02s**；`bun typecheck` 通过。已直接核验完整 runtime 原始日志及 JUnit：**2909 pass、13 skip、0 fail，child exit 0**。
- **归属边界**：当前 provider 文件与交接 diff 完全一致，仍未暂存；本轮未修改实现、计划或 index。最终提交前仍须复核两条任务路径及其他 agent 的暂存内容。

### Primary-path and fallback verdict

通过。唯一成功路径为：

初始化文件 writer → 读取实际路径和基线 → 执行真实取消/正常流 → 等待正常组 EOF 日志 → 执行正负断言。

三种日志模式属于测试输入矩阵；polling 仅等待同一日志落盘。两处吞错路径已删除，没有替代成功路径、责任外溢或新增生产分支。生产诊断决策面比例不适用。

### Code quality and Chinese-comment verdict

通过。

- 未新增 `any`、unchecked cast、类型抑制、依赖、无用抽象或无关格式化。
- 独立复算 **E = 10，C = 4，C/E = 40%**，满足中文解释注释门禁。
- E 包括测试声明 1 行、初始化 3 行、路径/基线 2 行、EOF 循环 3 行、就绪判断 1 行；排除 import 1 行、纯移动谓词 2 行、注释和文档。
- 四条新增中文注释分别解释旧文件夹具、进程级 writer 边界、真正 EOF 和同行判别，均邻近对应决策。
- 已核验 whitespace check、package-local typecheck、相关运行结果及 lint 原始输出。

### Release verdict

**APPROVE — 全范围实现审计通过，仅适用于 canonical plan R1 与当前实际 diff。**

精确审计对象：
- `docs/plans/ci-sse-regression-log-isolation.md`：R1，包含当前补充证据及上一轮审计记录。
- `packages/opencode/test/provider/provider.test.ts`：Git blob `5e74994e9dba6aee7d25d29c9e2b5146602bef1a`。

上一轮执行证据缺口已闭合。本结论不代表远端 CI 已通过，不替代提交前的路径归属检查，也不额外授权 commit 或 push。

## 25. Commit Evidence

Verified status 已由第 2 轮实现审计批准记录建立。Complete task paths: this canonical plan and `packages/opencode/test/provider/provider.test.ts`. Use `git commit --only -- <these two paths>` after adding only the new plan. Inspect all status/diff/cached diff/log before commit; leave unrelated staged/unstaged work intact. Commit message uses Chinese `test(provider): ...` with rationale paragraphs. No amend, no hook bypass, no push. 实际 commit id 由 Git history 和最终报告提供，避免为把自身 commit id 写入本文而追加无意义提交或 amend。

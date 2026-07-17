# Canonical Implementation Plan: PromptAsync Windows and macOS Race Isolation

> Status: verified
>
> Revision: R9
>
> Approved revision: R9
>
> Audit mode: implementation
>
> Requirement source: 原始需求与范围更正："调研相关Windows测试报错原因以及解决方案，在不退化测试质量的前提下解决部分竞态问题并且适当进行行为化测试，进行必要的主逻辑以及测试逻辑优化"；"不需要包含openTUI相关内容，其他内容都需要包含"
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-18

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 调研相关Windows测试报错原因以及解决方案，在不退化测试质量的前提下解决部分竞态问题并且适当进行行为化测试，进行必要的主逻辑以及测试逻辑优化

> 不需要包含openTUI相关内容，其他内容都需要包含

## 2. Explicit Non-Goals

- 不改变生产 `promptAsync` 的异步 HTTP acceptance 语义，不把错误吞掉后伪造成功，也不删除 Message 持久化断言。
- 不修改生产 `promptAsync` handler、SessionPrompt、公开 payload schema、generated SDK、数据库 schema、migration 或 request-usage 数据结构。
- 不增加固定 sleep、扩大 timeout、daemon fiber、私有 fiber 检查或 SQLite 直读来代替公开行为验证。
- 不包含用户明确排除的相关文件、workflow、release、package provenance 或 closure verifier 内容。
- 不处理与本任务无关的工作树修改、完整 suite 中其他已知 flaky/环境失败或桌面构建缺口。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 规定 Session、Message、Project、InstanceState、Server 和 Windows/PowerShell 术语；本任务涉及 Session Message 持久化与 Server handler。 |
| `AGENTS.md` | 要求测试从 `packages/opencode` 执行、使用 `bun typecheck`、避免弱化测试与无依据抽象。 |
| `packages/opencode/AGENTS.md` | 规定 Effect service、scope、InstanceState 和测试运行方式；禁止通过额外 fiber/started flag 掩盖生命周期问题。 |
| `packages/opencode/test/AGENTS.md` | 要求 Effect 测试使用真实 public seam，禁止用固定 sleep 等待 fork readiness。 |
| `packages/opencode/test/server/AGENTS.md` | HttpApi 测试应沿生产 router 顺序使用真实 server seam，避免内部实现断言。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | handler 负责 HTTP 映射；本方案不改变 handler。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、保持单一 primary path、证明 reachability、禁止 fallback，并执行 15% 中文解释性注释门禁。 |
| `.opencode/templates/canonical-plan.md` | 本文件遵循完整 canonical plan 字段和审计状态要求。 |
| `docs/adr/README.md` 与 `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 当前 ADR 无 Session/HttpApi 相关冲突；本任务不产生跨模块架构决策。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 用户提供的 macOS/Windows CI 日志 | 直接记录 `default promptAsync message was not persisted`，错误落在 `test/lib/effect.ts:139`。 | observed |
| `packages/opencode/test/server/httpapi-sdk.test.ts:214-255, 363-368, 675-728` | 定义 `serverPathParity` reset、文件级 cleanup、default/raw 场景、公开 Message 断言及当前异步测试顺序。 | observed |
| `packages/opencode/test/lib/effect.ts:125-141` | 定义已有 `pollWithTimeout` 和原始 timeout 症状。 | observed |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000 --test-name-pattern "matches generated SDK prompt no-reply routes"`（`packages/opencode`） | 单次窄测可通过，证明路径可达但不稳定。 | observed |
| 同一命令加 `--rerun-each 5` | 实际复现 `1 pass / 4 fail`，失败均为 `default promptAsync message was not persisted`，约 13-15 秒超时。 | observed |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000`（`packages/opencode`） | 完整 HttpApi SDK 文件一次运行 `16 pass / 0 fail / 45 expect`；说明问题是时序敏感而非静态路由必错。 | observed |
| 独立 `Server.Default().app` 两轮 Project/DB replay | 两轮均观察到 async Message；没有证据证明生产 PromptAsync 在正常独立进程中必然失败。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:308-330` | 显示 handler 对 promptAsync fork 完整 prompt 后立即返回 204。 | observed |
| `packages/opencode/src/session/prompt.ts:1596-2033, 2127-2163` | 显示 Message/Parts 与 noReply request usage 在 fork 内完成。 | observed |
| `packages/opencode/src/project/instance-store.ts:102-179` | 显示 instance disposal 及其与后台 fork 竞争的生命周期。 | reachable |
| `packages/opencode/test/fixture/db.ts:5-12` | 显示 `resetDatabase` 会 dispose instances、关闭 SQLite、删除 DB/WAL/SHM。 | observed |
| `packages/opencode/src/storage/db.ts:38-43, 92-103` | `OPENCODE_DB` 可指定绝对 DB 路径，Database client 在每个 worker 进程内缓存。 | observed |
| `packages/opencode/test/preload.ts:1-10, 34-86, 88-98` | 测试环境在任何 source import 前设置 XDG 目录、模型 fixture、实验开关、配置依赖标记、测试 home/managed config、cache version、认证环境清理和数据库；worker 必须保留这些必要契约，只把数据库改为传入的绝对路径。 | observed |
| `packages/opencode/test/session/goal.test.ts:795-866` | 已有真实 `Bun.spawn([process.execPath, "-e", ...])` 子进程与绝对 `OPENCODE_DB` 隔离模式。 | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts:1-60, 857-874` | 已有 child-process behavior test、stdout/stderr/exit 观察模式。 | observed |
| `packages/opencode/test/server/httpapi-promptasync-context.test.ts:90-119` | 已证明 `forkIn` 继承 InstanceRef/WorkspaceRef；生产 async path 不应被改写。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:181-205, 278-305` | `PromptPayload` 支持 noReply/messageID，request usage endpoint 是公开 HTTP contract。 | contracted |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:409-449` | request usage list/get 是公开 handler seam。 | observed |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts:267-274, 1136-1146, 2972-3045, 4201-4204` | request usage 属于生成 SDK 的 `Session` client；正确调用是 `sdk.session.requestUsage.get(...)`。 | observed |
| R1-R7 independent plan audit records | Earlier alternatives were rejected for cleanup contamination, uncorrelated abort, production contract changes, and unsupported error conversion; none authorized implementation. | observed / contracted |

## 5. Current Behavior

```text
SDK session.promptAsync({ noReply: true })
  -> HttpApi session handler
  -> promptSvc.prompt(...).catchCause(...).forkIn(handler scope)
  -> Message/Parts/request usage persist in the child fiber
  -> HTTP 204 already returned
  -> parent parity test polls public messages
  -> parent serverPathParity reset / afterEach may dispose InstanceState and SQLite
  -> active child fiber can race cleanup and fail the next rerun
```

The production endpoint intentionally accepts PromptAsync asynchronously. The
first divergence for the reported failure is the test owner combining a
process-global SQLite/InstanceState fixture with a background operation and
destructive reset/teardown. Changing production scheduling would alter the
public contract and is not necessary: the same behavior can be observed in an
isolated worker whose process and absolute database are private to that test.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Valid prompt noReply payload with existing Session | Generated SDK/TUI request | Payload schema, Session existence, instance context | SDK -> HttpApi -> forked SessionPrompt -> public Messages/usage | Worker behavior test owns process lifecycle; production owns prompt semantics | observed / contracted |
| Message/Parts become visible before request usage completes | SessionPrompt producer | Existing durable projector path | Background prompt fiber -> SQLite -> public APIs | Production persistence path; worker only observes | observed / reachable |
| Process-global database/InstanceState cleanup races active fiber | Parent test `resetState`/`afterEach` | `Database.Client` and fixture registries are process-global | Parent test -> child/background operation -> destructive cleanup | Current parent test lifecycle | observed / reachable |
| Isolated child process with absolute DB path | Parent test worker producer | Child has independent PID, DB client, XDG state and cleanup boundary | Parent Bun.spawn -> worker imports source after env setup -> child exit | Test harness owner | reachable / contracted by existing test patterns |

Speculative malformed inputs, future providers, and alternate persistence sources
do not justify production changes.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A valid PromptAsync request remains asynchronous and returns the existing 204 acceptance response; public Message and request usage are eventually observable through the real SDK. | Endpoint contract, handler, SessionPrompt and generated SDK. | Existing prompt no-reply parity test partially covers this. |
| INV-02 | The behavior test cannot let an active PromptAsync fiber, SQLite client, or InstanceState registry escape into the parent test process or later tests. | Process-global DB/registry evidence and reproduced rerun. | Existing test violates this by doing in-process reset/afterEach. |
| INV-03 | Default/raw HttpApi routes retain identical statuses, prompt role, Message count, literal texts and returned parity fields. | Existing parity contract. | `httpapi-sdk.test.ts:675-728`. |
| INV-04 | The worker observes the same public success contract: HTTP 200/204 statuses, Message texts `async hello`/`hello`, and request usage `completed`; failures propagate through child exit rather than being converted to success. | Public SDK APIs and child exit contract. | New worker behavior assertion plus parent parity assertion. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | No production divergence is established; the handler's async fork is the declared endpoint behavior. | Production HttpApi/SessionPrompt, preserve unchanged. | Standalone replay succeeds; context inheritance test passes. |
| INV-02 | Parent test performs destructive cleanup in the same process as a still-reachable fork. | `httpapi-sdk.test.ts` test lifecycle, not production handler. | Repeated test fails after reset; fixture and DB source show process-global cleanup. |
| INV-03 / INV-04 | Current parity test does not isolate the accepted async operation and stops at an unstable in-process observation. | Test behavior harness. | Exact user error and existing public route expectations. |

### Red-capable feedback loop

Run from `packages/opencode`:

```text
bun test test/server/httpapi-sdk.test.ts --timeout 30000 --test-name-pattern "matches generated SDK prompt no-reply routes" --rerun-each 5
```

Observed current result: `1 pass / 4 fail`, with the exact user-visible timeout
`default promptAsync message was not persisted`. The original test drives the
real SDK -> HttpApi -> SessionPrompt -> persistence chain; the approved test
repair must preserve that chain in child processes and make child failure
observable through exit/stderr.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| PromptAsync scheduling/production behavior | Existing HttpApi/SessionPrompt | Preserve async acceptance and persistence | No production divergence was proven | Handler cannot own test process isolation |
| Child process, DB, and preload-equivalent isolation | `httpapi-sdk.test.ts` plus worker script | A test-owned async operation must not share process-global cleanup state with its parent, and must run with the same necessary pre-import test environment | Existing repository subprocess/absolute DB patterns and `test/preload.ts` establish this owner and contract | Production DB/InstanceState must not gain test-only switches |
| Behavior observation | Worker SDK `session.messages` and `session.requestUsage.get` | Verify user-visible Message and terminal usage | Public generated SDK is the exact consumer seam | Direct SQLite/fiber inspection bypasses contract |
| Parent parity comparison | Existing `serverPathParity` | Compare independent default/raw worker results | Parent receives plain JSON and owns only comparison/reset after child exit | Worker should not decide cross-path parity semantics |

## 10. Single Approved Primary-Path Design

Preserve production `promptAsync` and move only the affected behavior scenario's
execution boundary into a test worker:

1. Add `test/server/httpapi-promptasync-worker.ts`, a non-`*.test.ts` Bun worker so Bun does not discover it as a standalone test.
2. The parent passes `serverPath` and a unique absolute DB path. Before dynamically importing any `src/` module, the worker reproduces the necessary `test/preload.ts` startup contract: unique `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME`; the repository model fixture as `OPENCODE_MODELS_PATH`; both experimental flags; isolated `OPENCODE_TEST_HOME` and `OPENCODE_TEST_MANAGED_CONFIG_DIR`; cache version `14`; all provider/server credential variables cleared; and the passed absolute `OPENCODE_DB`. It dynamically imports and calls `markConfigDependenciesInstalled` for the isolated config directory before importing production source. This is the existing test environment contract, not a provider workaround or alternate data source.
3. After that environment boundary, the worker initializes the same project prerequisites as `withStandardProject`: a temporary git-backed project, `formatter: false`, `lsp: false`, and the standard `hello.txt`/`needle.ts` files. It then invokes the real generated SDK `prompt` and `promptAsync` routes and observes public `messages` plus `sdk.session.requestUsage.get` until the accepted request is persisted and `completed`. It preserves the existing bounded public poll; no fixed sleep is added.
4. The worker asserts independent literal statuses, role, count and texts, writes one JSON result to stdout, and exits successfully only after the complete behavior is observed. Any assertion, HTTP error, or timeout exits nonzero with stderr; no error is converted to success.
5. The parent `httpapi-sdk.test.ts` spawns one worker for `default` and one for `raw`, parses their JSON result, and compares the returned public behavior using existing `serverPathParity`. The parent has no live PromptAsync fiber or child DB client to reset.
6. Existing parent cleanup remains. Worker cleanup runs after terminal public observation; if the worker fails, its process boundary ends the isolated DB/InstanceState instead of contaminating the parent test process.

```text
parent parity test
  -> child(default, absolute DB) -> public SDK behavior -> JSON/exit
  -> child(raw, absolute DB)     -> public SDK behavior -> JSON/exit
  -> independent expected-value parity comparison
  -> parent cleanup after both child processes exit
```

This is one test-harness primary path, not a production fallback or alternate
success implementation. Both workers execute the same production route and
public SDK consumer contract; only their process/resource boundary differs.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Production `promptAsync` fork -> SessionPrompt -> persistence | Current and preserved | primary contract | yes | 100% production path | preserve |
| Worker `default` invocation | Proposed | test process realization of primary contract | yes only after public assertions | 50% test paths | add |
| Worker `raw` invocation | Proposed | test process realization of primary contract | yes only after public assertions | 50% test paths | add |
| Parent JSON parity comparison | Proposed | diagnostic/behavior comparison | no; compares already observed outputs | test-only | add |
| Catch-and-success, synthetic Message, alternate data source, or production fallback | Not present/proposed | forbidden alternate success | yes | 0 allowed | reject |

The two workers are platform/resource realizations of one test behavior, not
competing production semantics. A child failure is a failed test, never a
success-shaped result.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| In-process `serverPathParity` prompt noReply scenario with shared DB reset | It tries to compare default/raw while an accepted async operation still runs in the parent process. | Child process + absolute DB isolates the operation and lets public completion be observed without parent teardown competition. | `packages/opencode/test/server/httpapi-sdk.test.ts:675-728` |
| Message-only timing assumption | It observes an intermediate durable state but not request usage completion. | Worker observes both public Message and request usage terminal behavior before emitting JSON. | Prompt worker behavior path |
| Any production scheduling change or test-side private completion registry | Earlier alternatives moved test concerns into production or shared cleanup. | The process boundary owns failure isolation without changing production. | Do not add |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01: preserve async PromptAsync behavior | Existing handler -> forked SessionPrompt | No production change | Worker invokes real `promptAsync`, observes eventual public result |
| INV-02: no active operation contaminates later tests | Existing production path inside isolated child | Add worker + parent spawn boundary | Worker exit/DB isolation; parent repeated test |
| INV-03: default/raw parity quality | Existing routes | Parent compares complete worker JSON result | Existing literal statuses/role/count/text assertions |
| INV-04: no fake success | Public SDK result + worker exit code | Child fails on any nonterminal/error and emits no success JSON | Parent rejects nonzero child and validates parsed expected values |

## 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Child worker script | INV-02 / INV-04 | Existing `Bun.spawn` test patterns and observed process-global DB/registry cleanup | Parent in-process teardown cannot safely own an active child fiber after the test body fails. |
| Absolute per-worker `OPENCODE_DB` | INV-02 | `Database.getPath` accepts absolute `Flag.OPENCODE_DB`; existing goal concurrency test uses per-test DB | Default test preload DB is process-global; changing production DB behavior is not allowed. |
| Public Message/request usage assertions in worker | INV-01 / INV-04 | Existing generated SDK methods and endpoint contract | Worker success without public assertions would only prove process exit, not user behavior. |
| Parent JSON parity comparison | INV-03 | Existing `serverPathParity` return comparison | Worker must not own comparison or duplicate expected-value policy. |

No production module, public interface, dependency, migration, configuration,
retry, cache, or fallback concept is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/server/httpapi-promptasync-worker.ts` | add | Reproduce the necessary preload environment before source imports, create one standard temporary project, run one real default/raw prompt behavior in an isolated process and absolute DB, and output JSON only after public terminal assertions. | +125 to +180 |
| `packages/opencode/test/server/httpapi-sdk.test.ts` | modify | Spawn the worker per server path for the prompt noReply parity case; retain independent expected values and existing cleanup. | +25 to +45 |

No production source, generated file, config, migration, or unrelated test file is
in the approved change set.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Run the existing prompt noReply parity test with `--rerun-each 5`; current in-process shared DB path reproduces `default promptAsync message was not persisted`. | Parent reset/afterEach can compete with the fork and contaminate the next rerun. | Add worker execution with isolated absolute DB, reproduce the necessary preload environment before source imports, and preserve public Message/request usage polling. | Original Windows/macOS failure loop, without changing production async semantics or changing provider selection. |
| 2 | Run the worker directly for `default` and `raw`; worker must fail nonzero on any HTTP/error/timeout and never emit a success JSON result before public completion. | A harness that only waits for process exit could hide a failed or incomplete prompt. | Assert public statuses, literal Message texts, request usage `completed`, and exit code in the worker. | No catch-and-success or process-only false green. |
| 3 | Run the parent parity test repeatedly and complete `httpapi-sdk.test.ts`. | Any path drift or parent cleanup interaction remains visible. | Both isolated worker results compare equal and all neighboring parity tests pass. | Default/raw behavior and complete HttpApi SDK regression. |

Expected values are independent literals (`async hello`, `hello`, `completed`,
HTTP 200/204). The parent must not assert worker internals, private helpers,
source text, call counts, or copied persistence logic.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 170 | Conservative upper bound for preload-equivalent worker setup, project setup, public assertions, parent spawn/JSON handling and lifecycle comments; excludes imports, blank lines, formatting, generated files, and this plan. |
| Required Chinese explanatory comments `C` | 26 | `max(1, ceil(170 * 0.15)) = 26`; comments must explain pre-import environment ordering, model/config fixture contract, absolute DB isolation, child failure/exit contract, public readiness intent, and parent/worker ownership. |

Qualifying comments must sit beside process/DB boundaries and non-obvious
behavior assertions. Comments that restate commands or variable names do not
count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000 --test-name-pattern "matches generated SDK prompt no-reply routes" --rerun-each 5` | `packages/opencode` | Original red-capable race loop becomes green through isolated workers and public behavior assertions. |
| `bun run test/server/httpapi-promptasync-worker.ts default <absolute-db>` | `packages/opencode` | Direct worker behavior, preload-equivalent startup contract, public Message/request usage contract, and exit/JSON contract. |
| `bun run test/server/httpapi-promptasync-worker.ts raw <absolute-db>` | `packages/opencode` | Same startup and behavior contract through raw route path. |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000` | `packages/opencode` | Complete HttpApi SDK parity regression; test count recorded from fresh output. |
| `bun test test/server/httpapi-promptasync-context.test.ts` | `packages/opencode` | Production fork context inheritance remains green. |
| `bun typecheck` | `packages/opencode` | Worker/test TypeScript remains type-safe. |
| `bun run test:ci` | `packages/opencode` | Original package CI result, with unrelated failures recorded rather than hidden. |
| `git diff --check` | repository root | No whitespace damage. |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | Isolated test worker is the owner of child process/DB setup. |
| Files modified | 1 | Existing parity test delegates only the affected behavior scenario. |
| Files deleted | 0 | No obsolete production or test file is deleted. |
| Production lines | 0 | Evidence does not prove a production PromptAsync contract defect. |
| Test lines | 125 to 195 net | Worker and parent spawn behavior, public assertions and explanatory comments. |
| Generated lines | 0 | Generated SDK is reused. |

## 20. Real Risks and Open Decisions

### Real Risks

- Child process startup is slower than an in-process test; the worker uses public readiness polling, not a fixed delay, and the package test timeout remains the existing 30 seconds.
- The worker must reproduce only the necessary preload contract before source imports; missing model fixture, config dependency marker, test home, managed config, cache version, experimental flags, or credential cleanup is an environment-contract failure, not a reason to add fallback behavior.
- The worker must set `OPENCODE_DB` before dynamic source imports; importing Database/Global before that boundary would collapse isolation and is a blocking implementation error.
- The worker must propagate nonzero exit/stderr and reject malformed/missing JSON; otherwise the process boundary would become a success-shaped fallback.
- The full suite may retain unrelated failures; focused repeated loop and complete HttpApi SDK output remain required.

### Open Decisions Requiring the User

None. The worker route preserves production async acceptance and gives the test a concrete isolation owner.

### Rejected Speculation

- Do not change production `promptAsync` scheduling merely to make the test immediate.
- Do not use a second parser, alternate data source, generated SDK change, registry fallback, private fiber state or SQLite direct read.
- Do not ignore child exit failures, parse partial stdout, or synthesize a successful JSON result after a timeout.
- Do not reuse the parent process's `OPENCODE_DB`, XDG directories, or global InstanceStore in the worker.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete current PromptAsync scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1-7 | R1-R7 | yes | Prior scope/teardown/contract findings | Recorded in superseded revisions | BLOCK / superseded before implementation | unavailable |
| 8 | R8 | yes | B-01: worker did not explicitly reproduce the necessary `test/preload.ts` environment contract before source imports. | Worker route, ownership and public behavior seam otherwise supported. | BLOCK / superseded | adversarial-auditor task `ses_08e028921ffeuKFnLcrlcqUi16` |
| 9 | R9 | yes | None | Section 2 could explicitly connect workflow/release/provenance/closure exclusions to the user-excluded openTUI scope; child cleanup operation remains implementation-defined. | APPROVE | adversarial-auditor task `ses_08dfc3b92ffejS4XH4YPV55VfQ` |

R9 is the revised plan after the first user-authorized fresh audit and is the
only approved implementation revision for this task.

### R9 Independent Auditor Verdict (verbatim)

No blocking findings.

## Blocking findings

None.

## Non-blocking findings

- Section 2 lists workflow, release, package-provenance, and closure-verifier content as excluded without explicitly stating that each item is excluded because it belongs to the user-excluded openTUI scope. The current plan is still internally consistent, but that relationship should be made explicit to prevent later scope ambiguity.
- The worker cleanup contract is described behaviorally, but the exact cleanup operation for the child’s `Database`/`InstanceStore` resources is left to implementation. The process boundary still provides the required parent-test isolation, so this does not block plan approval.

## Rejected speculation

- No production `promptAsync` repair is required merely because the asynchronous operation can outlive the HTTP 204 response. That is the contracted behavior of the endpoint.
- No malformed-payload guard, alternate persistence source, private fiber inspection, SQLite direct read, fixed sleep, timeout expansion, or synthetic success result is justified by the inspected producer-to-consumer path.
- The worker’s use of two child processes is not a production fallback: both children execute the same production `promptAsync` path and differ only in test-owned process/resource isolation.
- The lack of an independent production replay failure does not invalidate the test-harness repair; the repeated in-process test failure and shared process-global teardown path provide sufficient reachable evidence for the race.

## Release verdict

**APPROVE** — revision **R9** has no blocking findings and is eligible for the administrative transition:

```text
Status: approved
Revision: R9
Approved revision: R9
Implementation allowed: yes
```

This approval applies only to the exact R9 plan. Any substantive change to scope, ownership, behavior, test contract, or file plan requires a new revision and full-scope audit.

## 23. Implementation Evidence

Implementation follows the exact approved R9 route. No production source,
generated SDK, configuration, migration, database schema, or OpenTUI file was
changed.

### Actual Files and Diff

- Added `packages/opencode/test/server/httpapi-promptasync-worker.ts`: test-owned
  child process, preload-equivalent environment, standard project fixture, real
  generated SDK default/raw route execution, public Message/request-usage
  polling, JSON/exit contract, and cleanup.
- Modified `packages/opencode/test/server/httpapi-sdk.test.ts`: replaced only the
  in-process prompt noReply parity scenario with one isolated worker per route;
  retained parent `serverPathParity` comparison and cleanup.
- Tracked test diff: `28` added lines and `52` removed lines in the parent test;
  the worker is a new untracked file at audit time. No `packages/opencode/src`
  path changed.

### Red-Green Test Evidence

- Red baseline before the worker existed: the target test failed with child
  `Module not found ... httpapi-promptasync-worker.ts` and exit code 1.
- Original feedback loop before implementation: `1 pass / 4 fail` under
  `--rerun-each 5`, reproducing `default promptAsync message was not persisted`.
- Green direct workers: both `default` and `raw` returned statuses
  `session=200`, `prompt=200`, `asyncPrompt=204`, `messages=200`,
  `requestUsage=200`, `promptRole=user`, two messages, literal texts
  `async hello`/`hello`, and usage `completed`.
- Final focused rerun: `5 pass / 0 fail`.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun run test/server/httpapi-promptasync-worker.ts default <absolute-db>` | `packages/opencode` | pass; public behavior JSON and exit 0 |
| `bun run test/server/httpapi-promptasync-worker.ts raw <absolute-db>` | `packages/opencode` | pass; public behavior JSON and exit 0 |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000 --test-name-pattern "matches generated SDK prompt no-reply routes" --rerun-each 5` | `packages/opencode` | `5 pass / 0 fail` |
| `bun test test/server/httpapi-sdk.test.ts --timeout 30000` | `packages/opencode` | `16 pass / 0 fail / 41 expect()` |
| `bun test test/server/httpapi-promptasync-context.test.ts --timeout 30000` | `packages/opencode` | `2 pass / 0 fail / 7 expect()` |
| `bun typecheck` | `packages/opencode` | pass |
| `bunx prettier --check test/server/httpapi-sdk.test.ts test/server/httpapi-promptasync-worker.ts` | `packages/opencode` | pass |
| `git diff --check -- packages/opencode/test/server/httpapi-sdk.test.ts` | repository root | pass |
| `bun run test:ci` | `packages/opencode` | did not complete within 900s; existing `test/file/watcher.test.ts` timed out twice on `timed out waiting for file watcher update`, `install script` failed with `/usr/bin/bash: line 1: exec: env: not found`, and fixture disposal reported `test-hang disposal timed out after 5000ms` |

### Original Feedback-Loop Result

The user-visible persistence failure was reproduced before implementation and
the same command now completes `5 pass / 0 fail`. The parent no longer shares
the active PromptAsync fiber, SQLite client, XDG state, or InstanceState registry
with the child operation.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Result |
| --- | --- | --- |
| Production `promptAsync` handler -> forked `SessionPrompt` -> public Message/request usage | preserved primary contract | unchanged |
| Isolated worker `default` route | test realization of primary behavior | green; no alternate production semantics |
| Isolated worker `raw` route | test realization of the same primary behavior | green; parent parity matches default |
| Parent JSON/exit parsing and parity comparison | test diagnostic/comparison path | child failures remain nonzero failures; no success synthesis |
| Former in-process shared-DB prompt scenario | superseded workaround | removed from the target parity scenario |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 244 | Worker: 220 non-blank non-import/non-comment lines; parent: 24 substantive added lines. Excludes 4 import-only lines, 37 qualifying comment lines, blank lines, formatter-only changes, and the removed superseded block. |
| Qualifying Chinese comment lines `C` | 37 | Worker: 35; parent: 2. Comments are distributed beside environment, process, public-readiness, failure, and cleanup boundaries. |
| Ratio `C / E` | 15.16% | `37 / 244` |
| Required minimum `C` | 37 | `ceil(244 * 0.15) = 37` |

### Remaining Unverified Items

- The full `bun run test:ci` command is not a green release result in this local
  Windows environment because of the recorded file-watcher/install-script
  failures and timeout; these are outside the observed PromptAsync path and
  were not hidden or converted to success.
- macOS and Linux execution of the repaired worker was not available locally;
  the implementation uses Bun, absolute paths, generated SDK, and existing
  cross-platform `tmpdir`/child-process patterns, while the original Windows
  feedback loop is green.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | None | Worker temporary-directory removal uses best-effort `.catch(() => undefined)`; broader `bun run test:ci` remains non-green for unrelated watcher/install-script/disposal failures already recorded above. | APPROVE | adversarial-auditor task `ses_08dcedc22ffetOWp0ZiLfMvnW2` |

### R9 Implementation Auditor Verdict (verbatim)

No blocking findings.

## Non-blocking findings

- The worker suppresses errors from recursive temporary-directory removal with `.catch(() => undefined)` at `packages/opencode/test/server/httpapi-promptasync-worker.ts:260`. This does not hide PromptAsync failures—the child still exits nonzero for scenario failures, and the process boundary prevents parent-state contamination—but it can leave diagnostic cleanup failures unreported.
- The approved plan’s recorded `bun run test:ci` result is not a release-quality green result. The documented failures are outside the audited PromptAsync path, and the focused tests, context test, typecheck, and formatting checks independently pass. The full-suite failure remains an explicit unverified repository-level item rather than a defect in this implementation.

## Release verdict

**APPROVE** — the audited implementation satisfies approved revision **R9**, with no blocking findings. The focused PromptAsync regression loop, complete HttpApi SDK test file, context regression test, typecheck, and formatting checks all pass.

The broader `bun run test:ci` result remains non-green for unrelated watcher/install-script/disposal failures already recorded in the canonical plan; that limitation is explicit and does not block release of this scoped PromptAsync implementation.

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

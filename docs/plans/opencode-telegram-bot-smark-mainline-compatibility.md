# Canonical Implementation Plan: OpenCode Telegram Bot SMARK Mainline Compatibility

> Status: verified
>
> Revision: R13
>
> Approved revision: R13
>
> Audit mode: full-scope
>
> Requirement source: user instructions in the 2026-07-22 Session
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-23

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

The requirement is the combination of the following user instructions. Their
scope is assigned stable IDs for traceability; the quoted text is not rewritten.

- **REQ-01**: `grinev/opencode-telegram-bot  我研究研究这个仓库,然后将这个仓库相应的抓取到我们的third party文件夹里面,也就是目前我们需要研究研究这个机器人和我们仓库的一个兼容性问题,拉取到我们的third party文件夹里。`
- **REQ-02**: `由于我们当前open code做了相应的完整的修改,其整体的内容和端点等等可能都发生了一些变化,请你详细完整深度地对我们整体项目进行完整的研究,看看其兼容性如何,会不会发生相应的漂移等等问题。看看现有接口能不能对得上,以及现有API事件形状等内容。`
- **REQ-03**: `注意整体调研而不要进行修改，也就是先不要修改代码，整体构建完整方案，按照第一性原理构建，避免进行文件写入的副作用问题，如果需要实验请在缓存文件夹机械能`
- **REQ-04**: `避免影响全局环境与数据库`
- **REQ-05**: `同时question我希望能交互`
- **REQ-06**: `no more question`
- **REQ-07**: `opencode减少改动，理论上opencode已经有了完善的自行attach已有daemon的逻辑`
- **REQ-08**: The Session GOAL supplied by the user sets the terminal state to
  `verified-implementation-and-commit`, requires a canonical first-principles
  plan, independent full-scope plan and implementation audits, exact approved
  implementation, and a final commit without push.
- **REQ-09**: The Session GOAL supplied by the user explicitly imposes the
  following implementation gate, quoted verbatim:

  `E 排除空行、import-only、formatter-only、generated 和 pure-move 变化。必须满足 if E = 0: C = 0 与 if E > 0: C >= max(1, ceil(E * 0.15))。`

  `C 只计算邻近修改点并解释 invariant、真实边界、常量、测试意图、compatibility 或 safety 的中文注释。复述代码、翻译 identifier、重复测试名、显然流程、集中堆放和拆行凑数均不计入。`
- **REQ-10**: `克制但完整的甜点级别修改thirdparty的telegram-bot行为，同时克制性手术刀修改opencode的扩展性兼容性，使得telegram机器人能稳定与opencode链接运行，整体修改量最好在1200行以内的生产代码，避免破坏现有功能和接口，确保安全性和可维护性。`
- **REQ-11**: `理论上我觉得各种参数都能复用opencode的默认机制（譬如例如daemon启动逻辑就有自发现已有daemon而无需用户输入）`
- **REQ-12**: `理论上这个bot应该会注册成为一个TUI？不然理论上daemon在计数器归零之后就会自动退出，所以理论上bot应该能维持daemon不退出？（还是说我手动维持一个TUI？）`

The third-party source was fetched at tag `v0.22.3`, commit
`4367863fe6b5d1dd2ba33d5f7fa88ea69c782875`, under
`thirdparty/opencode-telegram-bot`. It is an independent nested Git checkout and
is ignored by the outer repository. This plan is the only outer-repository
artifact authorized in the current GOAL.

## 2. Explicit Non-Goals

- Do not continue implementation until the exact current revision receives an independent full-scope plan
  approval. After approval, implementation and commit are required by REQ-08.
- Do not change the daemon worker, Server routes, SQLite schema, database
  ownership, SSE producers, OpenAPI schemas, or generated SDK in OpenCode.
- Do not replace or fork the TUI's current `Daemon.ensure()` election, lock,
  health, stopping-owner, Windows launcher, or reconnect logic.
- Do not make the bot parse `tui-server.json`, acquire the daemon election lock,
  choose a port, or infer daemon ownership from a listening socket.
- Do not keep `opencode serve` as a failure-triggered local fallback. A local bot
  with no explicit `OPENCODE_API_URL` targets the shared daemon. Any explicitly
  configured Server URL, including loopback/custom-port URLs, remains a distinct
  shipped supported-domain branch and never activates after daemon failure.
- Do not add Workspace routing. This revision covers the current
  Project/directory domain only. A Workspace producer is not used by the bot's
  current single-user flow.
- Do not add multi-user, group-first, forum-topic, or parallel active-session
  behavior; `CONCEPT.md` explicitly excludes these product models.
- Do not change EventV2 migration code or add handling for additive events the
  bot does not consume, including `message.part.progress`, while the current
  `message.part.updated` producer remains available.
- Do not repair the observed `GlobalEvent` OpenAPI/runtime heartbeat metadata
  mismatch in this task. The bot accepts unknown raw global envelopes and the
  directory-less `server.connected`/`server.heartbeat` events carry no Session
  or Project mutation consumed by the bot.
- Do not install packages, run lifecycle scripts, or modify any global runtime,
  configuration, or database during planning or plan audit.
- Do not add a TUI identity, registration endpoint, synthetic heartbeat, second
  liveness SSE, or daemon-worker counter branch. The existing `/global/event`
  connection is the authoritative client/liveness seam.
- Do not let Project selection, Session attach/detach, background tracking, or
  model selection own the process-level SSE lifetime.
- Do not exceed 1,200 effective added or substantively modified production-code
  lines across OpenCode and the bot. Tests, docs, generated lockfile changes,
  imports, formatting, deletion, and pure moves are excluded from this cap.
- Do not initialize or recover OpenCode-backed scheduled tasks before the
  authoritative client is rebound and its Event transport has observed
  `server.connected`.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| Root `AGENTS.md` | Default branch is `dev`; tests and typecheck must run package-locally; prefer minimal cohesive changes; do not touch unrelated worktree changes. |
| `packages/opencode/AGENTS.md` | Preserves flat ESM module shape and the daemon/database conventions; no new namespace organization. |
| `packages/opencode/test/AGENTS.md` | Daemon tests must use isolated XDG paths, lock, and database; concurrent tests wait on observable readiness, not arbitrary sleeps. |
| `thirdparty/opencode-telegram-bot/AGENTS.md` | The bot is a single-user Telegram client; changes remain surgical, strict-TypeScript, localized, and verified with build/lint/test. The verbatim user authorization in REQ-09 has higher precedence than its English-comment preference for this exact implementation. |
| `CONTEXT.md` | Uses the canonical terms Session, Project, Workspace, Server, Status, Run state, and daemon; one Session belongs to one Project/directory; Run state and Bus ownership are process-local. |
| `docs/adr/README.md` | No new ADR is warranted: the plan exposes an existing daemon design rather than choosing a new load-bearing architecture. |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | Unrelated to this runtime change; no triage state or assignment files may be modified. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, one authoritative path, no new fallback, complete forward/reverse traceability, and the 15 percent Chinese explanatory-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines the required canonical-plan and audit-record shape. |
| Bot `CONCEPT.md` and `PRODUCT.md` | Preserve one active Telegram interaction, existing Session continuation, Question/Permission interaction, optional auto-restart, and remote Server support. |

## 4. Files and Evidence Read

Only evidence relevant to an affected interface, producer, consumer, or
verification seam is included below.

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts:222-428` | Existing owner discovery, stopping-owner wait, election, spawn, random internal URL, launcher PID, and status behavior. | observed |
| `packages/opencode/src/cli/cmd/tui/thread.ts:122-173` | Normal TUI obtains and reconnects to the shared daemon through `Daemon.ensure()`. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:111-184` | Existing TUI rebuilds one SDK client when daemon URL changes before the next SSE attempt. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/event.ts:41-97` | Current Project/workspace/directory filtering for global events. | reachable |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | OpenCode-owned random port, PID, token, channel, and control-port record; it must not become a bot contract. | reachable |
| `packages/opencode/src/cli/cmd/tui/worker.ts:430-590` | Lock publication, SSE/Session activity, launcher watcher, startup idle, and shared daemon ownership. | reachable |
| `packages/opencode/src/cli/cmd/daemon.ts:1-141` | Public daemon CLI currently exposes only safe `stop`; no status/start machine contract exists. | observed |
| `packages/opencode/src/cli/cmd/tui/attach.ts` | `opencode attach` accepts an already known URL; it does not discover the random daemon URL for an external client. | reachable |
| `packages/opencode/test/cli/tui/daemon.test.ts:1-1478` | Real isolated lifecycle coverage, including existing-owner reuse, stopping, launcher death, startup idle, Windows, and CLI stop. | observed |
| `packages/opencode/src/server/event.ts` and global/event handlers | 10-second SSE heartbeat and current global/raw stream behavior. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:18-95` | Every `/global/event` connection increments one process-level SSE count; there is no TUI identity check. | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts:321-355,418-455,478-584` | `tuiClients` is the global SSE count; any SSE client, Session activity, or maintenance prevents the default four-second idle shutdown. Launcher PID protects only the pre-first-SSE window. | observed |
| `packages/opencode/src/bus/global.ts` and `src/sync/index.ts` | GlobalBus is process-local; persistence does not forward live events between independent Server processes. | reachable |
| `packages/opencode/src/question/index.ts:70-213` | Pending Question ownership and `asked`, `replied`, and `rejected` producer events. | reachable |
| `packages/opencode/src/snapshot/index.ts:19-28` | `SnapshotFileDiff.file` remains optional for legacy/imported data. | contracted |
| `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts:11-64` | Provider catalog is InstanceContext/WorkspaceRouting scoped. | contracted |
| `packages/sdk/js/package.json` | Current repository SDK version is `1.15.3`. | contracted |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts:660-688` | `config.providers` accepts `directory` and `workspace`. | contracted |
| `packages/sdk/js/src/v2/gen/types.gen.ts:314-320,952-999,2768-2812,4363-4385` | Optional diff file, current global-event, additive event, and Provider query shapes. | contracted |
| `thirdparty/opencode-telegram-bot/package.json` and `package-lock.json:867-871` | Bot is locked to SDK `1.1.21`, not the current generated contract. | observed |
| Bot `src/opencode/client.ts` | One immutable client is bound to configured fixed URL at module evaluation. | reachable |
| Bot `src/opencode/process.ts` | Local path launches `opencode serve --port` and performs socket/PID-based termination. | reachable |
| Bot `src/opencode/auto-restart.ts` | Optional monitor restarts standalone serve and retains the fixed client URL. | reachable |
| Bot `src/opencode/events.ts` | Global/legacy SSE normalization and retry always read the fixed client; global-to-legacy behavior is existing compatibility. | reachable |
| Bot `src/app/bootstrap/start-bot-app.ts` | Settings/model refresh runs before the background auto-restart check; no daemon discovery occurs. | reachable |
| Bot `src/config.ts:12-20,193-205`, `src/runtime/bootstrap.ts:32-68,83-105,479-575`, README and `.env.example` | A trim-nonempty `OPENCODE_API_URL`, including loopback/custom ports, is an existing direct-Server contract; undefined, empty, whitespace, and wizard blank are the same optional-unconfigured input. | contracted |
| Bot `src/bot/index.ts:34-72` | The Event stream starts only from a ready callback when an attached Session or selected Project exists. | reachable |
| Bot `src/bot/services/event-subscription-service.ts:322-343,1047-1083` | Event transport lifetime is currently coupled to a non-empty Project directory and business callbacks. | reachable |
| Bot `src/app/services/project-switch-service.ts:53-86` and `src/bot/handlers/prompt.ts:90-98` | Project switch and Session mismatch close the entire Event transport, creating a zero-client window. | reachable |
| Bot `src/bot/commands/opencode-start-command.ts` | `/opencode_start` launches standalone serve and reports its child PID. | reachable |
| Bot `src/bot/commands/opencode-stop-command.ts` | `/opencode_stop` finds and kills a process by configured listening port. | reachable |
| Bot `src/app/services/model-selection-service.ts` | Provider call omits directory and uses one process-global catalog cache/in-flight request. | reachable |
| Bot `src/app/services/model-capabilities-service.ts` | Provider call omits directory; cache key is only Provider/model. | reachable |
| Bot `src/app/services/model-context-limit-service.ts` | Provider call omits directory; one global expiration/cache is shared across Projects. | reachable |
| Bot `src/app/services/variant-selection-service.ts` | Provider call omits directory. | reachable |
| Bot `src/bot/pinned/pinned-message-manager.ts:406-465` | Maps optional current-SDK diff file into required `FileChange.file`; existing message parsing is a shipped compatibility path. | reachable |
| Bot `src/app/managers/summary-aggregation-manager.ts:438-482,2045-2157` | Question resolution is logged only; Session diff is cast to required file; Permission already has a resolution callback pattern. | reachable |
| Bot `src/app/managers/question-manager.ts` | Active request and Telegram message IDs are available but cannot be resolved by matching request ID. | reachable |
| Bot `src/bot/services/event-subscription-service.ts:634-739` | Displays Questions; Permission resolution already clears matching Telegram state; Question resolution has no equivalent. | reachable |
| Bot `src/bot/callbacks/question-callback-handler.ts` | Telegram answers are interactive and eventually call the Question menu completion path. | observed |
| Bot `src/bot/callbacks/message-history-callback-handler.ts:208-310` | Fork checks `{data,error}`; Revert ignores the same SDK response error and reports success. | reachable |
| Bot `README.md:75-78,186-189,216-218,453-456`, `.env.example:30-42`, `docs/LINUX_SYSTEMD_SETUP.md:62-66`, `PRODUCT.md:28-57` | Public docs currently prescribe standalone serve/fixed-port topology and must describe daemon attachment after replacement. | contracted |
| Bot tests under `tests/opencode`, `tests/bot/commands`, `tests/bot/services`, `tests/app/managers`, `tests/app/services`, and `tests/app/start-bot-app.test.ts` | Existing public seams and regression locations for process, reconnect, commands, Question, model, diff, and startup behavior. | observed |
| Bot `src/app/services/scheduled-task-runtime-service.ts:101-114,188-265,297-368,411-441` and executor service | Startup recovery immediately executes a persisted due task and consumes `opencodeClient`; current startup initializes it before OpenCode acquisition. | reachable |
| Bot `tests/app/services/scheduled-task-runtime-service.test.ts:170-224` | A persisted task due at startup executes immediately, providing the behavior seam for ready gating. | observed |
| Isolated Server probe on port `44197` with `OPENCODE_DB=:memory:` and cache-only XDG/HOME | Auth, current SDK routes, global/raw SSE shapes, Provider directory scoping, heartbeat, and resolved `{error}` semantics were exercised without global state. | observed |
| Current `packages/sdk/js` and `packages/opencode` `bun typecheck` | Both current producer packages typecheck before implementation. | observed |
| Current `test/server/httpapi-sdk.test.ts` (`16 pass, 0 fail`) and related HTTP/Event tests | Current Server and generated SDK agree on the exercised main routes. | observed |
| Temporary bot/current-SDK compile | Produces `TS2322` at pinned diff mapping because `file` is optional; unrelated missing grammY declarations are excluded. | observed |
| First real bot build after installing exact SDK `1.15.3` | Produces stale `@ts-expect-error` failures in `file-download-service.ts` and `telegram-client-options.ts`, plus a DOM `RequestInit` versus node-fetch v2 `RequestInit` mismatch at the real Telegram file-download call. | observed |
| R8 partial implementation inspection | `startBotApp()` awaits one-shot acquisition before `bot.start()`, and daemon Event retry never invokes status/ensure recovery, so polling can remain unavailable and a replacement daemon URL cannot rebind. | observed |
| Isolated `bun src/index.ts daemon start --json` and `daemon status --json` on 2026-07-22 | Both exit `1` because the machine attach/start CLI seam does not exist. | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts:721-765` | A raw non-TUI `/global/event` client changes private status `tuiClients` from 0 to 1, proving a bot SSE is sufficient for daemon liveness. | observed |

## 5. Current Behavior

### 5.1 Local TUI path

```text
TUI command
  -> Daemon.ensure(args)
  -> existingOwnerUrl() reads OpenCode-owned ServerLock
  -> reuse live owner OR wait for stopping owner OR elect and spawn one worker
  -> random loopback URL
  -> TUI SDK + global SSE
  -> reconnect calls Daemon.ensure() and rebuilds the SDK client
```

The daemon owns one SQLite writer, one process-local GlobalBus, one Session Run
state map, and one SSE producer. The worker retains startup liveness while its
launcher PID is alive until the first SSE client arrives.

### 5.2 Current local bot path

```text
OPENCODE_API_URL (default localhost:4096)
  -> immutable SDK client
  -> /opencode_start or auto-restart
  -> opencode serve --port 4096
  -> independent Server process
  -> independent GlobalBus and Session Run state
```

When a normal TUI and the bot run together, the TUI uses the random shared
daemon while the bot uses standalone serve. Sharing a SQLite file does not share
live Bus or Run state. A prompt, abort, Revert, Question, or status transition
can therefore be observed or controlled through different process-local owners.

### 5.3 Current API compatibility

- The bot's principal SDK method names and current Server routes still exist.
- Current generated SDK responses resolve to `{ data, error }` by default.
  `session.revert` returning HTTP 404 was observed to resolve with `error` and
  not throw; the bot reports success because it ignores that field.
- Provider catalog resolution is Project/directory scoped. Four reachable bot consumers
  omit directory, and their caches can retain one Project's catalog after a
  Project switch.
- `SnapshotFileDiff.file` is optional in current SDK. The bot stores only named
  file changes but currently maps the optional field as required.
- The global stream envelope remains consumable by the bot. Directory-less
  connected/heartbeat events contain no consumed Session mutation, while
  handled Project events observed in the probe include routing metadata.
- `OPENCODE_API_URL` is an explicit public Server target. Current loopback URLs
  also own `/opencode_start`, `/opencode_stop`, and auto-restart through their
  configured port; this is a supported mode, not an accidental fallback.

### 5.4 Current Question path

```text
Question.ask
  -> question.asked on shared Server Bus
  -> bot shows Telegram poll
  -> Telegram answer -> question.reply -> question.replied -> TUI observes result
```

The basic Telegram answer path exists. The reverse race is incomplete: if TUI
answers or rejects first, the bot receives `question.replied` or
`question.rejected`, but only logs it. Its matching Telegram interaction and
messages remain active until another local action clears them.

### 5.5 Current daemon-liveness gap

The daemon does not distinguish a TUI from another global SSE client:

```text
/global/event -> sseClientCount++ -> worker.sseClients -> isActive()
```

The private status field is named `tuiClients`, but a raw HTTP client is counted
by the existing integration test. The bot can therefore keep the daemon alive
without TUI registration. The current bot nevertheless opens its Event stream
only after ready restoration finds an attached Session or a selected Project,
and Project/session reset paths close the whole stream. A cold local bot with no
Project has no SSE client; a Project switch can transiently drop the count to
zero; and the legacy `/event` fallback is not counted by the daemon at all.

The daemon's default regular and startup idle windows are four seconds. A live
launcher PID prevents shutdown only before the first global SSE. After one SSE
has connected, persistent liveness belongs to the stream, not the launcher.

### 5.6 Current scheduled-task startup race

```text
load settings -> create bot -> scheduledTaskRuntime.initialize()
              -> recover due task -> executeScheduledTask() -> fixed client
              -> background OpenCode startup check runs later
```

A persisted one-time task whose `nextRunAt` is already due executes immediately
during initialization. Under a fail-closed daemon client it can fail and clear
its next run before daemon acquisition/rebinding. Connection readiness must be a
startup orchestration precondition; the scheduled-task service must not acquire
or recover the connection itself.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Existing healthy shared daemon | Normal TUI or earlier bot start | OpenCode lock/election identifies one owner and URL | bot startup/reconnect -> daemon status CLI | OpenCode daemon adapter | observed |
| No shared daemon at local bot startup | Bot service starts | `Daemon.ensure` elects exactly one owner using default OpenCode state | startup start/ensure -> shared owner -> SDK -> global SSE | OpenCode daemon + bot connection lifecycle | contracted |
| Existing unresponsive but live owner | Long/blocking owner operation | `Daemon.ensure` must not create a second owner | status/start returns same owner; SDK health remains unavailable until recovery | OpenCode daemon adapter | reachable |
| Owner is stopping | `opencode daemon stop` or idle shutdown | Existing ensure waits for owner exit before election | explicit start -> existing ensure -> wait/new owner | OpenCode daemon adapter | observed |
| Bot starts daemon before opening SSE | Local bot startup or `/opencode_start` | worker watches the supplied live bot PID only until first SSE | CLI start -> daemon worker -> immediate global SSE | OpenCode daemon lifecycle | observed |
| Daemon random URL changes unexpectedly | daemon exits after ready | every owner writes a fresh lock; explicit stop changes desired state | bot SSE retry -> status or ensure by recovery policy -> client rebind -> global SSE | bot connection orchestration | reachable |
| Explicit non-loopback `OPENCODE_API_URL` | explicit bot configuration | URL is a caller-selected Server | bot SDK direct to remote Server; no local daemon CLI | bot connection mode | contracted |
| Explicit loopback/custom-port `OPENCODE_API_URL` | explicit bot configuration or wizard | URL is a caller-selected local Server and current process management targets its port | bot direct Server client; existing serve/start/stop/monitor branch | bot connection mode/process adapter | contracted |
| No effective `OPENCODE_API_URL` | undefined, empty, whitespace, or wizard blank | trim-normalization selects the new default local discovery contract | daemon ensure + process global SSE | bot configuration/mode | contracted |
| Project-scoped Provider catalog | selected Project in settings | settings store exposes canonical `worktree` | model/variant/media/status consumer -> `config.providers({directory})` | bot Provider consumers | observed |
| Project changes while cache is live | `/projects` or `/worktree` | selected Project worktree changes | next catalog read -> directory-aware cache | bot cache owner | reachable |
| SDK response with `error` and no throw | current generated client default | error is represented in response tuple | Revert callback -> response branch | bot SDK adapter | observed |
| Diff entry without `file` | legacy/imported Snapshot data | SDK schema explicitly permits omission | Session diff endpoint/event -> pinned/summary mapping | bot display adapter | contracted |
| Question answered in Telegram | authorized single user | current Question manager has matching request | reply endpoint -> shared daemon -> TUI event | Question workflow | observed |
| Question answered/rejected in TUI first | second client on same daemon | shared Bus emits matching request ID | global SSE -> aggregator -> Telegram cleanup | Question workflow | reachable |
| Bot has no selected Project or attached Session | Fresh setup or detach | global stream itself requires no directory | process-level SSE consumes connected/heartbeat while business filter is empty | bot Event transport | reachable |
| Project/session selection changes | Telegram UI | selected directory changes independently of transport | update Event filter/consumer without closing global SSE | bot Event transport | reachable |
| Explicit `/opencode_stop` | Authorized Telegram user | command is an intentional desired-state transition | mark stopped -> abort SSE -> safe daemon stop -> suppress reconnect | bot connection lifecycle | reachable |
| Local global stream fails | network/daemon loss | legacy `/event` does not increment daemon liveness count | connection failure -> rediscover/reconnect global stream only | bot local Event transport | observed |
| Persisted scheduled task is due at startup | settings store recovery | runtime executes due tasks immediately once initialized | startup waits for authoritative connection ready, then initializes runtime once | bot startup orchestration | observed |
| Workspace-only routing | no current bot producer | no Workspace selection in bot | no supported path | not applicable | speculative |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A local TUI and local Telegram client that operate on the same Session use the same shared daemon, Bus, and Run state owner. | REQ-01, REQ-02, daemon/TUI and isolated runtime evidence | No bot-to-daemon integration test |
| INV-02 | Local bot startup always invokes the existing daemon ensure path: it reuses a live owner or starts exactly one absent owner without user-supplied port, URL, lock, or attach arguments. | REQ-10, REQ-11 | Bot absent; OpenCode TUI ensure tests cover owner semantics |
| INV-03 | An unexpected daemon URL change rebinds all SDK calls and the one process-level global SSE; failure never routes to standalone serve or the configured local fixed port. | TUI reconnect precedent, REQ-07 | TUI SDK test only; bot absent |
| INV-04 | OpenCode remains the sole owner of lock parsing, owner election, stopping waits, launcher semantics, and safe stop. | REQ-07 and current daemon modules | Extensive daemon lifecycle/stop tests |
| INV-05 | Every Provider catalog read and cache is scoped to the currently selected Project worktree. | Provider probe and HttpApi contract | Existing bot model tests do not assert directory/project switch |
| INV-06 | Current SDK response errors are treated as operation failures even when no exception is thrown. | observed Revert 404 tuple | Fork covers this in source; Revert test absent |
| INV-07 | A nameless legacy diff entry cannot enter required `FileChange` state or crash rendering; named entries remain displayed. | current SDK/Snapshot contract | Existing pinned/summary tests omit nameless case |
| INV-08 | Question remains interactive from Telegram, and a matching TUI reply/reject clears the stale Telegram interaction without clearing an unrelated request. | REQ-05 and current Question events | Question manager and Permission resolution precedents only |
| INV-09 | Connection mode is selected by effective configuration, not hostname or key presence: undefined/empty/whitespace `OPENCODE_API_URL` means shared daemon; any trim-nonempty URL preserves direct Server semantics, with existing local management for loopback targets. | existing normalization/config/wizard/docs contract and REQ-11 | Existing local/remote tests; empty/whitespace mode missing |
| INV-10 | All tests and probes use isolated lock/XDG/database state; implementation changes no database schema or global state. | REQ-03, REQ-04, test instructions | Existing daemon fixture enforces isolation |
| INV-11 | OpenCode changes are a thin adapter over existing daemon behavior; worker, Server, DB, Event, and generated SDK semantics are unchanged. | REQ-07 | Existing lifecycle and HTTP regressions |
| INV-12 | Public bot documentation describes the actual shared-daemon topology and no longer instructs normal local users to create a parallel serve process. | REQ-01, REQ-02 | Documentation review |
| INV-13 | After local acquisition and before reporting OpenCode ready, the bot establishes one `/global/event` stream and keeps it open for the bot-process lifetime, even with no Project, Session, or background tracking. | REQ-12 and daemon SSE counter evidence | Raw SSE count test exists; bot behavior absent |
| INV-14 | The bot is a normal global SSE client, not a registered or simulated TUI; its stream alone keeps daemon `isActive()` true and no manual TUI is required. | REQ-12 and current handler/worker code | Raw non-TUI client increments `tuiClients` |
| INV-15 | Project switch, Session attach/detach/mismatch, and business-event filtering update consumer state without closing the process-level global SSE. | REQ-10, REQ-12 and current stop call sites | Existing behavior closes the stream |
| INV-16 | Local shared-daemon mode treats global SSE as mandatory; legacy Project SSE remains an existing remote/old-Server compatibility branch only and cannot represent local success. | daemon count producer and bot fallback path | Existing events tests cover unqualified fallback |
| INV-17 | Explicit `/opencode_stop` suppresses bot reconnect until `/opencode_start` or bot-process restart; ordinary bot shutdown closes only its SSE and leaves shared-daemon idle policy authoritative. | Existing start/stop product interface and shared ownership | Existing command tests cover old process semantics |
| INV-18 | Effective production-code changes remain at or below 1,200 lines and do not add a database, migration, dependency, second Event stream, or duplicate daemon implementation. | REQ-10 | Implementation diff calculation required |
| INV-19 | Both the nested bot repository and outer OpenCode repository receive verified, scoped commits without push; unrelated outer staged/worktree changes remain untouched. | REQ-08 and current two-repository topology | Final Git evidence required |
| INV-20 | Every OpenCode-backed startup consumer, including persisted due scheduled tasks, initializes only after client rebinding and mandatory global SSE readiness; a due task then executes exactly once. | scheduled runtime/executor call path | Existing due-task test lacks connection gate |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-04 | The bot's local process adapter chooses `opencode serve --port` instead of acquiring the OpenCode shared-daemon connection. | Bot `src/opencode/process.ts`; OpenCode daemon CLI is the cross-process seam | Source path plus runtime observation of two processes and process-local buses |
| INV-02, INV-11 | OpenCode has complete in-process discovery/ensure logic but no machine-readable external CLI for ensure/status and launcher-PID delegation. | `packages/opencode/src/cli/cmd/daemon.ts` over `tui/daemon.ts` | Isolated `daemon status/start --json` both exit 1; current CLI registers only stop |
| INV-03 | The bot exports an immutable SDK client created from fixed config at module evaluation. | Bot `src/opencode/client.ts` | Source and current SSE retries |
| INV-05 | The first directory-free Provider call occurs in each catalog-owning service/command, before the request reaches InstanceContext middleware. | Bot Provider consumers | Isolated Provider probe differs with and without directory |
| INV-06 | Revert callback discards the SDK response before checking `error`. | Bot message-history callback | Observed 404 resolves with `threw:false`; source unconditionally reports success |
| INV-07 | SDK diff is mapped to required display state without narrowing `file` to a string. | Bot pinned and summary adapters | Current-SDK compile TS2322 and Snapshot schema |
| INV-08 | Aggregator switch logs resolved Question events and exposes no callback to the Question workflow. | Bot summary aggregator/event subscription service | Source comparison with existing Permission resolution callback |
| INV-12 | Docs encode standalone fixed-port Server as the normal shared workflow. | Bot README/PRODUCT/env/systemd docs | Direct documentation references |
| INV-13, INV-14, INV-15 | The bot's first Event subscription is owned by ready restoration and requires a Project directory; Project/session reset callers invoke `stopEventListening()`. | Bot bootstrap, bot index, Event service, project switch, prompt reset | Current call graph and daemon four-second idle predicate |
| INV-16 | `events.ts` treats global failure as permission to succeed through legacy `/event`, but only global connections increment daemon liveness. | Bot Event adapter and OpenCode global/event handlers | Current source plus raw global SSE counter test |
| INV-17 | Current stop kills a fixed-port process and has no desired connection state because no persistent shared connection exists. | Bot stop command/process adapter | Current source |
| INV-09 | R3 classified mode by hostname and would reinterpret an explicit loopback Server URL as daemon discovery. | Bot config/wizard/process public contract | Explicit URL producer currently reaches direct client and local process management |
| INV-20 | `scheduledTaskRuntime.initialize()` runs before background OpenCode startup and immediately executes due persisted tasks. | Bot startup orchestration | Runtime source and existing due-at-startup test |

### Red-capable feedback loops

1. OpenCode public seam, working directory `packages/opencode`, isolated
   `HOME`/XDG/config and `OPENCODE_DB=:memory:`:

   ```text
   bun src/index.ts daemon status --json
   bun src/index.ts daemon start --json
   ```

   Observed on 2026-07-22: both exit `1` with no machine response. Either future
   command must fail before implementation and pass only after the public seam
   exists.

2. Bot/current SDK compile harness in the approved cache root:

   ```text
   bun typecheck
   ```

   Observed: `TS2322` at pinned-message-manager diff mapping because current
   `SnapshotFileDiff.file` is optional. Missing third-party package declarations
   from the intentionally uninstalled checkout are excluded from this signal.

3. Isolated two-process runtime probe:

   ```text
   normal TUI -> random daemon URL
   bot old local path -> fixed standalone serve URL
   ```

   Observed: separate process-local event streams and Run state despite shared
   route/storage compatibility. The implementation regression must instead
   show bot status/start returning the same daemon PID/URL as the TUI path.

4. Current SDK Revert probe returned HTTP 404 as `{ error }` with `threw:false`.
   The callback-level regression must assert error UI rather than success UI for
   that resolved tuple.
5. Current OpenCode integration test `daemon private status reports current TUI
   client count` drives a raw `/global/event` request and observes
   `tuiClients: 0 -> 1`. It is the red-capable public seam for a future bot-like
   client test: current bot startup cannot produce that transition without a
   selected Project/ready callback, while the R5 startup test must.
6. Existing scheduled runtime test with a past `nextRunAt` observes immediate
   execution during `initialize()`. The R5 startup integration slice must keep
   that executor at zero before `server.connected`, then observe exactly one
   execution after ready.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Discover/reuse/start shared daemon | OpenCode daemon module | One owner and actual random loopback URL | It already owns lock, election, health, stopping, and spawn | Bot must not duplicate private lock protocol |
| Machine-readable cross-process acquisition | OpenCode daemon CLI | Stable JSON status/start result | CLI is the process boundary already used for stop | Server API cannot be contacted before URL discovery |
| Launcher lifetime | `Daemon.ensure` spawn adapter | New worker observes the real long-lived launcher until first SSE | Worker already implements this invariant | Short-lived CLI child PID is not the bot lifecycle owner |
| Daemon/direct-Server mode selection | Bot configuration and connection orchestrator | No trim-nonempty URL selects daemon; every effective URL remains the selected Server | Configuration seam owns optional-value normalization | Key presence/hostname cannot distinguish blank input from explicit Server intent |
| URL rebinding | Bot client adapter | All importers observe current client | Existing module is the single SDK construction seam | Rebuilding clients in every service would duplicate behavior |
| Initial daemon acquisition | Bot connection orchestration calling OpenCode CLI | Local bot startup requires one usable shared owner | Bot owns its dependency startup; OpenCode owns ensure semantics | TUI and Server cannot start the independent bot service |
| Process-level global SSE | Bot Event transport | One stream represents connection readiness, liveness, events, and heartbeats | Event transport owns the external stream and daemon count | Project/Session managers only own filters and business state |
| SSE rediscovery/recovery | Bot connection orchestration | Unexpected disconnect honors desired state and auto-restart policy | Retry policy belongs with the long-lived client | OpenCode must not know Telegram product stop intent |
| Explicit stop state | Bot connection orchestration | `/opencode_stop` must remain stopped instead of being resurrected by retry | Product command owns intended state | Daemon idle/election cannot infer Telegram intent |
| Scheduled runtime readiness | Bot startup orchestration | OpenCode-backed runtimes start only after authoritative connection ready | Startup owns initialization order and has both dependencies | Scheduled-task service must not gain connection acquisition/fallback responsibility |
| Provider Project scope | Each bot Provider catalog owner using current settings Project | Catalog/caches describe selected Project only | These services own their cached data | Server already applies directory context and cannot infer omitted caller intent |
| SDK tuple adaptation | Bot callback adapter | Telegram success only after SDK success | External response compatibility belongs at the call site | Server and generated SDK already return correct errors |
| Optional diff adaptation | Bot display adapters | Only named files enter `FileChange` | Display model requires a name | Snapshot cannot strengthen legacy persisted schema |
| Question resolution | Bot Question workflow | Matching shared-daemon resolution clears Telegram state | It owns active interaction and message IDs | OpenCode emits events but cannot mutate Telegram UI |
| Documentation | Bot public docs | Installation/runtime instructions match behavior | Bot users consume these files | OpenCode core docs do not own third-party setup |

## 10. Single Approved Primary-Path Design

### 10.1 Authoritative local connection path

```text
bot local configuration
  -> OpenCode daemon CLI adapter
  -> existing Daemon owner classification/election/ensure
  -> machine JSON { running, url, pid }
  -> one mutable SDK construction seam
  -> one process-level global SSE reaches server.connected
  -> ready + all HTTP/Event consumers use that client and stream
  -> unexpected disconnect honors desired state and recovery policy
```

OpenCode receives only the cross-process adapter required by REQ-07:

1. Export a small daemon connection query from
   `src/cli/cmd/tui/daemon.ts` that reuses `existingOwnerUrl(false)` and returns
   the current internal URL and owner PID for a live responsive or unresponsive
   owner. It must preserve the existing no-second-owner rule and must not expose
   lock token, control port, database path, or lock-file location.
2. Allow `Daemon.ensure(args, options?)` to take an optional validated launcher
   PID. Existing TUI calls omit it and retain `process.pid`; the daemon CLI start
   command supplies the bot PID. Only the one environment assignment at daemon
   spawn changes. Existing-owner reuse does not mutate owner state.
3. Add `opencode daemon status --json`. It only queries the existing owner and
   emits `{ "running": false }` or
   `{ "running": true, "url": "http://127.0.0.1:<port>", "pid": <pid> }`.
   It never starts a daemon.
4. Add `opencode daemon start --json --launcher-pid <pid>`. It validates a
   positive safe integer, calls the existing `Daemon.ensure`, then emits the
   same running JSON. It reuses a live owner, waits for a stopping owner, or
   starts exactly one owner through the existing election path.
5. Preserve the current `opencode daemon stop` command unchanged.

The bot replaces local standalone-serve management with one connection
lifecycle and one Event transport:

1. Configuration trims `OPENCODE_API_URL` once. Undefined, empty, whitespace,
   and wizard blank produce no effective URL and mode `daemon`; every non-empty
   valid URL produces mode `server` for every hostname and port. No runtime
   failure changes modes.
2. Explicit Server mode creates the existing direct client. A loopback Server
   preserves current fixed-port start/stop/monitor behavior; a non-loopback
   Server remains direct-only. The local daemon CLI and liveness rules are not
   applied to either explicit Server branch.
3. Default daemon mode initializes the client against a fail-closed loopback URL
   that cannot accidentally contact port 4096, then sets desired connection
   state to `running`.
4. Startup loads settings, creates the bot/Event consumer, registers one-shot
   ready handlers, and begins Telegram polling independently. It then launches
   the connection lifecycle as a supervised background task. Acquisition
   failures stay unavailable and retry with abortable delay while polling
   remains available; they never terminate `bot.start()` or select another
   connection mode. Each daemon attempt runs `start --json` with the bot PID.
   Existing `Daemon.ensure` reuses a live owner or creates exactly one absent
   owner using OpenCode defaults. No user supplies a port, URL, lock path,
   Project path, or attach argument.
5. The returned URL rebuilds the one exported SDK client. The Event transport
   immediately opens `/global/event` and waits for `server.connected`; only then
   does startup mark OpenCode ready and refresh Session/Provider state. The bot
   PID bridges daemon liveness only until this first stream is counted.
6. The same global stream stays open for the bot-process lifetime. With no
   selected Project its business consumer is empty but connected/heartbeat are
   consumed. Project/session changes update directory and callback state in
   place; they never close the transport. Application shutdown closes its stream
   and lets the shared daemon's existing idle policy decide owner lifetime.
7. Daemon mode requires global SSE because that is the daemon liveness seam. A
   global subscription failure remains an unavailable/reconnect outcome and
   never succeeds through legacy `/event`. Explicit Server mode preserves the
   shipped global-to-legacy compatibility branch because it does not own a
   shared-daemon idle counter.
8. In daemon mode, `/opencode_stop` first sets desired state to `stopped`, closes the bot stream,
   invokes existing `opencode daemon stop`, and resets the local client to
   fail-closed. Event retry and auto-restart cannot resurrect it. `/opencode_start`
   sets desired state back to `running`, calls ensure, rebinds, and establishes
   global SSE before reporting success. Bot-process restart starts with desired
   state `running`.
9. The process-level Event transport reports every unexpected daemon-mode
   disconnect to the connection lifecycle before its next subscription attempt.
   While desired state is `running`, the lifecycle immediately queries status;
   a live owner URL is rebound even when auto-restart is disabled. When
   `OPENCODE_AUTO_RESTART_ENABLED=true`, an absent owner is ensured; when false,
   repeated status-only Event retries wait for a TUI or another OpenCode client
   to create one. In either branch the next subscription uses the live mutable
   client and only its `server.connected` restores ready. The flag controls
   owner creation after ready; initial acquisition always ensures once.
10. Concurrent startup, monitor, command, and Event recovery calls share one
   in-flight acquisition and generation guard so an older result cannot overwrite
   a newer desired state or URL. OpenCode's election remains the final
   single-owner authority.

Startup keeps Telegram polling available while acquisition retries, but gates
every OpenCode-backed runtime on the first authoritative ready transition:

1. Register ready handlers, create the Telegram bot, and configure the one Event
   business consumer without starting scheduled recovery.
2. Start Telegram polling and the supervised connection lifecycle independently.
   Acquisition retry is abortable on shutdown and cannot reject the polling
   promise. Rebinding plus `server.connected` publishes the first ready transition.
3. The ready refresh reloads Session/Provider state and a one-shot startup owner
   initializes `scheduledTaskRuntime` exactly once. A persisted due task cannot
   execute before this point and executes normally afterward.
4. Later unavailable/ready transitions reconnect Event and refresh caches but do
   not initialize the scheduled runtime twice. Shutdown is valid whether that
   runtime was initialized or still waiting.

This repairs the first divergence rather than reimplementing daemon attach in
the bot. The small OpenCode adapter replaces hundreds of lines of bot-side lock,
port, and platform ownership logic and leaves all semantic daemon decisions in
their existing owner.

### 10.2 Current SDK and Project contract

1. Pin the bot to `@opencode-ai/sdk` `1.15.3`, regenerate only its npm lock entry,
   and make no changes to OpenCode generated SDK files.
2. At each of the four reachable `config.providers()` consumers, obtain the
   authoritative selected Project from settings and pass
   `{ directory: project.worktree }`. If no Project is selected, the existing
   consumer-specific unavailable/default result remains explicit; no unscoped
   request is sent.
3. Add the selected Project worktree to model catalog, capability, and context
   cache identities. A Project switch cannot hit or await another Project's
   cached catalog. Existing same-Project TTL and stale-on-request-failure
   behavior is preserved and not expanded.
4. Revert destructures `{ error }` and enters its existing error UI branch when
   present, matching the already-correct Fork call.
5. Pinned and event-summary diff adapters narrow `file` to a non-empty string
   before constructing `FileChange`. Named entries are preserved. If the
   endpoint has no named entries, the pinned manager may use its already shipped
   message-part compatibility path; it does not synthesize a filename.

### 10.3 Bidirectional Question interaction

1. Add one Question-resolution callback to the aggregator, used for both
   `question.replied` and `question.rejected` after matching the current Session.
2. Add `questionManager.resolveRequest(requestID)` that returns the current
   Telegram message IDs and clears state only when the ID matches. An unrelated
   event is a no-op.
3. The event subscription service deletes those matching Telegram messages and
   synchronizes the interaction manager, mirroring the existing Permission
   resolution path. Telegram-originated replies remain idempotent because their
   local completion clears state before the echoed resolution event.
4. No OpenCode Question endpoint or event schema changes. Both TUI and Telegram
   use the same daemon producer; whichever responds first resolves the one
   pending request, and the other client observes the shared event.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Local shared daemon status/start/client path | proposed | primary-contract branch | yes | primary | add |
| Any explicit `OPENCODE_API_URL` direct Server | current | supported-domain primary branch | yes | about 12% | preserve, including loopback/custom ports |
| Explicit loopback Server start/stop/monitor | current | supported-domain branch within Server contract | yes | unchanged | preserve; never reached after daemon failure |
| Post-ready auto-restart disabled vs enabled | current/proposed | supported-domain branch within primary contract | yes | about 6% | preserve; status-only wait vs ensure after unexpected owner loss |
| Global SSE unavailable -> legacy Project SSE in explicit Server mode | current | existing shipped compatibility | yes | unchanged | preserve for explicit local/remote/old Server |
| Global SSE unavailable -> legacy Project SSE in local daemon mode | current if retained | forbidden liveness fallback | yes | zero allowed | reject; reconnect global stream |
| `session.diff` empty/unnamed -> parse existing message tool parts | current | existing shipped compatibility | yes | unchanged | preserve without expansion |
| Same-Project stale Provider cache after request failure | current | existing shipped compatibility | yes | unchanged | preserve; never cross Project |
| Explicit loopback Server `opencode serve` selected by configured URL | current | supported-domain branch | yes | unchanged | preserve |
| Fixed local `opencode serve` after daemon status/start failure | rejected | forbidden fallback | yes | zero allowed | reject |
| Bot parsing ServerLock or trying a second election | rejected | forbidden alternate implementation | yes | zero allowed | reject |
| Port-scoped PID discovery/kill in explicit loopback Server mode | current | existing shipped compatibility | yes | unchanged | preserve only in explicit Server branch; forbidden in daemon mode |
| Starting a new fixed external daemon Server | rejected | forbidden alternate implementation | yes | zero allowed | reject |
| Malformed/failed daemon JSON -> configured local URL | rejected | forbidden fallback | yes | zero allowed | reject; report unavailable |
| Separate heartbeat/liveness SSE beside business global SSE | rejected | duplicate primary transport | yes | zero allowed | reject; keep one process-level stream |
| Project/session reset closes process global SSE | current | responsibility leak | no | removed | replace with consumer/filter reset |
| CLI parse/health/start failure logs and Telegram error response | proposed | diagnostic path | no | estimated under 8% | add at orchestration seam |

The proposed diagnostic decision surface is estimated below the 10 percent
policy limit. New alternate success paths: zero.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Default-unset URL implicitly targets `localhost:4096` | Bot had no daemon-discovery mode | Omitted URL now selects shared daemon ensure | Bot config/client/bootstrap defaults |
| Immutable client bound to local 4096 | Standalone Server URL was stable | Daemon port is intentionally random across owners | Bot `src/opencode/client.ts` |
| Event transport tied to Project/Session reset | Original bot only needed business events from a fixed Server | Global SSE now owns shared-daemon liveness for the process | Bot Event adapter, project switch, prompt reset |
| README instruction to run serve plus TUI attach | Worked around independent client processes | Bot now acquires the same daemon directly | README/PRODUCT/env/systemd docs |
| Question resolution log-only cases | Single-client assumptions hid stale UI | Shared daemon makes cross-client resolution normal | Aggregator switch cases |

The global-to-legacy SSE path remains only for explicit remote/old Server
consumers, including explicitly configured loopback Servers. Default daemon mode
cannot invoke it because it does not participate in daemon liveness. Existing
serve/PID/kill helpers remain only behind explicit loopback Server mode and are
never a daemon recovery path. The message-based diff compatibility path remains
unchanged for persisted consumers.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01, INV-01 | bot local -> daemon CLI -> existing owner -> SDK | OpenCode daemon CLI/module; bot client/connection/process | Real isolated CLI start reuses the same owner PID/URL; bot connection consumes it |
| REQ-02 | current SDK/API/Event mapping | package pin and consumer adapters | SDK typecheck/build, HTTP SDK/Event tests, bot full suite |
| REQ-03, REQ-04, INV-10 | isolated lifecycle fixture | OpenCode daemon tests only use temp XDG/lock/DB; no migration | Test asserts isolated env; verification commands package-local |
| REQ-05, INV-08 | shared Question event -> matching Telegram cleanup | aggregator, Question manager, event service | replied and rejected clear matching UI; unrelated request remains; Telegram answer still works |
| REQ-07, INV-04, INV-11 | thin CLI over existing owner classification/ensure | `tui/daemon.ts`, `cmd/daemon.ts` | no-owner status does not spawn; existing owner reuses; stopping/single-owner regressions pass |
| REQ-10, REQ-11, INV-02 | local startup -> daemon start/ensure -> actual URL | bot startup/connection/process; OpenCode CLI | TUI-first, bot-first, and simultaneous starts return one owner with no user network arguments |
| INV-03, INV-17 | desired running -> rediscovery/recovery -> mutable client; desired stopped -> no retry | bot connection, client, events, commands | URL A/B recovery follows flag; explicit stop remains stopped; no serve fallback |
| INV-05 | current Project worktree -> Provider request/cache key | four reachable Provider service consumers | request includes Project A/B directory; B does not use A cache/in-flight result |
| INV-06 | Revert tuple check -> existing error UI | message-history callback | resolved error does not emit success and clears interaction as error |
| INV-07 | optional diff narrowing -> required display state | pinned manager and summary aggregator | mixed/nameless entries never create undefined file; named entries retained; all unnamed invokes existing pinned compatibility path |
| INV-09 | no effective URL -> daemon; trim-nonempty URL -> direct Server and existing local/remote management | config/bootstrap/client/connection/process/commands | undefined/empty/whitespace invoke daemon; explicit loopback remains exact target; no cross-mode fallback |
| INV-12 | actual topology in public docs | README, PRODUCT, env example, systemd guide | documentation search has no normal local `opencode serve` instruction |
| REQ-12, INV-13, INV-14 | ensure -> bind -> one global SSE -> `server.connected` -> ready | bot connection/Event transport; unchanged OpenCode global handler | no-Project bot raises daemon client count to 1 and survives beyond idle timeout without TUI |
| INV-15 | Project/Session changes update Event consumer/filter | events, event service, project switch, prompt reset | stream identity/client count stays stable across switch/detach/mismatch |
| INV-16 | local global failure -> unavailable/reconnect; remote global failure -> existing legacy branch | events/connection | local never calls legacy subscribe; remote compatibility still does |
| INV-18 | scoped implementation under production cap | all planned production files | actual effective production-line calculation <= 1,200 |
| INV-19 | nested bot commit + scoped outer commit | both Git repositories | post-commit status/log prove relevant paths committed and unrelated outer changes untouched |
| INV-20 | first connection ready -> one-shot scheduled runtime initialize -> due execution | startup orchestration and scheduled runtime | persisted due task executor remains zero before `server.connected`, then runs exactly once |
| SDK upgrade | current generated contract consumed directly | bot `package.json`, `package-lock.json` | `npm run build`, lint, tests pass at exact 1.15.3 |

No confirmed requirement or invariant is intentionally left without an
executable path and behaviorally sensitive verification.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Daemon connection query export | REQ-07, INV-04 | `existingOwnerUrl` is private to OpenCode | External bot cannot call module internals and must not parse lock |
| `daemon status --json` | INV-03, INV-17 | stopped/recovery/status paths must observe without starting | `attach` requires a URL and current daemon CLI only stops |
| `daemon start --json --launcher-pid` | INV-01, INV-02, INV-13 | startup/explicit start must use ensure and bot lifetime | short-lived CLI PID would trigger startup-idle shutdown before first SSE |
| Mutable single SDK binding | INV-03 | random URL changes after owner replacement | current const client permanently captures fixed URL |
| Fail-closed local initial URL | INV-01, INV-03 | configured local 4096 is old standalone path | retaining it would silently reconnect to a parallel Server |
| Bot daemon connection orchestrator | INV-02, INV-03, INV-09 | startup, SSE, start/stop, auto-restart share acquisition and retry | current process module only creates/kills fixed-port processes; one-shot await can terminate polling |
| Single in-flight local acquisition | INV-03, INV-04 | monitor/SSE/commands can run concurrently | OpenCode election prevents duplicate owners but duplicate bot child commands and stale rebinds remain observable |
| Desired connection state and generation | INV-03, INV-17 | explicit stop races Event disconnect/recovery | current independent command/retry paths cannot distinguish intentional stop from failure |
| One process-level global Event transport | INV-13, INV-14, INV-15 | daemon counts `/global/event`, while current bot waits for Project/Session | current business subscription owner can close or omit the only liveness stream |
| Local/remote Event compatibility split | INV-16 | only global SSE increments local daemon count | current unconditional compatibility fallback can report success without liveness |
| Effective connection-mode discriminator | INV-09 | current optional URL contract accepts blank values and includes loopback Servers | key presence/hostname classification cannot preserve normalization or caller intent |
| Ready-gated scheduled initialization | INV-20 | persisted due task executes immediately during initialize | current startup order can consume fail-closed client and lose a one-time run |
| Project-aware Provider cache identity | INV-05 | current cache keys omit selected worktree | passing directory alone does not prevent a prior Project cache hit |
| Revert tuple branch | INV-06 | observed resolved 404 | current catch only observes thrown failures |
| Diff file type guard | INV-07 | generated schema permits omission | required display state cannot represent unnamed file |
| Question resolution callback and request match | INV-08 | shared daemon makes TUI-first reply reachable | current aggregator only logs and manager cannot resolve by ID |
| SDK exact version pin | REQ-02 | bot 1.1.21 vs current 1.15.3 | old compile contract hides current optional fields and later response additions |
| node-fetch v2 type-owner alignment | SDK upgrade build feedback | installed dependency graph now exposes node-fetch declarations while the file-download adapter annotates DOM `RequestInit` | stale suppression and cross-library init type prevent the approved exact-SDK build without changing runtime behavior |
| Documentation replacement | INV-12 | public docs prescribe old topology | code-only repair would continue creating incompatible deployments |

No new dependency, database object, migration, feature switch, external port,
lock parser, or parallel daemon implementation is proposed.

## 15. File-Level Change Plan

### OpenCode repository

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | modify | Reuse existing owner classification to expose safe connection info; accept optional external launcher PID while preserving TUI default. | +20 / -2 |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | Register status/start JSON commands over existing daemon functions; validate launcher PID; preserve stop implementation. | +55 / -1 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | Real isolated CLI status/start/no-owner/reuse/launcher-liveness behavior. | +95 / -5 |

No OpenCode worker, Server, DB, Event, SDK source, generated file, migration, or
configuration file changes.

### Nested bot repository

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `package.json` | modify | Pin current SDK `1.15.3`. | +1 / -1 |
| `package-lock.json` | modify | npm-generated exact SDK lock/integrity update only. | generated lock delta |
| `src/config.ts` | modify | Normalize trim-nonempty `OPENCODE_API_URL` and expose daemon/server mode without inferring intent from key presence or hostname. | +10 / -2 |
| `src/opencode/client.ts` | modify | Remote direct/fail-closed local initial client and one live client replacement function. | +20 / -4 |
| `src/opencode/process.ts` | modify | Add cross-platform shell-free daemon CLI execution and strict JSON parsing while preserving existing explicit-loopback serve/PID/kill helpers. | +90 / -5 |
| `src/opencode/daemon-connection.ts` | add | Own mode selection, daemon desired state, supervised startup retry, status/stop, one in-flight generation-guarded acquisition, SDK rebinding, Event-disconnect recovery, and abortable shutdown. | +185 |
| `src/opencode/events.ts` | modify | Own one process-level global stream, connected/disconnect callbacks, mutable business filter/callback, daemon mandatory-global reconnect after connection recovery, and explicit-Server legacy compatibility. | +110 / -55 |
| `src/opencode/auto-restart.ts` | modify | Route default-daemon recovery through connection owner while preserving explicit-loopback Server monitor behavior. | +25 / -20 |
| `src/app/bootstrap/start-bot-app.ts` | modify | Register Event/one-shot ready owners, keep Telegram polling independent from supervised acquisition retry, and initialize scheduled runtime only after authoritative ready. | +45 / -12 |
| `src/bot/index.ts` | modify | Expose the existing Event consumer setup to startup without requiring Project/Session restoration. | +8 |
| `src/bot/commands/opencode-start-command.ts` | modify | Default mode uses daemon ensure; explicit loopback Server preserves child serve behavior; remote Server remains unmanaged. | +25 / -15 |
| `src/bot/commands/opencode-stop-command.ts` | modify | Default mode uses desired-state safe daemon stop; explicit loopback Server preserves port/PID stop. | +25 / -10 |
| `src/app/services/model-selection-service.ts` | modify | Pass selected Project directory and scope catalog/cache/in-flight state by worktree. | +25 / -8 |
| `src/app/services/model-capabilities-service.ts` | modify | Pass selected Project directory and include it in cache identity. | +12 / -3 |
| `src/app/services/model-context-limit-service.ts` | modify | Pass selected Project directory and isolate expiration/cache/in-flight by worktree. | +18 / -5 |
| `src/app/services/variant-selection-service.ts` | modify | Pass selected Project directory or return existing explicit default when absent. | +8 / -1 |
| `src/bot/callbacks/message-history-callback-handler.ts` | modify | Check Revert response error before success UI. | +5 / -1 |
| `src/bot/pinned/pinned-message-manager.ts` | modify | Narrow named diff entries before required display state; preserve existing compatibility path. | +12 / -4 |
| `src/app/managers/summary-aggregation-manager.ts` | modify | Narrow Session diff files and publish matching Question resolution callback. | +30 / -8 |
| `src/app/managers/question-manager.ts` | modify | Resolve and return message IDs only for matching request. | +12 |
| `src/app/services/file-download-service.ts` | modify | Remove the stale node-fetch suppression and type fetch options with node-fetch v2's own `RequestInit`, preserving proxy/IPv4/header runtime behavior. | +2 / -2 |
| `src/bot/telegram-client-options.ts` | modify | Remove only the stale node-fetch import suppression; preserve existing grammY proxy fetch behavior. | -1 |
| `src/bot/services/event-subscription-service.ts` | modify | Register/update the business Event consumer without owning transport lifetime; clear matching Telegram Question UI on resolution. | +34 / -8 |
| `src/app/services/project-switch-service.ts` | modify | Reset Project business state and update Event directory without closing process SSE. | +4 / -2 |
| `src/bot/handlers/prompt.ts` | modify | Clear mismatched Session consumer state without closing process SSE. | +3 / -2 |
| `tests/config.test.ts` | modify | Undefined, empty, whitespace, explicit loopback, and explicit remote URL preserve the intended connection modes. | +35 |
| `tests/opencode/process.test.ts` | modify | Preserve serve/socket behavior and add platform daemon command/JSON validation. | +85 |
| `tests/opencode/daemon-connection.test.ts` | add | Public omitted/explicit modes, supervised retry, desired stop/start, status-only versus ensure recovery, rebind, generation, and single-flight behavior. | +230 |
| `tests/opencode/events.test.ts` | modify | One global stream before Project, stable identity across directory changes, connected/disconnect recovery callbacks, daemon no-legacy, and explicit-Server compatibility. | +135 / -30 |
| `tests/opencode/auto-restart.test.ts` | modify | Daemon post-ready recovery and preserved explicit-loopback Server monitor behavior. | +65 / -25 |
| `tests/app/start-bot-app.test.ts` | modify | Telegram polling starts while acquisition is retrying; global connected then gates ready/reconcile/scheduled initialization without a Project. | +90 |
| `tests/app/services/scheduled-task-runtime-service.test.ts` | modify | Persisted due task cannot execute before connection ready and executes exactly once afterward through startup orchestration. | +45 |
| `tests/bot/commands/opencode-start.test.ts` | modify | Existing owner/explicit daemon start/health/error behavior. | +55 / -80 |
| `tests/bot/commands/opencode-stop.test.ts` | modify | Owner-safe daemon stop/no-owner/remote behavior. | +45 / -55 |
| `tests/app/services/model-selection-service.test.ts` | modify | Directory argument and Project cache isolation. | +45 / -15 |
| `tests/app/services/model-capabilities-service.test.ts` | modify | Current Project directory and cache identity. | +30 |
| `tests/app/services/model-context-limit-service.test.ts` | add | Current Project directory and context-cache isolation. | +55 |
| `tests/app/services/variant-selection-service.test.ts` | add | Current Project directory/default behavior. | +35 |
| `tests/bot/callbacks/message-history-callback-handler.test.ts` | add | Resolved Revert error cannot report success. | +80 |
| `tests/bot/pinned/pinned-message-manager.test.ts` | modify | Mixed/all-unnamed current-SDK diff behavior. | +30 |
| `tests/app/managers/summary-aggregation-manager.test.ts` | modify | Nameless diff exclusion and Question resolution callback. | +45 |
| `tests/app/managers/question-manager.test.ts` | modify | Matching/unrelated request resolution. | +25 |
| `tests/bot/services/event-subscription-service.test.ts` | modify | TUI-first Question reply/reject deletes Telegram messages and clears interaction. | +55 |
| `tests/app/services/project-switch-service.test.ts` | modify | Project switch updates Event consumer without transport stop. | +20 |
| `tests/bot/handlers/prompt.test.ts` | modify | Session mismatch resets business state without transport stop. | +20 |
| `tests/app/services/file-download-service.test.ts` | existing regression | Preserve Telegram proxy, IPv4, secret-header, size, and file download behavior after type-owner correction. | 0 |
| `tests/bot/telegram-client-options.test.ts` | existing regression | Preserve grammY API root, proxy, secret-header, and IPv4 options after stale suppression removal. | 0 |
| `README.md` | modify | Replace fixed-port serve/attach setup with shared-daemon status/start semantics and preserve remote setup. | documentation only |
| `PRODUCT.md` | modify | Update local Server management requirement/checklist to shared daemon. | documentation only |
| `.env.example` | modify | Explain omitted URL selects shared daemon while any explicit URL remains direct Server mode. | documentation only |
| `docs/LINUX_SYSTEMD_SETUP.md` | modify | Auto-restart ensures shared daemon rather than starting serve. | documentation only |

No other bot caller signature, i18n key, settings schema, persistence file, or
dependency is changed. Event transport APIs may change only at the listed
callers. If current SDK typecheck reveals a material additional contract change
outside these files, implementation must stop, increment this plan revision,
and return to full-scope plan audit.

## 16. TDD Behavior Slices

The agreed public seams are: the real `opencode daemon` CLI; the bot's exported
daemon connection operations; bot SSE subscription; existing Telegram command
handlers; SDK-facing Provider/display/callback adapters; and the existing
Question manager/event service. Tests do not inspect private lock files except
through the established isolated OpenCode lifecycle fixture.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `daemon status --json` reports no owner or current owner without spawning | command does not exist | thin query over existing owner classification | discovery never creates/duplicates daemon |
| 2 | `daemon start --json --launcher-pid` returns same existing PID/URL and starts one absent owner that survives short CLI exit while bot PID is alive | command does not exist; ensure records CLI PID | pass validated external launcher to existing ensure | owner reuse/election/startup idle |
| 3 | undefined, empty, whitespace, or wizard-blank `OPENCODE_API_URL` startup calls ensure and passes no network/lock arguments | key-presence classification can retain localhost:4096 | trim-normalized daemon mode invokes machine start with bot PID | all optional-unconfigured zero-configuration startups |
| 4 | explicit loopback/custom-port URL remains the exact direct Server and preserves serve/start/stop; explicit remote remains direct-only | hostname-only R3 mode would silently select daemon | trim-nonempty effective-value discriminator and existing Server branch | public configuration compatibility without fallback |
| 5 | before any Project exists, bot global SSE changes daemon client count to 1 and survives beyond idle timeout | current ready callback requires Project/Session | one process stream waits for `server.connected` before ready | no manual TUI liveness |
| 6 | Project switch, detach, and mismatch keep the same stream while changing business filtering | current callers close Event transport | update consumer/filter state only | process liveness ownership |
| 7 | daemon global failure never calls legacy `/event`, while explicit Server mode still can | current fallback is mode-agnostic | daemon reconnect outcome; Server existing compatibility | counted daemon liveness and Server compatibility |
| 8 | daemon URL A loss rebinds URL B; enabled recovery ensures an absent owner and disabled recovery waits status-only | immutable client remains A and old monitor starts serve | generation-guarded connection recovery | random-port recovery without fallback |
| 9 | explicit stop closes SSE, safely stops daemon, and no disconnect callback restarts it until explicit start | current stop scans/kills port and no desired state exists | stopped desired state gates recovery | owner safety and command intent |
| 10 | persisted task due at startup remains unexecuted before `server.connected`, then runs once after ready | current startup initializes runtime before connection | one-shot ready-gated scheduled initialization | no lost one-time scheduled run |
| 10a | Telegram polling starts and remains available while initial daemon acquisition fails and retries | awaiting acquisition before `bot.start()` terminates startup | supervised abortable connection task independent of polling | `/opencode_start` and status remain reachable during outage |
| 11 | Project A/B Provider calls carry their worktrees and never share cache/in-flight results | calls omit directory and caches are global | directory arguments and worktree cache identity | multi-Project catalog correctness |
| 12 | resolved Revert `{error}` shows error, not success | callback ignores result | branch on response error | current SDK error semantics |
| 13 | optional diff file is filtered while named files remain; pinned all-unnamed data reaches existing message compatibility path | mapper requires file | type guard before display mapping | legacy/imported Snapshot safety |
| 14 | matching TUI Question reply/reject clears Telegram messages and interaction; unrelated request does nothing | aggregator logs only | resolution callback + matching manager method | bidirectional Question race |
| 15 | Telegram Question option/custom reply still reaches `question.reply` and echoed event is idempotent | could regress during cleanup addition | retain current callback flow and no-op after local clear | REQ-05 primary interaction |
| 16 | exact SDK build uses node-fetch v2's own request type and no stale import suppressions while proxy/download tests remain green | installed declarations make old suppressions and DOM `RequestInit` invalid | type at the external adapter owner; no runtime branch | exact-SDK compile without proxy behavior drift |
| 17 | full current SDK build/lint/test, isolated shared-daemon harness, line cap, and both Git commits pass | SDK/lifecycle changes expose drift | only approved adapters compile and pass | complete compatibility and delivery surface |

Each slice is implemented red -> minimal green -> local regression before the
next slice. Expected JSON, URL/PID identity, directory strings, error UI, and
Question IDs are independent literals or values from the public test fixture,
not reproductions of production algorithms.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 850 | Added/substantively modified production, test, and package configuration lines; excludes imports, formatting, generated lockfile lines, docs, and deleted/pure-move lines |
| Required Chinese explanatory comments `C` | 128 minimum | `ceil(850 * 0.15) = 128`; implementation must recalculate actual E and satisfy the actual ceiling |

Qualifying Chinese comments must be distributed adjacent to the relevant code
and tests. They will explain:

- Why the CLI exposes URL/PID but never token, control port, DB path, or lock path.
- Why a live unresponsive owner is reused rather than replaced.
- Why the bot PID, not the short-lived CLI PID, protects startup before first SSE.
- Why initial local acquisition always ensures while post-ready recovery still
  honors the existing auto-restart policy.
- Why one global SSE, not TUI identity or a second heartbeat stream, owns daemon
  liveness after `server.connected`.
- Why Project/Session state changes update filtering without closing transport.
- Why local daemon mode cannot accept legacy `/event` as liveness success.
- Why desired stopped state must win over an in-flight reconnect result.
- Why local initial binding fails closed instead of retaining port 4096.
- Why remote direct mode is a supported domain branch, not a fallback.
- Why a trim-nonempty effective value, not key presence or hostname,
  distinguishes an explicitly selected Server from default daemon.
- Why one in-flight acquisition prevents stale URL rebinding while OpenCode
  election remains final authority.
- Why Project worktree participates in Provider cache identity and in-flight
  deduplication.
- Why SDK tuple errors must be checked even inside a try/catch.
- Why nameless legacy diff entries cannot enter `FileChange` and why no filename
  is synthesized.
- Why Question cleanup must match request ID and remain idempotent after a
  Telegram-originated reply.
- Why isolated daemon tests set lock/XDG/database/process-role values and wait on
  observable owner/SSE readiness.
- Why each test assertion observes public behavior rather than helper calls.
- Why due scheduled tasks must wait for first ready but runtime initialization
  must remain one-shot across reconnects.

Comments that translate identifiers, repeat test names, describe obvious
control flow, or are concentrated away from their decision do not count. The
verbatim REQ-09 user instruction makes these Chinese explanations mandatory
despite the nested bot repository's general English-comment preference.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "daemon status|daemon start"` | `packages/opencode` | Narrow red/green machine CLI, owner reuse, launcher liveness |
| `bun test test/cli/tui/daemon.test.ts` | `packages/opencode` | Full daemon election, lifecycle, stop, idle, signal, and Windows regression |
| `bun test test/server/httpapi-sdk.test.ts test/server/httpapi-event.test.ts test/server/httpapi-config.test.ts` | `packages/opencode` | SDK route, SSE, auth, and directory-aware Provider contracts unchanged |
| `bun typecheck` | `packages/opencode` | OpenCode TypeScript contract |
| `bun typecheck` | `packages/sdk/js` | Generated SDK remains unchanged and valid |
| `npm install --save-exact @opencode-ai/sdk@1.15.3` | `thirdparty/opencode-telegram-bot` | Task-local dependency install and exact manifest/lock update authorized by the implementation GOAL; no global install |
| `npm run test -- tests/config.test.ts tests/opencode/process.test.ts tests/opencode/daemon-connection.test.ts tests/opencode/events.test.ts tests/opencode/auto-restart.test.ts tests/app/start-bot-app.test.ts tests/app/services/scheduled-task-runtime-service.test.ts` | `thirdparty/opencode-telegram-bot` | Omitted/explicit connection modes, daemon liveness/recovery, and due-task ready gating |
| `npm run test -- tests/app/services/model-selection-service.test.ts tests/app/services/model-capabilities-service.test.ts tests/app/services/model-context-limit-service.test.ts tests/app/services/variant-selection-service.test.ts` | `thirdparty/opencode-telegram-bot` | Project-scoped Provider calls/caches |
| `npm run test -- tests/app/managers/question-manager.test.ts tests/app/managers/summary-aggregation-manager.test.ts tests/bot/services/event-subscription-service.test.ts tests/bot/callbacks/message-history-callback-handler.test.ts tests/bot/pinned/pinned-message-manager.test.ts` | `thirdparty/opencode-telegram-bot` | Question, Revert, and optional diff behavior |
| `npm run test -- tests/app/services/file-download-service.test.ts tests/bot/telegram-client-options.test.ts` | `thirdparty/opencode-telegram-bot` | node-fetch/grammY proxy and file-download runtime behavior unchanged |
| `npm test` | `thirdparty/opencode-telegram-bot` | Full bot regression |
| `npm run build` | `thirdparty/opencode-telegram-bot` | Strict compile against exact current SDK |
| `npm run lint` | `thirdparty/opencode-telegram-bot` | Bot lint and comment-adjacent code quality |
| Isolated cache harness: start the bot-like connection through the OpenCode CLI, observe private client count 1 without TUI/Project, wait beyond idle timeout, connect a second TUI-like SSE, create/continue one Session from both clients, answer one Question from each side, then close clients and safe-stop | cache root plus package-local commands | Original end-to-end shared PID/URL, persistent Event liveness, live Run state, Question, auth, shutdown, and no-global-state scenario |
| `lsof -nP -iTCP:<isolated-port> -sTCP:LISTEN` and isolated lock/process cleanup checks | cache root | No experiment process remains; no global daemon/database touched |
| Actual diff E/C and effective production-line calculation over both repositories | repository roots | `C >= ceil(E*0.15)` and effective production lines `<= 1200` with documented exclusions |
| `git status`, scoped diffs, `git log --oneline -10`, scoped commits, and post-commit status in nested bot then outer repository | each repository root | Verified relevant commits exist, no secret/unrelated path included, outer unrelated staged/worktree changes preserved, no push |

The implementation GOAL authorizes the task-local dependency install required
for verification; it does not authorize global installation, push, or unrelated
lifecycle changes. Every runtime harness must set isolated
HOME/XDG/config/lock and `OPENCODE_DB=:memory:` or an isolated cache DB.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 5 | one bot connection module and four behavior test files |
| Files modified | 39 | 3 OpenCode, 32 bot code/test/config, 4 bot docs; package lock counted once |
| Files deleted | 0 | obsolete functions are removed in place; no unrelated file deletion |
| Effective production lines | about 650 added/substantively modified; hard maximum 1,200 | thin OpenCode adapter; one bot connection/Event lifecycle plus explicit Server and confirmed compatibility branches |
| Production lines deleted | about 100 | default fixed-client and transport-lifetime workarounds removed; explicit Server process behavior retained |
| Test lines | about 500 net added | vertical public-seam, liveness, connection-mode, and ready-order coverage only |
| Generated lines | package-lock delta only; 0 OpenCode generated SDK lines | exact npm dependency pin; no SDK regeneration |

The budget is an audit signal, not permission to omit confirmed behavior. A
material file, owner, public seam, or behavior change requires a revision increment and new
full-scope audit.

## 20. Real Risks and Open Decisions

### Real risks

1. **Nested dependency installation executes third-party lifecycle code.** The
   implementation GOAL authorizes the task-local install required for build and
   tests, but it must run only in the nested checkout, never globally, and any
   preflight rejection remains an explicit verification blocker rather than a
   reason to skip tests.
2. **Daemon CLI is a new public machine contract.** JSON must be version-small,
   stdout-only, and behavior-tested. Exposing private lock token/control/DB data
   would be a security and ownership regression and is forbidden.
3. **Existing live but unresponsive owner may remain temporarily unusable.** The
   approved behavior returns/retries that owner and reports unavailable rather
   than violating the single-owner invariant by spawning another daemon.
4. **The nested bot checkout is ignored by the outer repository.** It is a clean
   `main` branch at `4367863`; implementation/audit/commit must inspect and commit
   it separately. The outer scoped commit records OpenCode, `.gitignore`, and
   this plan but does not pretend to vendor or submodule the bot.
5. **Windows command execution remains reachable.** The bot currently supports
   Windows and has executable-resolution tests. The daemon CLI adapter must
   preserve shell-free argument boundaries and existing trusted executable
   resolution rather than use shell interpolation.
6. **Explicit loopback Server mode remains supported.** Tests must prove its URL,
   port management, auto-restart, and Event compatibility stay on the configured
   Server and never cross into daemon mode.
7. **Scheduled initialization can race reconnect notifications.** Startup owns a
   one-shot guard so only the first authoritative ready initializes persisted
   tasks; later reconnects refresh connection state without replaying recovery.

### Open Decisions Requiring the User

None. REQ-06 delegates technical design, and REQ-07 selects reuse of the
existing daemon attach/ensure path with minimal OpenCode change. REQ-08 and
REQ-10 authorize task-local implementation, verification, and two scoped local
commits without push.

### Rejected Speculation

- Workspace routing is not a current bot input and cannot drive production
  changes in this revision.
- A fixed external daemon port is unnecessary because machine discovery returns
  the internal random URL on the same host.
- Reading ServerLock directly from Node would reduce OpenCode line count but
  duplicate private schema/path/auth/election ownership in the bot; rejected.
- Changing global heartbeat/event schemas is not required for the bot's consumed
  Project events and would expand OpenCode beyond REQ-07; rejected.
- Adding a broad SDK Gateway is unnecessary. A single mutable client construction
  seam handles URL lifetime; existing service calls remain direct.
- A local standalone-server feature switch is not added. It would retain the
  incompatible parallel path the user explicitly replaced; remote Server mode
  already covers intentional external Server deployments.
- Unconditional ensure after every SSE failure is rejected because desired
  stopped state and the existing post-ready auto-restart policy are reachable;
  initial startup still ensures once because the local bot requires a backend.
- A TUI registration API, fake TUI process, or second liveness Event stream is
  rejected because the existing global SSE counter already accepts any client.
- Synthesizing filenames for legacy diffs is rejected because no producer or
  contract establishes a correct value.
- Handling additive Event types with no bot consumer, or altering EventV2, is
  rejected as speculative compatibility work.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence, including the nested bot
  checkout, without trusting builder summaries.
- Audit the complete original scope on every round.
- Require observed, contracted, or reachable evidence for every blocking
  finding.
- Check both under-design and over-design.
- Check that OpenCode remains a thin adapter over existing daemon logic and that
  no bot lock parser, standalone fallback, or second election remains; daemon
  mode must not use raw PID stop, while the existing explicit loopback Server
  branch retains its scoped PID stop contract.
- Check local/remote/start-disabled/start-enabled/reconnect/stop behavior,
  Provider Project scope, current SDK semantics, optional diff data, and
  bidirectional Question interaction.
- Check startup ensure, process-level global SSE readiness/liveness, no-Project
  operation, stable transport across Project/Session changes, local no-legacy
  behavior, desired stop races, and the 1,200-line production cap.
- Check omitted versus explicit `OPENCODE_API_URL`, including loopback custom
  ports and preserved serve/stop/monitor behavior, without cross-mode fallback.
- Check a persisted due scheduled task cannot execute before first authoritative
  ready and executes exactly once afterward.
- Check nested and outer commit scopes independently and require unrelated outer
  index/worktree changes to remain untouched.
- Check file/TDD/verification mappings, code quality, and feasibility of the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | None | BLOCK | `ses_0769e826dffeKpebmD32X552cq` |
| 2 | R2 | yes | None | N-01 | APPROVE | `ses_0769e826dffeKpebmD32X552cq` |
| 3 | R3 | yes | B-01, B-02 | N-01 | BLOCK | `ses_0763c8124ffeE75Q0i5uYX1OaY` |
| 4 | R4 | yes | B-01 | N-01, N-02 | BLOCK | `ses_0763c8124ffeE75Q0i5uYX1OaY` |
| 5 | R5 | yes | B-01 | N-01, N-02 | BLOCK | `ses_0763c8124ffeE75Q0i5uYX1OaY` |
| 6 | R6 | yes | B-01 | N-01 | BLOCK | `ses_0763c8124ffeE75Q0i5uYX1OaY` |
| 7 | R7 | yes | B-01 (series limit) |  | BLOCK | `ses_0763c8124ffeE75Q0i5uYX1OaY` |
| S2-1 | R7 | yes |  | N-01, N-02 | APPROVE | `ses_075ef378bffe6z1rkUppPAYJ27` |
| S2-2 | R8 | yes | B-01, B-02 | N-01, N-02 | BLOCK | `ses_075ef378bffe6z1rkUppPAYJ27` |
| S2-3 | R9 | yes |  | N-01, N-02, N-03 | APPROVE | `ses_075ef378bffe6z1rkUppPAYJ27` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

### Round 1 Verdict (Verbatim)

```text
## Blocking findings

### B-01 中文注释方案违反更高优先级的子仓库规则

- Violated invariant: 实施必须同时满足仓库指令优先级和 15% 中文解释性注释硬门槛；计划不得虚构用户授权例外。
- Evidence class: contracted
- Producer and execution path: 计划实施 bot 生产代码、测试和配置 → 按计划加入至少 84 行中文解释性注释 → 进入 `thirdparty/opencode-telegram-bot` 的构建、lint 和实施审计。
- Source evidence: `thirdparty/opencode-telegram-bot/AGENTS.md:145-148` 明确要求代码注释必须使用英文；`.opencode/policy/first-principles-engineering.md:28-39` 规定 package-local `AGENTS.md` 高于该政策，用户例外必须在计划中引用真实指令；同文件 `496-546` 又将中文注释比例设为硬门槛。
- Canonical-plan evidence: §1 `REQ-01`–`REQ-08` 未包含中文注释例外；§3 第 78 行和 §17 第 582–607 行声称“用户 GOAL”给予了该例外，并计划在 bot 代码和测试附近分布中文注释。
- Responsibility owner: `thirdparty/opencode-telegram-bot/AGENTS.md` 所定义的子仓库代码质量契约，以及 canonical plan 的需求/例外记录。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 按 R1 实施时，加入合格中文注释会违反子仓库强制英文注释规则；不加入则无法通过仓库级 15% 中文注释硬门槛。因此该实施合同不存在同时通过两项硬门槛的路径。
- Why this is not speculative: 两项要求都来自当前直接读取的强制仓库契约；原始需求中没有计划所声称的用户授权例外。
- Minimal correction direction: 在 canonical requirement 中引用真实、明确的用户授权以覆盖子仓库英文注释规则，或者由规则所有者先消除该契约冲突；不能继续把当前 `approved-plan-only` GOAL 当作不存在的语言例外。

## Non-blocking findings

None.

## Rejected speculation

- Workspace 路由没有当前 bot producer，不能据此扩展本次生产范围。
- 未消费的 additive Event/EventV2 变化没有可达行为后果，不要求兼容分支。
- malformed daemon JSON 不应回退到固定端口 Server；失败保持 unavailable 符合单一主路径。
- 当前证据不足以把并发 status/start/rebind 的理论调度顺序列为独立阻断缺陷；实施审计仍需用计划中的 single-flight 行为测试验证。

## Requirement and traceability coverage

R1 已覆盖并映射：

- third-party checkout 及固定来源版本；
- TUI、daemon、Server、SDK、SSE、Provider、Question 的 producer-to-consumer 路径；
- standalone `serve` 与共享 daemon 的首个分歧；
- daemon status/start 公共 seam；
- SDK 升级、Project-scoped Provider 缓存、Revert tuple error、optional diff、双向 Question 交互；
- 文件级变更、red-capable TDD、隔离验证及无数据库迁移约束。

B-01 使代码质量与中文注释要求缺少可执行且合规的正向映射。

## Primary-path and fallback verdict

共享 daemon 路径本身满足单一权威路径原则：

local bot -> daemon CLI -> existing Daemon.ensure/election
          -> mutable SDK binding -> HTTP/SSE

固定端口 `opencode serve`、ServerLock 解析、socket/PID kill 和 acquisition-failure fallback 均被明确删除或拒绝。非本地 Server、global-to-legacy SSE 及既有 diff compatibility 有现存消费者依据，未被扩展为 daemon 获取失败后的 fallback。

主路径设计通过；整体计划仍受 B-01 阻断。

## Release verdict

**BLOCK**

审计对象：canonical plan **R1**。必须修订并进行下一轮完整范围审计，当前不得标记为 `approved`。
```

R2 resolves B-01 by adding the user's actual verbatim Chinese-comment gate as
REQ-09 and linking the precedence statement directly to that quoted
authorization. No production path, owner, file plan, test seam, fallback
classification, or verification command changed from R1.

### Round 2 Verdict (Verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01**：§19 第 653 行仍写着“material change requires R2”。当前版本已经是 R2，后续实质变更应递增到 R3。该处不改变当前设计、路径或硬门槛，属于非阻断记录修正。

## Rejected speculation

- Workspace 没有当前 bot producer，不要求增加 Workspace 路由。
- 未被 bot 消费的 additive Event/EventV2 不要求兼容处理。
- `GlobalEvent` heartbeat 元数据差异不会进入 Session 或 Project mutation consumer。
- daemon JSON 失败不应回退到固定端口 Server；保持 unavailable 符合 fail-closed 主路径。
- 并发 status/start/rebind 尚无证据构成独立缺陷；计划已要求 single-flight 行为测试，实施审计需核验实际语义。
- 不要求修改 worker、Server、数据库、OpenAPI 或生成 SDK。

## Requirement and traceability coverage

R2 完整映射了原始需求和受影响接口：

- third-party checkout 已固定为 `v0.22.3`、commit `4367863fe6b5d1dd2ba33d5f7fa88ea69c782875`。
- 已重建 TUI、daemon、Server、SDK、SSE、Provider、Snapshot diff 和 Question 的 producer-to-consumer 路径。
- 首个分歧定位在 bot 的 standalone `opencode serve` 路径及固定 SDK client。
- OpenCode 改动限制为现有 `Daemon.ensure()` 上的薄 CLI adapter。
- SDK `1.1.21 → 1.15.3`、Project-scoped Provider、resolved tuple error、optional diff 和双向 Question 均有文件与行为测试映射。
- 隔离 HOME/XDG/lock/database、package-local verification 和无数据库迁移要求完整。
- REQ-09 已真实引用用户授权，解决英文注释子仓库规则与中文注释硬门槛的优先级冲突。
- `E=560`、`C>=84` 算术正确，并承诺实施审计按实际变更重新计算。

## Primary-path and fallback verdict

权威本地路径唯一：

local bot
  -> opencode daemon status/start
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> HTTP + global SSE

固定端口 `serve`、ServerLock 解析、socket PID 扫描、直接进程终止及 acquisition-failure fallback 均被删除或拒绝。

非本地 Server URL 是既有支持域分支。global-to-legacy SSE、message-part diff 和同 Project stale cache 是有现存消费者依据的既有 compatibility path，未被扩展为 daemon 获取失败后的替代成功路径。新增 alternate success path 为零。

## Release verdict

**APPROVE**

该结论仅适用于 canonical plan **R2**。可以记录为 `approved-plan-only`；当前仍不授权实施。
```

R3 supersedes R2 because the new implementation GOAL and reachable daemon
liveness evidence materially change startup, Event transport ownership,
recovery, explicit stop behavior, verification, line budget, and commit scope.
R2 approval is historical only and does not authorize R3 implementation.

### Round 3 Verdict (Verbatim)

```text
## Blocking findings

### B-01 按 hostname 重解释 `OPENCODE_API_URL` 会破坏显式本地 Server 配置

- Violated invariant: 已公开的 `OPENCODE_API_URL` 必须继续表示调用方明确指定的 OpenCode Server；没有用户授权时，兼容性修改不能把显式 URL 静默改写为另一套连接语义。
- Evidence class: contracted
- Producer and execution path: 用户或安装向导写入 `OPENCODE_API_URL=http://127.0.0.1:<custom-port>` → `config.opencode.apiUrl` → bot client/process adapter → 当前实现直接连接并管理该端口；R3 改为仅按 hostname 分类，将所有 loopback URL 路由到随机端口 shared daemon，并且明确禁止访问配置的固定端口。
- Source evidence: `thirdparty/opencode-telegram-bot/src/config.ts:193-200`; `thirdparty/opencode-telegram-bot/src/opencode/process.ts:21-42`; `thirdparty/opencode-telegram-bot/src/runtime/bootstrap.ts:100-105,199-218,540-554`; `thirdparty/opencode-telegram-bot/README.md:94,208-220`; `thirdparty/opencode-telegram-bot/.env.example:30-42`
- Canonical-plan evidence: §6 line 254; §7 `INV-09`; §10.1 lines 410-419; §13 line 545; §15 lines 600-603, 641
- Responsibility owner: Bot configuration and OpenCode connection-mode seam.
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 已配置本机独立 Server、自定义本机端口、容器端口转发或本机代理的现有用户将不再连接所配置的 Server。Bot 会忽略 URL 的端口并操作另一个 shared daemon，Session、Project、Run state 和停止命令都可能落到错误 owner，直接违反“避免破坏现有功能和接口”。
- Why this is not speculative: `OPENCODE_API_URL` 是 README、`.env.example`、安装向导和运行时配置共同暴露的现有接口；其 producer 和直接连接路径当前均存在。原始需求只要求默认机制复用和 shared daemon 兼容，没有明确请求撤销显式 loopback Server 配置。
- Minimal correction direction: 由配置/连接模式 owner 保留显式 Server URL 的既有直连合同，只让真正选择默认本地发现语义的输入进入 shared-daemon acquisition；或者先取得并逐字记录用户对显式 loopback URL 行为的精确 rollback 授权。不得在 daemon 获取失败后回退到该 URL。

### B-02 启动计划未约束到期 scheduled task 必须等待 client 重绑定

- Violated invariant: 本地模式在 daemon acquisition、SDK 重绑定和 mandatory global SSE ready 之前，任何 OpenCode API consumer 都不能使用计划中的 fail-closed 初始 client；已有 scheduled task 功能不能因启动顺序而被错误消费。
- Evidence class: reachable
- Producer and execution path: 已持久化且在 bot 启动时到期的 scheduled task → `startBotApp()` 创建 bot 后调用 `scheduledTaskRuntime.initialize()` → `recoverTasksOnStartup()` → `scheduleTask()` 对已到期任务立即执行 `startExecution()` → `executeScheduledTask()` 使用 `opencodeClient`。R3 同时要求本地 client 在 daemon acquisition 前指向 fail-closed URL，但计划的启动测试只约束 ensure/global-SSE/ready/model reconciliation，没有约束 scheduled runtime 初始化顺序。
- Source evidence: `thirdparty/opencode-telegram-bot/src/app/bootstrap/start-bot-app.ts:71-85`; `thirdparty/opencode-telegram-bot/src/app/services/scheduled-task-runtime-service.ts:101-114,188-245,247-265,297-318,326-368,411-441`; `thirdparty/opencode-telegram-bot/src/app/services/scheduled-task-executor-service.ts:288-363,411-617`
- Canonical-plan evidence: §10.1 lines 412-428; §13 line 547; §15 line 605; §16 slices 3–4 and 14
- Responsibility owner: Bot startup orchestration in `src/app/bootstrap/start-bot-app.ts`.
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 一个启动时已到期的 one-time task 可以在 client 仍为 fail-closed binding 时开始执行，随后被记录为失败并把 `nextRunAt` 清空；该任务不会在 daemon ready 后自动重试。现有 scheduled-task 功能因此产生用户可见的错误执行和丢失运行机会。
- Why this is not speculative: scheduled tasks 是已实现并持久化的产品功能；恢复代码明确对 `delayMs <= 0` 的任务立即启动，当前 `startBotApp` 明确在后台 OpenCode startup 之前初始化它。现有测试也构造了启动时已到期任务并观察立即执行：`tests/app/services/scheduled-task-runtime-service.test.ts:170-224`。
- Minimal correction direction: 在 startup owner 中把 OpenCode acquisition、client 重绑定及 mandatory global SSE readiness 建立为所有 OpenCode-backed runtime 初始化的前置条件，并增加一个启动时到期 scheduled task 的行为测试。不要在 scheduled-task service 内增加连接 fallback 或自行 acquisition。

## Non-blocking findings

### N-01 外层仓库没有记录 third-party checkout 的可恢复引用

R3 选择把 `thirdparty/opencode-telegram-bot/` 加入 `.gitignore`，然后只在嵌套仓库创建本地 commit。当前外层仓库已有两个 third-party gitlink，并通过 `.gitmodules` 记录来源；Telegram bot 没有对应 gitlink、submodule URL 或其他可恢复引用：

- `.gitignore:28-32`
- `.gitmodules:1-8`
- `docs/plans/opencode-telegram-bot-smark-mainline-compatibility.md:47-51,777-780`
- `git ls-files --stage` 当前只记录 `thirdparty/chatgpt-browser-agent` 和 `thirdparty/opentui`

本地 checkout 与嵌套 commit 满足“抓取到 thirdparty 文件夹”和当前不 push 的字面终态，因此本轮不作为行为阻断项。不过外层 commit 无法让另一份 checkout 找到或恢复该 bot commit，最终提交记录应明确这是有意的仅本地资产，而不是已纳入外层仓库的 third-party 依赖。

## Rejected speculation

- Workspace 没有当前 bot producer，不要求本次增加 Workspace 路由。
- `/global/event` 已直接计入 daemon SSE client 数；不需要 TUI 注册、伪造 TUI、额外 heartbeat 或第二条 liveness SSE。
- 未被 bot 消费的 additive Event/EventV2 类型不要求兼容分支。
- directory-less `server.connected` 和 `server.heartbeat` 不携带 bot 消费的 Session/Project mutation，当前证据不足以要求修改其 schema。
- live-but-unresponsive owner 必须继续复用并报告 unavailable；不能据此启动第二个 daemon。
- malformed daemon JSON 不应回退到配置的固定端口 Server。
- 当前没有证据要求修改 worker、数据库、OpenAPI、generated SDK 或 global event producer。

## Requirement and traceability coverage

R3 已完整定位并映射以下主要路径：

- Bot standalone `opencode serve` 与 TUI shared daemon 的首个分歧；
- OpenCode `Daemon.ensure()`、owner election、stopping-owner wait、launcher PID 和 safe stop；
- mandatory `/global/event` liveness、无 Project 启动、Project/Session 切换以及 local no-legacy 约束；
- SDK `1.1.21 → 1.15.3`；
- Project-scoped Provider catalog/cache；
- resolved SDK tuple error；
- optional `SnapshotFileDiff.file`；
- Telegram/TUI 双向 Question resolution；
- 隔离 HOME/XDG/lock/database 验证；
- 1,200 行生产代码上限和实际 `E/C` 重算；
- 两个仓库的 scoped commit 和不 push 约束。

以下覆盖仍不完整：

1. `OPENCODE_API_URL` 的现有显式 loopback Server 输入域被错误缩减为 non-loopback remote Server，缺少兼容合同或精确 rollback 授权。
2. 已持久化且启动时到期的 scheduled task 没有映射到 daemon-ready 前置顺序和行为敏感测试。

中文注释计划按 `E ≈ 760`、`C >= 114` 承诺实际最低比例，算术正确且具备邻近解释主题；plan mode 下该门槛可行。

## Primary-path and fallback verdict

Shared-daemon 主路径本身保持单一权威语义：

default local discovery
  -> opencode daemon start/status
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE
  -> HTTP/Event consumers

计划正确删除或拒绝了：

- fixed-port `opencode serve` acquisition fallback；
- Bot 读取 `ServerLock`；
- 第二套 owner election；
- socket/PID 扫描和直接 kill；
- local global-SSE failure 后转入 legacy `/event`；
- 第二条 liveness SSE。

显式 non-loopback Server 和 remote-only legacy Event compatibility 具有现有消费者依据，不构成 acquisition-failure fallback。

整体主路径仍未通过：B-01 把现有显式 loopback Server 支持域错误并入默认 daemon 路径；B-02 允许 scheduled-task consumer 在权威连接路径完成前运行。

## Release verdict

**BLOCK**

审计对象：canonical plan **R3**，完整原始范围。R3 必须修订并再次进行 full-scope plan audit；当前不得记录为 `approved`，不得进入实施。
```

R4 resolves B-01 by selecting default daemon mode only when
`OPENCODE_API_URL` is absent and preserving every explicit Server URL, including
loopback process management, as a supported branch. It resolves B-02 by making
first authoritative ready a startup-orchestration precondition for one-shot
scheduled runtime initialization and adding the persisted-due-task behavior
slice. No worker, database, OpenAPI, generated SDK, or global Event producer is
added to the file plan.

### Round 4 Verdict (Verbatim)

```text
## Blocking findings

### B-01 空字符串 `OPENCODE_API_URL` 未纳入 connection-mode 合同

- Violated invariant: 现有配置语义把未设置、空字符串和安装向导留空统一视为“没有有效 Server URL”；这些输入必须进入新的默认 shared-daemon 路径，不能仅因环境变量键存在而保留旧 `localhost:4096` Server 模式。
- Evidence class: reachable
- Producer and execution path: 部署环境或测试设置 `OPENCODE_API_URL=""` → `getEnvVar()` 返回空字符串 → 当前 `config.opencode.apiUrl` 通过 `|| "http://localhost:4096"` 使用默认值；R4 要求“按配置 presence”选 mode，并写明“when present, mode is server”，因此按键存在实现时会把该输入分类为显式 Server，继续连接 `localhost:4096`，而不是执行 daemon ensure。
- Source evidence: `thirdparty/opencode-telegram-bot/src/config.ts:12-20,193-200`; `thirdparty/opencode-telegram-bot/src/runtime/bootstrap.ts:83-105,199-218,479-495,563-575`; `thirdparty/opencode-telegram-bot/tests/runtime/bootstrap.test.ts:196-215,233-237`
- Canonical-plan evidence: §6 lines 278-280; §7 `INV-09`; §9 line 392; §10.1 lines 444-450; §13 line 600; §15 lines 658, 680; §16 slices 3–4
- Responsibility owner: Bot configuration normalization and connection-mode discriminator.
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 使用 `OPENCODE_API_URL=` 表示“未配置可选 URL”的现有部署仍会走固定端口 Server 路径，不会发现或维持 shared daemon。Bot 与 TUI 因此继续连接不同的 Bus 和 Run state owner，原始兼容性问题在该可达默认配置上仍然存在。
- Why this is not speculative: 当前安装配置验证明确接受空字符串；现有测试也通过 `vi.stubEnv("OPENCODE_API_URL", "")` 产生该输入。`getEnvVar()` 和当前默认表达式证明空字符串一直与未配置具有相同有效语义。R4 只测试 omitted、显式 loopback 和显式 remote，没有锁定空白值的 mode。
- Minimal correction direction: 配置 owner 应以 trim 后的有效非空 URL 区分显式 Server intent；未定义、空字符串和纯空白值统一选择默认 daemon，并增加对应 connection-mode 行为测试。不得在 daemon acquisition 失败后再尝试固定端口 Server。

## Non-blocking findings

### N-01 R4 仍保留多处 R3 revision 引用

以下位置与顶部 `Revision: R4` 不一致：

- §2 lines 55–56：仍要求 exact R3 approval。
- §8 line 379：仍称 R3 startup test。
- §19 lines 825–827：仍写 material change requires R4，后续实质变更实际应为 R5。
- §23 lines 1172–1175：仍要求 exact R3 approval。
- §23 lines 1206–1209：仍写 pending R3 approval。
- §24 lines 1211–1215：implementation audit record 仍固定为 R3。

顶部状态仍是 `audit-required`、`Approved revision: none`、`Implementation allowed: no`，当前没有错误 release claim，因此按政策作为记录修正，不单独阻断。进入实施前应统一为 exact R4，后续实质修改递增到 R5。

### N-02 外层仓库仍不记录 nested bot commit 的可恢复引用

R4 继续把 `thirdparty/opencode-telegram-bot/` 作为 ignored nested checkout，并计划只创建嵌套本地 commit。外层仓库没有 gitlink、submodule URL 或其他可恢复引用。该安排满足本地抓取和双提交的字面终态，本轮不作为阻断项；最终记录不能把它描述成可由外层 repository checkout 恢复的 third-party 资产。

## Rejected speculation

- Workspace 没有当前 bot producer，不要求增加 Workspace 路由。
- 任意 `/global/event` 客户端都会增加 daemon SSE count，不需要注册 TUI、模拟 TUI 或增加第二条 liveness stream。
- directory-less `server.connected` 和 `server.heartbeat` 不产生 bot 消费的 Session/Project mutation，不要求修改 schema。
- 未消费的 additive Event/EventV2 类型不要求 compatibility branch。
- live-but-unresponsive owner 必须继续复用并报告 unavailable；不能创建第二个 daemon。
- daemon JSON 解析或 acquisition 失败不能切换到显式 Server URL。
- 显式有效 loopback Server 是现有支持域分支，其 serve/start/stop/monitor 行为有公开配置合同，不要求删除。
- 当前证据不要求修改 worker、Server route、数据库、OpenAPI、generated SDK 或 global Event producer。

## Requirement and traceability coverage

R4 已解决上一轮两个主要阻断项：

- 显式有效 `OPENCODE_API_URL`，包括 loopback/custom-port URL，继续使用 direct Server、既有本地进程管理和 Server Event compatibility。
- omitted URL 选择 shared daemon，不再按 hostname 推断用户意图。
- persisted due scheduled task 被 first authoritative ready 阻塞，并有“ready 前零执行、ready 后恰好一次”的 startup-orchestration 测试。
- scheduled-task service 没有吸收 connection acquisition 或 fallback 责任。

其余原始范围也已映射：

- standalone Server 与 shared daemon 的首个分歧；
- `Daemon.ensure()`、owner election、stopping owner、launcher PID、machine JSON 和 safe stop；
- mutable SDK binding 和 daemon URL 变化；
- mandatory global SSE、无 Project liveness、Project/Session 切换不关闭 transport；
- daemon mode 禁止 legacy Event fallback；
- Provider Project scope 与 cache/in-flight isolation；
- SDK tuple error、optional diff、双向 Question interaction；
- SDK `1.15.3`、package-local verification、隔离 HOME/XDG/lock/database；
- 1,200 行生产代码上限、实际 E/C 重算和两个 scoped commits。

剩余缺口是空字符串及纯空白 `OPENCODE_API_URL`。该输入已有 producer 和现有归一化合同，却没有稳定 invariant、file behavior 和敏感测试。

中文注释预算 `E ≈ 850`、`C >= 128` 的计算正确，并承诺实施审计按实际 diff 重算；plan mode 下可行。

## Primary-path and fallback verdict

对有效非空配置，R4 的路径划分清晰：

no effective OPENCODE_API_URL
  -> daemon CLI
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE
  -> ready-gated consumers

explicit valid OPENCODE_API_URL
  -> existing direct Server client
  -> existing loopback management or remote direct mode

以下 fallback 或重复路径已正确拒绝：

- daemon failure 后尝试 fixed-port Server；
- Bot 解析 `ServerLock`；
- Bot 实现第二套 election；
- daemon mode 的 global-to-legacy Event fallback；
- 第二条 heartbeat/liveness SSE；
- malformed JSON 后切换 connection mode。

显式 Server、Server-only legacy Event compatibility、message-part diff compatibility 和 same-Project stale cache 均有现有消费者依据，不是 daemon 失败后的替代成功路径。

空字符串输入目前可能跨入错误的 Server 分支，因此完整 supported domain 尚未形成单一权威 mode-selection 路径。

## Release verdict

**BLOCK**

审计对象：canonical plan **R4**，完整原始范围。必须明确空字符串和纯空白 `OPENCODE_API_URL` 的默认 daemon 语义并增加行为测试，然后递增 revision，重新进行 full-scope plan audit。当前不得记录为 `approved`，不得进入实施。
```

R5 resolves B-01 by defining one trim-normalized effective URL seam: undefined,
empty, whitespace, and wizard blank all select default daemon; every valid
non-empty URL selects the existing Server contract. It adds those inputs to the
config and startup behavior tests and updates all current revision references.
No owner, Event path, recovery behavior, scheduled ordering, or file boundary
changed from R4.

### Round 5 Verdict (Verbatim)

```text
## Blocking findings

### B-01 显式 loopback Server 的 PID stop 同时被要求保留和删除

- Violated invariant: 每个现有 workaround 或 compatibility path 必须有唯一、明确的保留或删除决定；显式 loopback Server 的既有 start/stop/monitor 合同不能在同一 revision 中同时被列为 supported branch 和 superseded workaround。
- Evidence class: contracted
- Producer and execution path: 用户提供 trim-nonempty loopback `OPENCODE_API_URL` → connection mode 选择 explicit Server → `/opencode_stop` 根据配置端口查找监听 PID → `killServerProcess()` 停止该 Server。R5 的主设计、文件计划和测试要求保留此路径，但 Secondary Inventory 和 Audit Contract 又要求删除 scanning/PID kill。
- Source evidence: `thirdparty/opencode-telegram-bot/src/opencode/process.ts:25-42,186-227,229-300`; `thirdparty/opencode-telegram-bot/src/bot/commands/opencode-stop-command.ts:17-77`; `thirdparty/opencode-telegram-bot/README.md:78-80,208-220`; `thirdparty/opencode-telegram-bot/PRODUCT.md:30-35,116-117`
- Canonical-plan evidence: §10.1 lines 448-451 要求保留 explicit loopback start/stop/monitor；§11 lines 550-551、556-557 将其列为 supported-domain branch；同表 line 560 又将 “Bot scanning a port and killing its PID” 列为 superseded workaround 并要求删除；§12 lines 580-584 要求保留 serve/PID/kill helpers；§15 lines 661, 667-668 要求保留 helpers 和 port/PID stop；§21 lines 903-905 又要求实施审计确认没有 raw PID stop。
- Responsibility owner: Bot explicit-Server process adapter、`/opencode_stop` command contract，以及 canonical plan 的 secondary/workaround inventory。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 实施无法同时满足该合同。删除 PID discovery/kill 会使计划承诺保留的 explicit loopback `/opencode_stop` 失效；保留它则违反 §11 的删除决定和 §21 的实施审计要求，即使行为测试全部通过也会被计划自身判定为不合规。
- Why this is not speculative: explicit loopback Server、端口 PID discovery 和 kill 均为当前公开且可达的生产路径；R5 明确将其视为现有兼容合同，并为保留行为安排了文件修改和测试。
- Minimal correction direction: 在 compatibility owner 处作出一个一致决定。按照 R5 已证明的现有合同，应把 PID discovery/kill 明确限定并保留在 explicit loopback Server branch，只删除 daemon mode 对这些 helpers 的使用；同步修正 secondary inventory、workaround disposition 和 audit contract。不得把它变成 daemon failure 后的 fallback。

## Non-blocking findings

### N-01 外层仓库仍没有 nested bot commit 的可恢复引用

`thirdparty/opencode-telegram-bot/` 继续被 `.gitignore` 排除，计划只在嵌套仓库创建本地 commit。外层 repository 没有 gitlink、submodule URL 或其他可恢复引用。

该安排满足本地抓取和两个 scoped commits 的字面终态，本轮不作为阻断项。最终实施记录必须明确 nested commit 是仅存在于当前本地 checkout 的资产，不能声称外层 commit 可以重新获取或恢复它。

### N-02 中文注释主题仍使用了旧的 “configuration presence” 表述

§17 lines 765-767 写的是 “configuration presence, not hostname”，R5 的实际 invariant 已改为 trim 后的有效值，而不是键是否存在。由于 §7、§10、§13、§15 和 TDD slice 已明确 undefined/empty/whitespace 的行为，这处不改变实施合同，属于非阻断文字修正。

## Rejected speculation

- Workspace 没有当前 bot producer，不要求增加 Workspace routing。
- 任意 `/global/event` 客户端都会增加 daemon SSE count，不需要 TUI registration、模拟 TUI 或第二条 liveness stream。
- directory-less `server.connected` 和 `server.heartbeat` 不产生 bot 消费的 Session/Project mutation，不要求修改 schema。
- 未消费的 additive Event/EventV2 类型不要求 compatibility handling。
- live-but-unresponsive owner 必须继续复用并报告 unavailable；不能启动第二个 daemon。
- daemon JSON 解析或 acquisition 失败不能切换到 explicit Server。
- 显式 loopback PID stop 的现有安全属性不在本轮证据下构成独立新缺陷；本轮问题是 R5 对其保留/删除决定互相冲突。
- 当前证据不要求修改 worker、Server route、数据库、OpenAPI、generated SDK 或 global Event producer。

## Requirement and traceability coverage

R5 已正确解决上一轮 `OPENCODE_API_URL` 缺口：

- undefined、empty、whitespace 和 wizard blank 经统一 trim-normalization 选择 daemon mode；
- trim-nonempty URL 选择 direct Server mode；
- explicit loopback/custom-port Server 保持当前 URL、start/stop/monitor 和 Event compatibility；
- 两种 mode 不会因运行时失败互相切换；
- config 和 startup 测试覆盖 undefined、empty、whitespace、explicit loopback 和 explicit remote。

其他完整映射包括：

- standalone Server 与 shared daemon 的首个分歧；
- `Daemon.ensure()`、owner election、stopping owner、launcher PID、machine JSON 和 safe stop；
- mutable SDK binding 与 daemon URL 重绑定；
- mandatory global SSE、无 Project liveness、Project/Session 变化不关闭 transport；
- daemon mode 禁止 legacy Event fallback；
- persisted due scheduled task 在 first ready 前不执行，ready 后只执行一次；
- Provider Project scope 和 cache/in-flight isolation；
- resolved SDK tuple error、optional diff 和双向 Question interaction；
- SDK `1.15.3`、隔离 HOME/XDG/lock/database、package-local verification；
- 1,200 行生产代码硬上限、实际 E/C 重算及两个 scoped commits。

当前唯一行为合同缺口是 explicit loopback Server PID stop 的 disposition 自相矛盾。

中文注释预算 `E ≈ 850`、`C >= 128` 算术正确，并承诺实施审计按实际 diff 重算；plan mode 下可行。

## Primary-path and fallback verdict

R5 的 connection-mode 主路径本身成立：

no effective OPENCODE_API_URL
  -> daemon CLI
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE
  -> ready-gated consumers

trim-nonempty OPENCODE_API_URL
  -> existing direct Server client
  -> explicit loopback management or remote direct mode

以下 fallback 已正确拒绝：

- daemon failure 后尝试 fixed-port Server；
- Bot 解析 `ServerLock`；
- Bot 实现第二套 election；
- daemon mode 的 global-to-legacy Event fallback；
- malformed daemon JSON 后切换 mode；
- 第二条 heartbeat/liveness SSE。

Explicit Server、Server-only legacy Event compatibility、message-part diff compatibility 和 same-Project stale cache 均有现有消费者依据。

主路径仍受 B-01 阻断：R5 无法确定 explicit loopback PID stop 究竟属于保留的 supported branch，还是必须删除的 superseded workaround。

## Release verdict

**BLOCK**

审计对象：canonical plan **R5**，完整原始范围。必须统一 explicit loopback Server 的 serve/PID/kill disposition，并同步 secondary inventory、workaround section 和 audit contract；该修改属于行为合同修订，需递增 revision 后再次进行 full-scope plan audit。当前不得记录为 `approved`，不得进入实施。
```

R6 resolves B-01 by classifying port-scoped PID discovery/kill once: it is
preserved only for the explicit loopback Server supported branch and forbidden
to daemon mode. Secondary inventory, workaround disposition, file plan, tests,
and audit contract now use the same rule. N-02 is corrected to the
trim-nonempty effective-value wording. No production behavior or file scope
changed from R5.

### Round 6 Verdict (Verbatim)

```text
## Blocking findings

### B-01 计划修改没有运行时消费者的 `models.ts`

- Violated invariant: 每个生产代码修改必须有 observed、contracted 或 reachable 的消费者和行为要求；未注册、未导入的 dead module 不能被纳入兼容性修复。
- Evidence class: observed
- Producer and execution path: Telegram command → `registerCommandRouter()` → 已显式注册的 command handlers。`modelsCommand` 没有在 router 中注册，整个 `src` 中也没有任何 import 或调用；因此没有 Telegram update、startup flow、service 或其他 producer 能到达 `src/bot/commands/models.ts`。
- Source evidence: `thirdparty/opencode-telegram-bot/src/bot/commands/models.ts:1-46` 只定义并导出 `modelsCommand`；`thirdparty/opencode-telegram-bot/src/bot/routers/command-router.ts:1-24,63-92` 没有导入或注册它；对 nested bot `src/**/*.ts` 的直接搜索只找到该定义本身；现有 `tests/bot/commands` 也没有 `modelsCommand` 或 `config.providers()` consumer。
- Canonical-plan evidence: §4 line 150 错误地将 `src/bot/commands/models.ts` 分类为 reachable；§5.3 lines 208-210 和 §10.2 lines 513-517 声称有五个 current consumers；§13 line 598 将五个 consumers 全部纳入 INV-05；§15 line 673 计划修改该文件，但没有对应 command-level test。
- Responsibility owner: Bot command registration seam，以及 canonical plan 的 Provider-consumer inventory。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 按 R6 实施会修改一个无法通过任何当前生产入口执行的模块。该改动不能改善任何用户可观察的 Provider Project scope，也无法通过计划认可的 public command seam 写出 red-capable test；它直接违反“无 proposed production concept 缺少反向依据”和“测试必须对原行为敏感”的硬门槛。
- Why this is not speculative: command router 是当前 command 的唯一显式注册入口，source-wide 搜索证明没有其他 importer。计划也没有提出注册 `/models`，而新增该注册会成为原始需求未授权的新功能和公开接口扩展。
- Minimal correction direction: 从生产文件计划、五-consumer 计数和相关 traceability 中移除 `src/bot/commands/models.ts`，只修复四个真实可达的 Provider consumers。不要通过注册新 command 来人为制造 reachability。

## Non-blocking findings

### N-01 外层仓库仍没有 nested bot commit 的可恢复引用

`thirdparty/opencode-telegram-bot/` 被 `.gitignore` 排除，计划只在嵌套 repository 创建本地 commit。外层 repository 没有 gitlink、submodule URL 或其他可恢复引用。

本地 checkout 和两个 scoped commits 满足当前需求的字面终态，因此本轮不作为阻断项。最终实施记录必须明确该 nested commit 仅存在于当前本地 checkout，不能声称外层 commit 可以重新获取它。

## Rejected speculation

- Workspace 没有当前 bot producer，不要求增加 Workspace routing。
- `/global/event` 已计入 daemon SSE client count，不需要 TUI registration、模拟 TUI 或第二条 liveness stream。
- directory-less `server.connected` 和 `server.heartbeat` 不产生 bot 消费的 Session/Project mutation，不要求修改 schema。
- 未消费的 additive Event/EventV2 类型不要求 compatibility handling。
- live-but-unresponsive owner 必须继续复用并报告 unavailable；不能启动第二个 daemon。
- daemon JSON 解析或 acquisition 失败不能切换到 explicit Server。
- explicit loopback Server 的 port-scoped PID stop 已在 R6 中一致限定为现有 Server compatibility，不进入 daemon mode。
- 当前证据不要求修改 worker、Server route、数据库、OpenAPI、generated SDK 或 global Event producer。
- 不应通过注册新的 `/models` command 修复 B-01；这会扩展公开产品接口，而不是修复现有兼容路径。

## Requirement and traceability coverage

R6 已正确解决前五轮确认的问题：

- undefined、empty、whitespace 和 wizard blank `OPENCODE_API_URL` 统一选择 daemon mode；
- trim-nonempty URL 保持 direct Server 语义，包括 explicit loopback/custom-port；
- daemon 和 explicit Server 不发生 failure-triggered mode switching；
- persisted due scheduled task 在 first authoritative ready 前不执行，ready 后只执行一次；
- explicit loopback serve/PID/kill 只保留在现有 Server branch，daemon mode 禁止使用；
- Secondary Inventory、file plan 和 audit contract 对 PID stop 的分类已经一致。

其余需求映射完整：

- standalone Server 与 shared daemon 的首个分歧；
- `Daemon.ensure()`、owner election、stopping owner、launcher PID、machine JSON 和 safe stop；
- mutable SDK binding 与 daemon URL 重绑定；
- mandatory global SSE、无 Project liveness、Project/Session 变化不关闭 transport；
- daemon mode 禁止 legacy Event fallback；
- 四个可达 Provider service consumers 的 Project scope 和 cache/in-flight isolation；
- resolved SDK tuple error、optional diff 和双向 Question interaction；
- SDK `1.15.3`、隔离 HOME/XDG/lock/database、package-local verification；
- 1,200 行生产代码硬上限、实际 E/C 重算和两个 scoped commits。

缺口集中在 Provider inventory：计划把一个没有 producer 的 dead command module 当成第五个 current consumer。

中文注释预算 `E ≈ 850`、`C >= 128` 算术正确，并承诺按实际 diff 重算；plan mode 下可行。移除 dead-file 修改后，实施审计仍须根据新的实际 `E` 重新计算最低 `C`。

## Primary-path and fallback verdict

R6 的连接主路径满足单一权威语义：

no effective OPENCODE_API_URL
  -> daemon CLI
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE
  -> ready-gated consumers

trim-nonempty OPENCODE_API_URL
  -> existing direct Server client
  -> explicit loopback management or remote direct mode

以下路径已正确删除或拒绝：

- daemon failure 后尝试 fixed-port Server；
- Bot 解析 `ServerLock`；
- Bot 实现第二套 election；
- daemon mode 的 global-to-legacy Event fallback；
- malformed daemon JSON 后切换 mode；
- 第二条 heartbeat/liveness SSE；
- daemon mode 使用 port/PID kill。

Explicit Server compatibility、Server-only legacy Event、message-part diff compatibility 和 same-Project stale cache 均有现有消费者依据。

连接主路径通过。整体计划仍受 B-01 阻断，因为 Provider scope 文件计划包含一个无消费者的生产改动。

## Release verdict

**BLOCK**

审计对象：canonical plan **R6**，完整原始范围。

本轮已达到 plan audit 的六轮上限。B-01 作为阻断 open decision 保留：默认最小方向是移除未注册的 `src/bot/commands/models.ts` 修改及“五个 current consumers”声明；注册新 `/models` command 会扩展产品接口，需要用户另行明确授权。根据迭代上限，当前审计系列不得继续通过追加 revision 自动取得批准，实施仍被禁止。
```

The primary evidence check confirms the blocker: `modelsCommand` has no import,
router registration, test producer, or other caller. The minimum correction is
therefore to remove only that dead module from Provider scope and keep the four
reachable service consumers; registering a new command is outside scope. The
six-round plan-audit limit prevents an automatic R7 approval under this GOAL.

The user explicitly authorized one exceptional R7 full-scope audit after the
six-round limit. R7 resolves B-01 only by removing the unreachable
`src/bot/commands/models.ts` modification and changing Provider traceability
from five consumers to the four reachable service consumers. It does not
register a new command, alter Provider behavior, or change any other file,
owner, test seam, route, fallback, or compatibility decision.

### Series 1 Round 7 Process Verdict (Verbatim)

```text
## Blocking findings

### B-01 Plan audit 已达到六轮上限

- Violated invariant: 同一 canonical plan 的 plan audit 最多进行六轮；达到上限后，未解决 finding 必须保留为 blocking open decision，不能通过第七轮审计取得批准。
- Evidence class: contracted
- Producer and execution path: R1 → R2 → R3 → R4 → R5 → R6 已完成六轮 full-scope plan audit；R6 仍有 B-01 → 当前请求构成同一需求、同一 canonical plan 的第七轮审计请求。
- Source evidence: `.opencode/policy/first-principles-engineering.md:548-557`; `.opencode/skills/adversarial-audit/SKILL.md` 的 Release Rules。
- Canonical-plan evidence: 上一轮读取的 §22 Plan Audit Record 已记录 R1–R6 六轮；R6 verdict 保留 `src/bot/commands/models.ts` 无消费者的问题。
- Responsibility owner: First-principles audit workflow 和用户对 open decision 的处置。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前审计系列不能对后续 revision 出具有效 `APPROVE`。未经新的用户决策直接实施，会绕过仓库强制的审计轮次门槛。
- Why this is not speculative: 六轮审计已经在当前会话完成；政策明确规定达到上限后不得弱化 finding 或继续自动迭代。
- Minimal correction direction: 用户需要明确处置 open decision。最小选择是确认移除未注册、无消费者的 `src/bot/commands/models.ts` 修改及“五个 Provider consumers”声明；若希望注册新的 `/models` command，则必须明确授权该公开功能扩展。之后应由一个新的、独立的 audit series 从完整原始范围重新审计最终 revision。

## Non-blocking findings

- 外层 repository 仍未记录 nested bot commit 的可恢复 gitlink；该事项在前六轮中保持非阻断。
- 本轮没有读取或评估六轮上限之后的 canonical revision，因此不对其内容作增量判断。

## Rejected speculation

- 不能假设后续 revision 已正确移除 dead `models.ts` 修改。
- 不能因修改看似很小而跳过新的完整范围独立审计。
- 不能把现有 dead command 注册为 `/models` 来自动制造 reachability；这需要用户明确授权公开接口扩展。

## Requirement and traceability coverage

R6 之前已完成 daemon、SSE liveness、配置 mode、scheduled task、Provider scope、SDK drift、optional diff、Question interaction、验证、行数和中文注释门槛的完整范围审计。

未关闭的 open decision 是：

src/bot/commands/models.ts
  -> 没有 import
  -> 没有 command registration
  -> 没有生产 producer
  -> 不应纳入兼容性生产修改

六轮之后的 revision 未经本轮审计，不具备新的 coverage verdict。

## Primary-path and fallback verdict

截至 R6，shared-daemon 主路径和 fallback classification 已通过：

no effective OPENCODE_API_URL
  -> daemon CLI
  -> Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE

trim-nonempty OPENCODE_API_URL
  -> existing direct Server branch

当前阻断来自审计迭代上限和未处置的 dead production modification，不来自 daemon 主路径。

## Release verdict

**BLOCK**

当前 audit series 已达到六轮上限，不能执行第七轮或批准新的 revision。R6 的 B-01 保留为 blocking open decision；实施仍被禁止，直到用户明确处置该决策并启动新的独立完整范围审计。
```

The user resolved the open decision by explicitly choosing removal of the dead
`models.ts` modification and authorizing a new full-scope audit. R7 contains
that exact correction. The next audit starts a new independent series and must
reconstruct the complete original scope rather than relying on series 1.

### Independent Series 2 Round 1 Verdict (Verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 外层仓库无法恢复 nested bot commit

`thirdparty/opencode-telegram-bot/` 被 `.gitignore:31` 排除；外层仓库只记录了另外两个 gitlink，`.gitmodules:1-8` 也没有 Telegram bot 条目。R7 计划在 nested repository 和外层 repository 分别创建本地 commit，能够满足当前工作树中的抓取、修改和“不 push”终态，但外层 commit 无法独立恢复 nested commit。

实施记录必须准确说明这是当前机器上的独立 nested checkout，不能声称外层仓库已经 vendoring、submodule 化或记录了可恢复引用。

### N-02 端到端隔离 harness 仍以操作描述代替完整命令

§18 第 802–803 行定义了同一 daemon PID/URL、无 Project SSE liveness、跨客户端 Session、Question 和安全停止的隔离验证流程，但没有给出脚本路径或完整可复制命令。

这不阻断 R7，因为相关行为已分别映射到：

- `packages/opencode/test/cli/tui/daemon.test.ts`
- bot `tests/opencode/daemon-connection.test.ts`
- bot `tests/opencode/events.test.ts`
- Question、startup 和 scheduled-task 行为测试
- §16 的 red-capable TDD slices

实施阶段应保留 harness 的实际命令、隔离环境变量和结果，避免最终只留下叙述性成功声明。

## Rejected speculation

- `/global/event` 已在 `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:60-95` 对任意 SSE client 计数；bot 无需注册或模拟 TUI，也无需第二条 heartbeat/liveness stream。
- Workspace 没有当前 bot producer，不要求新增 Workspace routing。
- `message.part.progress` 等未消费 additive events 不要求新增 compatibility branch。
- directory-less `server.connected` 和 `server.heartbeat` 不携带 bot 消费的 Session/Project mutation，不要求修改其 schema。
- live-but-unresponsive daemon owner 必须继续复用并报告 unavailable；不得据此创建第二个 owner。
- daemon JSON、health 或 acquisition 失败不得切换到 standalone fixed-port Server。
- trim-nonempty loopback `OPENCODE_API_URL` 是现有 direct Server 支持域，其 serve、port-scoped PID stop 和 Event compatibility 可以继续保留；它不是 daemon-failure fallback。
- npm 发布的 `@opencode-ai/sdk@1.15.3` 已包含本次依赖的 optional `SnapshotFileDiff.file`、Question events 和 `config.providers({directory})` 合同。SMARK 本地 generated SDK 的其他增量目前没有 bot consumer，不构成本次额外生产修改依据。
- 不应注册 dead `src/bot/commands/models.ts` 来制造 reachability；R7 已正确将它从修改范围移除。

## Requirement and traceability coverage

R7 对完整原始需求和受影响接口形成了可执行映射：

- **third-party 来源**：固定为 `v0.22.3`、commit `4367863fe6b5d1dd2ba33d5f7fa88ea69c782875`；nested repository 的 remote、tag 和 HEAD 一致。
- **首个分歧**：当前 bot 在 `src/opencode/process.ts:81-120` 启动 `opencode serve --port`，而 TUI 在 `packages/opencode/src/cli/cmd/tui/daemon.ts:307-408` 通过 `Daemon.ensure()` 发现、复用或选举 shared daemon。
- **OpenCode owner**：lock、owner election、stopping-owner wait、launcher、random internal URL 和 single-owner 语义继续由现有 daemon module 持有；OpenCode 只增加 machine-readable CLI adapter。
- **连接模式**：undefined、empty、whitespace 和 wizard blank 统一进入 shared-daemon mode；任意 trim-nonempty URL 保留 direct Server 语义，包括 loopback/custom-port。
- **daemon liveness**：现有 global SSE count 直接进入 worker `isActive()`，见 `worker.ts:450-455,563-584`；一条 bot process-level `/global/event` stream 足以维持 daemon，无需手动 TUI。
- **SSE 生命周期**：无 Project 启动、Project switch、Session detach/mismatch、daemon URL 变化、explicit stop 和 auto-restart policy 均有 owner、文件和敏感测试映射。
- **startup ordering**：当前 `start-bot-app.ts:71-85` 在连接建立前执行 model reconciliation 和 scheduled runtime initialization；R7 把 client rebind 与 `server.connected` 设为所有 OpenCode-backed startup consumers 的前置条件。
- **scheduled task**：当前 due task 在 `scheduled-task-runtime-service.ts:242-265` 立即执行；R7 明确要求 ready 前零执行、ready 后恰好一次。
- **Provider scope**：四个真实可达 service consumers 均传递 selected Project worktree，并把 worktree 纳入 cache/in-flight identity；dead `models.ts` 已排除。
- **SDK drift**：exact SDK pin、resolved `{data,error}`、Revert error、optional diff、Provider query 和 global/raw SSE 均有对应适配与测试。
- **Question interaction**：Telegram reply 主路径保留；TUI-first reply/reject 通过 request ID 匹配清理 Telegram interaction，且 unrelated request 保持不变。
- **安全和状态隔离**：没有数据库 schema、migration、worker、Server route、OpenAPI 或 generated SDK 修改；daemon 测试要求隔离 HOME/XDG/lock/database。
- **规模与交付**：生产代码预计约 650 effective lines，硬上限 1,200；两个 repository 分别 scoped commit，不 push，不触碰外层无关 staged/worktree changes。

每个确认需求和 invariant 均映射到 production owner、具体文件及行为测试或隔离验证。每个新增生产概念也有 REQ/INV、可达证据和现有逻辑不足说明。

## Primary-path and fallback verdict

权威默认本地路径唯一：

no effective OPENCODE_API_URL
  -> opencode daemon start/status
  -> existing Daemon.ensure/election
  -> actual random internal URL
  -> mutable SDK binding
  -> one mandatory /global/event stream
  -> server.connected
  -> ready-gated HTTP/Event consumers

现有显式 Server 支持域保持独立：

trim-nonempty OPENCODE_API_URL
  -> direct Server client
  -> explicit loopback management or remote direct mode

R7 正确拒绝：

- daemon failure 后尝试 fixed-port Server；
- bot 解析 `ServerLock`；
- bot 实现第二套 election；
- daemon mode 的 global-to-legacy Event fallback；
- malformed JSON 后切换 connection mode；
- 第二条 liveness SSE；
- daemon mode 使用 port/PID kill；
- hidden catch-and-default success。

保留的 Server-only legacy Event compatibility、message-part diff compatibility、same-Project stale cache 和 explicit loopback process management 都有现存消费者依据，并且不会由 daemon primary-path failure 激活。新增 alternate success path 为零；计划估计的 diagnostic decision surface 低于 10%。

## Code quality and Chinese-comment verdict

Plan-mode 门槛可行：

- 预计 `E = 850`。
- 最低 `C = ceil(850 × 0.15) = 128`。
- R7 明确承诺按实际双仓库 diff 重新计算，而非使用估算通过 implementation audit。
- 注释主题覆盖 invariant、owner boundary、launcher PID、single-owner、SSE liveness、mode compatibility、Project cache identity、Question idempotency 和测试意图。
- 用户逐字给出的中文注释硬门槛对本次实现构成明确授权，能够覆盖 nested repository 的一般英文注释规则。
- 预计生产代码约 650 effective lines，低于 1,200 行硬上限。

实际 `E/C`、注释邻近性、有效解释内容、production line cap 和 repository style 仍须在 implementation audit 中按真实 diff 复核。

## Release verdict

**APPROVE**

该结论仅适用于 canonical plan **R7** 的当前完整内容。R7 可以记录为 `approved`；任何生产路径、owner、文件范围、测试 seam、fallback classification 或 compatibility contract 的实质变化都必须递增 revision 并重新进行 full-scope plan audit。
```

R8 supersedes R7 after the first authorized exact-SDK installation and real
bot build exposed two additional compile owners. The installed node-fetch v2
declarations make two import suppressions stale, and
`file-download-service.ts` currently passes a DOM `RequestInit` to node-fetch's
distinct v2 contract. R8 adds only those two files and their existing public
behavior regressions: remove the stale suppressions and type file-download
options at the node-fetch adapter seam. No runtime branch, dependency, route,
fallback, daemon behavior, Event behavior, or user-facing contract changes.
The partial R7 implementation stopped immediately after this build signal and
remains unapproved until R8 receives a new full-scope audit.

### Independent Series 2 Round 2 Verdict (Verbatim)

```text
## Blocking findings

### B-01 启动阶段阻塞 Telegram polling，违反计划约定的 acquisition retry 语义

- **Violated invariant:** Bot 应在 OpenCode acquisition 重试期间保持 Telegram polling 可用；OpenCode-backed runtime 必须等待 authoritative ready，但 bot 本身不能被连接失败阻塞。
- **Evidence class:** observed
- **Producer and execution path:** `startBotApp()` 创建 bot → `await startOpencodeConnection()` → 执行 `opencode daemon start --json` → daemon acquisition 失败或超时 → 异常在 `bot.start()` 前传播，Telegram polling 尚未启动。
- **Source evidence:** `thirdparty/opencode-telegram-bot/src/app/bootstrap/start-bot-app.ts:73-91`; `thirdparty/opencode-telegram-bot/src/opencode/daemon-connection.ts:22-36,73-88`; `thirdparty/opencode-telegram-bot/src/opencode/process.ts:132-158`
- **Canonical-plan evidence:** §10.1 lines `491-503` 明确要求 “Startup keeps Telegram polling available while acquisition retries”；§16 slice 3、5、10 要求 startup acquisition、global SSE readiness 和 ready-gated consumers 分离。
- **Responsibility owner:** Bot startup orchestration 与 daemon connection lifecycle 的边界。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 当 shared daemon 不存在、live owner 无响应、CLI 启动失败或 acquisition 超时时，bot 不会进入 `bot.start()`，用户无法通过 Telegram 触发 `/opencode_start`、查看状态或等待后续恢复。当前 `startOpencodeConnection()` 没有 retry loop，`startBotApp()` 也没有异步脱离 acquisition 的启动路径。
- **Why this is not speculative:** 当前代码的 `await` 顺序和 `runOpencodeDaemonCommand()` 的 non-zero reject 已直接形成该路径；R8 又明确称只修复 node-fetch 类型和 stale suppression，不改变 runtime branch，因而不会修复该偏差。
- **Minimal correction direction:** 由 startup orchestration 保持 Telegram polling 生命周期独立运行，把 OpenCode-backed model、Session、scheduled-task 等 consumer 继续挂在 first authoritative ready barrier 后；acquisition 失败只能进入既定 unavailable/retry 语义，不能新增 fixed-port fallback。

### B-02 daemon URL 变化后的 Event 断线没有立即重新发现和重绑定

- **Violated invariant:** daemon mode 发生 unexpected disconnect 且 desired state 为 `running` 时，bot 必须重新发现现有 owner、在需要时复用同一 `Daemon.ensure()` 路径，并在新的 global SSE `server.connected` 后恢复 ready；不能持续使用已经失效的 URL。
- **Evidence class:** observed
- **Producer and execution path:** shared daemon URL A → daemon 退出或 owner 更换为 URL B → global SSE 读取失败/结束 → `events.ts` 仅按原 subscription retry → `opencodeClient` 仍绑定 URL A；`recoverOpencodeConnection()` 只在 auto-restart monitor 中被调用，Event 断线本身没有调用 connection recovery 或 status rediscovery。
- **Source evidence:** `thirdparty/opencode-telegram-bot/src/opencode/events.ts:373-429`; `thirdparty/opencode-telegram-bot/src/opencode/daemon-connection.ts:59-66`; `thirdparty/opencode-telegram-bot/src/opencode/auto-restart.ts:131-142`
- **Canonical-plan evidence:** §10.1 lines `480-488` 要求 unexpected disconnect 立即 rediscover，并区分 auto-restart enabled/disabled；§16 slice 8 要求 URL A loss 重绑定 URL B，disabled recovery 也必须执行 status-only wait/re-discovery。
- **Responsibility owner:** Long-lived Event transport 与 daemon connection orchestration 的协作边界。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 随机 daemon URL 变化后，bot 的 HTTP consumer 和 Event transport 会持续请求已失效的 URL A。auto-restart disabled 时不会执行 status-only rediscovery；auto-restart enabled 时也只能等待 monitor interval，而不是按计划在 disconnect path 立即恢复。Bot 可能长期处于错误 ready 状态，无法继续观察 shared Session、Question 或 Run state。
- **Why this is not speculative:** 当前 Event catch/retry path 的实际代码只递增 `reconnectAttempt`、等待后继续使用同一个 `opencodeClient`；`recoverOpencodeConnection()` 的唯一现有调用点在 `auto-restart.ts` 的定时检查分支，当前 Event path 没有其他 producer。
- **Minimal correction direction:** 由 Event/connection orchestration 在 daemon-mode disconnect owner seam 调用既定 status/ensure recovery，并通过已有 generation/desired-state guard 完成 client rebind；新的 global SSE `server.connected` 仍是恢复 ready 的唯一条件，不得转入 legacy `/event` 或 fixed-port Server。

## Non-blocking findings

### N-01 外层仓库仍无法独立恢复 nested bot commit

`thirdparty/opencode-telegram-bot/` 仍被 `.gitignore:31` 排除，外层 `.gitmodules:1-8` 没有该 checkout 的 gitlink 或 URL。R8 仍把 nested bot 作为独立本地 Git checkout 处理。

这满足当前“抓取到 thirdparty 文件夹”和本地不 push 的工作流，但外层 commit 无法让另一份 checkout 自动恢复该 bot。最终提交记录必须准确说明 nested commit 仅存在于当前本地 checkout，不得声称它已被 vendoring 或 submodule 化。

### N-02 R8 的实现证据仍是 pending，但当前工作树已经存在 R7 partial implementation

Canonical plan §23 lines `1716-1753` 仍正确保留 implementation evidence、实际 `E/C`、测试结果和 commit 记录为 pending。当前两个 repository 的工作树已经包含 R7 partial implementation，但这不应被记录为 R8 已实现、已验证或已提交。

进入 implementation audit 前必须重新收集完整双仓库 diff、red-green 证据、实际 `E/C`、生产代码行数和 scoped commit 证据。

## Rejected speculation

- `/global/event` 已由 `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` 计入 daemon SSE client count；不需要 TUI registration、模拟 TUI 或第二条 liveness SSE。
- Workspace routing 没有当前 Telegram bot producer，不要求扩展到 Workspace。
- 未被 bot 消费的 additive Event/EventV2 类型不要求新增 compatibility branch。
- directory-less `server.connected` 和 `server.heartbeat` 不携带当前 bot 消费的 Session/Project mutation，不要求修改 global event schema。
- live-but-unresponsive owner 必须继续复用并报告 unavailable；不得因 health 不可用创建第二个 daemon。
- daemon JSON 解析、status 失败或 acquisition 失败不得切换到显式 `OPENCODE_API_URL` 或 fixed-port `opencode serve`。
- 显式 trim-nonempty loopback `OPENCODE_API_URL` 的 serve、port-scoped PID stop 和 monitor 仍是既有 direct Server 支持域，不属于 daemon recovery fallback。
- R8 新增的 node-fetch 类型修复本身没有证据要求增加 runtime branch、依赖、API route 或新的 compatibility layer。
- 不应重新注册 dead `src/bot/commands/models.ts` 来制造 Provider consumer reachability。

## Requirement and traceability coverage

R8 保留了 R7 已建立的大部分正确映射：

- third-party checkout 来源、tag 和 commit 已固定。
- standalone `opencode serve` 与 TUI shared daemon 的首个分歧已定位。
- OpenCode owner discovery、election、stopping-owner、launcher PID 和 safe stop 仍由现有 daemon module 持有。
- `OPENCODE_API_URL` 的 undefined/empty/whitespace 与 trim-nonempty mode contract 已明确。
- global SSE 是 daemon liveness seam，bot 不需要注册为 TUI。
- Project/Session filter 与 process-level Event transport 的责任边界已明确。
- Provider directory scope、SDK tuple error、optional diff 和双向 Question resolution 均有 production owner 与测试映射。
- scheduled task 的 ready gate 已写入 invariant、startup owner 和行为测试。
- R8 新增的 node-fetch v2 `RequestInit` 类型归属和 stale suppression 修复具有 observed build evidence，文件范围也受到限制。
- 1,200 行 production cap 和 `E/C` 重新计算要求仍然存在。

但当前完整 affected interface 仍有两个可达运行时缺口：

1. startup acquisition failure 会阻塞 Telegram polling；
2. Event disconnect 不会触发 daemon URL rediscovery/rebind。

这两个缺口直接落在 R7/R8 所声明的 startup、recovery 和 Event transport contract 内，不能由 R8 的纯类型修复覆盖。

## Primary-path and fallback verdict

R8 的文档设计仍声明以下单一主路径：

no effective OPENCODE_API_URL
  -> daemon start/status
  -> existing Daemon.ensure/election
  -> mutable SDK binding
  -> mandatory global SSE
  -> server.connected
  -> ready-gated consumers

显式 Server 仍是独立支持域：

trim-nonempty OPENCODE_API_URL
  -> direct Server client
  -> explicit loopback management or remote direct mode

计划继续正确拒绝：

- daemon failure 后 fixed-port Server fallback；
- bot 解析 `ServerLock`；
- bot 第二套 election；
- daemon mode global-to-legacy Event fallback；
- 第二条 liveness SSE；
- daemon mode port/PID kill；
- catch-and-default success。

但当前工作树中的 startup 和 disconnect 实现尚未满足该主路径的完整生命周期合同。特别是：

- acquisition failure 会在 Telegram polling 建立前终止启动；
- disconnect retry 没有进入新的 daemon discovery/rebind transition。

因此当前不能把该主路径视为已经具备可发布的完整实现。

## Code quality and Chinese-comment verdict

Plan-mode 的静态门槛仍可行：

- 估算 `E = 850`。
- 计划最低 `C = ceil(850 × 0.15) = 128`。
- R8 的新增 node-fetch 修复没有引入新的 runtime branch 或依赖。
- R8 已明确要求 implementation audit 按真实 diff 重新计算 `E/C`，不能沿用估算。
- 实际 partial implementation 的 `E/C`、注释邻近性、生产代码行数和 lint/typecheck 结果尚未完成独立 implementation audit。

类型修复的 code-quality 方向合理，但不能抵消上述两个行为级阻断项。

## Release verdict

**BLOCK**

R8 需要先修正 startup polling 与 daemon disconnect rediscovery/rebind 的 owner/path contract，并递增 revision 后重新进行 full-scope plan audit。当前不得记录为 `approved`，不得继续 implementation，也不得进入 `verified-implementation-and-commit`。
```

R9 resolves B-01 by making Telegram polling independent from a supervised,
abortable acquisition retry task while keeping every OpenCode-backed consumer
behind first authoritative ready. It resolves B-02 by making daemon Event
disconnect invoke immediate status/ensure recovery before the next global
subscription attempt, with status-only rediscovery when auto-restart is disabled
and generation/desired-state guards in both branches. No fallback, connection
mode, dependency, Server route, OpenCode owner, or public Telegram command is
added.

### Independent Series 2 Round 3 Verdict (Verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 外层仓库仍无法恢复 nested bot commit

`thirdparty/opencode-telegram-bot/` 被 `.gitignore:31` 排除；外层 `.gitmodules:1-8` 没有对应 gitlink 或 URL。R9 的双 repository 本地 commit 流程满足当前抓取、修改、提交且不 push 的要求，但外层 commit 无法让另一份 checkout 自动恢复 nested commit。

最终实施记录必须准确说明 Telegram bot 是当前机器上的独立 nested checkout，不能声称已被 outer repository vendoring、submodule 化或记录了可恢复引用。

### N-02 隔离端到端 harness 仍以操作步骤代替完整命令

§18 第 820 行定义了同一 daemon PID/URL、无 Project SSE liveness、跨客户端 Session、Question 和安全停止的完整验证流程，但没有提供脚本路径或完整可复制命令。

这不阻断 R9，因为相关行为已分别映射到真实 daemon CLI 测试、bot connection/Event 测试、Question 测试和 package-local verification。Implementation evidence 必须保留实际执行命令、隔离环境变量、观察结果和清理证据，不能只记录叙述性结论。

### N-03 polling independence 没有单独的稳定 invariant ID

R9 已在 §10.1 lines `456-461,499-506`、file plan、`tests/app/start-bot-app.test.ts` 和 TDD slice `10a` 中完整定义“acquisition 失败期间 Telegram polling 保持可用”的行为，但 §7 没有为它增加独立 invariant ID。

现有行为、owner 和敏感测试映射足以执行，因此不阻断批准。后续可以只做行政性编号补充；若改变 polling、retry 或 ready-gating 语义，则属于实质 revision。

## Rejected speculation

- `/global/event` 已直接增加 daemon SSE client count；bot 无需注册或模拟 TUI，也无需第二条 heartbeat/liveness stream。
- Workspace 没有当前 Telegram bot producer，不要求新增 Workspace routing。
- `message.part.progress` 等未消费 additive events 不要求 compatibility branch。
- directory-less `server.connected` 和 `server.heartbeat` 不携带当前 bot 消费的 Session/Project mutation，不要求修改 global event schema。
- live-but-unresponsive owner 必须继续作为唯一 owner 被复用并报告 unavailable；不得启动第二个 daemon。
- daemon JSON、status、health 或 acquisition 失败不得切换到 fixed-port Server。
- trim-nonempty loopback `OPENCODE_API_URL` 是现有 direct Server 支持域；其 serve、port-scoped PID stop、monitor 和 legacy Event compatibility 不属于 daemon fallback。
- status-only recovery 在 auto-restart disabled 时是同一 daemon primary contract 的 owner discovery 分支，不是第二数据源或替代成功算法。
- R8/R9 的 node-fetch 类型修复不需要新增依赖、runtime branch、API route 或 compatibility wrapper。
- 不应注册 dead `src/bot/commands/models.ts` 来制造 Provider consumer reachability。
- 当前 partial implementation 的行为和 `E/C` 是否通过属于后续 implementation audit；本轮只批准精确 R9 计划。

## Requirement and traceability coverage

R9 已完整覆盖原始需求和受影响接口：

- **third-party 来源**：固定为 `v0.22.3`、commit `4367863fe6b5d1dd2ba33d5f7fa88ea69c782875`。
- **首个分歧**：bot 当前 standalone `opencode serve --port` 路径与 TUI 的 `Daemon.ensure()` shared-daemon 路径分离，导致不同 GlobalBus 和 Run state owner。
- **OpenCode owner**：lock parsing、owner election、stopping-owner wait、launcher PID、random URL、Windows launcher 和 safe stop 继续由现有 daemon module 持有；OpenCode 只增加 machine-readable status/start adapter。
- **默认连接模式**：undefined、empty、whitespace 和 wizard blank `OPENCODE_API_URL` 进入 shared-daemon mode；任意 trim-nonempty URL 保留 direct Server 语义。
- **Telegram polling**：R9 明确使 polling 与 supervised、abortable acquisition retry 独立；CLI acquisition failure 不再终止 bot polling，也不改变 connection mode。
- **ready gate**：SDK rebind 和 global SSE `server.connected` 是 OpenCode-backed Session、Provider、model reconciliation 和 scheduled runtime 的共同前置条件。
- **scheduled task**：启动时已到期任务在 first ready 前零执行，之后恰好执行一次；reconnect 不重复初始化 runtime。
- **daemon liveness**：一条 process-level `/global/event` stream 足以让 daemon `isActive()` 保持为真，无需手动 TUI。
- **Event 生命周期**：无 Project 启动、Project switch、Session attach/detach/mismatch 都只更新 business consumer/filter，不关闭 process-level stream。
- **URL recovery**：unexpected disconnect 在下一次 global subscription 前进入 connection lifecycle；auto-restart enabled 时 absent owner 走 ensure，disabled 时只做 status discovery；两者都在 live URL 出现后 rebind。
- **stop race**：desired `stopped` 和 generation guard 优先于旧 acquisition/reconnect 结果；只有显式 `/opencode_start` 或 bot restart 恢复 running intent。
- **Provider scope**：四个真实可达 Provider consumers 传递 selected Project worktree，并把 worktree 纳入 cache 与 in-flight identity。
- **SDK drift**：exact `1.15.3` pin、resolved `{data,error}`、Revert error、optional diff、Question events、Provider query 和 node-fetch v2 类型 owner 均有文件及测试映射。
- **Question interaction**：Telegram reply 主路径保留；TUI-first reply/reject 按 request ID 清理匹配 Telegram interaction，unrelated request 不受影响。
- **安全和隔离**：不修改 worker、Server route、database、OpenAPI、generated SDK 或 Event producer；测试使用隔离 HOME/XDG/lock/database。
- **交付**：生产代码硬上限 1,200 effective lines；两个 repository 分别 scoped commit，不 push，不触碰外层无关 staged/worktree changes。

每个确认需求都映射到 production owner、具体文件和行为测试。每个新增生产概念也有 REQ/INV、observed/contracted/reachable evidence，以及现有逻辑不能承载它的理由。

## Primary-path and fallback verdict

默认本地权威路径唯一：

Telegram polling
  └─ supervised connection lifecycle
       -> opencode daemon start/status
       -> existing Daemon.ensure/election
       -> actual random daemon URL
       -> mutable SDK binding
       -> one mandatory /global/event stream
       -> server.connected
       -> ready-gated consumers

Unexpected disconnect 继续进入同一生命周期：

desired running
  -> status discovery
  -> live owner: rebind
  -> absent owner + auto-restart enabled: existing ensure
  -> absent owner + auto-restart disabled: status-only retry
  -> global SSE server.connected

显式 Server 是独立支持域：

trim-nonempty OPENCODE_API_URL
  -> direct Server client
  -> explicit loopback management or remote direct mode

R9 正确拒绝：

- daemon failure 后尝试 fixed-port Server；
- bot 解析 `ServerLock`；
- bot 实现第二套 election；
- daemon mode global-to-legacy Event fallback；
- malformed JSON 后切换 connection mode；
- 第二条 liveness SSE；
- daemon mode port/PID kill；
- catch-and-default success；
- stale acquisition 覆盖新的 desired state 或 URL。

保留的 Server-only legacy Event compatibility、message-part diff compatibility、same-Project stale cache 和 explicit loopback process management 都有现存消费者依据，且不会由 daemon primary-path failure 激活。新增 alternate success path 为零；诊断路径估计低于 10%。

## Code quality and Chinese-comment verdict

Plan-mode 门槛可行：

- 预计 `E = 850`。
- 最低 `C = ceil(850 × 0.15) = 128`。
- R9 明确要求 implementation audit 根据实际双 repository diff 重算，估算不能替代真实结果。
- 注释主题覆盖 owner boundary、single-owner、launcher PID、polling/acquisition 分离、abortable retry、desired-state race、SSE liveness、URL rebind、Project cache identity、Question idempotency 和行为测试意图。
- 用户逐字给出的中文注释门槛对本次实现构成明确授权，可覆盖 nested repository 的一般英文注释规则。
- 生产代码估算仍低于 1,200 行硬上限。
- node-fetch 修复只调整 stale suppression 和 adapter-owned `RequestInit` 类型，没有扩大 runtime 或 dependency surface。

实际 `E/C`、注释邻近性、production line count、style、typecheck、lint、测试和 runtime harness 仍须由后续 implementation audit 按完整实际 diff 验证。

## Release verdict

**APPROVE**

该结论仅适用于 canonical plan **R9** 的当前完整内容。R9 可以记录为 `approved` 并继续实施；任何 production path、owner、retry/ready 语义、文件范围、测试 seam、fallback classification 或 compatibility contract 的实质变化都必须递增 revision 并重新进行 full-scope plan audit。
```

## 23. Implementation Evidence

Exact approved R13 is implemented. The diff is frozen for independent full-scope
implementation audit; only evidence recording or auditor-required rework may
change before a verdict.

### Actual Files and Diff

- Outer OpenCode: `packages/opencode/src/cli/cmd/daemon.ts`,
  `packages/opencode/src/cli/cmd/tui/daemon.ts`, and
  `packages/opencode/test/cli/tui/daemon.test.ts`.
- Nested bot: 45 changed paths (41 tracked modifications plus four additions)
  covering exact SDK manifest/lock, 21 production TypeScript owners, four public
  docs/config examples, and 13 modified plus four added behavior tests.
  `src/bot/commands/models.ts` remains untouched.
- Effective production/config lines under the conservative added-line method:
  bot 651 plus OpenCode 81 = 732, including Chinese comments; this is below the
  1,200 hard cap. No worker, Server route, database, OpenAPI, generated SDK,
  migration, Event producer, or global environment file changed.

### Red-Green Test Evidence

- OpenCode machine CLI red: `daemon status/start` tests exited `1` because the
  commands did not exist; green: 4 focused tests passed, then full daemon suite
  passed 32 with 3 platform skips.
- Bot mode red: five config tests observed missing mode/old fixed URL; green:
  51 config tests passed for undefined/empty/whitespace/loopback/remote inputs.
- Exact SDK build red: stale node-fetch suppressions, node-fetch/DOM
  `RequestInit` mismatch, and optional diff `file`; green: exact-SDK build and
  adapter regressions pass with no runtime proxy branch added.
- Lifecycle green slices: daemon connection 4/4, Event 17/17, startup 5/5,
  commands 13/13. These assert single-flight, status-only/ensure recovery,
  no daemon legacy fallback, polling independence, first-ready scheduled init,
  desired stop, and preserved explicit Server behavior.
- Compatibility green slices: Provider 41/41, Question/diff 49/49, resolved
  Revert tuple and wizard regressions 44/44. Expected values are fixture
  literals and public outcomes, not private helper algorithms.
- Implementation audit round 1 race red: focused daemon/stop suite produced
  2 failures out of 12 for stale acquisition reuse and missing fail-closed stop.
  Minimal R9 rework green: 12/12 passed; the race test additionally proves the
  restarted generation rebinds and reaches `daemon_global_connected` ready.
- Implementation audit round 2 status-race red: 2 of 8 focused tests proved a
  late live status could rebind and a late absent status could ensure after
  explicit stop. Generation-guard rework green: 8/8 passed for both deferred
  outcomes without changing enabled/disabled recovery policy.
- URL-order cache loop red: status A completed after acquisition B and the final
  rebind was old URL A. R13 green: one generation-scoped lane orders status and
  ensure, and the same cache loop passes 1/1 in 13 ms with final URL B.
- R12/R13 public slices: authority suite 12/12 passes. It covers both operation
  orders, pre-CLI stale-work rejection, new-generation detachment, original
  failure propagation, rejection-neutral retry, stop races, ordinary recovery,
  and explicit Server preservation.
- R13 fixture red: isolated Project context-limit test failed in global cleanup
  because its logger mock omitted `info`; complete interface green: 1/1 passes.
- URL-order implementation audit round 1 red-green: status failure previously
  ensured success and now rejects with zero start; a queued Project A callback
  previously fired after switching to B and now consumer generation drops it
  without restarting SSE; daemon bootstrap previously skipped the configured
  monitor and now starts it without blocking polling. Related suites pass 45/45.
- Final implementation-audit rework suites pass 66/66, including real process
  adapter, post-ready monitor, queued Project consumer, and pinned optional-diff
  behavior. Full bot regression now passes 1,194 tests.

### Verification Commands and Results

- `packages/opencode`: focused daemon CLI 4 pass; full daemon lifecycle 32 pass,
  3 skip; HTTP SDK 16 pass and isolated Event/Config 5 pass; `bun typecheck`
  pass. A combined HTTP run and first isolated SDK rerun hit the existing five-
  second timeout/state-noise window; a cold isolated rerun passed all contracts.
- `packages/sdk/js`: `bun typecheck` pass; generated source unchanged.
- Nested bot: final isolated `npm test` 127 files, 1,194 tests pass;
  `npm run build` pass;
  `npm run lint` pass. A later 75-test core rerun also passed after comments.
- Dependency install: `npm install --save-exact @opencode-ai/sdk@1.15.3` in the
  nested checkout only; 403 packages installed, npm reported three existing
  audit findings (one moderate, two high), with no global install or audit-fix.
- Isolated harness root:
  `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/telegram-shared-daemon-harness.ess9q5`.
  It set isolated HOME/XDG/lock, `OPENCODE_DB=:memory:`, and main process role;
  `daemon start --json --launcher-pid <bot-like PID>` returned PID 42278 and URL
  `http://127.0.0.1:51675`; one no-Project global SSE received
  `server.connected`, survived 5.5 seconds beyond the four-second idle window,
  retained the same PID/URL, and reported `{tuiClients:1,sessionActivity:0}`.
  Safe stop removed the lock; follow-up checks reported `pid-stopped` and
  `port-closed`.

### Original Feedback-Loop Result

The original fixed-port divergence is no longer the default path. Real CLI and
harness evidence prove `ensure -> random URL -> one global SSE -> liveness` with
no TUI and no manual attach. Bot tests prove Project/model switching,
status-only/ensure URL rebinding, ready-gated scheduled tasks, resolved SDK
errors, optional Snapshot diff, and two-sided Question cleanup. Full package
regressions pass after exact SDK installation.
The minimized URL-authority feedback loop first failed with expected B
`http://127.0.0.1:32302` but actual final A `http://127.0.0.1:32301`; after R13
it passes with A settling before queued B and B remaining final authority.

### Actual Secondary and Replacement Path Inventory

- Primary local path: shared daemon CLI -> existing `Daemon.ensure` -> mutable
  SDK -> mandatory global SSE. Implemented and observed.
- Explicit trim-nonempty Server: existing direct branch, including loopback
  serve/PID management and remote direct mode. Preserved and tested.
- Daemon disconnect: status discovery first; absent owner is ensured only when
  existing auto-restart policy permits. Supported-domain branch, not fallback.
- Explicit Server global-to-legacy Event and message-part diff parsing remain
  existing shipped compatibility paths. Daemon legacy fallback remains absent.
- Deleted/collapsed workaround ownership: default fixed port, immutable client,
  Project-owned transport stop, unscoped Provider caches, and success-only
  Revert handling. Bot does not parse ServerLock, elect, scan/kill daemon PID,
  synthesize filenames, add a second SSE, or catch daemon failure into success.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 1,695 | Final goal-scoped conservative added/substantively modified nonblank TypeScript/package config lines across both repositories; excludes outer unrelated patch work, docs, generated lock, imports, blanks, deletions, and pure formatting |
| Qualifying Chinese comment lines `C` | 270 | Adjacent comments manually reviewed for owner, invariant, compatibility, safety, constant, or independent test-intent explanations |
| Ratio `C / E` | 15.93% | `270 / 1695`; both nested (237/1518) and scoped outer (33/177) independently exceed 15% |
| Required minimum `C` | 255 | `ceil(1695 * 0.15)`; actual exceeds minimum by 15 |

### Remaining Unverified Items

- A new full-scope R13 implementation audit remains pending under the user's
  explicit URL-order revision/audit-series authorization.
- Two scoped local commits remain pending a clean implementation verdict; no
  push is authorized.
- The nested commit will remain a current-machine independent checkout without
  an outer gitlink, as recorded by plan audits N-01.
- npm reported three dependency audit findings; no evidence ties them to the
  approved compatibility path, and automatic dependency mutation was not run.
- Two cache-only feedback-loop files remain outside both repositories because
  deletion requires explicit exact-path authorization under the active tool
  policy; they do not affect source, build, tests, global config, or databases.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | B-01 stale acquisition swallowed explicit restart; B-02 explicit stop retained Event/client authority until safe stop completed | N-01 nested checkout is not outer-recoverable; N-02 isolated daemon test timeout was non-reproducible and isolated rerun passed | BLOCK | `ses_075a4f5c5ffeH7lUAl5ki6ihTn` |
| 2 | R9 | yes | B-01 late status recovery could revoke explicit stop through rebind or ensure | N-01 nested checkout is not outer-recoverable; N-02 parallel Vitest timeout disappeared in isolated full rerun | BLOCK | `ses_075a4f5c5ffeH7lUAl5ki6ihTn` |
| 3 | R9 | yes | B-01 older running-generation status A can overwrite a newer acquisition/status URL B because generation does not order URL-producing operations | N-01 nested checkout is not outer-recoverable; N-02 concurrent quality checks can time out while isolated full suite passes | BLOCK; three-round limit reached | `ses_075a4f5c5ffeH7lUAl5ki6ihTn` |
| URL-order series 1 | R13 | yes | B-01 status failure triggered ensure success; B-02 queued old-Project callback survived consumer switch; B-03 daemon monitor branch lacked bootstrap producer | N-01 outer repository cannot recover nested checkout | BLOCK | `ses_0754b94e5ffewRmEoyA9lexkcq` |
| URL-order series 2 | R13 | yes | B-01 monitor acquired/recovered before first ready; B-02 process adapter had no behavior-sensitive test; B-03 pinned all-unnamed compatibility had no behavior-sensitive test | N-01 outer repository cannot recover nested checkout; N-02 unrelated dirty worktree briefly affected typecheck evidence; N-03 daemon cold-start timeout under concurrent load | BLOCK | `ses_0754b94e5ffewRmEoyA9lexkcq` |
| URL-order series 3 | R13 | yes | No blocking findings | N-01 evidence path count was stale; N-02 outer repository cannot recover nested checkout; N-03 combined HTTP run hit existing five-second cold-start window and isolated SDK passed | APPROVE | `ses_0754b94e5ffewRmEoyA9lexkcq` |

### R13 Clean Implementation Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 Implementation Evidence 的 nested 文件数已过期

当前 nested actual diff共有 **45 paths**，新增的两项是上一轮要求补齐的：

- `tests/opencode/process.test.ts`
- `tests/bot/pinned/pinned-message-manager.test.ts`

canonical plan §15已明确授权这两个测试文件，因此不构成范围漂移；但 §23 lines 2006-2008仍记录“43 changed paths”。这是行政性 evidence drift，不影响已批准行为合同。

### N-02 外层仓库无法自动恢复 nested checkout

`thirdparty/opencode-telegram-bot/`仍由外层 `.gitignore`排除，没有 gitlink或 `.gitmodules`。nested基线确认是：

4367863 chore(release): v0.22.3

当前机器上的 independent nested checkout满足来源固定要求。最终交付记录必须保持这一描述，不能声称外层 commit可自动恢复 bot仓库。

### N-03 HTTP组合验证首次命中既有5秒冷启动窗口

组合运行HTTP SDK/Event/Config结果为 `20 pass / 1 timeout`，超时发生在 `httpapi-sdk.test.ts` 的5秒默认窗口。随后单独冷隔离运行该文件得到 `16 pass / 0 fail`。该现象与canonical evidence中记录的既有冷启动/state-noise窗口一致；目标 diff未修改相关 HTTP实现或测试，因此不阻断本次发布。

## Release verdict

**APPROVE**

该clean verdict仅适用于canonical plan **R13**和本轮审计的当前完整outer/nested actual diff，属于URL-order implementation audit series第3轮、也是本series最终full-scope verdict。

当前实现可以记录为`verified`并进入两个repository的scoped commit步骤；不得把无关outer worktree变化纳入commit，不得push。
```

### Round 3 Release Verdict (verbatim)

```text
## Release verdict

**BLOCK**

该结论仅适用于 canonical plan **R9** 和当前完整 actual diff。

本轮已达到 implementation audit 的第 3 轮上限。B-01 保留为阻断性开放决定；不得弱化、标记 `verified` 或按当前 diff 发布。后续是否授权新的计划 revision 或新的审计序列，需要用户明确决定。
```

The task may be marked `verified` only after a later implementation receives an
independent full-scope result of `No blocking findings` for the actual diff and
the exact approved plan revision.

## 25. URL Authority Ordering Revision History (R10-R12)

### Authorization and Scope

After R9 implementation audit reached its three-round limit, the user explicitly
selected: `授权 R10 新审计（Recommended）`. This authorizes one substantive plan
revision and a new independent audit series for the retained R9 finding. R10
preserves every R9 requirement, owner, supported-domain branch, non-goal, file
boundary, and verification gate except where this section explicitly strengthens
the same daemon connection orchestrator contract.

### Current Evidence and Red-Capable Feedback Loop

The affected producers are independently reachable:

```text
Telegram /opencode_start ---------> startOpencodeConnection() -----> daemon start/ensure
startup bootstrap ----------------> startOpencodeConnection() -----> daemon start/ensure
Event disconnect callback --------> recoverOpencodeConnection() ---> daemon status[/ensure]
auto-restart interval ------------> recoverOpencodeConnection() ---> daemon status[/ensure]
```

`OpencodeAutoRestartService.checkInProgress` serializes only its own interval
producer. It does not serialize the Telegram command, startup, or Event producer.
R9 `generation` changes only across stopped/running intent transitions, so two
URL-producing operations in the same running generation can complete out of
order and both pass the current commit guard.

The minimized repro used only a cache-local Vitest file and mocked the external
CLI boundary; it did not modify either repository, global configuration, or a
database:

```text
Working directory:
  thirdparty/opencode-telegram-bot
Command:
  npx vitest run --config "/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/telegram-authority-vitest.config.ts"
Sequence:
  recover status A pending -> start/ensure B commits -> status A returns
Expected final rebind:
  http://127.0.0.1:32302
Observed final rebind:
  http://127.0.0.1:32301
Result:
  1 failed / 1 total in 37 ms
```

This is deterministic, public-seam, agent-runnable, and red-capable for the exact
stale-authority symptom. The two cache files remain outside both repositories;
deletion requires separate exact-path authorization under the active tool policy.

### Strengthened Invariant and First Divergence

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-21 | Within one running desired-state generation, every operation that can publish a daemon URL uses one serialized authority lane; an earlier status/ensure operation cannot publish after a later operation has become authoritative. A stopped generation is detached immediately, so a new explicit start does not wait for or inherit old work. | Reachable producer graph plus observed cache repro; refines INV-03 and INV-17 without changing supported behavior | Missing; cache repro is red |

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-21 | `startOpencodeConnection()` and `recoverOpencodeConnection()` independently launch URL-producing CLI operations, while `generation` orders only desired-state transitions rather than operations in the same running generation. | `src/opencode/daemon-connection.ts` public connection orchestration API | Deferred status A starts first; acquisition B binds; A returns last and overwrites B while both carry the same generation. |

The first divergence is not OpenCode election or status freshness: OpenCode owns
each individual daemon command correctly. It occurs when the bot connection
orchestrator permits multiple command results to publish HTTP/SSE authority
without one operation order.

### Responsibility and Single Primary Path

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| URL-authority operation ordering | `src/opencode/daemon-connection.ts` | `startOpencodeConnection()` and `recoverOpencodeConnection()` publish one current URL to all ESM live-binding consumers | This module already owns desired state, generation, acquisition single-flight, status recovery, rebind, and stop invalidation | OpenCode CLI owns process election, Event owns SSE transport, auto-restart owns interval policy, and commands own Telegram UI; none sees all URL producers |

The current revision primary path is:

```text
running-generation producer
  -> enter that generation's one serialized authority lane
  -> immediately before any queued CLI side effect, verify generation is still current and desired state is running
  -> obsolete queued work exits without invoking status/ensure or publishing authority
  -> status or existing Daemon.ensure command
  -> verify generation is still current
  -> publish at most one URL authority
  -> next same-generation operation begins

explicit stop
  -> commit stopped + increment generation + detach old lane
  -> abort Event + fail-close client + safe stop

explicit start after stop
  -> create/use new running-generation lane immediately
  -> existing Daemon.ensure -> URL -> global SSE -> ready
```

The lane is generation-scoped rather than process-global. Same-generation
status/ensure operations are ordered. Every queued operation checks generation
and desired state after it reaches the front of the lane and before its first
CLI call, so stop-invalidated work that never started has no daemon side effect.
An already-running old CLI child remains uncancellable but cannot publish after
its completion guard; stop does not await it, and a subsequent explicit start
uses a detached new-generation lane immediately. Recovery's existing
status-first and auto-restart policy stays in one lane operation. No alternate
data source, retry policy, fixed port, legacy Event, owner parser,
identity-specific stop API, or success-shaped error conversion is introduced.

Lane ordering waits for the preceding operation to settle, not only to fulfill.
The preceding operation's rejection is returned unchanged to its own caller and
continues to drive the existing unavailable/retry path; the lane tail converts
that settlement only into permission for the next queued operation to begin.
The next operation executes its own CLI and produces its own result, so one
temporary spawn/non-zero/startup failure cannot poison later supervised retry,
Telegram start, Event recovery, or monitor work. This settlement bookkeeping
does not catch-and-succeed for the failed caller and does not add another
connection path.

### Secondary Path and Workaround Inventory

| Path | Classification | Current disposition |
| --- | --- | --- |
| Generation-scoped status/ensure lane | Primary contract | Add at the existing connection owner |
| Explicit trim-nonempty Server | Supported-domain branch | Preserve unchanged; does not enter daemon lane |
| Auto-restart disabled status-only discovery | Primary-contract policy branch | Preserve inside the same lane; no ensure |
| Explicit Server legacy Event compatibility | Existing shipped compatibility | Preserve; unreachable from daemon failure |
| Fixed-port/legacy/ServerLock/second-SSE fallback | Forbidden fallback | Remains absent |
| Existing unconstrained same-generation commits | Superseded orchestration | Collapse into the lane; do not retain a parallel commit path |

New alternate success paths: zero. Diagnostic decision-surface share: zero for
R10; it adds ordering only and emits no new diagnostic success state.

### Forward and Reverse Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-03, INV-21: stale A cannot overwrite B | status A enters lane; start/ensure B queues behind A; B is the final published authority | `src/opencode/daemon-connection.ts`: serialize same-generation URL-producing operations | Deferred status A, queued acquisition B, A then B completion; final public rebind is B |
| INV-03, INV-21: acquisition and later status observe one order | acquisition B enters lane; recovery status cannot execute/publish until B completes | same file and lane | Deferred acquisition B; assert status has not started; finish B; status B completes; final authority remains B |
| INV-17, INV-21: queued old work has no post-stop side effect | status A occupies old lane; start B queues; stop invalidates generation; after A resolves B exits before CLI | same file: pre-execution generation/desired-state gate at lane owner | Deferred `status A -> start B queued -> stop -> A resolves`; assert no B start CLI and no rebind |
| INV-17: stop/restart preempts old generation | stop detaches old lane; new start uses a new lane while old command remains unresolved | preserve and extend current generation invalidation | Existing stop-during-acquisition and stop-during-status tests remain green; add assertion that new generation command starts without resolving old lane |
| INV-02, INV-21: one failed lane operation does not poison later retry | first operation rejects to its caller; lane tail permits the next same-generation operation to execute its own daemon CLI | same file: settled predecessor sequencing without success conversion | First acquisition/status rejects; second same-generation operation actually invokes CLI, succeeds, and rebinds literal URL while first remains rejected |
| Stable daemon/Server compatibility | all existing startup, recovery, Event, Provider, Question and explicit Server paths | no other production file changes | Existing focused and full suites |

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Generation-scoped serialized authority lane | INV-03, INV-17, INV-21 | Observed A-after-B repro and four reachable producers | Desired-state `generation` rejects stopped generations but intentionally remains unchanged among running operations; `inFlight` only merges acquisitions and does not include status recovery |
| Pre-execution stale-work gate | INV-17, INV-21 | Plan-audit B-01 producer sequence reaches a queued ensure after stop | Completion guards cannot prevent a not-yet-started queued operation from creating an owner; the lane owner is the first seam before the CLI side effect |
| Recovery executes status and optional ensure in one lane operation | INV-21 | Current recovery can call acquisition after status and races independent producers | Calling the public start function as a separately queued operation would either deadlock behind its own recovery operation or reopen an unordered gap; the existing `acquireDaemon` primary helper already owns ensure parsing and commit guards |
| Rejection-neutral lane tail | INV-02, INV-21 | CLI spawn/non-zero failures are reachable and `runLifecycle()` retries in the same generation | A fulfillment-only Promise chain inherits rejection and suppresses every later CLI call; settlement must release ordering without changing the failed operation's externally observed rejection |

No new setting, dependency, public command, API response, Event shape, cache,
fallback, daemon module change, OpenCode file, or persisted state is proposed.

### File Plan and TDD Slices

| File | Change | Exact responsibility | Estimated effective delta |
| --- | --- | --- | ---: |
| `thirdparty/opencode-telegram-bot/src/opencode/daemon-connection.ts` | modify | Add one generation-scoped operation lane and route daemon status/ensure URL publication through it; preserve immediate stop detachment | 25-40 |
| `thirdparty/opencode-telegram-bot/tests/opencode/daemon-connection.test.ts` | modify | Add public deferred ordering slices and retain all stop/status/acquisition regressions | 45-70 |
| this canonical plan | modify | Current-revision evidence, mapping, audit and later implementation record | docs excluded |

Agreed test seam remains the exported connection API plus observable CLI adapter,
rebind, and ready lifecycle boundaries. Tests do not inspect private counters,
queue objects, source text, or OpenCode lock internals.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | status A remains pending, start B is requested, then A completes; final URL must be B | both operations run and A publishes after B | B waits in the same-generation lane and publishes after A | Exact observed cache repro |
| 2 | acquisition B remains pending and recovery is requested; status must not start until B completes, then final URL remains B | recovery currently launches status independently | status enters the same lane after acquisition | Reverse producer ordering and SSE/HTTP authority consistency |
| 3 | status A pending, start B queued, then stop; after A resolves B must not invoke daemon CLI | serialization creates a reachable not-yet-started old operation unless lane entry revalidates intent | obsolete B exits before its first CLI side effect | Plan-audit B-01 and stable explicit stop |
| 4 | stop while an old lane operation is pending, then explicit start; new-generation CLI must start before old operation resolves and reach rebind/global ready | a process-global queue would regress the approved R9 stop/start behavior | stop detaches old generation and new lane runs independently | INV-17 plus no serialization-induced restart stall |
| 5 | first same-generation acquisition/status rejects; a second operation must invoke daemon CLI and successfully rebind | a fulfillment-only tail remains rejected and skips later work | lane tail advances after settlement while the first caller still receives its original rejection | Supervised retry and command/recovery continuity without catch-and-success |

Each slice is one red -> minimal green cycle with literal URLs/PIDs. Expected
final URLs are independent fixtures and assertions remain at public behavior.

### Verification, Budget, Risks, and Rejected Speculation

Verification after approved implementation:

| Command | Working directory | Evidence |
| --- | --- | --- |
| `npm run test -- tests/opencode/daemon-connection.test.ts` | nested bot | all operation-order, stop, recovery and explicit Server slices |
| `npm test` | nested bot, isolated from concurrent build | complete regression suite |
| `npm run build` | nested bot | strict TypeScript and ESM bindings |
| `npm run lint` | nested bot | source style |
| Existing OpenCode daemon/HTTP tests and package-local typechecks from R9 | respective package directories | no drift in unchanged OpenCode adapter/SDK contracts |

R12 incremental estimate is `E = 75-120`, requiring `C = 12-18`; qualifying
comments will explain generation-scoped lane ownership, stop detachment, and the
five independent test intentions adjacent to those decisions. Combined
production effective lines are estimated below 740, still below 1,200. No
generated changes are expected.

Reachable risk: a process-global queue would make restart wait up to the old CLI
timeout. The generation-scoped lane and slice 3 prohibit it. Reachable risk: an
optional ensure invoked from inside recovery could enqueue behind itself; R10
requires status plus optional ensure to remain one lane operation using the
existing acquisition helper. Rejected as speculative or out of owner scope:
identity-specific daemon stop, cancellable CLI protocol, status timestamps,
fixed-port fallback, another health source, or changes to OpenCode election.

Open decisions requiring the user: none after the explicit R10 authorization.

### URL-Order Audit Contract and Record

The user-authorized URL-order revision uses a new independent plan-audit series of at most six full-scope
rounds. Every round covers the complete original requirement and affected
interface, not only INV-21. Prior R9 approval and implementation audits are
historical evidence, not R10 authorization. Only `No blocking findings` and
`APPROVE` for exact R12 may set `Status: approved`, `Approved revision: R12`,
and `Implementation allowed: yes`.

| Series | Round | Revision | Full scope? | Findings | Result | Invocation reference |
| --- | ---: | --- | --- | --- | --- | --- |
| URL-order plan audit | 1 | R10 | yes | B-01 queued old-generation ensure could invoke CLI after explicit stop; N-01 duplicate invariant ID; N-02 stale R9 non-goal; N-03 nested checkout not outer-recoverable | BLOCK | `ses_0756e1ef7ffe0h4o9k7LXkdsII` |
| URL-order plan audit | 2 | R11 | yes | B-01 lane failure continuation undefined; N-01 stale R10 labels; N-02 nested checkout not outer-recoverable; N-03 comment budget said three tests instead of four | BLOCK | `ses_0756e1ef7ffe0h4o9k7LXkdsII` |
| URL-order plan audit | 3 | R12 | yes | No blocking findings; N-01 current contract retains minor historical R10 labels; N-02 outer repository cannot recover nested checkout | APPROVE | `ses_0756e1ef7ffe0h4o9k7LXkdsII` |

### R12 Clean Plan Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 当前合同仍残留少量 R10 标签

顶部元数据、审批条件和审计表均正确指向 exact R12，但当前合同中仍有几处历史 R10 表述：

- §25 line 2257：diagnostic decision surface 写为 “zero for R10”；
- line 2286：canonical-plan file change 写为 “R10 evidence”；
- lines 2323–2324：recovery risk 仍写 “R10 requires”；
- line 2331：标题仍为 `R10 Audit Contract and Record`。

§25 已明确是 `R10-R12` revision history，且 lines 2333–2338 明确规定只有 exact R12 的 clean verdict 才能批准，因此这些标签不改变实施合同。记录 clean verdict 时可做纯行政性统一；任何行为变化仍须递增 revision。

### N-02 外层仓库仍无法恢复 nested bot checkout

`thirdparty/opencode-telegram-bot/` 被 `.gitignore:31` 排除，外层 `.gitmodules` 没有对应 gitlink。nested checkout 的 upstream remote、`v0.22.3` tag 和 commit `4367863fe6b5d1dd2ba33d5f7fa88ea69c782875` 已直接验证，满足当前机器上的来源固定和抓取要求。

外层 commit 无法让另一份 checkout 自动恢复 bot 或其后续 nested commit。最终交付记录必须继续准确描述为当前机器上的 independent nested checkout，不能声称已被 vendoring、submodule 化或由外层仓库持久引用。

## Release verdict

**APPROVE**

该 clean verdict 仅适用于 canonical plan **R12** 的当前完整内容，属于 URL-order 新审计系列第 3 轮，并覆盖完整原始需求和 affected interface。

R12 可以记录为：

Status: approved
Revision: R12
Approved revision: R12
Implementation allowed: yes

任何 production path、lane settlement、generation/stop semantics、文件范围、测试 seam、fallback classification、compatibility contract 或中文注释最低门槛的实质变化，都必须递增 revision 并重新进行 full-scope plan audit。
```

### R13 Verification-Fixture Amendment

After approved R12 implementation, isolated full verification produced one
failure outside the authority behavior assertions:

```text
npm run test -- tests/app/services/model-context-limit-service.test.ts
FAIL: TypeError: logger.info is not a function
  at stopEventListening(src/opencode/events.ts:491)
  at resetSingletonState(tests/helpers/reset-singleton-state.ts:75)
```

The reachable chain is the repository-wide `tests/setup.ts` afterEach hook ->
`resetSingletonState()` -> `stopEventListening()` -> `logger.info()`. The
Project-scope test's hoisted logger mock exposes only `debug` and `warn`, so its
own cleanup cannot execute the real Event reset contract. This is a test-fixture
boundary defect, not a production Event/logger defect and not authority-lane
behavior. Changing production to tolerate an incomplete test mock would be a
responsibility leak.

R13 adds exactly one planned test-file change:

| File | Change | Responsibility | Effective delta |
| --- | --- | --- | ---: |
| `thirdparty/opencode-telegram-bot/tests/app/services/model-context-limit-service.test.ts` | modify | Add `info: vi.fn()` to the existing logger mock so global singleton cleanup exercises the real logger interface | 1 |

The existing isolated command is already red-capable and observed. Minimal
green is the complete mock interface; no assertion, production behavior, setup
hook, Provider behavior, fallback, or file beyond the R12 plan changes. After
green, rerun the isolated file, complete bot suite, build, and lint. Conservative incremental
`E=2` and `C=1` require one adjacent qualifying Chinese comment; the existing three-line
comment at the Project-scope assertion does not explain this mock boundary, so
R13 will add one adjacent Chinese comment explaining that global cleanup uses
`logger.info`. Production effective-line estimate remains unchanged at 691 plus
the approved lane delta and below 1,200.

| URL-order plan audit | 4 | R13 | yes | No blocking findings; N-01 incremental E estimate omitted the new comment line; N-02 outer repository cannot recover nested checkout | APPROVE | `ses_0756e1ef7ffe0h4o9k7LXkdsII` |

### R13 Clean Plan Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 R13 增量 E 估算遗漏新增注释行

R13 将增量写为 `E=1`，但计划同时增加：

1. `info: vi.fn()` 测试代码行；
2. 一行邻近中文解释性注释。

按照本计划此前采用的“substantively modified nonblank TypeScript lines”口径，增量更保守地应记为 `E=2`、`C=1`。实际比例为 `50%`，最低要求仍是 `ceil(2 × 0.15)=1`，因此不降低中文注释硬门槛，也不阻断批准。Implementation audit 必须按完整 actual diff 重新计算。

### N-02 外层仓库仍无法恢复 nested bot checkout

`thirdparty/opencode-telegram-bot/` 被 `.gitignore:31` 排除，外层 `.gitmodules` 没有对应 gitlink。nested checkout 的 upstream remote、`v0.22.3` tag 和 commit `4367863fe6b5d1dd2ba33d5f7fa88ea69c782875` 已直接验证，满足当前机器上的来源固定和抓取要求。

外层 commit 无法让另一份 checkout 自动恢复 bot 或其 nested commit。最终交付记录必须继续描述为当前机器上的 independent nested checkout，不能声称已被 vendoring、submodule 化或由外层仓库持久引用。

## Release verdict

**APPROVE**

该 clean verdict 仅适用于 canonical plan **R13** 的当前完整内容，属于 URL-order 新审计系列第 4 轮，并覆盖完整原始需求和 affected interface。

R13 可以记录为：

Status: approved
Revision: R13
Approved revision: R13
Implementation allowed: yes

任何 production behavior、authority-lane semantics、fixture范围、测试断言、fallback classification、compatibility contract 或中文注释最低门槛的实质变化，都必须递增 revision 并重新进行 full-scope plan audit。
```

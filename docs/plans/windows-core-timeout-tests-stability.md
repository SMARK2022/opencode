# Canonical Implementation Plan: Windows Core Timeout Test Stability

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 修正Windows 当前两个超时测试：可能通过，也可能再次偶发失败。不能进行测试的大量实质性降级而是要找到一个比较好的更加能反应真实行为逻辑时序等等是否有问题的测试；也就是要么检查主行为是否有问题要么检查测试本身是否有问题。修复后要保证测试能通过，且不影响其他测试。
>
> Implementation allowed: yes (verified; commit authorized by end state)
>
> Last updated: 2026-07-21
>
> R1 plan BLOCK. R2 plan BLOCK. R3 plan APPROVE. Implementation: round1 BLOCK B-01 race; round2 APPROVE.

This file is the sole implementation specification for this task. Chat
summaries, the previously verified process timing plan, and builder rationale
outside this file are evidence only and do not authorize implementation.

## 1. Verbatim Requirement

> 修正Windows 当前两个超时测试：可能通过，也可能再次偶发失败。不能进行测试的大量实质性降级而是要找到一个比较好的更加能反应真实行为逻辑时序等等是否有问题的测试；也就是要么检查主行为是否有问题要么检查测试本身是否有问题。修复后要保证测试能通过，且不影响其他测试。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不修改 `packages/opencode/src/util/process.ts`，除非新的可重复证据证明 `Process.run`/`Process.spawn` 的生产 abort 合同在目标路径本身失效。
- 不修改 `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`、`ReasoningRun`、`ReasoningBody` 或错误展示逻辑；当前 Windows 成功样本证明目标 UI 语义可以在相同 SHA 上完成。
- 不跳过、标记 flaky、屏蔽平台、吞掉错误、删除断言或把行为断言改成源码/调用次数断言。
- 不把 `Process` abort 的 `<2_000ms` 语义断言改成仅等待最终退出；只把启动 readiness watchdog 与 abort 行为预算分离。
- 不把 reasoning 测试改成只验证任意一段文字；保留 aborted footer、provider error、两段 reasoning 正文四项用户可见行为。
- 不修改 package/CI 全局 timeout、Bun 并发策略或 GitHub workflow 来掩盖单测 harness 问题。
- 不修改此前 Linux ColdStorage、Windows maintenance rename、doom-loop、i18n、SDK 或其他并行工作树内容。
- 不复用或改写已完成的 `docs/plans/process-test-timing-fix.md`、`docs/plans/ci-linux-cold-status-windows-eperm-fix.md` 或 `docs/plans/windows-macos-ci-test-failures.md` 作为本任务实现授权；它们只提供历史证据。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | `Session`、`Message`、`Part` 和 TUI 运行时的当前领域边界；目标是用户可观察的 Session Message frame，不改变持久化或生产 Session 语义。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、单一权威路径、零新 fallback、forward/reverse traceability 和独立审计。 |
| `.opencode/templates/canonical-plan.md` | 规定本文件的完整章节、revision 和审核状态。 |
| `AGENTS.md` | 测试和 typecheck 必须在 package 目录运行；必须保留无关工作树修改。 |
| `packages/opencode/AGENTS.md` | 保持现有模块形状、错误处理和测试组织；不把测试同步责任泄漏到生产模块。 |
| `packages/opencode/test/AGENTS.md` | 并发测试必须使用 published readiness signal，不以固定 sleep 假设 fork/渲染已就绪。 |
| `docs/adr/README.md`、`docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 没有与 Process 或 TUI 渲染相关的 accepted ADR；本任务不新增架构决策。 |
| `packages/opencode/package.json` | package-local `test`/`test:ci` 使用 Bun；package 默认测试 timeout 为 30 秒。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| GitHub Actions run `29773888043`, SHA `1c53af980ffa43da912c26f167e1e9cb0ab579c2` | 原始 Windows required job 的两个失败和完整测试计数。 | observed |
| Required Windows job `88458505334` / check `88466043322` | `util.process` 3,000.45ms timeout；reasoning test 5,335.02ms frame timeout；3,997 tests中2失败。 | observed |
| Successful same-SHA Windows compatibility check `88464619179` / job `88458505209` | 同一 SHA、同一平台、4,726 tests、0 failures；两个目标测试分别 562.51ms 和 174.80ms。证明不是确定性产品失败。 | observed |
| Required Windows raw log | reasoning 失败的最后 frame 为空；timeout 后才出现 `kv.json` ENOENT 清理噪声。 | observed |
| `packages/opencode/test/util/process.test.ts:53-81` | 目标 abort 测试把 readiness deadline 和整个 test timeout 都设为 3 秒。 | observed |
| `packages/opencode/src/util/process.ts:58-153` | `Process.run` 的真实 producer/consumer：spawn、Windows sync `taskkill`、`proc.kill`、exit/stdout/stderr 并行等待。 | observed |
| `packages/opencode/test/util/process.test.ts:83-135` | 相邻 Windows process-tree 测试使用 stdout readiness，并在失败 run 中以 910.26ms 通过，支持生产 abort 路径正常。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:41-44` | 文件只串行化同一文件测试；跨文件 native renderer 仍可并行。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:745-783` | reasoning-only 测试的四项用户可见 expected behavior。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:2821-2948` | `withRenderedSession` 在 `testRender` 后立即运行 callback；`waitForFrame` 使用 2 秒墙钟 + `Bun.sleep(10)`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-377` | Session route 先异步 `session.get`，再执行 `sync.session.sync`；mount 返回并不代表 transcript 已进入 store。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:868-975,1012-1060` | Sync bootstrap/status 和 session message/part snapshot 的实际 producer；`status`/store 是可观察 readiness seam。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1642-1817,1852-1977` | Reasoning、aborted footer、非 abort error 的真实 consumer 与渲染边界。 | observed |
| `packages/opencode/thirdparty/opentui/packages/core/src/testing/test-renderer.ts:198-329` | OpenTUI 已提供 scheduler-aware `waitForFrame`，不是固定墙钟轮询。 | contracted / observed |
| `packages/opencode/thirdparty/opentui/packages/core/src/renderer.ts:1051-1055` | Windows 默认 `useThread: true`，Linux 默认 false。 | observed |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx:139-179` | 已有 Windows 兼容先例：`useThread:false`、等待 `sync.status === "complete"`、显式 cleanup。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx:88-103` | 已有同类 TUI route fixture 在 Windows-safe `useThread:false` 下观察最终 frame。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-export.test.tsx:150-165,250-265` | 已有 `useSync` probe + store predicate 等待 session 数据的测试 seam。 | observed |
| `.github/workflows/test.yml:31-50,315-353` | required job 使用 package test；upstream job 使用独立 runner 和串行 turbo，解释同 SHA 的不同时序结果。 | observed |
| `docs/plans/process-test-timing-fix.md:81-152` | 历史 marker 修复已把 spawn 延迟从 abort 计时中移除，但仍保留 readiness deadline 与 test timeout 相等的残余边界；仅作证据，不作本计划授权。 | observed |
| 本机 process 压力 loop | 24 个 CPU burner 下重复 20 次，当前 macOS 20 pass；说明本机不能替代 Windows 原生 red signal。 | observed |
| 本机 TUI 压力 loop | 8 个 CPU burner 下重复 10 次，当前 macOS 10 pass；与 same-SHA Windows 成功样本和失败样本一起证明平台负载敏感性。 | observed |

## 5. Current Behavior

### 5a. Process abort test

```text
Bun test starts test
  -> Process.run(node(script), { abort, nothrow })
  -> Process.spawn attaches abort listener and starts Bun child
  -> child writes ready marker, then keeps event loop alive
  -> test polls marker for at most 3s
  -> abort.abort()
  -> Windows Process abort synchronously runs taskkill /T /F
  -> proc.kill()
  -> Process.run waits for exited + stdout + stderr
  -> code != 0 and abort elapsed < 2s assertions
```

The test-level watchdog is also 3 seconds. A slow child startup can consume the
entire outer budget before the test reaches the abort semantic assertions. The
production path itself preserves the intended Windows process-tree behavior;

### 5b. Reasoning-only TUI test

```text
withRenderedSession
  -> create temp KV state and fake transport
  -> testRender mounts SessionHarness
  -> Session route asynchronously calls session.get and sync.session.sync
  -> SyncProvider fills message/part store
  -> ReasoningRun mounts ReasoningBody
  -> CodeRenderable asynchronously emits highlighted chunks
  -> waitForFrame repeatedly calls renderOnce and sleeps 10ms
  -> predicate requires both reasoning bodies + interrupted + provider error
```

`testRender` returning only proves that the renderer/root was created. It does
not prove that the Session snapshot or its Parts are present. The helper calls
the behavior callback immediately and gives the final frame only a 2-second
wall-clock window. The failed Windows frame was blank, so the failure occurred
before the four presentation assertions could observe their semantic target.

The `kv.json` `ENOENT` emitted after the timeout is teardown fallout: the test
has already failed and its temporary state is being disposed while an async
provider read is still finishing. It is not the first divergence.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Windows runner with delayed child startup | GitHub Actions Windows runner + Bun child process | Child eventually writes marker when started; OS does not promise startup latency | `process.test.ts` marker poll and outer Bun timeout | Test harness watchdog | observed |
| Windows `Process.run` abort after child readiness | `Process.spawn` / `Process.run` | Abort invokes taskkill/proc.kill and resolves streams | `test/util/process.test.ts` | `src/util/process.ts` | observed / contracted |
| Session renderer mounted before transcript sync completes | `Session` route effect + `SyncProvider` bootstrap | HTTP/fake transport eventually returns session/messages/parts; mount itself has no sync guarantee | `withRenderedSession` invokes callback immediately after `testRender` | TUI test fixture | observed / reachable |
| Async reasoning Markdown chunk production | `ReasoningBody` `CodeRenderable.onChunks` | Final visible chunks eventually appear after store data | `reasoning-only` frame predicate | TUI renderer/test synchronization | observed / reachable |
| Windows native renderer thread default | OpenTUI `CliRenderer` default | `useThread` defaults true on Windows; test fixture may explicitly select false | repeated `testRender` mounts across TUI files | TUI test harness configuration | observed / reachable |
| Arbitrary production reasoning rendering failure after data readiness | none in current evidence | no failing producer trace; same SHA Windows success exists | no proven path | — | speculative; cannot drive implementation |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Once the child has published readiness, abort must terminate `Process.run` with a non-success code and resolve its output promises. | `src/util/process.ts:73-109`; adjacent Windows process-tree test passes. | `test/util/process.test.ts:70-76` |
| INV-02 | Process abort timing must measure abort completion after readiness; outer Bun timeout must satisfy `outer ≥ readiness + abort_budget(2s) + cleanup`; readiness must not starve the abort assert. | `test/AGENTS.md:161-204`; CI failure at exactly 3,000.45ms; R1 audit B-01. | `test/util/process.test.ts:53-81` |
| INV-03 | The reasoning test may begin visual assertions only after the fixture's Session message and Part snapshot is published into the Sync store. | `Session` route and `SyncProvider` call chain; existing `session-export` probe precedent. | `session-message-render.test.tsx:745-783` |
| INV-04 | The final frame must preserve both reasoning bodies, the aborted `interrupted` footer, and the non-abort provider error as separate visible behaviors. | `AssistantMessage` rendering at `routes/session/index.tsx:1776-1814`; user requirement forbids test weakening. | `session-message-render.test.tsx:768-780` |
| INV-05 | Frame waiting must force renderer progress and yield for TreeSitter Worker highlight delivery; diagnostic wall bound only after Sync ready; keep `string[]` helper contract. | `drawUnstyledText=false` + Worker oneshot; R1 B-02; R2 B-01 yield/budget. | `session-message-render.test.tsx:2938-2948` currently uses sleep+2s as mixed readiness. |
| INV-06 | TUI fixtures must not leave a native renderer thread or temporary KV operation alive after a failed test. | Existing `sync-fixture` Windows cleanup decision and `withRenderedSession` `finally`. | TUI fixture suites and target test cleanup. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | `test/util/process.test.ts` gives marker readiness up to 3 seconds while the entire test has the same 3-second timeout. Startup delay can terminate the test before `abort.abort()` and its semantic assertions. | `packages/opencode/test/util/process.test.ts` test watchdog/readiness boundary; production `Process` remains the downstream behavior under test. | Required Windows job failed at `3000.45ms`; same SHA Windows compatibility run passed the test at `562.51ms`; no production diff exists in the failure commit. |
| INV-03/05 | `withRenderedSession` invokes the callback immediately after `testRender`, before `Session`'s async `session.get`/`sync.session.sync` publishes message and Part data, then uses a custom 2-second wall-clock loop. | `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` fixture seam. | Failure frame was blank and threw `timed out waiting for frame`; same SHA run passed at `174.80ms`; `sync-fixture.mount` already waits on Sync readiness. |
| INV-06 | The target fixture leaves OpenTUI's Windows-default threaded renderer selected, unlike the existing Windows-safe repeated-mount fixture. | `session-message-render.test.tsx` `testRender` configuration. | OpenTUI defaults `useThread:true` on Windows; `sync-fixture.tsx` explicitly sets false because repeated mount/destroy otherwise races native cleanup. |

**Red-capable feedback loops and observed results:**

```text
# package directory: packages/opencode
bun test --timeout 3000 test/util/process.test.ts -t 'aborts a running process' --rerun-each 10
```

This command drives the exact child-process abort path and can fail on the
3-second watchdog. On the current macOS host, an 8-burner run produced 10/10
pass; a 24-burner run produced 20/20 pass. The original Windows required job
is the red execution of the same path: `3000.45ms` timeout.

```text
# package directory: packages/opencode
bun test --timeout 10000 test/cli/cmd/tui/session-message-render.test.tsx -t 'reasoning-only messages preserve abort and error presentation' --rerun-each 10
```

This command drives the real Session/Sync/ReasoningRun/CodeRenderable path and
asserts the exact four visible strings. On the current macOS host under eight
CPU burners it produced 10/10 pass. The original Windows required job is the
red execution: blank final frame and `timed out waiting for frame`; the same
SHA Windows compatibility job produced 0 failures, proving load/platform
sensitivity rather than a deterministic presentation result.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Child startup readiness boundary | `test/util/process.test.ts` | The test owns when it begins measuring abort; marker is a published child signal. | The failure is created by the test's nested watchdogs, not by Process API input validation. | `src/util/process.ts` cannot know the test's startup budget and has correct abort behavior. |
| Abort semantic measurement | `test/util/process.test.ts` | Observe non-zero exit and bounded completion after readiness. | Keeps the public `Process.run` seam and independent expected value. | A private helper or production timing hook would weaken the behavioral test. |
| Session fixture readiness | `session-message-render.test.tsx` | Callback begins after the fixture's public Sync store has the requested Session transcript. | The helper owns its provider setup and already controls fake transport/state. | `Session` production route must not expose a test-only readiness API. |
| Renderer execution mode | `session-message-render.test.tsx` fixture | Visual semantics are tested without requiring a native threaded renderer lifecycle. | Existing Windows-safe TUI fixtures make this choice at the test renderer seam. | Production renderer defaults and OpenTUI core thread tests are outside this Session behavior fixture. |
| Frame progression wait | `session-message-render.test.tsx` helper using OpenTUI `waitForFrame` | The test waits for actual renderer frames, then applies its visible predicate. | OpenTUI owns scheduler/frame events; the local helper should not duplicate a wall-clock scheduler. | Production Session code cannot own test frame polling. |

## 10. Single Approved Primary-Path Design

```text
Process test:
child publishes marker -> readiness watchdog (8s, distinct error)
  -> abort -> Process.run resolves -> non-zero + abort-to-done <2s
  outer Bun test timeout (15s) covers readiness + abort + cleanup

TUI test:
testRender(useThread:false) -> SyncReadyProbe (distinct missing-data error)
  -> behavior callback -> local waitForFrame (renderOnce + event-loop drain + 5s diagnostic)
  -> unchanged four-string visible assertions
```

### Process path

- Keep the marker-file producer and the `Process.run` public seam.
- **Outer guard is the Bun test third-argument timeout**, not a second nested
  promise. It is a deadlock diagnostic only and never decides abort success.
- Budget formula (R2; resolves audit B-01):

  ```text
  readiness_deadline = 8_000ms   // marker poll only; fail with readiness diagnostic
  abort_semantic_budget = 2_000ms // post-marker Process.run completion assert
  cleanup_and_assert_overhead = 5_000ms // expect + finally temp cleanup margin
  outer_bun_timeout >= readiness + abort + overhead = 15_000ms
  ```

  Planned concrete values: readiness poll 8s; outer Bun timeout **15s**. This
  leaves a full 2s abort semantic window plus 5s cleanup/assert margin after a
  worst-case readiness wait. R1's 8s + 10s left only 2s total after readiness
  and could collide with the `<2_000ms` abort assertion itself.
- Start the measured clock immediately after the marker exists.
- Preserve `out.code !== 0` and `abort-to-completion <2_000ms`; these remain the
  semantic assertions and are not replaced by a larger general timeout.
- If the marker never appears, throw a readiness-specific error
  (`child process did not signal readiness`) before abort; do not report an
  abort-timeout false positive.
- Keep `finally` abort and temp-directory cleanup.

### TUI path

- Keep the existing `withRenderedSession` fake transport and real Session route.
- Mount a test-only `SyncReadyProbe` beneath the existing `SyncProvider`. Resolve
  the fixture readiness promise only when the target Session exists, its message
  array has been installed, and each fixture message has a Part array installed.
  This observes the existing store contract and does not duplicate rendering.
- **Readiness failure is distinct from frame failure** (audit non-blocking fix):
  probe timeout throws `timed out waiting for session sync data` with the missing
  session/message/part detail; frame helper throws
  `timed out waiting for frame after N passes` with the last captured frame.
- Pass `useThread:false` to this repeated-mount test renderer, matching the
  existing Windows-safe `sync-fixture` and `session-v2-error` seams. This does
  not change production renderer configuration or Session semantics.
- Await the readiness promise before invoking each test's existing `run`
  callback. Keep a separate finite failure guard (e.g. 10s) that only reports
  missing Sync data; it must never turn missing data into success.
- **Local `waitForFrame` remains the file helper and keeps the caller-facing
  `(lines: string[]) => boolean` / `string[]` return contract** (R1 B-02).
  Do **not** inherit bare OpenTUI `app.waitForFrame` default `maxPasses=20` or
  its idle-exit path: OpenTUI exits early when the scheduler is idle between
  async Markdown highlight callbacks, while this file's 65+ call sites rely on
  repeated `renderOnce` to force progress.
- **R3 frame-wait yield/budget coherence** (resolves R2 audit B-01):

  Reasoning bodies use `<code drawUnstyledText={false} filetype="markdown" />`.
  `CodeRenderable` awaits TreeSitter Worker oneshot highlight before painting
  text; until then the frame stays blank even when Sync data is present
  (`Code.ts` highlight gate; OpenTUI Code tests assert blank until highlight).
  Therefore each wait pass must return control far enough for Worker
  `ONESHOT_HIGHLIGHT_RESPONSE` delivery, not only a pure microtask.

  ```text
  // After SyncReadyProbe has already published session/message/part data.
  FRAME_WAIT_DEADLINE_MS = 5_000  // diagnostic wall bound only; not Sync readiness
  // 5s > observed Windows success (~175ms) and legacy 2s helper; covers Worker
  // highlight under CI load without replacing semantic asserts.

  loop while Date.now() < deadline:
    await app.renderOnce()                 // force frame progress even if idle
    frame = rows(app.captureCharFrame())
    if predicate(frame) return frame
    // OpenTUI-strength drain (test-renderer drainImmediateWork):
    await Promise.resolve()                // microtasks
    await new Promise(r => process.nextTick(r))
    // One macrotask tick so Worker postMessage can land + requestRender.
    // This is event-loop yield for highlight delivery, NOT sleep-as-Sync-readiness
    // (Sync readiness is already complete via SyncReadyProbe).
    await new Promise(r => setTimeout(r, 0))

  throw `timed out waiting for frame after ${elapsed}ms (${passes} passes):\n${frame}`
  ```

  Explicitly **rejected** (R2 mistake): calibrating maxPasses to ~10ms polls but
  only `await Promise.resolve()` each pass — 250 microtask-only iterations can
  finish in far less wall time than highlight needs under load, reintroducing
  blank-frame false failures across 65+ call sites.

- Retain the current four-condition predicate and assertions. No expected string
  is removed or weakened. Intermediate call sites keep the same helper API.

This is one test-harness synchronization path for each affected public seam. It
does not add a fallback renderer, alternate data source, retry-success path, or
production compatibility branch.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Marker readiness followed by `Process.run` abort | proposed | primary-contract branch | yes | 100% of process test path | adopt |
| Readiness 8s + Bun outer 15s + abort assert `<2s` | proposed | diagnostic guard; formula outer ≥ readiness+abort+cleanup | no; only fails deadlocks | bounded diagnostic only | adopt (R2 margin fix) |
| R1 readiness 8s + outer 10s | rejected R1 | outer collides with abort budget | yes/no | — | reject (audit B-01) |
| Current 3s readiness + 3s outer timeout | current | scheduler-sensitive workaround | yes/no | — | replace |
| Sync store readiness probe | proposed | primary-contract branch | yes | 100% of TUI fixture setup | adopt |
| Local `waitForFrame` with `renderOnce` + full event-loop drain + 5s diagnostic | proposed | primary-contract branch; preserves `string[]` API | yes | 100% of frame wait | adopt (R3) |
| R2 maxPasses=250 + microtask-only yield | rejected R2 | pass budget ≠ wall/Worker time; blank reasoning frames | yes/no | — | reject (R2 audit B-01) |
| Bare OpenTUI `waitForFrame` default maxPasses=20 / idle-exit | rejected | under-budget; exits while highlight pending | yes/no | — | reject (R1 B-02) |
| `useThread:false` in this test fixture | proposed | existing test compatibility configuration | yes | setup configuration, no alternate semantic result | adopt |
| Fixed `Bun.sleep(10)` frame loop as readiness contract | current | scheduler-sensitive workaround | yes/no | — | replace |
| Larger frame timeout with unchanged immediate mount | rejected | forbidden timing-only workaround | yes | 0% approved | reject |
| Skip/xfail/platform guard/catch-success | rejected | forbidden fallback | yes | 0% | reject |
| Production Process or Session fallback | rejected | responsibility leak / unsupported | yes | 0% | reject |

New alternate success paths: zero.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Equal 3-second marker and test deadlines | Previous marker repair removed the 25ms startup assumption but left no budget for the marker phase itself. | Readiness remains signal-based (8s); outer Bun timeout (15s) reserves full abort+cleanup; abort assert stays `<2s`. | `test/util/process.test.ts:64-81` |
| Immediate `run` after `testRender` | Existing helper assumed fake HTTP/Sync bootstrap would finish inside the frame timeout. | Probe uses the existing Sync store as a published readiness seam with a distinct missing-data error. | `session-message-render.test.tsx:2866-2874` |
| Custom `renderOnce` + `Bun.sleep(10)` + 2s loop treated as readiness | Local helper mixed Sync latency into frame wait and failed blank under Windows load. | Split SyncReadyProbe from frame wait; frame loop uses renderOnce + microtask/nextTick/setTimeout(0) drain and 5s diagnostic only. | `session-message-render.test.tsx:2938-2948` |
| Default Windows threaded renderer in repeated Session fixture | Native thread lifecycle differs from Linux and another fixture already disables it for Windows cleanup stability. | Fixture explicitly selects the established test mode; threaded behavior remains covered by OpenTUI/core tests and separate lifecycle tests. | `session-message-render.test.tsx:2866-2871` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 abort still terminates the child | `Process.run` / `Process.spawn` unchanged | no production change; preserve public test seam | process test `out.code !== 0`, full process file, Windows CI |
| INV-02 startup scheduling is not abort timing contract | `Process.run` call boundary | readiness 8s + Bun outer 15s + post-marker abort assert `<2s` | marker-ready abort elapsed `<2_000ms`; stress reruns; Windows required job |
| INV-03 Session data exists before visual assertion | `Session` -> `SyncProvider.session.sync` | test-only `SyncReadyProbe` with distinct missing-data error | target reasoning test and full render file |
| INV-04 abort/error/reasoning visual semantics remain distinct | `AssistantMessage` / `ReasoningRun` / error footer | no production rendering change; preserve predicate/assertions | target test requires all four visible strings |
| INV-05 frame wait follows renderer progress + Worker highlight | local helper: `renderOnce` + microtask/nextTick/setTimeout(0) + 5s diagnostic | keep `string[]` API; no OpenTUI default-20 / idle-exit / microtask-only 250 | all existing frame assertions in render file (≥65 call sites) |
| INV-06 fixture cleanup remains deterministic | `testRender` renderer + temp KV fixture | use established non-threaded fixture mode and existing `finally` | target test, full TUI render suite, Windows CI |
| User forbids substantial test degradation | existing production/test behavior | no skip, xfail, removed assertion, or global timeout | diff review and complete required job |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| No new production concept | INV-01 through INV-06 | Current production paths pass the same-SHA Windows success sample; failures terminate in test watchdogs. | Production modules do not own test startup or renderer-frame readiness. |
| Separate process readiness + Bun outer margin | INV-02 | Required Windows timeout at exactly 3s; abort contract allows up to 2s post-marker; R1 8+10 left no margin. | Existing equal deadline and R1 8+10 both can kill the test before semantic asserts. |
| `SyncReadyProbe` test seam | INV-03 | `SyncProvider` already publishes session/message/part store; `session-export` uses a probe pattern. | `testRender` completion has no Session data promise and `Session` production API must not gain one for tests. |
| `useThread:false` fixture setting | INV-06 | Existing `sync-fixture` comment and `session-v2-error` precedent document Windows native lifecycle difference. | Default OpenTUI config enables threads on Windows; this fixture repeatedly mounts/destroys Session roots. |
| Local `waitForFrame` with `renderOnce` + full drain + 5s diagnostic | INV-05 | Reasoning uses drawUnstyledText=false + TreeSitter Worker; R2 microtask-only 250 under-covers wall time. | Bare OpenTUI idle-exit/default-20 under-cover; microtask-only pass budget ≠ Worker delivery. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/util/process.test.ts` | modify | Readiness 8s + Bun outer 15s; preserve post-marker abort `<2s` and readiness-specific error; cleanup unchanged. | +4 to +12 / -2 to -5 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | SyncReadyProbe; `useThread:false`; local waitForFrame with renderOnce + full event-loop drain + 5s diagnostic; distinct errors. | +30 to +60 / -10 to -20 |
| `docs/plans/windows-core-timeout-tests-stability.md` | add | Sole canonical plan and evidence/audit record. | plan only |

No production file, migration, generated file, workflow, dependency, or new
public API is planned.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Under a delayed Windows child startup, `aborts a running process` is killed by the 3s test timeout before its abort assertions. | Readiness poll and whole-test watchdog share the same 3s budget. | Marker readiness 8s; Bun outer 15s (≥ readiness+2s abort+5s cleanup); post-ready `<2_000ms` and non-zero code remain. | Process abort semantics and no orphan child. |
| 2 | Under delayed TUI bootstrap, reasoning-only test throws `timed out waiting for frame` with an empty frame. | Callback starts before Sync transcript readiness; frame loop mixes Sync latency with sleep. | Await SyncReadyProbe; `useThread:false`; local waitForFrame with renderOnce + microtask/nextTick/setTimeout(0) + 5s diagnostic; retain four visible predicates. | Reasoning aggregation, aborted footer, non-abort error panel, renderer cleanup. |
| 3 | Full `session-message-render.test.tsx` stays green for multi-step TreeSitter highlight/toggle call sites. | OpenTUI default-20/idle-exit and R2 microtask-only 250 under-cover Worker highlight. | Full drain + 5s diagnostic wall bound; full-file suite. | No unrelated waitForFrame regressions. |

Expected values remain independent of implementation:

- Process: non-zero result and measured elapsed time from published marker to
  `Process.run` completion.
- TUI: literal strings supplied by the fixture and the user-visible frame;
  no private component state or render call count is asserted.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~45 to 60 | Exclude imports, formatting, plan, and pure helper movement. |
| Required Chinese explanatory comments `C` | >= 9 | `max(1, ceil(E * 0.15))`; at E=60 minimum is 9. |

Qualifying nearby comments must explain only non-obvious constraints, adjacent
to the actual synchronization decisions (not generic preamble):

- Why readiness is 8s and Bun outer is 15s: formula
  `outer ≥ readiness + abort_budget(2s) + cleanup(5s)`, so abort assert cannot
  be starved by marker wait.
- Why Sync store presence, not `testRender` return, is readiness; missing-data
  error text must differ from frame timeout.
- Why this repeated-mount fixture selects `useThread:false` on Windows.
- Why frame wait uses `renderOnce` + microtask/nextTick/setTimeout(0) and a 5s
  diagnostic wall bound: TreeSitter Worker highlight needs macrotick delivery;
  this is not Sync readiness (handled by SyncReadyProbe).

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/util/process.test.ts -t 'aborts a running process'` | `packages/opencode` | Focused abort contract and cleanup. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx -t 'reasoning-only messages preserve abort and error presentation'` | `packages/opencode` | Focused four-string visual contract. |
| `bun test --timeout 30000 test/util/process.test.ts` | `packages/opencode` | All Process consumers/regressions in the file. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | All Session Message renderer behavior and cleanup. |
| `bun test --timeout 30000 test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | Existing Sync readiness and structured error TUI seams remain green. |
| `bun typecheck` | `packages/opencode` | Test/type integration. |
| CPU-pressure rerun of both focused commands with bounded local burners | `packages/opencode` | Red/green timing sensitivity where host permits; no assertion weakening. |
| Required workflow `bun turbo test:ci --filter=opencode --continue=dependencies-successful` | repository CI | Linux/Windows/macOS complete package behavior, with Windows as authoritative platform proof. |

The Windows native job is required evidence because this macOS host cannot
reproduce the original Windows timing envelope. A passing local test alone is
not sufficient for the final release verdict.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | This canonical plan only. |
| Files modified | 2 | Two existing failing test harnesses. |
| Files deleted | 0 | No obsolete fixture file is required. |
| Production lines | 0 | Current first divergences are test synchronization boundaries. |
| Test lines | ~25 to 55 net | Readiness probe, watchdog separation, and frame-wait delegation. |
| Generated lines | 0 | No generated surface involved. |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无。当前证据支持 test-only primary repair，不需要产品行为选择。

### Real Risks

- If the child never writes its marker, the process test must fail with a
  readiness diagnostic and still execute `finally` cleanup; it must not report
  a successful abort.
- If Sync bootstrap fails, the TUI readiness probe must fail and preserve the
  existing renderer/temp-state cleanup; it must not let a blank frame satisfy
  the test.
- `useThread:false` deliberately scopes this test to Session/TUI semantics;
  OpenTUI native threaded behavior remains covered by its own tests and the
  existing platform/lifecycle suites. The target test must not claim to cover
  native renderer threading.
- The exact Windows runner can still expose a new failure after this repair;
  any new symptom must be treated as a new observed divergence, not hidden by
  more timeout expansion.

### Rejected Speculation

- No evidence supports changing `Process.stop`, `taskkill`, or `Process.run`.
- No evidence supports changing `ReasoningRun`, `ReasoningBody`, error
  formatting, or message aggregation; the same SHA Windows run rendered the
  target test successfully.
- No evidence supports a production retry/fallback or a global CI concurrency
  change.
- No evidence supports treating the post-timeout `kv.json` ENOENT as the root
  cause; it occurs during teardown after the frame timeout.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct both complete producer-to-consumer paths from the repository and
  the original CI evidence.
- Treat the previous process plan, chat summaries, and this planning rationale
  as untrusted outside the canonical artifact.
- Audit the full two-test scope, including Process abort, Session Sync,
  ReasoningRun/Body, OpenTUI renderer configuration, cleanup, and CI commands.
- Require observed, contracted, or reachable evidence for every blocking finding.
- Check that no test assertion is weakened and no timeout-only fallback is used.
- Check forward/reverse traceability, ownership, alternate-path budget, TDD
  seams, verification coverage, diff budget, and the Chinese comment estimate.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 process outer 8s+10s collides with abort window; B-02 OpenTUI default maxPasses=20 under-covers file-wide waitForFrame | outer guard mechanism explicit; SyncReadyProbe vs frame errors; Chinese comments adjacent | BLOCK | `ses_07e892d9fffe70cJxKmFCPMuN4` |
| 2 | R2 | yes | B-01 frame-wait maxPasses=250 calibrated to 10ms but only microtask yield under-covers TreeSitter Worker highlight | R1 process budget fixed; R1 maxPasses=20 shape partially addressed | BLOCK | `ses_07e82dbebffefoiPouAMei4K5Y` |
| 3 | R3 | yes | No blocking findings | evidence path drift thirdparty path; drain wording slightly stronger than OpenTUI microtask+nextTick only; §19 vs E estimate arithmetic drift | APPROVE | `ses_07e7fa422ffe3TSAUBfQcgU1rm` |

### Verbatim R3 plan-audit verdict (round 3)

```text
No blocking findings.

APPROVE

Exact audited artifact: docs/plans/windows-core-timeout-tests-stability.md revision R3, full scope.
Implementation remains disallowed until this clean plan verdict is recorded and
Approved revision: R3 / Implementation allowed: yes are set by the orchestrator.
```

### Verbatim R1 plan-audit verdict (round 1)

```text
BLOCK

B-01 Process watchdog budget can still consume the semantic assertion window
- R1 planned readiness 8s + outer 10s leaves only 2s after readiness, equal to
  abort_semantic_budget; reachable timeout before non-zero/elapsed asserts.
- Minimal correction: outer strictly larger than readiness + full abort interval
  + cleanup overhead; keep post-marker <2s assertion.

B-02 Replacing shared waitForFrame with OpenTUI default 20-pass limit can
     regress existing renderer tests
- File has many async multi-step waitForFrame call sites; OpenTUI default
  maxPasses=20 is under-budget vs existing ~2s local helper.
- Minimal correction: keep caller-facing string[] contract; define explicit
  scheduler-aware pass budget for all call sites; diagnostic-only timeout.

Non-blocking:
- Make outer guard mechanism explicit (Bun timeout vs promise).
- SyncReadyProbe failure message distinct from frame failure.
- Chinese comments adjacent to synchronization decisions.
```

### Verbatim R2 plan-audit verdict (round 2)

```text
BLOCK

B-01 Local waitForFrame pass budget is calibrated to ~10ms polls, but R2 only
     yields microtasks
- Reasoning uses drawUnstyledText=false; Code awaits TreeSitter Worker oneshot;
  blank until highlight completes.
- 250 × Promise.resolve() can exhaust before Worker delivery under load.
- Minimal correction: keep renderOnce + string[] API; reconcile yield with
  Worker delivery (OpenTUI-strength drain + macrotask, or equivalent wall budget);
  do not sleep-as-Sync-readiness; do not bare OpenTUI default-20 idle-exit.

R1 process budget and maxPasses=20 under-cover addressed in R2 text.
```

Any substantive revision invalidates earlier approval. R3 addresses R2 B-01
(frame-wait yield/budget) without narrowing original scope.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/test/util/process.test.ts` | readiness 8s; Bun outer 15s; post-marker abort `<2s` retained; readiness-specific error |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | SyncReadyProbe; single-loop sync poll (no race loser); useThread:false; waitForFrame drain+5s; distinct errors |
| `docs/plans/windows-core-timeout-tests-stability.md` | plan R3 + evidence |

No production files changed.

### Red-Green Test Evidence

| Slice | Red (pre-fix observed) | Green (post-fix) |
| --- | --- | --- |
| process abort | Windows required job timeout 3000.45ms | focused + full process file green |
| reasoning frame | Windows blank frame timeout 5335ms | focused + full session-message-render green (71 pass) |

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test --timeout 30000 test/util/process.test.ts -t 'aborts a running process'` | packages/opencode | 1 pass |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx -t 'reasoning-only messages preserve abort and error presentation'` | packages/opencode | 1 pass |
| `bun test --timeout 30000 test/util/process.test.ts` | packages/opencode | 11 pass |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx` | packages/opencode | 71 pass |
| `bun test --timeout 30000 test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx` | packages/opencode | 18 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

- Process: outer budget no longer equals readiness; post-marker abort assert retained.
- TUI: Sync data readiness before visual assert; frame wait yields for Worker highlight.
- Windows native required job still authoritative final platform proof (not re-run here).

### Actual Secondary and Replacement Path Inventory

- Process: marker readiness + abort asserts primary; Bun 15s diagnostic only.
- TUI: SyncReadyProbe primary setup; local waitForFrame primary observation; useThread:false fixture config; no skip/xfail/fallback.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~55 | process budgets + SyncReadyProbe + withRenderedSession + waitForFrame; exclude pure import |
| Qualifying Chinese comment lines `C` | 14 | readiness formula, outer margin, Sync vs frame errors, useThread:false, Worker drain/5s |
| Ratio `C / E` | 25% | ≥15% |
| Required minimum `C` | 9 | ceil(55×0.15) |

### Remaining Unverified Items

- Windows GitHub Actions required job after push (native timing envelope).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | B-01 Promise.race loser continues renderOnce after sync ready | N-01 Windows CI not re-run; N-02 probe timeout detail; N-03 expect only two thoughts pre-existing | BLOCK | `ses_07e724cb6ffezJlLjaT9LFvxil` |
| 2 | R3 | yes | No blocking findings | N-01 Windows native job residual; N-02 plan “promise” wording vs single-loop poll | APPROVE | `ses_07e6e6c12ffeOeIWV6UhE6KNFo` |

### Verbatim implementation-audit verdict (round 2)

```text
No blocking findings.

APPROVE

Exact audited artifact:
- Plan R3
- Diff: process.test.ts, session-message-render.test.tsx (+ plan)
- Prior B-01 Promise.race orphan resolved by single-loop poll
- Residual: Windows required job post-push platform proof
```

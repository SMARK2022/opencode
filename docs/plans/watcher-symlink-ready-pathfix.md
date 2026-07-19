# Canonical Implementation Plan: Fix FileWatcher symlink readiness and SessionPrompt CI timeout boundary

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户要求完整准确识别 Mac CI 测试报错原因并进行测试不降级的高质量修正，检查生产代码与测试逻辑（含时序、静态问题），让测试依赖于行为正确性而非时间超时；并明确授权“扩展并修复”独立发现的 SessionPrompt CI blocker。
>
> Implementation allowed: yes
>
> Last updated: 2026-07-19

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 完整准确识别mac上的CI测试报错原因以及相关行为逻辑,需要进行测试不降级的高质量,充分反映测试目的的修正。检查正常代码逻辑是否有问题,以及测试内容是否有问题,包括时序、静态问题等逻辑。同时让测试相对稳定,不要依赖于,不要完全依赖于时间超时等等内容,应该依赖于行为的正确性与准确性。

> 扩展并修复 (Recommended)

## 2. Explicit Non-Goals

- 不修改 `src/file/watcher.ts` 生产代码——经审计，`1ac3f09468`（realpath 订阅）和 `43f17817d5`（同步订阅、错误穿透、CI skip 移除）的生产行为均正确，无需变更。
- 不恢复 `!process.env.CI` 守卫——`43f17817d5` 移除它是正确的测试覆盖升级，不构成降级。
- 不把 timeout 当作正向成功信号：`nextUpdate` 必须由匹配的 watcher 事件 resolve，timeout 只能作为失败诊断边界；`noUpdate` 的有限观察窗口保留，因为“没有事件”不能由一个瞬时同步返回证明。
- 不新增测试——现有 symlinked .git 测试本身即为回归测试，修正 `ready()` 后它将直接通过。
- 不修改 `SessionPrompt`、`SessionRunState` 或 `Runner` production 语义——并发错误测试在 warm process 中通过，确认共享结果能力存在；当前 first divergence 是 3 秒 Bun test envelope 包含冷 fixture/Layer 生命周期。
- 不通过增大或移动 `shortSessionTimeout` 取得 green；R3 实施证据证明 operation-scoped 3 秒在并行负载下仍会误判。R4 删除该测试专属短边界，只保留包级 30 秒进程 hang safety，成功完全由两个 loop 结果和既有断言决定。
- 不修改只在一轮 full CI 中 timeout、但单独重跑通过的 `subtask from auto parent inherits auto ceilings...`；没有稳定复现和 first divergence，不能驱动代码。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` — EffectBridge、InstanceState | watcher 的 native callback 通过 EffectBridge 恢复 Instance 上下文；InstanceState 按 directory 缓存，init 失败不缓存伪成功。确认 `43f17817d5` 的错误穿透与这些 invariant 一致。 |
| `packages/opencode/AGENTS.md` — Effect rules | `Effect.forkScoped` 在 Effect v4 中不存在；`43f17817d5` 已改用直接 `yield*`，符合规则。init 在 bootstrap 中 fire-and-forget，由 `Effect.catchCause` 兜底。 |
| `packages/opencode/test/AGENTS.md` — Synchronizing With Concurrent Work | 禁止用 `Effect.sleep(N)` 作为 readiness hack；`ready()` 使用 `nextUpdate`（Deferred 信号 + timeout 安全网）是正确的 readiness 模式。 |
| `packages/opencode/test/lib/effect.ts` — `testEffect.instance` / `awaitWithTimeout` | `it.instance` 把 test timeout 包在 fixture 创建、Layer、body 和 cleanup 外；`awaitWithTimeout` 可把 diagnostic boundary 放在实际行为上。 |
| `.opencode/policy/first-principles-engineering.md` | primary-path 修复、禁止 fallback、responsibility ownership、Chinese comment 15% 门禁。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/file/watcher.ts` (全文) | 生产 watcher 实现：`realpath(resolved)` 订阅（L141）、同步 `yield* subscribe`（L132,152）、错误 `failCause` 穿透（L122,159）| observed |
| `packages/opencode/test/file/watcher.test.ts` (全文) | 测试文件：`ready()` helper（L120-146）使用 symlink 路径 `dir/.git/HEAD`；symlinked 测试体（L272-319）正确使用 `actualGit/HEAD` | observed |
| `packages/opencode/src/project/bootstrap.ts` (全文) | `init()` 调用点：`Effect.catchCause` 兜底所有 init 失败为 warning，不崩溃 | observed |
| CI 日志 #134 | 失败信号：`FileWatcher > symlinked .git > publishes .git/HEAD events through a symlinked .git directory [5265.99ms]` — 5s `nextUpdate` 超时 | observed |
| 本地复现 `bun test test/file/watcher.test.ts` | `[5784.16ms]` 超时，6 pass 1 fail，非符号链接测试全通过 | observed |
| `bun typecheck` | 通过——`init()` 返回类型变更 `EffectConfig.ConfigError \| Cause.TimeoutError` 不破坏调用方 | observed |
| `git show 1ac3f09468` | 引入 `realpath(resolved)` 订阅 + symlinked .git 测试，但未同步更新 `ready()` | observed |
| `git show 43f17817d5` | 移除 `!process.env.CI` 守卫暴露潜伏 bug；同步订阅+错误穿透为正确行为 | observed |
| `git show 3ab67f3280` | 另一条上游分支曾为旧的 forked subscription 增加 `eventuallyUpdate` 与 real/symlink 双路径检查；用于审查当前是否仍需要该 workaround | observed |
| native `@parcel/watcher` harness（canonical temp path + `fs-events`） | 直接观察订阅 `actualGit` 后通过 `.git` symlink 写 HEAD，事件 path 为 `actualGit/HEAD`，旧 `dir/.git/HEAD` predicate 明确失败 | observed |
| `CI=1 bun test test/file/watcher.test.ts --timeout 30000` + 8 次并行窄测试 | 当前 candidate 在 CI 条件下 9 次 watcher 执行均为 7 pass / 0 fail | observed |
| `packages/opencode/test/fixture/fixture.ts` | `tmpdir({ git: true })` 返回 realpath-resolved 路径；`provideInstance` 绑定 InstanceRef | observed |
| `packages/opencode/test/session/prompt.test.ts:75,2188-2207` | 失败测试把 `shortSessionTimeout=3000` 作为整个 `it.instance` timeout，而被验证的行为仅是两个 concurrent loop caller 获得同一错误结果 | observed |
| `packages/opencode/test/lib/effect.ts:57-68` | `instance()` 将 `withTmpdirInstance(...)` 包在 Bun `test(..., testOptions)` 内，证明 3 秒包含 fixture 和完整 lifecycle | observed |
| focused cold run：`bun test ... -t "concurrent loop callers all receive same error result"` | 独立运行稳定在 3000ms timeout；本轮隔离重跑仍失败并在 teardown 后暴露中断 fiber 错误 | observed |
| warm paired run：`bun test ... -t "concurrent loop callers"` | 相邻成功并发测试先执行后，两项均通过（2 pass / 0 fail），证明生产共享结果能力存在而 whole-test cold envelope 不稳定 | observed |
| R3 operation-scoped timeout run under parallel watcher/file/typecheck load | isolated cold 已通过，但 paired run 在 `awaitWithTimeout(..., 3000)` 失败；证明 3 秒 operation wall-clock 仍不是稳定行为契约 | observed |
| `git show ebeaf3561ec` | 3 秒 `shortSessionTimeout` 是测试级 wall-clock cap，不是并发结果接口契约 | observed |

## 5. Current Behavior

### 生产路径（正确）

```text
watcher.init() -> InstanceState.make -> git rev-parse --git-dir -> path.resolve -> realpath(resolved) -> subscribe(vcsDir=actualGit, ignore=[...except HEAD])
```

watcher 订阅 `realpath(.git)` = `actualGit`（真实目录）。@parcel/watcher 按订阅目录报告事件路径，因此 HEAD 事件以 `actualGit/HEAD`（真实路径）发布。这是 `1ac3f09468` 的正确修复——订阅真实目录而非符号链接，避免 FSEvents/inotify 在符号链接上的不确定行为。

### 原始失败路径（candidate 修复前）

```text
withWatcher(dir) -> watcher.init() -> ready(dir) -> nextUpdate(check: evt.file === dir/.git/HEAD, trigger: write to .git/HEAD via symlink)
```

`ready()` helper 在 `watcher.test.ts:122` 使用 `head = path.join(directory, ".git", "HEAD")`（符号链接路径）匹配事件。但 watcher 发布的事件路径是 `actualGit/HEAD`（真实路径）。两者在符号链接场景下字符串不等，`nextUpdate` 的 Deferred 永不 resolve，5 秒后 timeout 触发失败。

### 当前 candidate 路径

```text
withWatcher(dir) -> watcher.init() [await root/git acquisition] -> ready(dir) -> realPath(dir/.git) -> nextUpdate(check: actualGit/HEAD)
```

当前 candidate 的 `ready()` 使用 `fs.realPath(gitRoot)`，与 production watcher 的 `vcsDir` 路径空间一致；`nextUpdate` 仍由 Deferred 事件完成，5 秒仅用于报告缺失事件。

### 测试体（正确）

symlinked .git 测试体（`watcher.test.ts:306`）正确检查 `evt.file === path.join(actualGit, "HEAD")`（真实路径）。若 `ready()` 通过，测试体本会通过。

### SessionPrompt CI blocker

```text
Bun test timeout (3000ms)
  -> testEffect.instance
  -> withTmpdirInstance + live Layer + test setup
  -> Effect.all(prompt.loop, prompt.loop)
  -> shared Runner result assertions
  -> fixture cleanup
```

`shortSessionTimeout` 原先覆盖整个链，而测试名只承诺两个并发 caller 共享同一个 error result。单独 cold run 在 3000ms 被 Bun 中断；同一进程先执行相邻并发测试后，两项都通过。R3 把同一个 3 秒移入 `Effect.all` 后 isolated cold 通过，但并行负载下 paired run 仍 timeout，确认短 wall-clock 本身不是该行为的稳定契约。production `Runner.ensureRunning` 在 Running 状态返回同一个 `Deferred`（`src/effect/runner.ts:120-143`），因此共享结果主路径存在。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `.git` 是符号链接 | 测试 fixture 移动 .git 并创建 symlink | `tmpdir({git:true})` 创建真实 git repo；test body 执行 rename+symlink | symlinked .git 测试 | `ready()` helper | observed |
| `.git` 是普通目录 | `tmpdir({git:true})` 直接创建 | 无符号链接 | 非 symlinked 测试（publishes .git/HEAD events 等）| `ready()` helper | observed |
| `.git` 不存在 | `tmpdir({git:false})` | 无 git | 非 git 测试（watches non-git roots 等）| `ready()` helper | observed |
| SessionPrompt 错误并发测试 cold isolated run | Bun `-t` 单测试进程 | `shortSessionTimeout=3000` 覆盖 fixture + body + cleanup | `testEffect.instance` -> `prompt.loop` x2 | `prompt.test.ts` 测试边界 | observed |
| 同一错误并发测试 warm paired run | 相邻 `concurrent loop callers get same result` 先执行 | production module/Layer 已 warm；行为断言不变 | 相同 `prompt.loop` x2 | `SessionPrompt` + `Runner` | observed |
| auto-parent subtask timeout | 一轮 implementation audit full CI | 单独重跑通过 | full CI only | 独立 SessionPrompt test | reachable but not stable enough to change |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `ready()` 的 HEAD 事件检查路径必须与 watcher 实际发布事件的路径一致 | watcher 订阅 `realpath(.git)`（watcher.ts:141），事件路径 = 订阅目录 + 相对路径 | symlinked .git 测试（当前 fail） |
| INV-02 | `ready()` 的 readiness probe（`.watcher-xxx` 文件）使用根目录路径，与 root watcher 订阅路径一致 | root watcher 订阅 `ctx.directory`（watcher.ts:132），`tmpdir` 返回 realpath | 所有 watcher 测试（当前 pass） |
| INV-03 | 生产 watcher 订阅 `realpath(.git)` 而非符号链接，确保跨平台事件可靠性 | `1ac3f09468` commit 修复了符号链接订阅问题 | symlinked .git 测试体检查 `actualGit/HEAD` |
| INV-04 | `init()` 失败时错误穿透到 bootstrap，InstanceState 不缓存伪成功 | `43f17817d5` commit；bootstrap.ts:49 `catchCause` 兜底 | reports native subscription acquisition failure 测试（当前 pass） |
| INV-05 | 正向 readiness 只能由实际事件完成，不能由延长 timeout 或固定 sleep 制造成功 | `test/AGENTS.md:161-177`；`nextUpdate` 注册 listener 后等待 Deferred | root probe 与 HEAD probe；当前多次 CI 条件执行 |
| INV-06 | 负向“无事件”断言只能在明确观察窗口内成立，不能伪装成无界证明 | `noUpdate` 的公开测试目的和 `test/AGENTS.md` 的 live OS 行为约束 | ignores `.git/index` changes、cleanup stops publishing events |
| INV-07 | 同一 Session 的并发 `prompt.loop` caller 必须 join 同一 Runner work，并收到同一个错误 assistant result | `Runner.ensureRunning` Running branch 返回 `awaitDone(st.run.done)`；现有 test assertions | concurrent loop callers all receive same error result |
| INV-08 | 并发结果测试不得把任意短 wall-clock 当作成功语义；成功只来自两个 loop 完成并满足同 ID/role 断言 | 用户要求行为正确性优先；R3 operation-scoped 3 秒在并行负载下仍失败 | isolated、paired、parallel-load、full CI |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `ready()` 在 `watcher.test.ts:122` 使用 `path.join(directory, ".git", "HEAD")`（符号链接路径）匹配事件，但 watcher 自 `1ac3f09468` 起订阅 `realpath(.git)` 并发布真实路径事件。`1ac3f09468` 新增 symlinked .git 测试时未同步更新 `ready()`。 | `ready()` helper in `test/file/watcher.test.ts` | 仅 symlinked .git 测试 fail（5s timeout）；非 symlinked 测试 `realpath(dir/.git) === dir/.git` 路径一致故 pass；测试体正确使用 `actualGit/HEAD`。 |
| INV-07/08 | 任何 test-specific `shortSessionTimeout` 都把调度性能混入共享结果契约；R3 把 3 秒缩到 operation 后仍在并行负载下误判。 | `test/session/prompt.test.ts` 测试边界 | whole-test cold red；R3 isolated green；R3 parallel paired red；production assertions unchanged。 |

### Red-capable feedback loop

```bash
cd packages/opencode && bun test test/file/watcher.test.ts --timeout 60000
```

**Observed output:**
```
(fail) FileWatcher > symlinked .git > publishes .git/HEAD events through a symlinked .git directory [5784.16ms]
 6 pass
 1 fail
```

该 CI 日志是原始用户症状。对当前 native producer 的最小 red harness 订阅 canonical `actualGit`，通过 `.git` symlink 写 HEAD，并将旧 predicate `evt.path === dir/.git/HEAD` 作为独立期望；实际输出为 `observed=actualGit/HEAD`、`oldReadyPredicate=dir/.git/HEAD`、`mismatch=true`，命令以 exit code 1 结束。它直接证明 first divergence，而不是等待一个泛化 timeout。

### Minimised reproduction

`ready()` 函数的第二个 `nextUpdate`（HEAD 事件检查）是原始失败点：
- 第一个 `nextUpdate`（`.watcher-xxx` readiness probe）使用根目录路径，root watcher 订阅同一 `ctx.directory`，路径匹配，快速通过。
- 第二个 `nextUpdate`（HEAD 事件检查）使用符号链接路径 `dir/.git/HEAD`，但 .git watcher 发布 `actualGit/HEAD`（真实路径），路径不匹配，5s timeout。

最小化：仅符号链接 `.git` 场景触发；移除符号链接（`realpath === dir/.git`）即通过。

### Timing and historical workaround audit

`3ab67f3280` 的 `eventuallyUpdate` 是在 production `watcher.ts` 仍使用 `Effect.forkScoped(subscribe(...))` 时加入的：`init()` 返回后 subscription acquisition 仍可能在后台，重复写入是为了等待 native callback 真正可见。当前 `43f17817d5` 已将 root 与 `.git` subscription 改为直接 `yield* subscribe(...)`，并把 acquisition failure 穿透；因此旧 workaround 不能无证据地复制为第二条路径。当前 candidate 仍使用行为信号，不使用 `Effect.sleep`，并在 `CI=1` 下完成 9 次独立执行无失败。

`noUpdate` 的 500ms 是负向断言的观察窗口，不是正向 readiness 的成功条件；删除它会使“没有 `.git/index` 事件”和“dispose 后没有事件”失去可执行的失败边界。该窗口的残余平台风险保留为验证项，不通过扩大 timeout 掩盖。

### Hypothesis ranking

1. **`ready()` 路径不匹配**（确认）：`ready()` 用 symlink 路径，watcher 发布 realpath。预测：将 `ready()` 改为 `realpath` 后测试通过。
2. ~~init 同步订阅延迟~~：非符号链接测试同样使用同步订阅且通过，排除。
3. ~~root subscription 失败~~：root watcher 订阅 `dir`（非符号链接），不受影响，排除。
4.~~ .git subscription 失败~~：subscription 失败会导致 init 报错（非 timeout），排除。
5. ~~symlink setup 的 `Effect.all` 并发竞态~~：当前 `Effect.all` 默认顺序执行，实际行为输出顺序为 `a,b`；rename 完成后才创建 symlink，排除。

### SessionPrompt red-capable feedback loop

```bash
cd packages/opencode
bun test test/session/prompt.test.ts --timeout 30000 -t "concurrent loop callers all receive same error result"
```

Observed cold result: `0 pass, 1 fail`, Bun test timeout at approximately 3000ms. The same behavior run after the adjacent successful concurrency test with `-t "concurrent loop callers"` produces `2 pass, 0 fail`. This differential loop isolates the test-envelope cold-start dependency without changing the production path.

Ranked hypotheses:

1. **Test-specific 3000ms boundary is not a stable concurrency contract**（confirmed）：whole-test cold red、warm paired green、R3 isolated operation green 和 parallel-load operation red 共同证明短 wall-clock 受环境调度影响。
2. ~~Runner does not share errors~~：warm paired run exercises the same error test and both ID/role assertions pass；`Runner.ensureRunning` joins the same Deferred while Running.
3. ~~Permanent SessionPrompt deadlock~~：the same test passes in warm paired and one full CI run；rejected.
4. ~~Raise every session timeout~~：would expand unrelated tests and hide timing rather than repair the owning boundary；rejected.
5. ~~Move the same 3s into `awaitWithTimeout`~~：R3 parallel-load run directly falsified this design；rejected and removed in R4.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| `ready()` 使用与 watcher 一致的事件路径 | `ready()` helper in `test/file/watcher.test.ts` | readiness gate 必须在同一路径空间匹配事件 | `ready()` 的唯一职责是验证 watcher 已就绪可收事件；路径匹配是就绪验证的前提 | 生产 watcher（`watcher.ts`）已正确订阅 realpath，不需要修改 |
| 生产 watcher 订阅 realpath | `src/file/watcher.ts` | 确保跨平台符号链接场景的事件可靠性 | `1ac3f09468` 已正确实现 | 不需要变更 |
| concurrent error test timeout boundary | `test/session/prompt.test.ts` | 测试承诺两个 loop caller 共享结果，不承诺 cold fixture 在 3 秒内完成 | 该文件选择 `shortSessionTimeout` 的作用范围，并拥有移除被证伪短边界的测试责任 | `SessionPrompt`/`Runner` production 已在 warm run 通过同一行为，不拥有测试进程 cold-start SLA |

## 10. Single Approved Primary-Path Design

```text
ready(directory) -> existsSafe(gitRoot=dir/.git) -> actualGit=realPath(gitRoot) -> head=path.join(actualGit, "HEAD") -> listener-before-trigger -> Deferred resolves on matching event
```

修正 `ready()` 使其使用 `realpath` 解析 `.git` 目录，与生产 watcher 的 `realpath(resolved)` 订阅路径（watcher.ts:141）保持一致。

具体变更（`watcher.test.ts` `ready()` 函数 L120-146）：

1. 将 `const head = path.join(directory, ".git", "HEAD")` 从函数顶部移入 `Effect.gen` 内部。
2. 先 `existsSafe(gitRoot)` 验证 `.git` 存在（避免对不存在路径调用 `realPath` 抛错）。
3. `realPath(gitRoot)` 解析为真实路径 `actualGit`。
4. `head = path.join(actualGit, "HEAD")`——与 watcher 发布的事件路径一致。
5. `existsSafe(head)` 保留原有 HEAD 存在性检查。
6. refs 写入路径改为 `path.join(actualGit, "refs", "heads", branch)`——与 HEAD 写入保持同源路径。

### 为什么修复了 first divergence

`ready()` 的事件路径检查从符号链接路径改为真实路径，与 watcher 订阅 `realpath(.git)` 后发布的事件路径完全一致。`nextUpdate` 的 Deferred 将在 HEAD 事件到达时立即 resolve；5s timeout 只在事件缺失时产生 failure，不产生 success。

### 非符号链接场景不受影响

非符号链接 `.git`：`realpath(dir/.git) === dir/.git`，`head` 值不变，行为不变。非 git 目录：`existsSafe(gitRoot)` 返回 false，`ready()` 提前返回，行为不变。

### SessionPrompt test-boundary repair

```text
fixture and service setup
  -> Effect.all(prompt.loop A, prompt.loop B)
  -> assert same assistant id and role
  -> fixture cleanup
  -> package default 30s timeout remains only as process-level hang safety
```

在 `concurrent loop callers all receive same error result` 中保留原有 concurrent `Effect.all` 和 ID/role assertions，只移除 `it.instance` 的第三个 `shortSessionTimeout` 参数。R3 新增的 operation-level `awaitWithTimeout` 必须删除，因为并行负载已证明 3 秒 operation wall-clock 仍会误判。成功只来自两个真实 `prompt.loop` 结果；不增加 retry、sleep、warm-up 或 production fallback。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `ready()` 使用 realpath 匹配事件 | proposed | primary-contract | yes | 100% | 修正 |
| `nextUpdate` Deferred + timeout 安全网 | current | primary-contract wait + diagnostic failure boundary | yes/no (事件 success，timeout failure) | 0% alternate success | 保留 |
| `noUpdate` 有限观察窗口 | current | negative-observation contract | no | 0% alternate success | 保留，不伪装为无界证明 |
| package default test timeout | current | process-level diagnostic boundary | no | 0% alternate success | 保留；不作为并发行为 SLA |

无新增 alternate success path。无 fallback。无配置开关。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| concurrent error test 的 test-specific `shortSessionTimeout` | 快速暴露 Session loop hang，但 whole-test 和 R3 operation-scoped 两种放置方式都在不同负载下误判 | 直接等待 `Effect.all` 行为结果并保留 package default hang safety；不再声明不存在的 3 秒 SLA | `test/session/prompt.test.ts` 第三个参数及 R3 临时 `awaitWithTimeout` wrapper |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01: ready() 路径与 watcher 事件路径一致 | watcher.ts:141 `realpath(resolved)` 订阅（不修改） | `watcher.test.ts` `ready()` 改用 `fs.realPath(gitRoot)` | symlinked .git 测试（现有，修正后 pass） |
| INV-02: root readiness probe 路径一致 | watcher.ts:132 订阅 `ctx.directory`（不修改） | 不变更 `ready()` 第一个 `nextUpdate` | 非 symlinked 测试（现有，持续 pass） |
| INV-03: 生产 watcher 订阅 realpath | watcher.ts:141（不修改） | 不修改生产代码 | symlinked .git 测试体检查 `actualGit/HEAD` |
| INV-04: init 错误穿透 | watcher.ts:122,159 `failCause`（不修改） | 不修改生产代码 | reports native subscription acquisition failure 测试（现有，持续 pass） |
| 用户要求：检查生产代码 | watcher.ts 全文审计 | 无生产代码变更 | typecheck + 现有测试套件 |
| 用户要求：检查测试时序/静态 | watcher.test.ts 审计 | 仅修正 `ready()` 路径 | typecheck + 全 watcher 测试 |
| 用户要求：依赖行为非超时 | `ready()` 修正后 Deferred 在事件到达时即时 resolve | `ready()` 使用 realpath 匹配 | symlinked .git 测试在事件到达时通过而非 5s timeout |
| INV-05/06：正负同步语义边界 | `nextUpdate` / `noUpdate` 的 Deferred 观察 | 保留 listener-before-trigger 与有限负向窗口 | watcher test + CI 条件重复执行 |
| INV-07：并发 caller 共享 error result | `SessionPrompt.loop` -> `SessionRunState.ensureRunning` -> `Runner.ensureRunning` shared Deferred | 不改 production；保留现有 ID/role assertions | focused cold/warm differential + full prompt/full CI |
| INV-08：成功不依赖短 wall-clock | test fixture -> direct concurrent operation -> assertions -> cleanup | `prompt.test.ts` 删除该测试专属短 timeout，保留直接 `Effect.all` | isolated、paired、parallel-load、full CI 均不依赖 warm ordering |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `fs.realPath(gitRoot)` in `ready()` | INV-01 | watcher 订阅 `realpath(.git)`，事件路径为真实路径 | 现有 `ready()` 使用符号链接路径 `path.join(directory, ".git", "HEAD")`，与事件路径不匹配 |
| `path.join(actualGit, "refs", "heads", branch)` in `ready()` | INV-01 | 与 HEAD 写入保持同源路径 | 现有代码使用 `path.join(directory, ".git", "refs", ...)` 符号链接路径（功能正确但不一致） |
| 不复制 `3ab67f3280` 的 `eventuallyUpdate` | INV-05 | 当前 production 已同步等待 subscription acquisition，且候选在 CI 条件下 9 次通过 | 旧 helper 的重复触发服务于已被 `43f17817d5` 修正的 forked acquisition race；新增 retry 会扩大测试语义而无当前失败证据 |
| 删除 concurrent error test 专属短 timeout | INV-07/08 | whole-test cold red、warm paired green、R3 operation-level parallel red | whole-test 与 operation-level 3 秒都无法承载稳定行为契约；package default 已拥有进程级 hang safety |

无其他新增生产概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/file/watcher.test.ts` | modify | `ready()` 函数：使用 `fs.realPath(gitRoot)` 解析 `.git` 真实路径，使 HEAD 事件检查路径与 watcher 订阅路径一致 | +5 / -2 (净 +3，不含注释) |
| `packages/opencode/test/session/prompt.test.ts` | modify | 删除 concurrent error result 的 test-specific 3 秒边界，保留直接 `Effect.all` 与 assertions | +1 / -1（1 行中文注释，删除 1 行 timeout option） |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | symlinked .git 测试在 `ready()` 的 HEAD `nextUpdate` 处 5s timeout | `ready()` 用符号链接路径 `dir/.git/HEAD` 匹配事件，watcher 发布真实路径 `actualGit/HEAD`，字符串不等 | `ready()` 改用 `realPath(gitRoot)` 得到 `actualGit`，`head = path.join(actualGit, "HEAD")` 与事件路径一致 | symlinked .git 测试通过（事件到达时 Deferred 即时 resolve）；非 symlinked 测试持续通过（`realpath === dir/.git` 路径不变） |
| 2 | concurrent error result 测试在 whole-test cold 与 R3 parallel operation 两种 3 秒边界下失败 | 短 wall-clock 受 fixture、调度和系统负载影响，不是共享结果契约 | 恢复直接 `Effect.all`，删除该测试专属 `shortSessionTimeout`，保留 assertions 和 package default safety | isolated、paired、parallel-load/full prompt/full CI 均由结果行为决定 |

现有 symlinked .git 测试即为红测试和回归测试。不需要新增测试——测试体本身已正确验证 `evt.file === path.join(actualGit, "HEAD")`，只是被 `ready()` 的路径不匹配阻塞。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 6 | watcher candidate 5 行；SessionPrompt test 删除 short option 1 行；排除注释、空行、未改 `Effect.all` 和 formatter-only |
| Required Chinese explanatory comments `C` | 1，计划提供 2 | `if E > 0: C >= max(1, ceil(6 * 0.15)) = 1` |

需要中文注释的位置：

1. `realPath(gitRoot)` 调用处——解释为什么 readiness 检查必须使用真实路径而非符号链接路径：
   > `// production订阅realpath；readiness必须监听同一事件路径，不能用symlink拼写等待另一个名字。`
2. concurrent error `Effect.all` 调用处——解释该测试只断言共享结果，包级 timeout 仅防进程级挂死：
   > `// 这里只断言并发loop共享结果；包级timeout仅防进程挂死，不构成3秒性能契约。`

该注释解释非显然的 invariant：watcher 订阅 `realpath(.git)`，事件路径基于订阅目录，因此 `ready()` 必须在同一路径空间匹配。这不是对代码的复述，而是对跨模块路径一致性约束的解释。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/file/watcher.test.ts --timeout 60000` | `packages/opencode` | symlinked .git 测试从 fail(5784ms) 变为 pass；全部 7 测试通过 |
| `bun typecheck` | `packages/opencode` | 无类型错误（`fs.realPath` 返回 `Effect<string>`，类型推断正确） |
| `bun test test/file/ --timeout 60000` | `packages/opencode` | 全 file 目录测试通过，无回归 |
| `CI=1 bun test test/file/watcher.test.ts --timeout 30000` | `packages/opencode` | CI 条件下 watcher 行为仍执行，不因 CI skip |
| 多次并行 `bun test test/file/watcher.test.ts --timeout 30000` | `packages/opencode` | 观察 native readiness 是否出现时序 flake；当前 8 次均通过 |
| `bun test test/session/prompt.test.ts --timeout 30000 -t "concurrent loop callers all receive same error result"` | `packages/opencode` | cold isolated concurrency behavior 不再被 fixture envelope 截断 |
| `bun test test/session/prompt.test.ts --timeout 30000 -t "concurrent loop callers"` | `packages/opencode` | 成功结果与错误结果两条 Runner join 行为均通过 |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | SessionPrompt 全文件回归，覆盖 queue/cancel/goal/subtask 邻近路径 |
| `bun turbo test:ci --filter=opencode --continue=dependencies-successful` | repo root | R4 最终必须 0 fail；历史执行一轮 3820 pass / 0 fail，R2 implementation audit 另一轮因 SessionPrompt timeout 失败 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 无新增文件 |
| Files modified | 2 | `test/file/watcher.test.ts`、`test/session/prompt.test.ts` |
| Files deleted | 0 | 无删除 |
| Production lines | 0 | 不修改生产代码 |
| Test lines | 约 +9 / -3（含 2 行中文注释） | watcher path 修正 + SessionPrompt 删除 test-specific short timeout |
| Generated lines | 0 | 无生成代码 |

## 20. Real Risks and Open Decisions

### Real risks

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| `fs.realPath` 在不存在路径上抛错 | `fs.realpath` Node.js 行为；`watcher.ts:141` 生产代码用 `.catch(() => resolved)` 防护 | `ready()` 在调用 `realPath` 前先 `existsSafe(gitRoot)` 检查，避免对不存在路径调用 `realPath` |
| 非 macOS 平台（Linux CI）符号链接行为差异 | CI 在 macOS 和 Linux 均运行 | 修复基于路径字符串一致性，不依赖平台特定行为；`realpath` 在 Linux 上同样解析符号链接 |
| native acquisition promise 成功后 callback 首次可见仍可能延迟 | `3ab67f3280` 曾在旧 forked path 处理过 readiness race；当前 43 已改为同步 acquisition | 当前不增加 retry/fallback；以 CI 条件重复执行和完整 CI 回归验证，若出现真实 miss 则作为新事实重新修订 plan |
| SessionPrompt 在 package default 30 秒内仍无法完成 | R3 只证明短 3 秒不稳定，未证明无界正确 | R4 focused/paired/full prompt/full CI 必须完成；若触发 default timeout，回到 production first divergence，不再移动或扩大短边界 |
| auto-parent subtask 测试曾在一轮 full CI timeout | 单独重跑通过，没有稳定 red signal | 仅在 full prompt/full CI 中回归；若复现并可最小化，再作为新事实修订，不预防性改动 |

### Open Decisions Requiring the User

无。修复方向唯一且明确，不涉及产品或策略选择。

### Rejected Speculation

- ~~`43f17817d5` 的 `init()` 错误类型变更可能破坏调用方~~：`bun typecheck` 通过；bootstrap.ts:49 `catchCause` 兜底所有错误。排除。
- ~~`43f17817d5` 的同步订阅（`forkScoped` → `yield*`）可能导致 init 阻塞~~：订阅有 10s timeout（`SUBSCRIBE_TIMEOUT_MS`）；非符号链接测试同样使用同步订阅且通过。排除。
- ~~`ready()` 应添加 `realPath` fallback 匹配生产代码的 `.catch(() => resolved)`~~：生产代码的 fallback 是为了在 `realpath` 失败时仍能订阅（降级到符号链接路径）；`ready()` 是测试代码，`realPath` 失败应直接报错而非静默降级，否则会掩盖路径不一致问题。排除。
- ~~应新增 `ready()` 对符号链接场景的专项测试~~：`ready()` 是 test helper 不是生产代码；symlinked .git 测试本身已覆盖符号链接场景。排除。
- ~~当前必须照搬 `3ab67f3280` 的 eventuallyUpdate~~：其 owner 是旧的 forked acquisition race；当前 production path 已由 `43f17817d5` 改为同步 acquisition，当前 candidate 在 `CI=1` 和 8 次并行执行中没有再现该 race。保留为可观测风险，不把历史 workaround 当作无条件需求。
- ~~通过把所有 `shortSessionTimeout` 提高到 15/30 秒修复 SessionPrompt~~：会扩大 17 个无关测试并把 cold startup 当作行为 SLA；拒绝。
- ~~修改 `Runner.ensureRunning` 或 error continuation production~~：warm paired run 已证明共享 error result 主路径可达并通过；没有 production first divergence，拒绝。
- ~~保留 R3 operation-scoped 3 秒~~：parallel-load paired run 已直接失败；该设计已被证伪，拒绝。

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
| 1 | R1 | yes | 0 | 3 (N-01: noUpdate characterization marginally imprecise but decision sound; N-02: refs path change is consistency improvement not functional fix; N-03: comment uses uncommon term "cell") | APPROVE — No blocking findings | adversarial-auditor task ses_088a5726bffehYFwCNUVppRSKd |
| 2 | R2 | yes | 0 | 3 (N-01: external harness/stress evidence is not repository-reproducible; N-02: refs path is consistency-preserving support; N-03: noUpdate retains bounded 500ms negative observation) | APPROVE — No blocking findings | adversarial-auditor task ses_087143a07ffeawQjbGylYAWEgK |
| 3 | R3 | yes | 0 | 3 (N-01: expanded authorization source distinction; N-02: Runner file path precision; N-03: operation-timeout diagnostic message) | APPROVE — No blocking findings | adversarial-auditor task ses_087143a07ffeawQjbGylYAWEgK |
| 4 | R4 | yes | 0 | 3 (N-01: stale R3 verification wording; N-02: current candidate still contains rejected R3 timeout; N-03: obsolete helper detail in responsibility text) | APPROVE — No blocking findings | adversarial-auditor task ses_087143a07ffeawQjbGylYAWEgK |

**Verbatim verdict:** "APPROVE. The plan R1 correctly identifies the root cause (`ready()` path mismatch at `watcher.test.ts:122`), repairs it at the owning module (the `ready()` test helper), uses a valid API (`fs.realPath` confirmed on `AppFileSystem.Service`), introduces no fallbacks or alternate success paths, preserves behavior for non-symlinked and non-git cases, and maps all invariants to executable tests. The production code audit is thorough and correct — no production changes are needed. The Chinese comment budget is feasible. No blocking findings."

R1 的 approval 已因 R2 实质性补充完整时序、历史路径和 red harness 证据而失效；R2 必须重新进行 full-scope plan audit。

**R2 verbatim verdict:** "APPROVE — the exact canonical plan revision R2 has No blocking findings and can be approved. This approval applies only to plan revision R2. It authorizes plan approval, not implementation completion. The current candidate implementation still requires a separate full-scope implementation audit against the exact approved R2 revision, including independent verification of the final diff, complete required commands, and the actual Chinese-comment calculation."

R2 implementation audit 的 B-01 和用户随后授权“扩展并修复”使 R2 plan approval 失效；R3 将 SessionPrompt cold whole-test timeout 纳入同一完整范围，必须重新 plan audit。

**R3 verbatim verdict:** "APPROVE — the exact canonical plan revision R3 has No blocking findings and can be approved. This approval applies only to plan revision R3. Implementation remains disallowed until the independent verdict is recorded for R3. After implementation, a new full-scope implementation audit must verify both the watcher change and the SessionPrompt test-boundary change, including cold isolated execution, focused paired execution, full prompt tests, full CI-equivalent verification, and the actual Chinese-comment calculation."

R3 implementation 的 parallel-load paired test 证伪 operation-scoped 3 秒设计；R3 approval 已失效，R4 删除该测试专属短 timeout，等待 full-scope plan audit。

**R4 verbatim verdict:** "APPROVE — exact canonical plan revision R4 has No blocking findings and can be approved. R4 may be recorded as: Status: approved, Revision: R4, Approved revision: R4, Implementation allowed: yes. The current SessionPrompt candidate still contains the rejected R3 `awaitWithTimeout(..., shortSessionTimeout)` wrapper. Plan approval does not approve that candidate. The subsequent R4 implementation must restore direct `Effect.all`, remove the test-specific timeout, preserve the assertions, and pass the complete R4 verification matrix before implementation release."

## 23. Implementation Evidence

R1/R2 的 implementation evidence 保留为历史记录。R3 曾临时把 3 秒移动到 operation，isolated green 但 parallel-load paired red；R4 已删除该临时 wrapper，当前为 direct `Effect.all` + 无 test-specific short timeout。

### Actual Files and Diff

**Changed files:**

- `packages/opencode/test/file/watcher.test.ts` — `ready()` function (L120-150)
- `packages/opencode/test/session/prompt.test.ts` — concurrent error-result test (L2188-2208)

```diff
 function ready(directory: string) {
   const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
-  const head = path.join(directory, ".git", "HEAD")

   return Effect.gen(function* () {
     const fs = yield* AppFileSystem.Service
     const git = yield* Git.Service
+    const gitRoot = path.join(directory, ".git")
 
     yield* nextUpdate(
       directory,
       (evt) => evt.file === file && evt.event === "add",
       fs.writeFileString(file, "ready"),
     ).pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)), Effect.asVoid)
 
+    if (!(yield* fs.existsSafe(gitRoot))) return
+    // production订阅realpath；readiness必须监听同一事件路径，不能用symlink拼写等待另一个名字。
+    const actualGit = yield* fs.realPath(gitRoot)
+    const head = path.join(actualGit, "HEAD")
     if (!(yield* fs.existsSafe(head))) return
 
     const branch = `watch-${Math.random().toString(36).slice(2)}`
     const hash = (yield* git.run(["rev-parse", "HEAD"], { cwd: directory })).text()
     yield* nextUpdate(
       directory,
       (evt) => evt.file === head && evt.event !== "unlink",
       fs
-        .writeFileString(path.join(directory, ".git", "refs", "heads", branch), hash.trim() + "\n")
+        .writeFileString(path.join(actualGit, "refs", "heads", branch), hash.trim() + "\n")
         .pipe(Effect.andThen(fs.writeFileString(head, `ref: refs/heads/${branch}\n`))),
     ).pipe(Effect.asVoid)
   })
 }
```

```diff
       yield* llm.fail("boom")
       yield* user(chat.id, "hello")

+      // 这里只断言并发loop共享结果；包级timeout仅防进程挂死，不构成3秒性能契约。
       const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
         concurrency: "unbounded",
       })
       expect(a.info.id).toBe(b.info.id)
       expect(a.info.role).toBe("assistant")
     }),
   { git: true },
-  shortSessionTimeout,
 )
```

### Red-Green Test Evidence

**Red (before fix):**
```
bun test test/file/watcher.test.ts --timeout 60000
(fail) FileWatcher > symlinked .git > publishes .git/HEAD events through a symlinked .git directory [5784.16ms]
 6 pass
 1 fail
```

**Green (after fix):**
```
bun test test/file/watcher.test.ts --timeout 60000
 7 pass
 0 fail
```

**SessionPrompt red / falsification / green:**

- Original cold isolated: `0 pass, 1 fail`, whole-test timeout at 3000ms.
- Warm paired baseline: `2 pass, 0 fail`, proving shared-result behavior exists.
- R3 isolated operation-scoped 3s: `1 pass, 0 fail`.
- R3 parallel-load paired: `1 pass, 1 fail`, operation-scoped 3s timeout; R3 design rejected.
- R4 direct `Effect.all` under the same parallel load: isolated `1 pass, 0 fail`; paired `2 pass, 0 fail`.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/file/watcher.test.ts --timeout 60000` | `packages/opencode` | 7 pass, 0 fail (9.38s) — symlinked .git test now passes |
| `bun typecheck` | `packages/opencode` | Pass (no output = success) |
| `bun test test/file/ --timeout 60000` | `packages/opencode` | 97 pass, 2 skip, 0 fail (17.71s) — no regression |
| `bun test test/session/prompt.test.ts --timeout 30000 -t "concurrent loop callers all receive same error result"` | `packages/opencode` | 1 pass, 0 fail under parallel load |
| `bun test test/session/prompt.test.ts --timeout 30000 -t "concurrent loop callers"` | `packages/opencode` | 2 pass, 0 fail under parallel load |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 84 pass, 0 fail, 365 expects |
| `bun turbo test:ci --filter=opencode --continue=dependencies-successful` | repository root | 3820 pass, 16 skip, 0 fail; 3 tasks successful |

### Original Feedback-Loop Result

The original CI failure (`FileWatcher > symlinked .git > publishes .git/HEAD events through a symlinked .git directory [5265.99ms]`) is resolved. The test now passes in 9.38s total (including all 7 watcher tests), with the symlinked .git test completing without timeout.

Native red harness independently observed `actualGit/HEAD` while the old predicate expected `dir/.git/HEAD` and exited 1; the corresponding realpath predicate exited 0. The original full CI-equivalent command completed with `3820 pass, 16 skip, 0 fail`.

The independently discovered SessionPrompt blocker is resolved without changing production: the cold isolated and parallel-load paired paths now complete from real `prompt.loop` results, and the full CI-equivalent command is green.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Decision-surface share |
| --- | --- | --- | --- |
| `ready()` 使用 `realPath(gitRoot)` 匹配事件路径 | primary-contract | yes | 100% |
| `nextUpdate` Deferred + timeout 安全网 | diagnostic (timeout produces failure, not success) | no | 0% |
| direct concurrent `Effect.all` + ID/role assertions | primary test contract | yes | 100% of SessionPrompt test success |
| package default 30s timeout | diagnostic process-hang boundary | no | 0% alternate success |

No fallbacks. No alternate success paths. No configuration switches.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 6 | Excluded: 2 comment lines, unchanged `existsSafe(head)` and direct `Effect.all`, 0 import-only, formatter-only, generated, or pure-move. Counted: watcher 5 lines + removal of SessionPrompt test-specific timeout 1 line. |
| Qualifying Chinese comment lines `C` | 2 | watcher realpath invariant comment + SessionPrompt no-3-second-SLA boundary comment. |
| Ratio `C / E` | 0.333 | 2/6 = 0.333 >= 0.15 ✓ |
| Required minimum `C` | 1 | `if E > 0: C >= max(1, ceil(6 * 0.15)) = 1` |

### Remaining Unverified Items

- Linux CI 平台未本地验证（仅 macOS 本地验证）。修复基于路径字符串一致性，不依赖平台特定行为，`realpath` 在 Linux 上同样解析符号链接。
- Windows symlink branch remains intentionally skipped by the existing platform capability boundary (`process.platform !== "win32"`); no Windows symlink behavior is claimed.
- R2 implementation audit 重跑完整 CI 时出现 `test/session/prompt.test.ts` timeout；用户授权扩展后，R4 已在 test owner 删除被证伪的 3 秒 SLA，production 未修改。
- 一轮 R4 full CI 曾在 `httpapi-workspace-routing` 收到 `Healthy` 文本后 JSON parse 失败；该测试单独与整文件分别 1/1、9/9 通过，下一轮 full CI 3820/3820 通过。没有稳定 first divergence，未修改第三个 owner。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 0 | 2 (N-01: refs path change is consistency not functional fix; N-02: existsSafe(head) reachable but unexercised, preserved verbatim from original) | APPROVE — No blocking findings | adversarial-auditor task ses_0889edf37ffeOK48D3jpzKGRbd |
| 2 | R2 | yes | 1 (B-01: required full CI-equivalent verification failed in unchanged SessionPrompt tests; one timeout reproduced independently) | 1 (N-01: actual E=5, not 6; C gate still passes at 20%) | BLOCK | adversarial-auditor task ses_0870472e5ffeSqBVtPLu5YX7S0 |
| 3 | R3 | not invoked | pre-audit paired verification falsified approved operation-scoped 3s design | — | superseded by R4 | — |
| 4 | R4 | yes | 0 | 1 (N-01: canonical plan recorded diff contained one trailing-whitespace line; corrected after audit without behavioral change) | APPROVE — No blocking findings | adversarial-auditor task ses_0870472e5ffeSqBVtPLu5YX7S0 |

**Verbatim verdict:** "APPROVE. The implementation diff matches approved revision R1 exactly. The root cause (`ready()` event-path mismatch at the symlink-spelled `dir/.git/HEAD` vs watcher's realpath-published `actualGit/HEAD`) is repaired at the owning module — the `ready()` test helper — with no production code change. No fallback, no alternate success path, no weakened test, no responsibility leak. All input-domain branches (symlinked .git, non-symlinked .git, non-git) are preserved. Independently reproduced: 7/7 watcher tests pass (8.55s), 97 pass / 0 fail across `test/file/` (17.38s), typecheck clean. The 15% Chinese-comment gate passes (C=1, E=5, ratio 0.20)."

R1 的 implementation verdict 只覆盖 R1；R2 的 BLOCK 驱动 R3/R4，当前只允许 R4 full-scope implementation audit 放行。

**R2 implementation verdict:** "BLOCK. B-01 — required full CI-equivalent verification currently fails. The watcher implementation itself repairs the confirmed root cause and all watcher/file/typecheck verification passes, but `test/session/prompt.test.ts` produced two timeouts; `concurrent loop callers all receive same error result` remained reproducible in isolation. Restore the required CI green baseline and rerun a full-scope implementation audit. N-01 — actual E=5, C=1, ratio 20%; the Chinese comment gate passes."

**R4 implementation verdict:** "APPROVE. The exact R4 implementation diff has No blocking findings and can be marked verified."

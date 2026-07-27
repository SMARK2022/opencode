# Canonical Implementation Plan: OpenTUI 流式 Markdown 渲染性能与稳定性修复

> Status: audit-required
>
> Revision: R39
>
> Approved revision: none
>
> Audit mode: plan (full-scope)
>
> Requirement source: 本 Session 用户关于 OpenTUI/OpenCode TUI 卡顿、阻塞、Markdown delta/表格闭合、长代码段、公式/跨行公式约束、完整检查与修改的原始要求
>
> Implementation allowed: no
>
> Last updated: 2026-07-27

本文是本任务唯一的 implementation authority。聊天摘要、`.temp/testing` 原型、历史 branch、旧审计和 builder 自述均不是实施授权。R1因公开异步状态边界被阻塞，R2补齐该边界但因 source/release runtime 闭包断裂被阻塞，R3/R4/R5补齐技术闭包和授权证据，R6发现 one-slot supersession不能覆盖连续 hung request，R7发现 callback/response cancellation不能终止worker内的hung work，R8改为隔离且可物理终止的one-shot worker channel；实施前发现TreeSitterClient已有并发highlightOnce兼容契约，R9补充channel restart期间的非取消请求replay；R10记录用户对11个tarball加SHA256SUMS的明确授权；R11记录实现阶段发现的AbortSignal测试替身兼容边界；R12补齐reference definition对stable-prefix closure的语义边界；R13重建当前dirty WIP baseline并固定termination failure的公开diagnostic contract；R14禁止termination failure提交success-shaped source文本；R15补齐latest-job测试helper的settle时序；R16统一canonical metadata并修复Code侧AbortError抢先吞掉termination failure。

R17补齐`.3` provenance fixture的显式测试映射；R18统一当前revision与后续用户runtime/release授权的审计输入；R19记录真实240-flush反馈环发现的append-only Markdown active-abort starvation，并在同一Code/cache owner内定义coalescing与stale raw-cache seed修复方向。

R20-R24探索过append-only hung request的watchdog/progress协议，但无法在不扩大worker lifecycle责任的前提下区分合法长loading/query与永久不返回。R25按用户明确选择回到最小正常流修复：append-only Markdown保留active parse并合并latest dirty；synthetic append-only永久不返回不属于本轮保证，semantic setter和destroy仍沿既有AbortSignal/worker termination contract立即终止。已发布的`.3`是不可变历史基线；最终修复使用新的`.4`，且source实现独立审计必须先于任何commit/push/tag/workflow远程动作。

R28 records the final implementation audit's observed visible-output regression: R27 deferred an unresolved long fence below the parse threshold while OpenCode's actual `drawUnstyledText={false}` consumers retained the old frame. `.4` is immutable and cannot be corrected in place. R28 keeps the one Markdown path but commits a current-content provisional StyledText frame made from the confirmed stable-prefix highlights plus default-styled unresolved tail, then lets the existing full-context highlighter correct it at the threshold or valid fence closure. The user authorized a separately audited immutable `.5` staged release for this repair.

## 1. Verbatim Requirement

> 下面需要你对我们的OpenTUI的相关部分,也就是我们的OpenCode,本质上是有一个TUI所进行的,请你检查检查,也可以自行benchmark测试一下相应TUI的渲染速度以及其卡顿阻塞的点在哪里。我当前有时候使用的时候会遇到某些卡顿或者阻塞问题,比如说抽搐,屏幕突然卡了半天才在下面出来字符等等,或者说MacDown有时候它渲染得也很慢。请你检查检查,看看主要是哪些原因,然后以及看看有没有办法进行相应的优化。以及请注意,理论上来说你不能对当前仓库内容进行修改。所以如果你真的需要修改的话,我建议你在临时文件夹中进行相应的修改操作。与此同时,如果你真的需要修改,你也可以在我们的.temp里面的testing这个已有的文件夹里面进行修改。

> 继续，主要是你说的那个markdown是按照分批,或者说按照delta进行刷新的。如果我们只对delta部分进行更新的话,会有个问题,就是markdown它本身可能是一个表格,进行一点一点出来。如果你只对delta部分进行更新的话,那本质上它是解析不了,也就是无法让整个表格闭合。所以这针对等等这种内容,你可以自行完整检查检查,看看整体来说如何进行更好的优化。我知道增量实现是更好的,但是你也可以看一看怎么进行增量,能够更加稳定地对整个markdown进行完整的输出。譬如说,理论上来说有一些东西完全闭合之后,也就是当前后面的输出不会再影响前面的时候,那它这个时候可以把前面的进行buffer或者等等内容。你可以检查检查,看看这到底应该怎么搞。

> 因此下面请你完整我检查检查,理论上来说,我们是有一个openTUI的分支,你看看,理论上结合这些内容是否可以放到我们的openTUI分支里面。同时理论上来说,相应的约束还包括长代码段等等内容。因为长代码段本质上它也会触发重解析,同时一些公式等等,比如说跨行公式等等内容,也需要进行相应的约束。

> 范围约束：整体修改保持甜点级别，整体修改文件数量控制在8个代码文件以内，生产代码修改不超过1200行，测试代码或者测试脚本最好不超过十个，修改后不能出现红测问题。

## 1.1 Subsequent User Scope Authorization (verbatim)

The original requirement makes repository modification the default non-goal, while allowing it when genuinely necessary. After the R2 runtime-closure finding, the user explicitly selected the following scope amendment in the current Session:

> Assistant question: 是否允许把 canonical plan 扩展为“OpenTUI源码修复 + 新immutable release family + OpenCode package/lock/provenance更新”的完整交付路径？我可以先本地构建、隔离安装并验证，不能未经你明确授权执行 push/tag/GitHub release；如果不扩展，则只能做 source-only 修复并明确不声称当前OpenCode安装运行时已生效。
>
> User answer: **扩展到完整runtime闭包（推荐）**

The user then explicitly authorized the release gate required by that expanded scope:

> Assistant question: 是否明确授权上述 staged release gate：在 source/local package 验证和对应独立审计通过后，创建 nested OpenTUI release commit，normal push 到 `smark/main`，创建 annotated `v0.4.3-smark.3` tag并允许现有 GitHub release workflow发布11个assets？不 force push；parent OpenCode lock更新、installed-runtime验证和最终parent commit仍等后续 implementation audit。
>
> User answer: **授权 staged release gate（推荐）**

The user subsequently clarified the asset-count wording after the R9 audit:

> User clarification: **11+256sums，同时无需继续审计，本身方案没有blocker了所以不算问题**

This clarification authorizes the existing workflow's exact release set: 11 npm tarballs plus the required `SHA256SUMS` manifest, which is 12 GitHub Release assets in total. The phrase `无需继续审计` does not remove the repository-required full-scope re-audit after a blocking plan revision; it confirms that the asset-count boundary is not a user objection.

After R24 exposed the tradeoff between a minimal normal-stream repair and a full worker-lifecycle progress protocol, the user made these two explicit decisions:

> Assistant question: R25应采用哪种行为边界？
>
> User answer: **最小正常流修复（推荐）**
>
> Assistant question: 是否授权在source实现独立审计通过后发布新的immutable `.4`，再更新parent runtime closure？
>
> User answer: **授权 `.4` staged release（推荐）**

The `.4` authorization was consumed by the now-published immutable release; it remains an observed baseline rather than current implementation authority. The later `.5` authorization is the only future release identity and may be published only after a clean source implementation audit.

After the final R27 implementation audit found the visible long-fence regression, the user explicitly authorized its immutable successor:

> Assistant question: 是否授权R28在独立方案/实现审计通过后发布新的immutable `v0.4.3-smark.5`，替代已发现可见性缺陷的`.4` runtime？
>
> User answer: **授权 `.5` staged release（推荐）**

This is a later, explicit user scope decision, not a builder inference. The original temporary-directory constraint still applies to all work before the approved plan and to every unapproved alternative; this record authorizes only the exact primary release path described in Section 10.4, in the stated order, with no force push or source fallback.

## 2. Explicit Non-Goals

- R39审计通过前不继续修改 OpenTUI/OpenCode 生产代码、测试、生成文件、配置、lockfile 或 migration；当前`.4` source/release和parent WIP只是待修复baseline，不构成R39实施授权。
- 不为仅在测试替身中构造的append-only one-shot永久不返回增加watchdog、parser/query/loading progress协议或第二worker调度路径。用户明确选择最小正常流修复；该请求仍可由semantic setter、destroy或client teardown终止，但仅有无限append时不承诺自动恢复。
- 不新增数学/LaTeX renderer、tree-sitter math grammar、Markdown math query或公式着色语义。当前 parser 对 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\begin...\end...`只产生普通 `spell`/`string.escape`文本语义，本任务保留并测试该 pass-through contract。
- 不把 `createBuffer/updateBuffer` 作为下游或fallback路径；R39只在TreeSitterClient内部将其提升为Code-owned的唯一streaming Markdown buffer contract，并返回完整当前文档语义。
- 不修改 OpenCode `sync.tsx` 的16ms producer节流，不在下游复制渲染缓存。
- 不重写或复制已有 `MarkdownRenderable` marked parser、table renderer、top-level block reconciliation；其 owner已有独立稳定块逻辑。
- 不把 experimental completed Markdown route强行切换为默认 streaming route；`ReasoningBody`依赖 CodeRenderable `onChunks`回传 conceal 后文本计算折叠高度，整路由切换会改变已有布局责任。
- 不在本任务修复 synthetic native handle ceiling；该问题需要独立资源生命周期设计，当前没有真实 Session 达到阈值的 producer trace。
- 不在R39批准、source实现完成、本地package preflight和独立source implementation audit全部通过前执行新的`commit`、`push`、`tag`或GitHub Release；随后仅按用户授权发布同一source commit的`.5` 11个npm tarballs plus `SHA256SUMS` manifest（GitHub Release实际12个assets），禁止任何其他远程副作用。
- 不把R39 provisional presentation分类为parser-error或termination error的raw-text escape：它只适用于已验证的current streaming Markdown snapshot、保持同一`CodeRenderable -> StyledText`路径、使用当前snapshot的`onChunks`，且不执行`onHighlight`或把未解析tail标记为语法高亮。
- 不让 OpenCode runtime从 `thirdparty/opentui` source fallback；仓库约定 consumer使用 immutable Release tarballs。
- 不把 `.temp/testing/tui-perf` 中的绝对路径 prototype、临时 dylib或 fallback复制到生产。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `AGENTS.md:1-141` | 并行调查、Bun、最小修改、保留 dirty worktree；测试从 package directory运行，typecheck不能直接调用 `tsc`。 |
| `thirdparty/opentui/AGENTS.md:1-74` | OpenTUI使用 Bun；native变更必须 build/native test；先建立复现再修复。 |
| `packages/opencode/AGENTS.md` | 保持现有 ESM/module shape，不扩展无依据的 Effect/API重构。 |
| `CONTEXT.md:1-181` | 使用 Session、Message、Part 等项目术语；producer是 Message Part delta。 |
| `.opencode/policy/first-principles-engineering.md:41-69,172-231,236-322` | 修复 first divergence；一个 primary path；禁止 fallback；完成正反向 traceability。 |
| `.opencode/templates/canonical-plan.md:1-264` | 计划必须覆盖 evidence、domain、owner、TDD、verification、diff、风险和审计记录。 |
| `docs/workflow.md:1-105` | exact approved revision前不得实施；R5通过后进入 implementation-audit-required流程。 |
| `docs/adr/README.md:1-50` | 没有约束本任务的 accepted OpenTUI ADR；不新增 ADR。 |
| `README.md:239-243` | submodule只承载源码发现/provenance；OpenCode正常安装使用 immutable Release；修改 fork后需独立发布完整 package family。 |
| `thirdparty/opentui/.github/workflows/release.yml:21-137` | release tag必须指向已推送 source commit；workflow构建、验证并发布完整 package family。 |
| `thirdparty/opentui/.github/workflows/build-native.yml:57-123` | 11个 npm tarballs 的 lockstep build/pack/checksum/verifier contract，另有必需的 `SHA256SUMS` manifest；不是单一 JS 包发布。 |
| `thirdparty/opentui/scripts/prepare-release.ts:40-105` | 所有 `@opentui/*` workspace package 使用同一 release version，并由版本更新驱动 lockfile。 |
| `thirdparty/opentui/scripts/verify-release-packages.ts:5-188` | loopback HTTP 安装真实 tarball family、重复 target install、native/manifest/version/repository 和用户可见 frame 验证。 |
| `script/upgrade-opentui.ts:11-129` | parent consumer 的 release allowlist、11项 override asset map、catalog/dependency/peer更新边界。 |
| `packages/opencode/script/build.ts:439-475` | OpenCode build从 resolver实际解析 `@opentui/core` 和 target native package；source submodule不是编译输入。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| nested OpenTUI HEAD/remote/tag `df4bd31caaa1153944b28509ac13610b4a16ca85`, `origin/smark/main`, `v0.4.3-smark.4` | `.4` source/release已不可变发布；它包含R27 open-fence stale-frame行为，是R28起点而非最终修复 | observed |
| `.gitmodules:5-8` | OpenTUI source branch为 `smark/main` | contracted / observed |
| root `package.json`、`bun.lock`、gitlink和provenance WIP | 当前parent工作树已指向11个 immutable `v0.4.3-smark.4` Release tarballs和`df4bd31c`，但尚未形成最终parent commit | observed / contracted |
| `packages/opencode/package.json:113-115` | OpenCode真实 consumer 使用 `@opentui/core`、`@opentui/keymap`、`@opentui/solid` 的 catalog依赖 | observed |
| `packages/opencode/script/verify-opentui-closure.ts:8-19,97-120`、`opentui-provenance.ts:1-68`、`opentui-source-revision.json` | source gitlink与release identity独立；source-authorized闭包路径 | observed / contracted |
| `bun script/verify-opentui-closure.ts` from `packages/opencode` | 当前closure通过：11 packages、Solid1.9.12、arm64 native hash `003043...838b` | observed |
| `routes/session/index.tsx:2052-2092,2096-2147` | `ReasoningBody`/`TextPart`真实 streaming CodeRenderable consumers；公开状态包括 syntax、conceal、onChunks等 | observed / reachable |
| `context/sync.tsx:425-445` | Message Part delta 16ms producer节流 | observed |
| `Code.ts:47-115,160-271,289-421,535-555` | public setters、dirty/snapshot、全文 one-shot、callbacks、提交与render loop owner | observed |
| `client.ts:391-418,557-657`、`types.ts:7-21,75-105` | one-shot flat highlights与buffer-mode按行 response的边界 | observed |
| `parser.worker.ts:819-878,982-1050` | worker one-shot parse逐请求串行处理 | observed |
| `default-parsers.ts:39-123`、`resolve-ft.ts:42,77` | Markdown只注入 inline/table cell；tex/latex仅filetype mapping，无math query | observed |
| `Markdown.ts:261-325,630-655,954-1045,1430-1855,1867-2017`、`markdown-parser.ts:1-79` | 现有 marked stable token/block和table/code child owner | observed |
| `Code.test.ts:1005-1086,1119-1194,1578-1739`、Markdown/parser tests相关范围 | 现有 streaming、table、fence、stable token和callback regression | observed |
| `Code.test.ts:525-608` | 既有可达契约：底层 `highlightOnce` Promise 永不完成时，后续 content/filetype 更新仍必须继续到达最新 Markdown consumer；严格单 active gate 会永久阻塞 | observed / reachable |
| `TreeSitterClient`、worker one-shot lifecycle | R18 WIP已有AbortSignal、isolated worker termination和termination barrier；R25只在semantic invalidation/destroy使用该合同，不扩展append-only watchdog/progress | observed |
| `platform/worker.ts:21-28,165-207` | 已有跨运行时 `PlatformWorkerHandle.terminate()` 生命周期边界；Node shim会移除transport listeners并等待底层 worker termination | observed / contracted |
| `TreeSitterClient:73-99,557-642`、`tree-sitter/index.ts:22-74` | 同一client/singleton同时承载 reusable buffer parser和Code one-shot；终止共享worker会破坏其他buffer语义，因此隔离one-shot channel是兼容性需要 | observed / reachable |
| `client.test.ts:408-440,545-613,910-934` | 既有 public `highlightOnce` 并发调用契约：不同filetype、相同parser和Markdown injection请求可以同时发出，所有结果必须完成且复用parser assets | observed / reachable |
| R5 WIP red/regression run | 新增 callback invalidation red 已转绿；启用严格 active gate后，hung-promise和两个 drawUnstyledText streaming regression失败，证明R5 gate过强 | observed |
| `text-buffer.ts:45-93`、`text-buffer.zig:909-977,1077-1185`、`text-buffer-iterators.zig:13-62` | `setStyledText`逐chunk调用全量 `walkLines` 的 native first divergence | observed |
| `text-buffer-iterators_test.zig:15-183`、native highlight/drawing tests | native LineInfo和styled-text行为测试 seam | observed |
| `.temp/testing/tui-perf/e2e-stream.ts` | 真实 renderer + Code，捕获用户可见 commit gap和catchup | observed |
| `.temp/testing/tui-perf/incremental-correctness.ts` | buffer-mode结构 differential | observed |
| `.temp/testing/tui-perf/markdown-structure-probe.ts` | 公式实际 groups和prefix closure | observed |
| `.temp/testing/tui-perf/markdown-renderable-stream.ts` | 现有 MarkdownRenderable top-level benchmark；用于 owner对比 | observed |
| `.temp/testing/tui-perf/stable-prefix-adversarial.ts`、`stable-prefix-fuzz.ts`、`prefix-cache-correctness.ts`、`prefix-cache-bench.ts` | 候选stable boundary/cache的 adversarial、fuzz、逐delta correctness、性能证据；不是生产实现 | observed |
| `.temp/testing/tui-perf/native-ab.ts`、`native-correctness.ts`、`pipeline-breakdown.ts`、`setstyled-complexity.ts` | native热点、bounded prototype A/B和 correctness | observed |
| `bun e2e-stream --mode=baseline --flushes=240` | 15504 chars/240 jobs，max concurrency11，job p95 178ms，commit gap p95 41ms/max170ms，catchup214ms | observed |
| `bun .temp/testing/tui-perf/e2e-stream.ts --mode=public --flushes=240` after R18 | 15504 chars/240 flushes，只有2次commit，最大可见间隔4834ms，post-stream catchup757ms，最终14448/15504；正常active-abort路径在真实producer cadence下出现starvation | observed |
| `.temp` no-abort diagnostic experiment, same 240 flushes | 屏蔽当前实例active abort后229次commit，gap p95 23ms/max205ms，post-stream catchup223ms，0次shrink；证明worker termination是first divergence而非renderer capture | observed |
| `bun highlight-scaling.ts` | 5905 chars已17.30ms，96745 chars 367.28ms/delta；理论100k累计约379.8s | observed |
| `bun pipeline-breakdown.ts` | 53280 chars/3061 lines：highlight205.6ms、toChunks15.9ms、setStyled511.9ms、total733.4ms | observed |
| `bun incremental-correctness.ts` | table4/7、partial5/7、fence6/6、blockquote2/2、setext2/3、emphasis1/3 divergence | observed |
| `bun stable-prefix-adversarial.ts`、`stable-prefix-fuzz.ts --docs=40 --checks=6` | 可判定 adversarial全通过；187 fuzz checks、0 violations、平均可缓存77.8% | observed |
| `bun prefix-cache-correctness.ts --docs=12`、`prefix-cache-bench.ts --deltas=300` | 163 steps/0 mismatch；19526 chars full6.88s vs cache0.15s、46.70x | observed |
| `bun run test:native`、targeted Markdown/Code/parser tests | native1688 passed/2 skipped；targeted suites green | observed |
| full `bun test` + isolated rerun | 一次全量4978 pass/23 skip/1 fail/1 error；isolated TreeSitter client 48/48 pass，记录为并发基线噪声 | observed |
| OpenTUI history `ad13890c`, `6c24440a`, `48c02d19`, `5e20a2eb`; OpenCode `b0ade40265`, `daf41ca522` | stable blocks、fence flicker、requestRender和route历史；不能直接复制旧实现 | observed |

## 5. Current Behavior

默认 streaming path：

```text
Provider -> Message Part delta -> sync 16ms batch -> TextPart/ReasoningBody
  -> CodeRenderable.content/setters -> dirty + render request
  -> renderSelf -> startHighlight(full content)
  -> TreeSitterClient.highlightOnce -> worker ONESHOT_HIGHLIGHT
  -> treeSitterToTextChunks -> TextBuffer.setStyledText
  -> native addHighlightByCharRangeInternal(each chunk)
  -> full walkLines(each line from zero) -> next frame
```

当前 generation只在 `content` setter和`startHighlight`路径中变化；`filetype`、`syntaxStyle`、`conceal`、`streaming`、`baseHighlight`、`onHighlight`、`onChunks`等公开setter没有统一使当前异步结果失效。故旧任务可在新公开状态下执行 callback或提交 `StyledText`。

当前每个 delta都可启动全文 one-shot；generation只丢弃 stale result，不阻止 worker/native工作创建。native `setStyledText`又对每个 chunk调用全量 `walkLines`，造成第二层 chunk×line放大。

experimental `MarkdownRenderable`已有 marked stable-token/block和table reuse，但默认 streaming `TextPart`及`ReasoningBody`仍走 Code；ReasoningBody还依赖 `onChunks`的可见文本反馈。

`.4` source commit、remote tag和12个assets已经存在，parent WIP也已解析`.4`的11个immutable tarballs；但`.4`包含R27 open-fence stale-frame行为。因为该release identity不可覆盖，R28 source修复必须在独立source implementation audit通过后发布新的`.5` family，再更新parent resolver/lock/provenance并执行installed-package验证。

R18的isolated one-shot worker和AbortSignal仍保护semantic setter、destroy及client teardown。用户在R24后明确选择不为synthetic append-only永久不返回建立额外watchdog/progress合同；因此相关test fixture不再定义正常append的自动恢复要求，但semantic invalidation仍必须物理终止旧worker且不能提交旧结果。

## 6. Supported Input Domain and Reachability

| Input/condition | Producer/path | Owner | Class |
| --- | --- | --- | --- |
| append-only assistant Markdown Part | provider -> sync -> TextPart -> streaming Code | CodeRenderable | observed / reachable |
| append-only reasoning Markdown-like Part | provider -> ReasoningBody -> streaming Code + onChunks | CodeRenderable | observed / reachable |
| experimental v2 debug Markdown Part | plugin/internal experimental event system -> session-v2 -> streaming Code + onChunks | same CodeRenderable seam | reachable |
| table header/delimiter/rows跨delta | same text Part | Code Markdown seam | contracted / reachable |
| open/closed long backtick or tilde fence | same text Part | Code Markdown seam | contracted / reachable |
| blockquote/list/setext/reference/emphasis跨delta | same text Part | Code Markdown seam | observed / reachable |
| formula-like `$`, `$$`, backslash delimiters、跨行 begin/end | model普通文本；当前无math query | Markdown grammar pass-through | observed / contracted |
| `filetype`, `syntaxStyle`, `conceal`, `drawUnstyledText`, `streaming`, `initialStyledText`, `treeSitterClient`, `baseHighlight`, `onHighlight`, `onChunks`在active job期间变化 | Solid/OpenTUI public prop setters | Code snapshot seam | reachable |
| non-Markdown/non-streaming Code consumers | Diff、tool、example、completed views | existing Code full path | reachable |
| CJK/tab/empty/long styled lines | tree-sitter -> TextBuffer | native TextBuffer | observed / reachable |
| source gitlink differs from release commit | submodule/provenance scripts | parent metadata | reachable |
| source修复后的11个 package family、OpenCode override/lock和实际resolver graph | OpenTUI release workflow -> parent install/build -> TUI consumer | release/provenance seam | reachable |
| active one-shot never resolves while semantic setter/destroy arrives | Code setter/destroy -> isolated TreeSitter one-shot channel | existing cancellation/worker-lifecycle seam | observed / reachable |
| append-only one-shot never resolves且没有semantic invalidation | 仅测试替身构造；用户明确排除本轮自动恢复保证 | no new owner | explicit non-goal |
| one-shot channel restarts while unrelated public highlight requests remain pending | concurrent `highlightOnce` callers -> TreeSitterClient channel restart | TreeSitterClient request lifecycle | observed / reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Test |
| --- | --- | --- | --- |
| `INV-01` | 每个当前direct streaming Markdown snapshot在无`onChunks`或caller显式承诺其不改写chunks时（首次、active full parse期间append和open-fence deferred append）都使最新原文在可见frame中出现；完整highlight可稍后校正，但旧snapshot不能覆盖新snapshot。callback-transforming Markdown children保留既有callback-first语义。 | R27/R29 final audit B-01；真实`drawUnstyledText={false}` consumers and callback evidence | visible initial/active/deferred append + 240-flush convergence |
| `INV-02` | 一个 CodeRenderable最多推进一个full-highlight job；正常append-only Markdown不终止active parse，只合并一个latest dirty，并为eligible current streaming Markdown snapshot提交provisional StyledText；semantic invalidation/destroy使旧job退出并按既有isolated channel合同物理终止，不产生detached backlog。 | R18 public loop 2 commits/4834ms；R27/R29 visible-frame evidence；用户选择最小正常流修复 | delayed serialized stream + visible active/deferred append + semantic invalidation termination + 240-flush e2e |
| `INV-03` | stable Markdown prefix在未来append后不改变，未闭合tail保留完整上下文。 | adversarial/fuzz/prefix differential | stability + Code differential |
| `INV-04` | table、fence、long code、blockquote/list和跨行普通文本不截断，最终等于full parse。 | incremental red and cache green evidence | actual client stream |
| `INV-05` | bounded native traversal对受影响LineInfo和最终绘制与旧全量walk等价。 | native A/B、17/17 byte correctness | Zig iterator/highlight tests |
| `INV-06` | `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`streamingChunksAreIdentity`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`、`onChunks`任一公开输入变化都使active snapshot失效；旧任务不得在新状态下执行callback或提交StyledText。 | auditor B-01；Code public setters和真实 OpenCode reactive path | delayed public-state mutation test，包括identity marker true↔false |
| `INV-07` | 公式-like输入在当前grammar下保持普通可见文本，不虚构math AST且不丢失跨行内容。 | formula probe | literal formula stream |
| `INV-08` | 最终`.5` OpenTUI source、release tag和parent gitlink必须指向同一clean source commit；runtime只能通过对应immutable package family进入parent，不得覆盖`.3`、`.4`或source fallback。 | 用户`.5`授权、README/release workflow/provenance | pre-release source audit + release source identity + closure |
| `INV-09` | non-Markdown、non-streaming、既有parser-error兼容和public callback语义保持；不新增第二success path。 | Code consumers/tests | full Code/Markdown regression |
| `INV-10` | OpenCode实际 resolver必须同时加载新版本的3个 framework package和8个 native package；closure verifier、installed consumer smoke和原始 e2e必须证明用户路径消费新 family而不是旧 release/source checkout。 | root overrides/lock、build.ts、release verifier | installed package graph + e2e |
| `INV-11` | `highlightOnce`收到 abort后，隔离的 one-shot worker channel必须先物理终止并清理其 callback/handlers，再允许后续请求创建新channel；共享buffer worker、未取消请求的逻辑结果和其他client语义不可受影响。channel重启时，仍pending且未aborted的请求必须以同一逻辑请求身份replay，而不是新增重复请求。 | `PlatformWorkerHandle.terminate()` existing lifecycle contract；共享client/buffer和并发highlight reachability | actual worker fixture + repeated abort/replacement + concurrent replay + buffer compatibility |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| `INV-01`/`INV-02` | R27仅修复open-fence deferred branch，普通active full parse期间append仍只保留dirty；`drawUnstyledText={false}` consumer保留旧frame或首次为空。 | CodeRenderable streaming Markdown presentation seam | R27/R29 final audit B-01; real consumer path and active-gate source evidence |
| `INV-03`/`INV-04` | reachable Code Markdown path把stable-prefix cut后的suffix作为独立输入，导致tail parser看不到前文上下文。 | Code Markdown seam | R34 plan audit B-01; current `highlightMarkdownFragment(content.slice(cachedCut))` path |
| `INV-05` | native `addHighlightByCharRangeInternal`对每个chunk调用全量 `walkLines`。 | text-buffer iterator seam | 512ms setStyled vs bounded prototype |
| `INV-06` | 非content public setters不递增generation；旧异步链重新读取可变 fields并可提交混合语义。 | Code snapshot/invalidation seam | auditor B-01，Code setter ranges |
| `INV-07` | 当前不是formula parse failure；parser/query没有math node。 | Markdown grammar | default parsers + probe |
| `INV-08`/`INV-10` | `.4`已发布且parent WIP已消费它，但immutable `.4`包含R27 stale-frame regression；若不发布并安装`.5`，用户runtime仍会隐藏sub-threshold open-fence append。 | staged `.5` release/dependency closure | remote `.4` identity + current parent graph + user `.5` authorization |

### Red-Capable Feedback Loops Already Executed

```bash
bun .temp/testing/tui-perf/e2e-stream.ts --mode=baseline --flushes=240
bun .temp/testing/tui-perf/incremental-correctness.ts
bun .temp/testing/tui-perf/pipeline-breakdown.ts
bun .temp/testing/tui-perf/markdown-structure-probe.ts
```

这些命令分别捕获真实 commit gap、结构错误、native stage cost和公式实际语义；具体结果见 Section 4。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here / why not elsewhere |
| --- | --- | --- | --- |
| streaming scheduling | `CodeRenderable` | latest content最终绘制 | 它是delta到one-shot的first consumer；sync只合并事件，worker只执行request |
| async snapshot invalidation | `CodeRenderable` public setters + snapshot capture | 所有影响parser/style/conceal/visible/callback的公开状态变更使旧任务失效 | 所有异步阶段在该类读取状态；producer和native都无法统一协调这些setter |
| Markdown stable boundary/cache | `CodeRenderable`内聚pure boundary logic | closed prefix可复用、tail保留full context | 默认reachable streaming seam是Code；不新增第九个production helper file |
| native line range | `text-buffer-iterators.zig`/`text-buffer.zig` | range highlight只访问可能重叠lines | rope marker/geometry只由native拥有 |
| marked/table block semantics | existing `MarkdownRenderable` | stable token/block/table reuse | 已有owner；本任务不复制或替换 |
| source/release identity | parent provenance metadata | clean gitlink and no source fallback | repository policy/README owner |
| installed package closure | release workflow + parent resolver/provenance scripts | all 11 npm tarballs plus `SHA256SUMS` manifest and OpenCode consumers resolve one release family | source-only tests cannot alter the installed package graph |
| one-shot lifecycle cancellation | existing `CodeRenderable` + `TreeSitterClient` dedicated one-shot channel | semantic invalidation/destroy aborts the invalid snapshot, physically terminates only its worker, clears callbacks/handlers, replays unaffected pending requests and preserves the shared buffer worker | R18 already owns this safety boundary; R25 does not invoke it for normal append-only growth or add progress/watchdog semantics |

## 10. Single Approved Primary-Path Design

```text
OpenTUI source commit
  -> lockstep build/pack/checksum of 11 npm tarballs + SHA256SUMS manifest
  -> immutable release tag/assets
  -> OpenCode catalog/override/lock resolves the same package family
  -> CodeRenderable public update
  -> unified setter invalidation and immutable render snapshot
  -> active-job gate keeps only latest dirty state; streaming Markdown uses one versioned buffer handle, semantic invalidation resets/disposes that handle
  -> streaming markdown: incremental complete-context parser tree + versioned full SimpleHighlight result
  -> other domains: existing full one-shot parse
  -> current-snapshot checks before parser callback/chunk transform/commit
  -> one StyledText commit
  -> native bounded line window
  -> actual TextPart/ReasoningBody consumer frame
```

### 10.1 Unified snapshot and latest-snapshot scheduling

- 所有公开setter（`content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`streamingChunksAreIdentity`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`、`onChunks`）通过一个invalidation入口递增generation并标记dirty。
- 除可验证的 append-only `content` 外，其余setter清空Markdown prefix cache；content rewrite、frontmatter transition或非prefix内容由resolver清空cache。
- `startHighlight`捕获不可变snapshot：上述全部输入、content、filetype和generation；解析、`onHighlight`、chunk transform、conceal映射、`setStyledText`都使用snapshot，不在异步链重新读取可变字段。`streamingChunksAreIdentity`也在snapshot中决定provisional eligibility，setter变化必须使active/queued presentation失效。
- 在parser返回、`onHighlight`返回、`onChunks`返回以及最终可见提交前统一检查generation和destroyed；任何公开状态变化都让旧任务丢弃，只有上述append-only Markdown stale结果可以按独立cache-seed规则保留raw prefix，由最新dirty snapshot重新进入主路径。
- `renderSelf`正常情况下只在无active任务时启动；active期间保留dirty并合并中间更新。每个`streaming && filetype === "markdown"` 当前snapshot（首次、append、rewrite和open-fence growth）进入同一个Code-owned buffer handle：严格append发送edit，rewrite发送reset，目标version完成后才消费完整SimpleHighlight结果。eligible direct OpenCode路径可先提交当前可见文本，语法结果由同一buffer version追上；transforming callback保留callback-first单次提交。semantic setter或destroy清空/重置buffer并沿既有AbortSignal/worker termination contract处理；不增加timer、watchdog、第二parser或第二成功路径。
- `TreeSitterClient.highlightOnce(content, filetype, signal?)`继续使用独立one-shot worker，但只服务non-Markdown/non-streaming和既有semantic lifecycle contract；streaming Markdown不得调用该接口。signal abort时沿既有独立channel termination语义清理worker和pending callback。
- one-shot channel在正常连续/并发请求间复用；取消或worker error后只在前一channel termination完成后懒创建新worker，并重新发送INIT、default parser和已注册custom parser配置。仍pending且未aborted的逻辑请求以原始payload和callback身份replay一次；不保留旧worker的物理request，不重复创建逻辑请求。不得把one-shot回退到共享buffer worker，也不得发送只抑制response但不终止work的伪cancel消息。
- `TreeSitterClient`必须保存可重放的custom parser/data-path注册状态；`destroy`同时终止两个channel，`setDataPath`/`clearCache`不能留下旧one-shot channel。channel restart期间到达的新请求加入同一pending set，等待replacement初始化后只发送一次。
- 未取消的并发 `highlightOnce` 调用必须继续保持现有结果语义和parser asset reuse；只有被abort的逻辑请求reject `AbortError`，其他请求不得因channel replacement暴露旧worker termination。
- Code job identity和`finally`必须同时检查generation/job token；abort rejection不能进入既有parser-error plain-text fallback，也不能影响其他buffer request。注入的兼容mock必须遵守可选AbortSignal，Code仍需在signal abort时停止等待旧Promise。
- 保留现有 parser-error plain-text warning compatibility，不把它扩展成新性能fallback。

### 10.2 Conservative Markdown prefix cache

- 仅`streaming && filetype === "markdown"`走cache；non-streaming和非Markdown保留full parse。
- 只接受append-only；真实空行才关闭block，末尾split artifact不是blank line。
- 开放 backtick/tilde fence从opener起保持tail，closing marker必须同字符且长度不短于opener。
- 未闭合长fence的tail仍使用完整上下文；每个合并后的current streaming Markdown snapshot都通过同一buffer version进入Tree-sitter完整parser tree，不因行/字节门槛跳过tail处理。active-job gate合并连续delta，避免每个16ms producer事件启动独立worker；closing marker和普通append沿同一buffer主路径收敛。每个current snapshot都先提交符合callback contract的可见结果，不能保留旧frame、初始空frame或等待另一条append。
- `MarkdownHighlightCache`只记录buffer version对应的stable boundary和可复用输出ranges；完整SimpleHighlight结果由buffer worker返回，包含当前tail、injection和conceal metadata。Code不得用缓存ranges拼接第二份parser结果，也不得把未解析tail标记为已高亮。
- 文首`---`/`+++`在matching marker前保持unresolved；关闭时清空此前cache。
- 任何需要语法结果的Markdown请求都通过唯一buffer handle；worker以完整parser tree处理edit/reset，并返回当前文档的完整SimpleHighlight结果。禁止`highlightMarkdownFragment(content.slice(cachedCut))`、standalone suffix、synthetic wrapper、offset-shift伪造上下文或并列one-shot Markdown成功路径。
- 公式不新增delimiter state：当前grammar没有math node，cross-line formula-like文本按普通Markdown tail和真实block boundary处理，并由 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\begin...\end...` 五组literal tests锁定pass-through。
- 不复制MarkdownRenderable的marked parser/block cache；incremental buffer只复用Tree-sitter自身的完整parser tree和Code的versioned result，不建立第二套Markdown语义。

### 10.3 Bounded native line walk

- `text-buffer-iterators.zig`增加按`col_offset`二分定位、到`char_end`顺序停止的bounded iterator，回调字段与旧`walkLines`一致。
- `text-buffer.zig:addHighlightByCharRangeInternal`只替换iterator调用，保留overlap、column、priority、internal和error语义。
- 不修改其他`walkLines` callers或editor/layout API。

### 10.4 Immutable `.5` release and OpenCode consumer closure

- 已存在的`v0.4.3-smark.3`、`v0.4.3-smark.4`、对应remote source/assets都是不可覆盖的历史baseline；不得重建、移动或替换这些tag/release。使用现有`prepare-release.ts`将OpenTUI所有lockstep `@opentui/*` workspace manifest从`.4`升级到`0.4.3-smark.5`；不手工只改core。
- 按现有 `build-native.yml` 生产同一 source commit 的11个 npm tarballs：core、solid、keymap和8个 host/target native packages；同时生成必需的 `SHA256SUMS` manifest，GitHub Release实际包含12个assets；执行 native regression、library/framework build、packed dist smoke和 `npm pack`。
- 运行现有 `scripts/verify-release-packages.ts` 的 loopback HTTP install。该 verifier必须校验11个 tarball的 `SHA256SUMS`，从tarball重新安装两次（含 target reinstall），检查11个 manifest的版本/repository/native closure，并执行用户可见 `createTestRenderer` smoke；不能用 workspace symlink替代。
- 在已安装的parent workspace中直接运行`packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts`，并由`verify-opentui-closure.ts`报告真实resolver realpath/version，确认不是`thirdparty/opentui` source或旧`.3` tarball；`.temp/testing/tui-perf`只承载原始e2e/性能诊断。
- **Pre-release hard gate:** source TDD、native/package build、本地11-tarball-plus-checksum verifier、真实240-flush loop和实际source diff/E/C证据完成后，将canonical状态设为policy允许的`implementation-audit-required`，并在Implementation Audit Record中明确audit object仅为nested OpenTUI source diff/local package artifacts。只有exact source diff返回`No blocking findings`和`APPROVE`，才允许创建nested source commit、normal push到`smark/main`、annotated `v0.4.3-smark.5` tag并触发现有GitHub workflow发布同一source commit的12个assets。不得以plan approval或builder自测代替该门禁。
- 发布完成后，按既有contract更新root catalog、11项override、source/revision metadata和gitlink到`.5` source commit；随后由`bun install`生成`bun.lock`，禁止手工伪造integrity。运行closure、parent runtime test和typecheck，确认root、`packages/opencode`、plugin和Solid解析到同一`.5` family。
- release workflow要求tag、source commit和assets全部来自同一nested source commit；任何source implementation audit blocker都必须在远程动作前返工并重审。没有`.5` remote release时只能记录local preflight，不能声称OpenCode runtime deployment完成。
- 发布后的最后一条用户路径必须是：`published immutable assets -> root lock/override -> installed @opentui packages -> OpenCode TextPart/ReasoningBody consumer -> CodeRenderable primary path`；source import/native dylib link只作为禁止项。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| non-streaming/full parse and non-Markdown streaming full parse | primary-contract branch | preserve |
| existing parser-error -> plain text warning | existing compatibility | preserve without expansion |
| Markdown versioned buffer + stable output boundary | primary-contract branch | implement as the only streaming Markdown syntax path |
| append-only Markdown active-job coalescing + buffer-version complete SimpleHighlight + provisional eligible StyledText | same streaming Markdown primary contract; latest content visible and tail is processed by the full incremental parser tree | implement at CodeRenderable/TreeSitterClient owner |
| bounded native iterator | same primary optimization | implement |
| isolated one-shot worker termination + unaffected-request replay | existing semantic-invalidation and teardown safety contract | preserve R18 behavior; do not trigger it for normal append-only Markdown and do not add watchdog/progress |
| lockstep `.5` 11-tarball-plus-checksum release family + root catalog/override/lock | primary deployment contract | prepare locally, pass independent source implementation audit, then publish and update parent |
| installed OpenCode consumer graph | primary deployment verification | run isolated local artifact smoke and post-release resolver/e2e checks |
| existing MarkdownRenderable stable blocks | existing compatibility/other owner | preserve, do not duplicate |
| naive buffer-mode update outside the Code-facing handle | forbidden alternate success path | reject |
| drawUnstyled error escape, source import/native dylib fallback, old release reuse | forbidden fallback | reject |

No new alternate success path is approved.

## 12. Workaround Deletion and Replacement

| Existing workaround/duplicate | Replacement |
| --- | --- |
| `_lastHighlights` only written/reset, never read | remove; versioned buffer result is the single Markdown highlight source |
| unbounded one-shot launches with generation-only stale discard | active gate + one Code-owned Markdown buffer + unified snapshot invalidation |
| aborting every normal append-only Markdown delta | retain the active buffer parser, coalesce latest dirty content, and apply versioned edits; semantic invalidation resets/disposes the buffer and preserves one-shot termination for other domains |
| full `walkLines` per styled chunk | bounded iterator at native owner |
| immutable `.4` retains an open-fence stale-frame regression | independently audited `.5` lockstep family + root lock/provenance update; never overwrite `.3` or `.4` |
| temp absolute imports/dylib/prototype | diagnostic evidence only; do not ship |

## 13. Forward Traceability

| Requirement/invariant | Production path | Planned files | Behavioral test |
| --- | --- | --- | --- |
| no normal-stream starvation, visible latest content and full-context Markdown processing (`INV-01`,`INV-02`,`INV-04`) | active gate/latest dirty snapshot + one versioned Markdown buffer + complete SimpleHighlight result + existing semantic invalidation termination | `Code.ts`, `client.ts`, `parser.worker.ts`, `types.ts` | visible initial/active append, empty completion, full-context tail differential, semantic invalidation and 240-flush e2e |
| all public state changes invalidate old async semantics (`INV-06`) | unified setter invalidation + immutable snapshot + pre-callback/pre-commit checks | `Code.ts` | mutate filetype/style/conceal/draw/streaming/client/base/callback while delayed |
| table/fence/long code correctness (`INV-03`,`INV-04`) | incrementally edited full parser tree + complete current-version SimpleHighlight result | `Code.ts`, `client.ts`, `parser.worker.ts`, `types.ts` | actual Markdown differential |
| formula pass-through (`INV-07`) | ordinary tail, no math query | `Code.ts` integration; no parser assets | literal formula stream |
| native range equivalence (`INV-05`) | bounded iterator | two Zig files | LineInfo equivalence/native regression |
| existing consumers/callbacks (`INV-09`) | only streaming Markdown branch changes | `Code.ts` | Code/Markdown suites and full JS |
| source/release identity (`INV-08`) | source implementation audit -> clean nested commit -> `.5` release tag/assets -> source manifest | nested package manifests, `opentui-source-revision.json`, provenance scripts | pre-release audit record, release workflow and remote tag check |
| installed OpenCode closure (`INV-10`) | 11 overrides/lock -> real resolver -> TUI consumer | root `package.json`, `bun.lock`, closure/provenance scripts, `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | local packed install + post-release closure/e2e |
| request termination (`INV-11`) | semantic invalidation/destroy -> AbortSignal -> isolated one-shot callback cleanup -> `PlatformWorkerHandle.terminate()` -> fresh channel -> unaffected request replay | `Code.ts`, existing `tree-sitter/client.ts` | semantic setter termination, concurrent replay and shared-buffer compatibility |

## 14. Reverse Traceability

| Proposed concept | Requirement | Evidence | Why reuse insufficient |
| --- | --- | --- | --- |
| active latest gate + serialized provisional current snapshot + complete-current-document Markdown parse + existing semantic termination | `INV-01`,`INV-02`,`INV-04`,`INV-11` | R18 public loop starvation, R27/R29 final-audit stale/blank frame, R34 full-context tail finding and existing isolated channel tests | initial/normal/open-fence append must not restart the worker or hide current text; each merged snapshot must parse with complete context; semantic changes still need the existing physical termination boundary |
| append-only Markdown coalescing and stale cache seed | `INV-01`,`INV-03`,`INV-04` | R18 240-flush starvation (2 commits/4.8s) versus no-abort control (229 commits/p95 23ms) | aborting each normal delta physically restarts the worker; retaining only a semantically compatible raw cache seed avoids visible stale commits while allowing the latest snapshot to reuse settled prefix work |
| unified public-setter invalidation + immutable snapshot | `INV-06` | auditor B-01; Code setters170-271 and real reactive props | content-only generation cannot prevent old filetype/style/callback semantics |
| stable boundary logic inside Code | `INV-03`,`INV-04`,`INV-07` | differential/adversarial/fuzz/cache results and formula probe | Code currently full parses; MarkdownRenderable state is not reachable/shared, and a separate helper would exceed the approved file boundary |
| prefix cache | `INV-03` | 46.70x and 0 mismatch | downstream cannot safely merge raw highlights |
| newline clipping | `INV-03`,`INV-04` | `# He`/fence temp correctness failures | parser padding otherwise becomes user ranges |
| bounded iterator | `INV-05` | 512ms vs30.8ms, 17/17 equivalent | JS cannot access rope markers |
| remove dead `_lastHighlights` | `INV-09` | current source has no reads | otherwise two ambiguous raw highlight caches |
| no math query | `INV-07` | assets/probe | no current math contract; new renderer would be unsupported semantics |
| independently audited lockstep `.5` family and installed consumer verification | `INV-08`,`INV-10` | immutable `.4` regression baseline, user `.5` authorization, release workflow and closure verifier | nested source tests cannot change the package actually resolved by OpenCode; `.3`/`.4` cannot be overwritten |

## 15. File-Level Change Plan

| File | Action | Responsibility | Expected delta |
| --- | --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | modify | unified setter invalidation, immutable snapshot, active gate, abortable one-shot, stable Markdown boundary/cache, serialized current-snapshot provisional StyledText, bounded open-fence full-parse batching, dead cache removal | `+310 to +510 / -35 to -100` |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | mark ReasoningBody's synchronous identity `onChunks` callback as eligible for eager streaming presentation | `+1 to +3` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | modify | isolated reusable one-shot worker channel, AbortSignal termination, callback/handler cleanup, parser registration replay, unaffected-request replay, shared-buffer preservation and one Code-owned incremental highlight-buffer seam | `+220 to +390 / -20 to -60` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | modify | versioned buffer completion always returns success, including empty highlights, and exposes complete current-document SimpleHighlight results with existing metadata/injections | `+45 to +100 / -20 to -60` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | modify | define versioned buffer completion payload and complete SimpleHighlight response contract without weakening existing shared-buffer consumers | `+12 to +35 / -2 to -8` |
| `thirdparty/opentui/packages/core/src/zig/text-buffer-iterators.zig` | existing published baseline | bounded LineInfo iterator is already present in immutable `.4`; R39 adds no native diff | no new diff |
| `thirdparty/opentui/packages/core/src/zig/text-buffer.zig` | existing published baseline | existing owner already calls the bounded iterator in immutable `.4`; R39 adds no native diff | no new diff |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | modify | streaming convergence, public state mutation, table/fence/long code/formula | `+140 to +300` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | modify | actual one-shot worker abort/replacement, termination ordering, parser replay and buffer compatibility | `+100 to +220` |
| `thirdparty/opentui/packages/core/src/zig/tests/text-buffer-iterators_test.zig` | modify | bounded-vs-full LineInfo, CJK/tab/empty/range edges | `+100 to +220` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client-worker.fixture.ts` | add | deterministic worker fixture with a never-settling one-shot and boot identity for replacement proof | `+60 to +110` |
| `thirdparty/opentui/packages/core/src/testing/mock-tree-sitter-client.ts` | modify | align the existing test double with the approved AbortSignal cancellation contract so aborted requests leave no stale pending entries | `+20 to +45` |
| `thirdparty/opentui/packages/core/src/renderables/__tests__/renderable-test-utils.ts` | modify | settle successive latest highlight jobs created by the approved abort/line-info continuation before Diff public assertions | `+15 to +35` |
| `packages/opencode/script/opentui-provenance.ts` | modify | bind source manifest/release tag contract to `.5` | `+2 to +8 / -1 to -3` |
| `packages/opencode/script/verify-opentui-closure.ts` | modify | verify installed `.5` family and release/source identity from real resolver paths | `+2 to +12 / -2 to -8` |
| `packages/opencode/test/script/opentui-provenance.test.ts` | modify | keep the existing provenance seam's release-tag fixture aligned with the exact `.5` manifest contract | `+1 to +4` |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | modify | actual OpenCode package-boundary consumer using the public Code streaming contract, table/fence/formula/callback convergence | `+100 to +180` |
| `thirdparty/opentui/packages/*/package.json` | release metadata | lockstep all `@opentui/*` workspace versions at `.5`; generated dist/native manifests are not committed | metadata only |
| root `package.json`, `bun.lock`, `packages/opencode/script/opentui-source-revision.json`, parent gitlink | release metadata | point catalog/11 overrides/lock/provenance to the same independently audited and published `.5` source commit; lock is generated, not hand-edited | metadata/generated |

Production source files: 7 (`Code.ts`, the ReasoningBody identity-callback marker, `TreeSitterClient`, two Zig files, and two parent provenance scripts); test files/scripts: 8 including the existing worker fixture, mock test seam, latest-job settle helper and provenance fixture. This remains within the user limit of 8 code files and 10 test files/scripts. R33 adds no worker message type, parser-worker progress, timer, watchdog, alternate parser or scheduler; the eager eligibility marker is a narrow public contract for a known identity callback inside the existing Code scheduling owner. Existing concurrent `highlightOnce` calls remain one public contract through R18 transparent replay. No OpenCode TUI route structure change is planned; parent changes only close the `.5` package/runtime boundary.

## 16. TDD Behavior Slices

| Order | Red behavior | Current failure | Minimal green | Regression |
| --- | --- | --- | --- | --- |
| 1 | Delayed serialized parser receives initial and rapid normal append-only Markdown snapshots; each newest content is visible before its full highlighter settles and final output converges after the active request completes. | R18 aborts every16ms append; R27 avoids abort but leaves active append/initial frame stale under `drawUnstyledText=false` | retain one active request + one latest dirty snapshot + serialized current-snapshot provisional StyledText | no normal-stream starvation/blank or stale output |
| 2 | While a job is active, mutate public `filetype`, `syntaxStyle`, `conceal`, `drawUnstyledText`, `streaming`, `streamingChunksAreIdentity`, `treeSitterClient`, `baseHighlight`, `onHighlight`, `onChunks`; final frame/callback output must reflect only new state, including identity eligibility true↔false. | current setters do not increment generation; old task can commit mixed state | one invalidation helper, snapshot capture, checks before each callback/commit | `INV-06`, ReasoningBody rendered-text feedback |
| 3 | Stable boundary differential: every claimed prefix equals future full parse; incomplete table/fence/frontmatter claims no unsafe cut. | no current helper; naive blank-line split is unsound | evidence-backed boundary/padding/cache | table/fence/setext/reference/formula |
| 4 | Actual Code stream table/long-fence and all five formula-like forms (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`, `\begin...\end...`) equal independent full parse at settled deltas. | full parse is correct but repeats expensive work | merge cached segments + full tail, preserve callbacks | no corruption/truncation/loss |
| 5 | Bounded native range output equals filtered full walk for empty/boundary/CJK/tab/trailing lines. | function absent | binary locate + bounded walk | native LineInfo contract |
| 6 | Native styled text preserves byte/plain output and improves measured chunk×line budget. | current full walk repeats every line | call bounded iterator only at existing owner | native highlights/drawing |
| 7 | Semantic setter or destroy during an active request terminates its isolated worker channel; late responses cannot invoke callbacks or overwrite current output, unrelated concurrent requests still resolve, and shared buffer requests remain usable. | normal append and semantic invalidation currently share the same abort entry | append bypasses abort only for strict streaming-Markdown prefix growth; all semantic invalidations preserve R18 termination/replay | Code, actual worker fixture, concurrent client and TreeSitter buffer regression |
| 8 | Packed 11-tarball-plus-checksum family installs through loopback and its manifest/native/repository closure is internally consistent. | release assets are not produced by source tests | build/pack/checksum + existing release verifier | package metadata/native regression |
| 9 | Isolated OpenCode workspace resolves the packed `.5` family, not source/old `.4`, and the actual `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` consumer converges. | current parent WIP resolves `.4` | local override install + real package-boundary test/e2e harness | post-release root lock/closure/e2e |
| 10 | Original real loop + targeted/full regressions converge with no visible shrink. | stock backlog and known concurrent baseline noise | approved implementation and explicit baseline accounting | user scenario/non-Markdown consumers |
| 11 | A cancelled Code highlight leaves the existing mock client with no pending logical request, so Diff/ScrollBox render tests settle like the real worker path. | `CodeRenderable` now passes `AbortSignal`, while `MockTreeSitterClient` retains aborted promises in its pending queue. | signal-aware mock cancellation with independent `AbortError` rejection and queue cleanup | Diff/ScrollBox focused regressions and full core JS suite |
| 12 | Diff/ScrollBox helper settles a latest job created after the previous job's completion continuation, rather than awaiting a promise that no later resolver can settle. | existing helper resolves pending mocks before the approved latest-job continuation schedules the next request | render, drain, await current public `highlightingDone`, then repeat while new pending work exists | Diff/ScrollBox regressions and full core JS suite |
| 13 | The existing provenance fixture remains type-safe and continues to reject a source revision mismatch after the release family moves to `.5`. | the exact `releaseTag` contract moves from immutable `.4` to `.5` | update only the fixture's contracted release identity; keep the public rejection seam unchanged | provenance tests and package-local typecheck |
| 14 | A realistic16ms append-only Markdown stream continues producing visible commits instead of waiting for stream end; semantic invalidation still terminates active work. | R18 produces2 commits/4834ms gap; no-abort control produces229 commits/23ms p95 and no shrink | retain active append request, coalesce latest dirty content, seed only compatible raw prefix cache; preserve immediate abort for semantic invalidation without watchdog/progress | real240-flush e2e, delayed Code behavior, semantic invalidation and full JS regressions |
| 15 | Eligible direct Code snapshots (no callback or explicit synchronous identity callback) immediately display latest initial/active/open-fence content; each merged snapshot's syntax result comes from the complete current document; arbitrary transforming callbacks never expose pre-transform text. | R27 deferred old frame; R29 active stale/blank; R34 standalone tail and R35 default-only defer violate full processing | eager base only for no-callback or opt-in identity callback; callback-transforming path retains existing callback-first commit; remove threshold-only parse suppression; full-current-document differential remains correction oracle | public eligible initial/active/open-fence behavior, identity callback side effect, transforming callback no-pretransform-frame, full-context table/reference/fence differential and no-shrink e2e |

Tests observe public output, callbacks, settled highlights or native LineInfo. They must not assert private helper names, source text, exact call counts or cache layout.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | `620-960` | R27 baseline plus provisional StyledText/onChunks scheduling, bounded full-parse batching, substantive tests/configuration and `.5` release/provenance scripts; no lifecycle-progress implementation |
| Required Chinese explanatory comments `C` | `93-144` | plan estimate only; implementation must recompute `ceil(E*0.15)` across all substantive changed files |

Qualifying comments explain only real constraints: trailing split artifact, fence marker length, frontmatter invalidation, append-only cache, synthetic newline clipping, immutable public snapshot, formula pass-through, native newline offsets, and stale completion. No assignment/control-flow restatements.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test src/renderables/Code.test.ts --test-name-pattern 'streaming|markdown|fence|formula'` | `thirdparty/opentui/packages/core` | Code streaming/state/callback regression |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | isolated one-shot worker termination/replacement, parser replay and late-response regression |
| `bun run test:native -Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"` | `thirdparty/opentui/packages/core` | bounded native seam; the planned exact test name must match, and zero matched tests is failure |
| `bun run test:native` | `thirdparty/opentui/packages/core` | full native regression |
| `bun test src/renderables/__tests__/Markdown.test.ts src/renderables/__tests__/markdown-parser.test.ts` | `thirdparty/opentui/packages/core` | existing Markdown owner regression |
| `bun test ./src/renderables/Diff.regression.test.ts --test-name-pattern 'no endless loop|line number alignment'` and the setter-based ScrollBox test | `thirdparty/opentui/packages/core` | red-capable cancellation-seam regressions exposed by the full JavaScript suite |
| `bun test` | `thirdparty/opentui/packages/core` | full JS regression; isolate/report concurrent TreeSitter baseline noise |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | exact OpenTUI TypeScript/library build; core has no typecheck script |
| `bun run build` | `thirdparty/opentui` | native + library build after Zig change |
| `bun run prepare-release 0.4.3-smark.5 --no-install` | `thirdparty/opentui` | lockstep package manifest version red/green; no release metadata drift |
| `bun run --cwd packages/core build:native --all`、`bun run --cwd packages/core build:lib`、`bun run --cwd packages/solid build`、`bun run --cwd packages/keymap build` | `thirdparty/opentui` | exact 11-tarball-plus-checksum release producer from `build-native.yml` |
| `mkdir -p artifacts/npm-packages; npm pack --pack-destination artifacts/npm-packages ./packages/core/dist; npm pack --pack-destination artifacts/npm-packages ./packages/solid/dist; npm pack --pack-destination artifacts/npm-packages ./packages/keymap/dist; for package in packages/core/node_modules/@opentui/core-*; do npm pack --pack-destination artifacts/npm-packages "$package"; done; (cd artifacts/npm-packages && shasum -a 256 *.tgz > SHA256SUMS)` | `thirdparty/opentui` | exactly 11 npm tarballs plus the required checksum manifest; existing release workflow publishes 12 GitHub assets |
| `bun scripts/verify-release-packages.ts --directory <artifacts> --version 0.4.3-smark.5` | `thirdparty/opentui` | loopback installed package/native/repository and user-visible frame behavior |
| independent source implementation audit of exact source diff/local artifacts | repository root, before any new nested commit/push/tag | mandatory `No blocking findings` + `APPROVE` remote-action gate |
| direct root catalog/11-override update, then `bun install` | repository root, after `.5` assets are published | one-time `.5` dependency metadata update; legacy upgrader remains unchanged |
| `bun install` | repository root, after the `.5` assets are published and root metadata is updated | generate the immutable `.5` lock entries; do not hand-edit integrity |
| `bun install --frozen-lockfile` | repository root, clean repeat after lock generation | actual immutable URL/integrity installation |
| `bun script/verify-opentui-closure.ts` | `packages/opencode` | installed `.5` package family, realpath identity, source/release tag and native hash |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | `packages/opencode` | actual package-boundary streaming table/fence/all-formula/callback convergence |
| `bun typecheck` | `packages/opencode` | parent TypeScript check after release/provenance metadata changes |
| `bun .temp/testing/tui-perf/incremental-correctness.ts` | repository root | original structure loop |
| `bun .temp/testing/tui-perf/e2e-stream.ts --mode=baseline --flushes=240` | repository root | original user-visible latency loop and post-fix comparison |
| `bun .temp/testing/tui-perf/highlight-scaling.ts` | repository root | full-delta cost curve |
| `bun .temp/testing/tui-perf/pipeline-breakdown.ts` | repository root | stage attribution |
| `bun script/verify-opentui-closure.ts --source-revision-authorized` | `packages/opencode`, post-release only | source/release closure when the new source pin is authorized; remote `.5` tag must already exist |
| `git ls-remote --tags https://github.com/SMARK2022/opentui refs/tags/v0.4.3-smark.5 refs/tags/v0.4.3-smark.5^{}` | repository root | external release tag exists and peels to the independently audited nested source commit |
| `git -C thirdparty/opentui status --porcelain=v1; git ls-files --stage -- thirdparty/opentui` | repository root | clean nested source and parent gitlink |
| `git diff --check` / `git diff --stat` | root and nested repo | whitespace, scope and budget |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2 | OpenCode installed-consumer test and deterministic one-shot worker fixture |
| Files modified | 7 production source + up to8 tests/scripts + release metadata | Code/ReasoningBody/TreeSitter/native owner files, parent provenance scripts, manifests and generated lock |
| Files deleted | 0 | obsolete logic collapses inside Code; temp evidence is not committed |
| Production lines | `620-960` | includes public-state snapshot repair, append-only coalescing/cache seed, provisional tail StyledText, bounded open-fence full parse, existing isolated worker termination/replay, stable cache, bounded native walk and parent provenance behavior; below1200 |
| Test lines | `700-1300` | owner-local/parent test files plus the real package-boundary consumer; fewer than ten test files/scripts |
| Generated lines | 0 | no parser/query/generated asset change |

Any implementation exceeding 8 production code files or 1200 effective production lines requires a new revision and full-scope audit.

## 20. Real Risks and Open Decisions

### Observed or Reachable Risks

- bounded binary search must preserve current rope line offset semantics; test empty lines, CJK, tabs, trailing newline and range endpoints.
- fragment isolation is only claimed for current evidence-backed Markdown boundaries; future math/query/block grammar requires a new plan.
- full `setStyledText` remains a complete visible-buffer rebuild; this plan removes parser and full line-walk amplification but does not invent an append protocol.
- `.4` is already published and cannot be replaced; until independently audited `.5` assets exist and the parent lock installs their immutable URLs, the current runtime retains the known stale-frame behavior.
- `.5` release tag, independently audited nested source commit, parent gitlink, 11 asset names, package versions and lock integrities must be one identity; a partial metadata update creates a mixed package graph.
- one-shot channel termination必须等待 `PlatformWorkerHandle.terminate()` 完成后才清除 replacement barrier；若termination失败，必须显式传播worker error并禁止回退到共享buffer worker，不能以“callback已删除”声称旧work已释放。
- custom parser registration、data-path变化和clear-cache必须同步/重放到仍存活的one-shot channel；替换channel不能丢失现有buffer或custom parser语义。
- channel重启时只replay仍pending且未aborted的逻辑请求；每个逻辑请求只能有一个当前callback owner，不能因旧worker response或重复replay产生双重resolve。
- termination failure必须让当前Code snapshot进入明确diagnostic/unavailable状态并保留dirty语义，不能显示旧snapshot为成功结果，也不能静默丢弃后续并发请求。
- full JS baseline once showed `4978/23/1/1`, isolated TreeSitter client `48/48`; final verification must report rather than hide this concurrency/environment distinction.
- R18的真实240-flush loop证明“每个append都物理终止worker”会造成可达starvation；R25只放宽严格append-only Markdown的active cancellation，不放宽semantic invalidation/destroy termination。按用户明确选择，append-only永久不返回且没有semantic transition不属于本轮自动恢复保证。
- synthetic handle ceiling near1638 modeled turns remains a separate resource-lifecycle risk.

### Open Decisions Requiring the User

No open product decision remains. The user explicitly selected the minimal normal-stream boundary and authorized a corrective staged `.5` release. `.5` remote actions remain sequenced after a clean independent source implementation audit; no force push is allowed. If a release workflow or remote asset fails, do not substitute a source fallback or old `.4`/`.3` package.

### Rejected Speculation

- renderer traversal is not the main hotspot: 10k renderables averaged2.6146ms versus highlighter/native hundreds of ms.
- delta-only parsing is rejected by structure differential.
- new math renderer/query is rejected by current parser evidence.
- global handle-width redesign is separate and lacks a real Session trace.
- blanket route switch to MarkdownRenderable is rejected because ReasoningBody owns Code `onChunks` layout feedback.
- source import/native dylib fallback is rejected by README/provenance.

## 21. Audit Contract

The independent auditor must read this exact R39 file and the complete original user requirement, including the later verbatim runtime-closure, staged-release, additional-audit, minimal-normal-stream and `.5` authorization, reconstruct the complete release -> OpenCode resolver -> producer -> Code -> worker -> styled-text -> native path, and audit:

- default OpenCode `TextPart` / `ReasoningBody` and reachable experimental session-v2 streaming consumers;
- every public CodeRenderable input listed in `INV-06`, including transition, cache invalidation and stale checks;
- Markdown table/partial row/open and closed long fence/setext/reference/emphasis/CJK/tab/empty-line behavior, with every syntax request receiving the complete current document rather than a standalone suffix;
- all formula forms as current pass-through semantics without invented math renderer;
- non-Markdown/non-streaming/callback/error compatibility;
- the lockstep 11-tarball-plus-checksum release producer (12 GitHub assets total), root catalog/override/lock, source/release manifest, actual resolver realpaths and post-release OpenCode consumer/e2e evidence;
- the user-selected exclusion of append-only permanent-hang auto-recovery, plus visible current-content commits for the actual callback-free/identity OpenCode streams, the exact Code-facing buffer request/version/reset/dispose contract and complete-context incremental Markdown processing on every merged buffer version including empty highlights, preserved callback-first semantics for arbitrary transformations, no provisional `onHighlight`, AbortSignal-triggered semantic-invalidation/destroy termination, unaffected concurrent request replay, handler/callback cleanup, termination-failure diagnostic state and job-identity `finally` behavior;
- the `MockTreeSitterClient` test seam's AbortSignal behavior, including pending-request removal and independent AbortError rejection, so focused Diff/ScrollBox regressions model the same public cancellation contract;
- `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` as a real package-boundary consumer, not a nested OpenTUI-only fixture;
- native iterator equivalence, source/release provenance, fallback inventory, TDD seams, file/line budget and Chinese comment gate.

The auditor must require evidence for every blocker, reject speculative defenses, and check both under-design and over-design. No implementation is authorized from a clean chat summary alone.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: public async render state setters were not included in snapshot/cache invalidation | typecheck command specificity; implementation E/C recalculation | BLOCK | `ses_060996ddcffe70nW8Sea4dGr9u` |
| 2 | R2 | yes | B-01: nested source repair was not connected to OpenCode's immutable installed package family | E/C scope includes tests/configuration; native filter name; formula form coverage | BLOCK | `ses_0608874a4ffek394tWn5WTYwMJ` |
| 3 | R3 | yes | B-01: production/release scope was recorded as authorized without an auditable verbatim user authorization record | none beyond authorization evidence; implementation E/C remains future work | BLOCK | `ses_0600c216effeOHzcXXvflbgLFL` |
| 4 | R4 | yes | B-01: auditor handoff did not include the actual later user authorization; plan-internal quotation was insufficient | native filter/test-name and phase-boundary records | BLOCK | `ses_060066ff7ffeHVU1yYEEGSyObR` |
| 5 | R5 | yes | none | N-01 staged release phase boundary; N-02 native filter future test name; N-03 runtime consumer file is planned; N-04 stable-prefix context proof; N-05 implementation E/C recalculation | APPROVE | `ses_06001120affeLzdX2h6nf41gTk` |
| 6 | R6 | yes | B-01: one detached slot cannot guarantee convergence for a second consecutive hung request | N-01 trigger condition; N-02 native filter; N-03 runtime test; N-04 visible output proof | BLOCK | `ses_05fe88ab6ffeAFyPnN8ybT8sdA` |
| 7 | R7 | yes | B-01: callback/response suppression cannot physically terminate hung worker work or prove no detached worker backlog | N-01 E/C estimate scope; N-02 native filter name; N-03 full JS baseline | BLOCK | `ses_05fd4a39bffeoQpreAypgYeHBP` |
| 8 | R8 | yes | none | N-01 termination-failure visible convergence; N-02 Markdown boundary proof; N-03 native filter exact name; N-04 full JS release gate; N-05 implementation E/C recalculation | APPROVE | `ses_05fc35a91ffeZAcydQ9YNicjBz` |
| 9 | R9 | yes | B-01: user authorization says 11 GitHub assets while the existing workflow necessarily publishes 11 tarballs plus SHA256SUMS, i.e. 12 assets | N-01 release-stop rule for full JS baseline; N-02 native filter name; N-03 final public Markdown output; N-04 historical R8 approval wording | BLOCK | `ses_05fb4b605ffep41XxmuUgzaQlA` |
| 10 | R10 | yes | none | N-01 termination-failure visible state; N-02 Markdown public-output proof; N-03 native filter exact name; N-04 JS release-stop format; N-05 implementation E/C; N-06 staged release ordering | APPROVE | `ses_05fa81762ffep1f8ZHioFOHLAA` |
| 11 | R11 | yes | B-01: stable-prefix cache can freeze reference-dependent Markdown semantics | N-01 termination diagnostic contract; N-02 JS release-stop rule; N-03 native filter; N-04 historical approval wording | BLOCK | `ses_05f66074fffePXWZnu7pHvwzVF` |
| 12 | R12 | yes | B-01: canonical plan baseline drift; B-02: termination diagnostic/unavailable contract lacks public owner/seam | reference execution precision; native filter; JS release-stop; E/C | BLOCK | `ses_05f5f2802ffeBRx5cG0u9B35jP` |
| 13 | R13 | yes | B-01: termination failure still emits success-shaped plain-text fallback | event payload/consumer timing; reference execution; native filter; JS release-stop | BLOCK | `ses_05f5821dfffefwf0Hw2wqtCFXg` |
| 14 | R14 | yes | none | N-01 diagnostic marker isolation; N-02 reference boundary precision; N-03 native filter; N-04 JS release-stop evidence; N-05 E/C | APPROVE | `ses_05f5208baffeTYn3HkBEr8MQz7` |
| 15 | R15 | yes | B-01: canonical revision metadata drift; B-02: local AbortError race hides termination failure | helper microtask boundary; generic parser-error separation; native filter; JS release-stop; E/C | BLOCK | `ses_05f3ed775ffeHk3MT4ebtTUDmD` |
| 16 | R16 | yes | none | N-01 Section 21 revision text; N-02 reference boundary placement; N-03 native filter; N-04 real termination propagation; N-05 E/C | APPROVE | `ses_05f37d3dcffeTxfya6cgcW4tWv` |
| 17 | R17 | yes | B-01: current revision metadata still mixed R16/R17; B-02: later runtime/release authorization was absent from the audit handoff | absent runtime harness should not remain required; historical R16 approval must be clearly historical | BLOCK | `ses_05d58f9ffffefJuolYhbUnJXgK` |
| 18 | R18 | yes | none | N-01 README release wording; N-02 exact native filter match; N-03 real termination-failure propagation; N-04 pre-R18 WIP isolation; N-05 implementation E/C | APPROVE | `ses_05d5100c3ffe34gD2hj7AO7ViM` |
| 19 | R19 | yes | B-01: plan-audit round limit; B-02: append-only hung request has no supersession transition | exact R19 audit contract; remove absent runtime harness; visible starvation threshold | BLOCK | `ses_05d33ade2ffe7v1WOdLiS0lCqV` |
| 20 | R20 | yes | B-01: adaptive watchdog cannot distinguish legal long parse from hung request | long-parse acceptance, progress observation and watchdog lifecycle must be executable; implementation E/C remains future evidence | BLOCK | `ses_05d0cff9efferUuKd2xN3jfjsT` |
| 21 | R21 | yes | B-01: worker contract has no observable progress for legal long tail | progress marker is not implementable at Code-only owner; implementation E/C remains future evidence | BLOCK | `ses_05d039e4cffe6dM9aR7p1G6w5l` |
| 22 | R22 | yes | B-01: progress misses loading/query/injection lifecycle; B-02: types/worker files absent from exact file plan | full lifecycle stages, file mapping and traceability must be explicit | BLOCK | `ses_05cfa72abffeBokqQNEhIERnuY` |
| 23 | R23 | yes | B-01: current primary-path label and production file count drifted to R19/6 while scope was R23/8 | behavior path otherwise clean; implementation E/C remains future evidence | BLOCK | `ses_05cf2e780ffeJR7ALQehFjdbKE` |
| 24 | R24 | yes | B-01: watchdog misclassifies legal loading/querying; B-02: missing pre-release source implementation audit; B-03: release/runtime baseline stale versus published `.3` | README and budget wording; implementation E/C remains future evidence | BLOCK | `ses_05cec324dffey6sp6DXsu6ijD7` |
| 25 | R25 | yes | B-01: pre-release source audit used an undefined canonical status; B-02: long open-fence tail still reparses unbounded history on each append | synthetic append-only permanent hang remains explicitly excluded; `.4` baseline and fallback inventory otherwise covered | BLOCK | `ses_05cd42fd5ffewgoFxvP3OqVzZH` |
| 26 | R26 | yes | B-01: deferred long-fence state was not connected to dirty-job continuation; B-02: boundary detection still scanned full history; B-03: closing-marker contract was incomplete | implementation E/C and exact threshold behavior remain future evidence | BLOCK | `ses_05cca3597ffev8pAWgqh80g3zx` |
| 27 | R27 | yes | none | N-01 stale raw-cache seed timing; N-02 deferred visibility/drawUnstyled behavior; N-03 native filter match; N-04 full JS baseline; N-05 Bun/release tool consistency; N-06 historical revision volume | APPROVE | `ses_05cc38b29ffe6tVCzMSg1bYmrG` |
| 28 | R28 | yes | B-01: non-historical deployment/verification contracts still mixed immutable `.4` with newly authorized `.5` | historical `.4` records may remain when labeled | BLOCK | `ses_05b1ccfcbffeD3y4DSJz9lqjTL` |
| 29 | R29 | yes | B-01: visible provisional contract covered only deferred fence append, not initial/ordinary active append; B-02: current revision labels still named R28 | legacy upgrader remains intentionally unused | BLOCK | `ses_05b17f333ffezcETZF3EQZZ3ko` |
| 30 | R30 | yes | B-01: queued provisional async `onChunks` could start after snapshot invalidation | v2 consumer inventory; runtime test action metadata | BLOCK | `ses_05b11ece1ffeZXdyGCi1pwP6r0` |
| 31 | R31 | yes | B-01: waiting for an already-started async `onChunks` blocked newer current provisional frames | `.5` parent fixture remains future implementation work | BLOCK | `ses_05b0c8243ffeWdEFsKLnxV7cCf` |
| 32 | R32 | yes | B-01: base provisional frame exposed pre-`onChunks` transformed text | none | BLOCK | `ses_05b04c596ffeVjVvInC0f7LRfi` |
| 33 | R33 | yes | B-01: public identity marker was outside snapshot/invalidation semantics | current verdict text drift | BLOCK | `ses_05aff0b22ffe0MSZTPT5vsjeyy` |
| 34 | R34 | yes | B-01: stable-prefix tail parser remained a standalone suffix; B-02: transforming callback path hid current delta before callback completion | N-01 identity marker invariant row; N-02 production-file count; N-03 pack command; N-04 historical records | BLOCK | `ses_05af29f07ffexs8FvIM71B6t2u` |
| 35 | R35 | yes | B-01: open-fence threshold still allowed default-styled unprocessed tail during the gate | historical full-context correction | BLOCK | `ses_05ae6db6fffe1yuhOIi1T57yJd` |
| 36 | R36 | yes | B-01: transforming callback path still hides delta; B-02: full-document parse removes claimed parser-cache performance benefit without an executable incremental owner | native/test baseline drift | BLOCK | `ses_05ae23594ffebUFkWfJ1sy7LKy` |
| 37 | R37 | yes | B-01: empty buffer highlights had no completion; B-02: changed-range line output lacked Code's complete SimpleHighlight/metadata contract | file plan omitted worker/types owners | BLOCK | `ses_05adc0830ffeTvvw44PuzO5377` |
| 38 | R38 | yes | B-01: Markdown one-shot and incremental buffer paths remained simultaneously authorized; B-02: actual production scope exceeded eight files; B-03: Code-facing buffer API/version/reset contract was undefined | none | BLOCK | `ses_05ad778e6ffeho7fHRdc6uW18X` |
| 39 | R39 | yes | pending independent full-scope audit | single Markdown path, exact buffer contract, and seven-file scope must be audited | audit-required | pending |

### Round 1 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 流式任务门禁没有覆盖全部影响渲染语义的公开状态变更

- Violated invariant: `INV-06` 要求既有 `CodeRenderable` public callbacks 和渲染语义保持不变；`INV-01`/`INV-02` 要求正在执行的 snapshot 不得以过期语义提交。任何会改变解析器、样式、conceal、callback 或 streaming 行为的状态变更，都必须使当前异步结果失效，或被纳入同一个明确的 snapshot。
- Evidence class: reachable
- Producer and execution path: OpenCode 的响应式 TUI props 可以在 streaming 期间更新 `content`、`filetype`、`syntaxStyle`、`conceal`、`streaming` 以及 `onChunks`；这些值进入 `CodeRenderable` 的公开 setter。若此时已有 `highlightOnce()` 在 worker 中执行，旧任务完成后会继续经过 `onHighlight`、`treeSitterToTextChunks`、`onChunks` 和 `setStyledText` 提交。
- Source evidence:
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:170-175`：`filetype` 变更只设置 `_highlightsDirty`，没有递增 `_highlightSnapshotId`。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:181-196`：`syntaxStyle`、`conceal` 变更同样没有递增 snapshot。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:221-227`：`streaming` 变更只重置 `_hadInitialContent`、`_lastHighlights` 和 dirty 状态，没有使当前异步任务失效。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:241-271`：`baseHighlight`、`onHighlight`、`onChunks` 变更也没有递增 snapshot。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:317-420`：snapshot 只在 `startHighlight()` 中生成，并且 stale 判断只比较 `_highlightSnapshotId`；旧任务在上述 setter 发生后仍可被认为是 current。
  - `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2067-2092`：`ReasoningBody` 在 streaming CodeRenderable 上动态传入 `syntaxStyle`、`conceal`、`onChunks`。
  - `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2139-2147`：默认 streaming `TextPart` 同样通过响应式 props 使用 `CodeRenderable`。
- Canonical-plan evidence: Section 7 `INV-01`/`INV-02`/`INV-06`；Section 10.1 声明“apply callbacks only to the current snapshot”并要求 active job 完成时统一处理 stale/current/error；Section 10.2 声明 filetype/streaming 切换需要清空 cache；Section 13 的 `INV-06` 映射只覆盖了 callback/generation checks preserved，没有覆盖这些公开状态的 snapshot 失效规则。
- Responsibility owner: `CodeRenderable` 的 snapshot / scheduling seam。OpenCode producer 只负责传递响应式 props，worker 只执行已经提交的 request。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 在一个 Markdown streaming job 执行期间切换 `filetype`，旧 filetype 的 highlights 可以在新 filetype 已生效后提交到当前 `TextBuffer`；切换 `syntaxStyle`、`conceal` 或 `onChunks` 时，旧 content snapshot 也可以使用新旧状态的混合语义提交。active-job gate 只限制任务数量，不能修复这种错误提交，因此会产生错误高亮、错误 conceal、错误 `onChunks` 内容反馈或布局状态倒退。
- Why this is not speculative: 这些都是当前 `CodeRenderable` 的公开 setter 和当前 OpenCode 的真实响应式调用路径。异步边界由 `highlightOnce()`、`onHighlight` 和 `onChunks` 明确存在；无需假设内部私有调用或未来输入。
- Minimal correction direction: 将所有会影响异步渲染结果的公开输入纳入统一 snapshot invalidation/cache invalidation 约束，并在 canonical plan 中明确其 producer、transition、stale 提交规则及行为测试；不能只在 `content` setter 上维持 generation 语义，也不能用 active gate 掩盖旧状态提交。

# Non-blocking findings

- 计划第 18 节的 `bun typecheck` 使用“affected package directories where a package script exists”的泛化表述，没有列出具体工作目录和脚本结果。它不构成当前行为缺陷，但实施前应明确 OpenTUI TypeScript、native build 以及 parent package 的实际验证命令。
- Section 17 的 `E/C` 只是范围估算，符合 plan mode 的要求；实施审计时仍必须重新计算实际 `E`、合格中文解释注释行数 `C` 和比例，不能直接沿用 `360-520` / `54-78`。

# Rejected speculation

- 没有把 synthetic native handle ceiling 作为本次阻塞项。计划已给出 `.temp/testing` harness 的测试边界，且当前材料没有真实 Session 达到该阈值的 producer trace。
- 没有要求新增数学/LaTeX renderer。当前 Markdown parser 的实际 query 只对普通 Markdown 节点、`spell` 或 `string.escape` 相关文本产生语义，计划保留公式 pass-through 的方向与用户要求一致。
- 没有要求把所有 OpenCode streaming 路由切换到 `MarkdownRenderable`。当前 `ReasoningBody` 依赖 `CodeRenderable.onChunks` 的可见文本反馈，路线切换会改变已存在的布局责任。
- 没有把 `sync.tsx` 的 16ms delta 合并器认定为高亮 first divergence。当前 producer 负责事件合并，异步 full highlight 和 native styled-text 重建发生在 OpenTUI `CodeRenderable` 之后。

# Primary-path and fallback verdict

计划确立了一个明确的主路径：`CodeRenderable update -> active-job gate -> Markdown stable-prefix/full-context tail 或既有 full parse -> callbacks -> StyledText -> bounded native line traversal`。没有新增 parser B-after-parser A 的 fallback、`createBuffer/updateBuffer`替代路径、`drawUnstyledText=true`错误逃生路径或 source fallback；现有 parser-error plain-text行为被识别为既有兼容路径。

但当前 revision不能批准，因为 active-job gate 与 stable-prefix cache 的 snapshot 边界没有覆盖 `filetype`、`syntaxStyle`、`conceal`、`streaming`、`baseHighlight`、`onHighlight`、`onChunks` 等真实公开输入。该问题必须在 canonical plan 中先补齐 owner、transition 和行为验证，再进行 implementation audit。

# Code quality and Chinese-comment verdict

这是 plan audit，没有 implementation diff，因此不能计算实际 `E/C`，也不能判定实现后的 repository style、类型、native 编译或中文注释硬门槛。实施阶段仍必须实际复算：`C >= max(1, ceil(E * 0.15))`。

# Release verdict

**BLOCK**

审计对象为精确的 `R1`，状态为 `audit-required`，`Approved revision: none`。在修订计划并递增 revision、补足所有异步渲染输入的 snapshot invalidation/cache invalidation 语义和行为测试之前，不能批准该计划，也不能进入实现阶段。
````

R1 approval was not granted. R2 is a substantive revision and therefore requires a new full-scope audit.

### Round 2 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 OpenTUI 源码修复不会进入 OpenCode 的实际运行时闭包

- Violated invariant: 原始需求要求检查并优化 OpenCode TUI 的实际卡顿、Markdown 流式渲染和用户可见输出。计划的实现必须能够通过 OpenCode 当前真实 producer → consumer 路径产生用户可见的修复效果，而不能只修改不参与运行时加载的源码副本。
- Evidence class: observed
- Producer and execution path: OpenCode TUI 的 `TextPart` / `ReasoningBody` 使用 `@opentui/core` 的已安装包；当前 OpenCode 解析的是根 `package.json` / `bun.lock` 中固定的 OpenTUI Release tarball，而不是 `thirdparty/opentui` submodule 源码。计划只修改 nested OpenTUI source、gitlink 和 source revision metadata，并明确不发布新的 package family、不更新 Release URL、lock 或 runtime dependency。
- Source evidence:
  - `packages/opencode/package.json:113-115`：OpenCode 依赖 `@opentui/core`、`@opentui/keymap`、`@opentui/solid` 的已安装 package。
  - `package.json:131-141`：OpenTUI 11 个 package 固定到 `v0.4.3-smark.2` 的 GitHub Release tarball。
  - `README.md:239-243`：`thirdparty/opentui` 只用于源码发现和 provenance；正常安装和编译不使用该 submodule；修改 fork 后必须先发布完整 package family，再更新 OpenCode 的 URL、lock 和 gitlink。
  - `packages/opencode/script/verify-opentui-closure.ts:72-74`：脚本明确将 thirdparty 源码排除在实际 consumer graph 之外。
  - `packages/opencode/script/verify-opentui-closure.ts:17-29,31-55`：runtime closure 验证的是 11 个 immutable release package。
- Canonical-plan evidence: Section 2 lines 38-39 明确禁止 runtime source fallback；Section 15 lines 262-269 只计划修改 nested OpenTUI source、gitlink 和 source revision metadata；Section 18 lines 313-314 只验证 source-authorized closure；Section 20 lines 336-338 已承认“installed OpenCode 仍使用旧 immutable release”。
- Responsibility owner: OpenCode 的 OpenTUI package provenance、Release package family 和 dependency closure；不是 `CodeRenderable` 本身，也不是只修改 nested source 的 gitlink metadata。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 即使 Section 10 计划的 `CodeRenderable` active-job gate、Markdown stable-prefix cache 和 native bounded iterator全部实现并通过 nested OpenTUI 测试，当前 OpenCode TUI 仍加载旧的 `v0.4.3-smark.2` tarball，因此实际用户仍会执行旧的全文 highlight、旧的异步调度和旧的 native `walkLines` 路径。Section 18 的 `.temp/testing/tui-perf/e2e-stream.ts` 若直接从源码或测试闭包运行，也不能证明 OpenCode 实际运行时已经修复。
- Why this is not speculative: 这是当前 package resolution、lockfile、provenance verifier 和 README 明确规定的已观察加载路径；计划自身也记录了该事实和未解决的 runtime release gap。
- Minimal correction direction: 先明确该计划是“仅为 OpenTUI 分支准备源码修复”而非交付 OpenCode 用户可见优化，并删除或改写原始需求的 OpenCode 修复和 release 结论；或者将 OpenTUI package family 发布、OpenCode URL/lock 更新以及通过实际 installed-package consumer graph 的端到端验证纳入同一 canonical scope。不能以 source-authorized closure 或 nested OpenTUI 源码测试替代实际 runtime integration。

# Non-blocking findings

- Section 17 的 `E` 估算明确写成“exclude tests”，但 `.opencode/policy/first-principles-engineering.md:501-515` 的 `E` 定义包含 production、test 和 configuration 的 substantive changes。Plan mode 只要求可行估算，因此这不是当前阻塞项；implementation audit 必须按政策重新计算实际 `E`、`C` 和比例。
- Section 18 的 native 验证命令使用 `-Dtest-filter="walkLinesInCharRange"`，但当前直接可见的 native 测试主要位于 `text-buffer-iterators_test.zig` 的 `walkLines` 测试以及其他 `TextBuffer` 测试中，计划没有给出新增测试的精确名称。实施前应把过滤器和新增测试名称固定下来，并验证零匹配确实失败。
- 计划将公式需求映射为一个笼统的“literal formula stream”测试。Section 6 明确列出了 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\begin...\end...` 等多种形式；实现阶段应确保行为测试覆盖这些实际形态，避免只验证一种普通字符串。

# Rejected speculation

- 没有将 synthetic native handle ceiling列为本次阻塞项。计划已有独立边界说明，且当前材料没有真实 OpenCode Session producer trace证明该阈值会在本调用路径中达到。
- 没有要求新增数学/LaTeX renderer。当前 parser/query 的实际语义是普通文本或 escape pass-through，计划保留该既有 contract符合原始要求。
- 没有要求把所有 streaming 路由切换到现有 `MarkdownRenderable`。`ReasoningBody` 真实依赖 `CodeRenderable.onChunks` 的可见文本反馈，直接切换会改变已有布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching认定为 first divergence；当前证据指向后续 `CodeRenderable` 全文异步 highlight 和 native styled-text 重建。
- 没有要求增加 parser-after-parser、`createBuffer/updateBuffer`、plain-text catch-and-success 或 source import fallback；这些均已被 Section 11 正确列为禁止的 alternate success path。

# Requirement and traceability coverage

- TUI 卡顿和阻塞诊断：有真实 `CodeRenderable` → worker → `TextBuffer` → native path、baseline e2e、highlight scaling 和 pipeline breakdown 证据；覆盖充分。
- delta/streaming 调度：`INV-01`、`INV-02`、Section 10.1 active-job gate 和 delayed parser TDD slice覆盖；方向正确。
- Markdown table、partial row、open/closed fence、长代码段：`INV-03`、`INV-04`、stable-prefix/full-context tail和 differential tests覆盖；仍需在实现阶段证明最终用户可见输出，而不仅是 raw highlight tuple。
- setext/reference/emphasis/blockquote/list：被 supported domain、adversarial evidence和 TDD slice列出；测试计划存在，但 boundary helper的实际实现仍需证明不会把跨块语义错误缓存为稳定 prefix。
- 跨行公式及公式 pass-through：有明确 no-math-query contract和`INV-07`；测试形态需要在实施时具体化。
- 异步公开状态 snapshot：R2 已补入 `filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`、`onChunks`，并建立 `INV-06`；相较 R1 已覆盖前次阻塞项。
- native bounded line traversal：有明确 owner、A/B 证据和 Zig 测试计划；边界测试必须覆盖 empty line、CJK、tab、trailing newline和 range endpoint。
- 非 Markdown、non-streaming、callback、parser-error兼容：Section 10.1、10.2、`INV-09`及回归测试映射覆盖。
- OpenTUI branch/source provenance：有 `.gitmodules`、source manifest和 closure verifier约束，但当前计划只覆盖 source provenance，不覆盖该修复进入 OpenCode 实际安装闭包的路径；因此被 B-01 阻塞。
- 文件数和生产行数：计划预计 4 个生产代码文件、3 个测试文件、400–560 行生产变更，满足用户给出的规模约束；实际 implementation audit仍需重新统计。
- TDD：各主要行为均有 red-capable slice，且测试声明观察 public output、callback、settled highlight或 native LineInfo，而不是私有 helper调用次数。

# Primary-path and fallback verdict

计划在 OpenTUI 源码内部确立了单一主路径：

```text
CodeRenderable update
  -> unified invalidation/snapshot
  -> active-job gate
  -> stable Markdown prefix + full-context tail
     或既有 full parse
  -> callback/styled-text commit
  -> bounded native traversal
```

没有发现新的 parser fallback、错误后 alternate success、source import fallback、`drawUnstyledText` 逃生路径或 `createBuffer/updateBuffer` 替代路径。现有 parser-error plain-text行为也被正确保留为既有兼容路径。

但该主路径没有连接到 OpenCode 当前实际加载的 immutable OpenTUI package family，因此不能作为原始 OpenCode TUI 优化需求的完整交付路径。

# Release verdict

**BLOCK**

R2 已修复 R1 关于公开异步状态 snapshot边界的阻塞问题，但当前 canonical plan仍未覆盖“修改后的 OpenTUI 行为进入 OpenCode 实际运行时”的必要 producer-to-consumer/package closure。该计划在修订并明确 source-only scope，或补齐经过授权的 package family release、OpenCode dependency closure更新及 installed-runtime端到端验证前，不得批准。
````

R2 approval was not granted. R3 is a substantive revision and therefore requires a new full-scope audit.

### Round 3 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 未获用户授权却把生产修改、发布和依赖闭包纳入实施范围

- **Violated invariant:** 计划必须遵守原始用户要求；用户明确要求原则上不能修改当前仓库内容，若确实需要修改，应在临时目录或 `.temp/testing` 中进行。未经明确授权，不得把当前仓库生产修改、远程 push、tag 或 GitHub Release 作为交付路径。
- **Evidence class:** contracted
- **Producer and execution path:** 计划拟修改 `thirdparty/opentui` 源码和 native 实现，生成 11 个 immutable package assets，发布 `v0.4.3-smark.3`，再修改父仓库的 catalog、override、lock、gitlink 和 provenance，最终让 OpenCode 的实际 resolver 使用新发布包。
- **Source evidence:** 原始需求已逐字记录于 `docs/plans/opentui-streaming-markdown-performance-repair.md:19-27`，其中包含“理论上来说你不能对当前仓库内容进行修改”以及只能在临时目录或 `.temp/testing` 中修改的约束。计划却在 `docs/plans/opentui-streaming-markdown-performance-repair.md:228-237` 规定 release、parent dependency closure 和实际运行时部署路径，并在 `:234` 规定可执行 `smark/main` normal push、annotated tag 和 GitHub Release；`:395-397` 进一步声称用户已经授权这些操作。
- **Canonical-plan evidence:** Sections `10.4`、`15`、`18`、`20`。
- **Responsibility owner:** OpenTUI source/release and parent dependency-provenance boundary.
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 按当前计划实施会直接修改用户明确要求不要修改的当前仓库，并可能执行远程 push、tag 和 release；即使所有本地测试通过，也不能作为满足原始需求的合法交付。若不执行这些动作，计划自身又明确承认 OpenCode 仍会解析旧的 `.2` runtime，因此该计划无法同时满足“不要修改当前仓库”和“让优化进入实际 OpenCode runtime”两个条件。
- **Why this is not speculative:** 这些动作不是未来可能发生的 incidental 行为，而是计划的明确生产路径：`thirdparty/opentui` 源码修改、11 个包构建、父仓库依赖更新和远程发布均列在文件级变更计划及验证命令中。
- **Minimal correction direction:** 将当前计划限制为临时目录 / `.temp/testing` 中的诊断、benchmark、prototype 和本地 artifact preflight，删除未经用户明确授权的当前仓库生产修改、dependency lock 更新、parent gitlink 更新、push、tag 和 GitHub Release 步骤；或者先取得与原始限制明确冲突的用户授权，并以新的 canonical revision 重新审计整个 release scope。不能通过“用户已经授权”的计划文字替代原始用户授权。

# Non-blocking findings

- 计划中的 `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` 当前不存在，属于计划新增文件而非缺失实现；但后续实施时必须确认该测试确实通过真实安装后的 `@opentui/*` package boundary，而不是 nested source checkout 或 workspace symlink。
- `Section 17` 的 `E/C` 数值目前只是计划估算，符合 plan audit 阶段要求；实施审计仍必须按实际 diff 重新计算 Chinese explanatory-comment ratio。
- `Section 22` 保留了 R1/R2 的历史 verdict，当前 R3 的审计结果仍为 pending；这不构成独立的行为缺陷，但任何 clean verdict 只能适用于 R3，不能沿用 R1/R2 的结果。

# Rejected speculation

- 没有将 native handle ceiling列为阻塞项。当前计划已记录没有真实 OpenCode Session producer trace证明该阈值在本调用路径中可达。
- 没有要求新增数学/LaTeX renderer。当前代码和计划证据显示公式形态属于普通 Markdown/highlight pass-through，原始需求没有要求引入新的数学语义。
- 没有要求把所有 streaming 路由切换到 `MarkdownRenderable`。`ReasoningBody` 当前确实通过 `CodeRenderable.onChunks`反馈可见文本，直接切换会改变已存在的布局责任。
- 没有把 `sync.tsx` 的 16ms producer batching认定为 first divergence；现有计划提供的 evidence 指向后续 Code、worker、`setStyledText` 和 native line traversal路径。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback 或 source import/native dylib fallback；计划已正确将这些列为禁止的 alternate success paths。

# Requirement and traceability coverage

| Requirement / invariant | Audit result |
|---|---|
| TUI 卡顿、阻塞和渲染热点诊断 | 有 baseline e2e、highlight scaling、pipeline breakdown 和 native traversal evidence，覆盖充分。 |
| delta streaming 调度与 stale backlog | `INV-01`、`INV-02`、Section 10.1 和 TDD slice 1 有明确映射。 |
| Markdown table、partial row、open/closed fence、long code | `INV-03`、`INV-04`、stable prefix + full-context tail 有映射；实现阶段必须验证最终 `CodeRenderable` public output，而不只是 raw highlight tuples。 |
| blockquote、list、setext、reference、emphasis | 已列入 supported domain、adversarial evidence 和 TDD slice，但 boundary helper实施时必须继续证明不会错误缓存跨块语义。 |
| 跨行公式和公式 pass-through | `INV-07` 明确禁止虚构 math AST，并列出五类 literal 测试形态，覆盖方向正确。 |
| public async setter invalidation | R3 已覆盖 `filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`、`onChunks`，解决了 R1 的遗漏。 |
| native bounded traversal | `INV-05`、Zig owner、A/B evidence 和 native tests 有明确映射。 |
| non-Markdown、non-streaming、callback、parser-error compatibility | `INV-09` 和回归测试有映射。 |
| OpenTUI source、release、parent resolver、实际 OpenCode consumer closure | 技术路径描述完整，但当前被 B-01 阻塞，因为计划把未获授权的当前仓库修改和远程发布作为必要交付条件。 |
| 用户范围：不超过 8 个代码文件、不超过 1200 行生产代码、测试脚本少于 10 个 | 计划估算在表面数字上满足，但 release metadata、root lock、gitlink 和实际 scope仍需实施阶段重新核算。 |
| 修改后不能出现红测 | 有 targeted、native、full JS、runtime closure 和 original e2e verification命令；当前没有 post-fix evidence，因为尚未获批实施。 |

# Primary-path and fallback verdict

OpenTUI 内部设计了一个相对清晰的 primary path：

```text
CodeRenderable update
  -> unified invalidation/snapshot
  -> active-job gate
  -> stable Markdown prefix + full-context tail
     或既有 full parse
  -> callback/styled-text commit
  -> bounded native traversal
```

没有发现新的 parser fallback、错误后 alternate success、`createBuffer/updateBuffer` 替代路径、source import fallback 或 native dylib fallback。现有 parser-error plain-text行为被明确作为既有兼容行为保留。

但是，计划的完整交付路径依赖未经原始需求授权的 source modification、parent lock/gitlink modification、remote tag 和 package release。该 release/dependency path 不是合法的当前任务 primary path，因此整个计划不能在现有授权边界下批准。

# Release verdict

**BLOCK**

R3 相比 R2 已补齐 public async state invalidation、lockstep package family、OpenCode dependency lock 和 installed-consumer verification，但仍把原始需求未授权的当前仓库修改及远程发布作为必要实施路径。当前 revision 不能批准或进入实施。
````

R3 approval was not granted. R4 records the verbatim user scope and staged-release authorization and requires a new full-scope audit.

### Round 4 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 R4 仍将未经当前用户明确授权的仓库修改与远程发布作为必要交付路径

- **Violated invariant:** 原始需求明确要求原则上不要修改当前仓库；如确实需要修改，应在临时目录或 `.temp/testing` 中完成。Canonical plan 不能仅凭自身叙述把当前仓库生产修改、依赖锁更新、远程 push、tag 和 GitHub Release 变成授权行为。
- **Evidence class:** contracted
- **Producer and execution path:** 计划拟修改 `thirdparty/opentui` 源码和 native 实现，构建 11 个 immutable package assets，发布 `v0.4.3-smark.3`，再修改根目录 catalog、override、`bun.lock`、gitlink 和 provenance，使 OpenCode 实际解析新版本 package family。
- **Source evidence:** 原始需求已记录在 `docs/plans/opentui-streaming-markdown-performance-repair.md:19-27`，其中明确包含“理论上来说你不能对当前仓库内容进行修改”以及应在临时目录或 `.temp/testing` 中修改。
  - 计划自身在 `docs/plans/opentui-streaming-markdown-performance-repair.md:246-253` 把 nested source 修改、11 个 package 构建、远程 `smark/main` push、annotated tag、GitHub Release、父仓库 lock 更新和 runtime 部署串成完整路径。
  - 计划在 `docs/plans/opentui-streaming-markdown-performance-repair.md:29-43` 声称存在后续用户授权，但本次审计输入中没有对应的实际用户消息；该段只是 canonical plan 内部的授权记录，不能替代当前用户明确授权。
- **Canonical-plan evidence:** Sections `1.1`、`2`、`10.4`、`15`、`18`、`20`。
- **Responsibility owner:** 当前任务的变更授权边界以及 OpenTUI source/release、OpenCode dependency-closure 边界。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 按该计划实施会修改用户明确要求保持不变的当前仓库，并可能对 `smark/main` 执行 push、创建 tag 和发布 GitHub Release。若不执行这些动作，计划又明确承认 OpenCode 仍然解析旧的 `.2` immutable runtime，因此该计划无法同时满足“不要修改当前仓库”和“让优化进入实际 OpenCode runtime”两个条件。
- **Why this is not speculative:** 这些不是未来输入或泛化安全担忧，而是计划明确列出的生产动作和外部副作用。当前仓库也确实通过 immutable release tarball 消费 OpenTUI，而不是直接消费 nested source；因此 source-only 修改无法改变实际 OpenCode runtime。
- **Minimal correction direction:** 二选一：将当前 revision 限制为 `.temp/testing` 中的 benchmark、诊断和 prototype，删除当前仓库生产修改及远程发布步骤；或在实际用户消息中取得对当前仓库修改、package release、依赖 lock 更新以及远程 push/tag/release 的明确授权，并据此递增 canonical revision、清空 approval，重新进行完整方案审计。不能用 plan 内部的“verbatim user answer”替代实际授权，也不能在未授权时继续进入 implementation 阶段。

# Non-blocking findings

- Section 18 的 native 过滤命令 `-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"` 依赖计划新增测试的未来精确名称；目前没有现存测试证明该过滤器必然命中。实施前应固定测试名，并验证零匹配会失败。
- `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` 在当前仓库中尚不存在。作为计划新增测试没有问题，但实施时必须确认它通过实际安装的 package boundary 验证，而不是 workspace symlink、nested source 或旧 `.2` package。
- Section 17 的 `E/C` 仍是 plan-mode 估算；实现审计必须按照实际 diff 重新统计 substantive production、test、configuration 行以及邻近中文解释性注释，不能直接沿用 `500-700` 与 `75-105` 的估算。
- Section 10.4 同时描述“发布后更新父仓库 lock”和“本轮不执行远程发布”，阶段边界较复杂。若获得授权，实施前应把 source preflight、remote release、parent lock update、installed-consumer verification 固定为不可跳步的阶段状态。

# Rejected speculation

- 没有把 synthetic native handle ceiling 列为本轮 blocker；计划已有独立边界说明，当前材料没有真实 OpenCode Session producer trace 证明该阈值可达。
- 没有要求新增数学/LaTeX renderer。现有 parser/query 证据支持公式作为普通文本或 escape pass-through，计划保留该 contract 的方向正确。
- 没有要求把所有 streaming 路由切换到 `MarkdownRenderable`；当前 `ReasoningBody` 依赖 `CodeRenderable.onChunks` 的可见文本反馈，整路由切换会改变既有布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching 判定为 first divergence；当前证据指向后续 `CodeRenderable` 全文异步高亮、`setStyledText` 和 native line traversal。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text catch-and-success 或 source import/native dylib fallback；计划将这些列为禁止 alternate success path 是正确的。

# Requirement and traceability coverage

技术闭包各项（TUI热点、delta调度、Markdown结构、公式pass-through、public async setter invalidation、native bounded traversal、兼容性、TDD和范围预算）均有映射；OpenTUI source/release/parent resolver/实际 OpenCode consumer closure 的技术描述也完整。但该闭包在当前 revision 被 B-01 阻塞，因为授权证据不在当前用户需求输入中。

# Primary-path and fallback verdict

OpenTUI 内部设计了相对清晰的单一 primary path：

```text
CodeRenderable update
  -> unified invalidation/snapshot
  -> active-job gate
  -> stable Markdown prefix + full-context tail
     或既有 full parse
  -> callback/styled-text commit
  -> bounded native traversal
```

没有发现新的 parser fallback、错误后 alternate success、`createBuffer/updateBuffer` 替代路径、`drawUnstyledText` 逃生路径或 source import fallback。现有 parser-error plain-text 行为也被正确识别为既有兼容路径。

但是，完整部署路径依赖当前仓库生产修改和远程 release，而本次审计输入没有提供相应的实际用户授权。因此该 primary path 在当前授权边界下不能作为合法的本任务交付路径。

# Code quality and Chinese-comment verdict

这是 plan audit，没有 implementation diff，不能计算实际 `E/C`，也不能确认最终 TypeScript、Zig、包构建或中文注释硬门槛是否通过。实现时必须把 substantive 测试和配置修改纳入 `E`，并重新满足 `C >= max(1, ceil(E * 0.15))`。

# Release verdict

**BLOCK**

R4 在技术根因、Markdown 稳定边界、异步 snapshot、native bounded traversal 和 package/runtime closure 方面比前几版完整；但当前可审计输入没有实际用户消息授权其扩大到当前仓库生产修改、远程 push、tag 和 GitHub Release。该授权边界问题必须先解决，并递增 canonical revision 后重新进行完整方案审计。
````

R4 approval was not granted. R5 supplies the raw authorization addendum in the auditor handoff; no implementation is allowed before a clean R5 verdict.

### Round 5 Independent Verdict (verbatim record)

````text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01：发布阶段边界仍较复杂。** Section 10.4 同时描述 source preflight、远端 release、父仓库 lock 更新和 installed-runtime 验证。实施时应严格按不可跳步的 staged gate 执行，避免在 `.3` 尚未发布时生成或声称已完成 immutable runtime closure。
- **N-02：native 测试过滤器依赖未来新增测试名。** `-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"` 只有在新增测试确实使用该精确名称时才有效；实施阶段需要确认零匹配会导致命令失败，而不是静默通过。
- **N-03：计划中的 runtime consumer 测试当前尚不存在。** 这作为计划新增文件本身没有问题，但实施时必须证明它通过真实安装后的 `@opentui/*` package boundary 运行，不能通过 workspace symlink、nested source 或旧 `.2` 包路径。
- **N-04：稳定前缀算法仍需在实现阶段证明其上下文保持能力。** 当前计划已经列出 table、partial row、setext、reference、emphasis、blockquote、list、fence 等测试域，但 fragment parse 的上下文隔离、synthetic newline 和 highlight range clipping 必须通过最终 `CodeRenderable` 输出验证，而不能只比较内部 highlight tuple。
- **N-05：计划阶段的 `E/C` 仅为估算。** 实现审计必须把 production、test 和 configuration 的 substantive diff 全部计入 `E`，再重新计算邻近且解释真实约束的中文注释 `C`。

## Rejected speculation

- 没有要求新增数学/LaTeX renderer。当前 parser/query 对公式形态保持普通文本或 escape pass-through，计划中的 `INV-07` 与原始要求一致。
- 没有要求将所有 streaming 路由切换到现有 `MarkdownRenderable`。`ReasoningBody` 的 `CodeRenderable.onChunks` 可见文本反馈属于真实现有接口，整路由切换会改变布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching 判定为 first divergence。当前证据链明确指向 `CodeRenderable` 全文异步 highlight、`TextBuffer.setStyledText` 以及 native `walkLines` 放大。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback、source import fallback 或 native dylib fallback；计划已将这些正确列为禁止的 alternate success path。
- 没有将 synthetic native handle ceiling 列为本轮 blocker。当前材料缺少真实 OpenCode Session producer trace 证明该阈值在目标调用链中可达。

## Requirement and traceability coverage

- **TUI 卡顿、阻塞和渲染热点：** 已由真实 `CodeRenderable → TreeSitter worker → TextBuffer → native` 调用链、e2e latency、highlight scaling 和 pipeline breakdown 覆盖。
- **delta/streaming 调度：** `INV-01`、`INV-02` 对应 active-job gate、latest dirty snapshot 和 delayed serialized stream 测试。
- **Markdown 表格与未闭合结构：** `INV-03`、`INV-04` 覆盖 table、partial row、open/closed fence、long code、blockquote/list、setext/reference/emphasis；计划明确保留完整 tail 上下文。
- **跨行公式：** `INV-07` 明确保持五类公式形态的 pass-through，不引入未被当前 grammar 支持的 math AST。
- **公开异步状态：** `INV-06` 覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight` 和 `onChunks`。
- **native 性能路径：** `INV-05` 对应 bounded iterator，并要求验证 CJK、tab、empty line、trailing newline 和 range endpoint 等可达边界。
- **兼容性：** `INV-09` 覆盖 non-Markdown、non-streaming、parser-error compatibility 和 callback 语义；现有 parser-error plain-text 行为被保留，而不是扩展为新 fallback。
- **实际 runtime 闭包：** `INV-08`、`INV-10` 覆盖 OpenTUI source commit、11-asset release family、root override/lock、provenance、installed realpath、OpenCode `TextPart`/`ReasoningBody` consumer 和原始 e2e。
- **用户授权边界：** 当前审计输入已经逐字提供了“扩展到完整 runtime 闭包”和“授权 staged release gate”的后续授权，因此 R5 不再存在 R3/R4 的授权阻塞。
- **范围约束：** 计划列出的生产 source files、测试文件和预估行数仍处于用户约束以内；实际 diff 仍须在 implementation audit 中复核。
- **TDD 与回归：** 计划提供了可在当前行为上失败的调度、snapshot、Markdown correctness、native equivalence、package closure 和原始反馈循环验证。

## Primary-path and fallback verdict

R5 建立了单一权威 primary path：

```text
OpenTUI source commit
  -> lockstep 11-asset immutable release
  -> OpenCode catalog/override/lock
  -> installed @opentui package family
  -> CodeRenderable unified invalidation/snapshot
  -> active-job latest-snapshot gate
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse contract branch
  -> callback/styled-text commit
  -> bounded native line traversal
  -> TextPart/ReasoningBody visible frame
```

没有发现新的 parser fallback、错误后 alternate success、`createBuffer/updateBuffer` 替代成功路径、source import fallback、native dylib fallback 或 `drawUnstyledText` 逃生路径。现有 parser-error plain-text 行为属于已有兼容路径，且计划没有扩大其语义。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有 implementation diff，因此：

- 无法计算实际 `E/C`；
- 无法确认最终 TypeScript、Zig、package build、lockfile、release verifier 或 runtime consumer 结果；
- 无法判定最终实现是否遗留 dead helper、重复 cache、未清理 workaround 或类型/风格问题。

计划已承诺实现阶段按：

```text
C >= max(1, ceil(E * 0.15))
```

重新计算，并已将中文解释性注释限定在真实的 snapshot、stable-boundary、synthetic newline、fence、formula pass-through、native offset 和 stale completion 约束附近。该门槛仍需在 implementation audit 中实际验证。

## Release verdict

**APPROVE**

本 verdict 仅适用于当前 canonical plan 的精确 **R5** revision，且属于 **plan audit**。R5 已补齐：

1. public async state invalidation；
2. Markdown stable-prefix/full-context tail 的完整测试责任；
3. native bounded iterator owner；
4. 11 个 immutable package 的 release/runtime closure；
5. OpenCode 实际 installed consumer 验证；
6. 当前用户材料中明确提供的完整 runtime 闭包与 staged release gate 授权。

允许将 R5 记录为 approved revision 并进入 implementation，但不代表实现、远端发布、父仓库 lock 更新或最终 runtime 已完成。实施完成后仍必须通过完整的 implementation audit，包含实际 diff、测试结果、release closure 和中文注释硬门槛。
````

R5 is the exact approved plan revision. Implementation is now authorized, subject to the approved-plan-only workflow and a later independent implementation audit. R6 invalidated that approval after the pre-revision red regression exposed a new reachable scheduler contract.

### Round 6 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 单个 detached slot 无法满足“任意 hung request 不阻塞后续最新输出”的调度不变量

- Violated invariant: `INV-02` 要求“一个 hung request 不得阻塞后续最新输出”，同时要求最新 dirty snapshot 持续收敛、不能形成无界 worker backlog。当前设计只允许“一个当前 job + 一个 detached superseded request”，但没有定义已有 detached request 占用 slot 时再次发生 hung request 的行为。
- Evidence class: reachable
- Producer and execution path: `CodeRenderable` 接收公开的 `content`、`filetype` 等更新；每个 dirty snapshot 进入 `startHighlight()`，再调用 `TreeSitterClient.highlightOnce()`。公开 `treeSitterClient` 可由测试或实际调用者注入，且该 Promise 可以永不 settle。连续的 Message Part delta 可在前一个 request 未完成时继续触发新的 snapshot。
- Source evidence:
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:46-57`：`treeSitterClient`、`content`、`filetype` 等属于公开 `CodeOptions` 输入。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:359-373`：每个 highlight job 对完整 snapshot 调用 `highlightOnce()` 并等待其 Promise。
  - `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:525-553`：现有可达测试明确构造了永不完成的 `highlightOnce()` Promise。
  - `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:575-606`：同一个 `CodeRenderable` 在活动高亮期间继续接收多次 content/filetype 更新。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:701-752`：client 提供的是 client 级 `destroy()`，没有单个 `highlightOnce()` request 的取消接口；因此 detached Promise 并不会被底层取消。
- Canonical-plan evidence: Section 7 `INV-02`；Section 9 “hung request supersession”；Section 10.1 lines 228-234；Section 11 lines 270-273。
- Responsibility owner: `CodeRenderable` 的 job ownership 与调度状态机；`TreeSitterClient` 当前接口不拥有 per-request cancellation。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 设第一个请求 A 永不完成，计划允许将 A detached 并启动 B；若 B 也永不完成，此时 A 已占用唯一 detached slot，而 B 是当前 active job。再次到达更新 C 时，计划既不能再 detached B（否则突破 one-slot cap、产生未界定的并发 hung requests），也没有规定如何让 C 进入主路径。结果是最新内容可能继续等待 B，直接违反 `INV-02` 的“hung request 不得阻塞后续最新输出”及 `INV-01` 的最终最新内容收敛要求。
- Why this is not speculative: 首个永不完成 Promise 已由现有测试直接构造；连续更新由同一现有测试直接覆盖；`TreeSitterClient` 没有 request-level cancel，因此不能假定前一个 detached job 会被底层终止。第二个 hung request 只是同一公开接口在后续 snapshot 上再次返回同样 Promise，属于该 producer-to-consumer 链可达的重复输入，而非虚构的新接口。
- Minimal correction direction: 在 `CodeRenderable` 的唯一调度 owner 中补齐“已有 detached request 后再次发生未 settle active request”的明确状态转移和行为级测试，使任意可达的连续 hung request 都不会阻塞最新 snapshot，同时仍保持一个明确、唯一的 primary success path。不能仅保留 one-slot 文档约束而把该状态留给实现阶段自行决定。

# Non-blocking findings

- N-01：detached 的触发条件仍不够可执行。Section 10.1 使用“下一渲染周期仍未 settle”作为脱离条件，但没有明确该条件如何与 render loop、Promise settle、`finally` 和 dirty snapshot 合并交互。该问题目前主要是实现规格精度问题；在补齐 B-01 的完整状态机后，应把触发条件和 observable convergence test 固定下来。
- N-02：native 测试过滤器依赖未来新增测试名。Section 18 的 `-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"` 只有在新增 Zig 测试采用完全相同名称时才有效。计划已经要求零匹配必须失败，但尚未给出该命令自身的可执行失败验证。
- N-03：runtime consumer 测试尚不存在。`packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` 是计划新增文件；这不构成当前阻塞，但 implementation audit 必须证明它通过实际安装的 immutable package family 运行，而不是 nested source、workspace symlink 或旧 `.2` tarball。
- N-04：稳定前缀的最终用户可见验证仍需保持为硬要求。Section 16 同时要求 raw Markdown differential 和实际 `CodeRenderable` stream。实现不能只证明 prefix/highlight tuple 等价，还必须证明 `TextPart` / `ReasoningBody` 的最终可见文本、conceal 映射、table、long fence 和 callback 输出等价。

# Rejected speculation

- 没有将 synthetic native handle ceiling 列为阻塞项；计划明确记录当前没有真实 Session producer trace 证明该阈值在目标调用路径中可达。
- 没有要求新增数学/LaTeX renderer 或 tree-sitter math grammar；当前源码证据显示公式形态属于普通文本或 escape pass-through，保留该语义符合原始要求。
- 没有要求把所有 streaming 路由切换到现有 `MarkdownRenderable`；`ReasoningBody` 依赖 `CodeRenderable.onChunks` 的可见文本反馈，整路由替换会改变现有接口责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching 判定为 first divergence；计划提供的实测链路已将主要放大点定位到 `CodeRenderable` 全文高亮、`TextBuffer.setStyledText` 和 native 全量 `walkLines`。
- 没有把当前工作树中的 `Code.ts` / `Code.test.ts` WIP 当作实现证据；Canonical plan Section 23 已明确 R6 尚无 approved implementation evidence。

# Requirement and traceability coverage

- TUI 卡顿、阻塞与渲染热点诊断：覆盖充分。计划给出了 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 的实际链路，以及 baseline、scaling、pipeline breakdown 和 native A/B 证据。
- delta 调度与最新内容收敛：已映射到 `INV-01`、`INV-02`、Section 10.1 和 TDD Slice 1，但因 B-01，重复 hung request 的完整可达状态没有 executable owner/test coverage。
- Markdown table、partial row、长代码段、open/closed fence：有 stable prefix + full-context tail 的明确方向及 differential 测试映射。
- blockquote/list/setext/reference/emphasis：已列入输入域、边界证据和测试计划；仍需最终 `CodeRenderable` 输出验证。
- 跨行公式与公式 pass-through：`INV-07` 明确保持普通文本语义，并列出五类公式形态的测试要求。
- 公开异步 setter invalidation：`INV-06` 覆盖 content、filetype、syntax/style、conceal、drawUnstyledText、streaming、initialStyledText、treeSitterClient、baseHighlight、onHighlight 和 onChunks。
- native bounded traversal：`INV-05`、Zig owner、LineInfo 等价性和 CJK/tab/empty/trailing newline 边界均有映射。
- 非 Markdown、non-streaming、parser-error 与 callback 兼容：`INV-09` 有明确保留约束，且没有引入 parser-after-parser 或 plain-text alternate success。
- OpenTUI source/release/runtime closure：`INV-08`、`INV-10` 已覆盖 11-package release family、root override/lock、provenance、installed realpath 和实际 OpenCode consumer；用户提供的完整 runtime 闭包及 staged release 授权已满足前一轮授权阻塞。
- 范围约束：计划估算为 7 个生产 source files、5 个测试文件、500–700 行生产代码，表面上满足用户的文件数、行数和测试数量约束；implementation audit 仍需重新统计实际 diff。
- TDD 与回归：主要行为均有 red-capable slice，但 B-01 所涉及的连续 hung-request 情形尚未由测试锁定。

# Primary-path and fallback verdict

计划试图建立以下单一 primary path：

```text
CodeRenderable update
  -> unified invalidation/snapshot
  -> active-job/latest-snapshot scheduling
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse contract branch
  -> callback/styled-text commit
  -> bounded native traversal
  -> TextPart/ReasoningBody visible frame
```

目前没有发现 parser fallback、错误后 alternate success、`createBuffer/updateBuffer` 替代路径、source import fallback、native dylib fallback 或 `drawUnstyledText` 逃生路径。既有 parser-error plain-text 行为也被正确分类为兼容路径。

但调度主路径在“一个 detached request 已存在、当前 request 再次 hung、随后又有最新 delta”这一可达状态上不完整。one-slot cap 与“任意 hung request 不得阻塞最新输出”同时存在，却没有唯一的状态转移，因此该 primary path 尚不能批准。

# Release verdict

**BLOCK**

R6 相比 R5 补充了既有 hung-request 兼容契约，并正确否定了过强的严格 active gate；但当前 canonical plan 仍未证明其 one-detached-slot 调度设计能够在连续 hung request 下保持最新 snapshot 收敛。该问题直接违反 `INV-02`，属于 CodeRenderable 调度 owner 的可达行为缺口。

必须先修订 canonical plan，明确该状态的唯一主路径、状态转移、资源/Promise 归属和行为级回归测试，再进行下一轮完整 scope plan audit。
````

R6 approval was not granted. R7 replaces detached-slot supersession with an explicit request-cancellation protocol and requires a new full-scope audit.

### Round 7 Independent Verdict (verbatim record)

````text
## Blocking findings

### B-01 取消协议不能实现计划自身要求的“无 detached worker backlog”

- **Violated invariant:** `INV-02` 要求失效任务通过 request-level cancellation 退出，任意连续 hung request 都不能阻塞最新输出，也不能形成 detached worker backlog；`INV-11` 进一步要求取消只终止目标 one-shot。
- **Evidence class:** reachable
- **Producer and execution path:** `CodeRenderable` 接收公开的 `treeSitterClient`，在每次新 snapshot 到达时调用 `highlightOnce()`。计划拟通过 `AbortSignal` 从 `CodeRenderable` 传到 `TreeSitterClient`，再发送 `CANCEL_ONESHOT_HIGHLIGHT` 给 parser worker。可是 worker 端的取消只能标记 message、移除客户端 callback 和抑制 response，不能终止已经运行的 Promise、同步 parser 调用、语言加载或 query/injection 工作。
- **Source evidence:**
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:46-57,359-373`：`treeSitterClient` 是公开输入，highlight job 等待 `highlightOnce()` Promise。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:391-417`：当前 one-shot 只有 `messageCallbacks` 和 worker message，没有 request-level cancellation 或底层任务句柄。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts:819-878`：one-shot 会执行 parser、query 和 injection，最终才发送 response；当前没有执行取消接口。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts:282-305,307-322`：reusable parser 的创建 Promise 可以长期处于 pending 状态，且会被多个 one-shot 共享。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts:940-1050`：worker handler 对每条消息启动异步处理；计划增加 cancel message 后，取消消息可以标记请求，但不能强制终止已进入 `await`、同步 `parse()` 或 query 的旧处理。
  - `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:525-608`：现有公开测试 seam 已经构造永不 settle 的 `highlightOnce()`，并在同一 `CodeRenderable` 上连续提交新内容和 `filetype`。
- **Canonical-plan evidence:** Section 7 `INV-02`、`INV-11`；Section 8 lines 176-183；Section 10.1 lines 229-236；Section 20 lines 419-423；Section 11 lines 270-273。
- **Responsibility owner:** one-shot request 的实际生命周期 owner，即 `TreeSitterClient` 与 parser worker request seam；`CodeRenderable` 只能停止等待并丢弃旧结果，无法释放 worker 内已经运行或永不完成的任务。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 连续 hung request 仍可能留下多个 worker 内 pending 的 one-shot。客户端 callback 被删除只会让结果不可见，不会释放底层 Promise、parser loading 或 worker 资源。于是计划宣称的“no detached worker backlog”不成立；在连续失效请求场景下，worker 工作量仍可无界累积，后续最新输出可能继续受到 worker 资源和调度竞争影响。仅验证“取消后不调用 callback、不提交 StyledText”不足以证明 `INV-02`。
- **Why this is not speculative:** 永不完成的 `highlightOnce()` 已由现有测试直接证明可达；当前真实 worker 路径也明确存在长期异步 parser loading、injection 和 one-shot 执行阶段。取消协议的计划行为仅定义了 callback/response 抑制，没有定义或证明底层执行终止。
- **Minimal correction direction:** 在唯一的 TreeSitter request owner 中补齐可验证的 request 生命周期终止语义，并把“取消后旧 worker work 不再累积”作为行为级契约；或者收紧 `INV-02`，明确 Code 层只能丢弃旧结果而不能承诺释放底层 work，同时删除与该未实现资源保证相冲突的“no detached worker backlog”交付声明。不能只增加 cancel message、callback deletion 或 response suppression 来宣称 request 已被终止。

## Non-blocking findings

- **N-01：计划阶段的 `E/C` 估算范围仍不完全一致。** Section 17 的 `E` 描述主要覆盖生产行为和 parent provenance 脚本，而政策要求 plan-mode 估算同时考虑 substantive test 和 configuration changes。Section 19 又把测试行数单列。当前属于估算口径问题；implementation audit 必须按实际 diff 重新计入 production、test、configuration，并重新计算 `C >= max(1, ceil(E * 0.15))`。
- **N-02：native 过滤命令依赖未来测试名称。** Section 18 的 `-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"` 当前没有对应现存测试。计划已要求零匹配失败，但实施前仍需把新增测试名称和“零匹配即失败”的实际命令行为固定下来。
- **N-03：完整 JS 测试仍有已记录的基线失败。** Section 4 和 Section 20 记录过 `4978 pass / 23 skip / 1 fail / 1 error`，并将其归因于并发环境噪声。该说明不能替代最终证据；若发布前仍出现失败，必须通过隔离复现证明与本改动无关，并明确哪些命令构成 release gate。

## Rejected speculation

- 没有把 synthetic native handle ceiling列为本计划 blocker。当前材料没有真实 Session producer trace证明该阈值在目标 OpenCode TUI调用链中可达。
- 没有要求新增数学/LaTeX renderer或 tree-sitter math grammar。现有 parser/query 证据支持公式作为普通文本或 escape pass-through，计划保留该语义。
- 没有要求将所有 streaming 路由切换到现有 `MarkdownRenderable`。`ReasoningBody` 当前通过 `CodeRenderable.onChunks`反馈可见文本，整路由替换会改变已有布局责任。
- 没有把 OpenCode `sync.tsx` 的16ms producer batching认定为 first divergence。计划提供的证据链指向 `CodeRenderable`全文高亮、`TextBuffer.setStyledText`和native line traversal。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback、source import fallback或native dylib fallback；这些路径在计划中已正确列为禁止的 alternate success path。

## Requirement and traceability coverage

- **TUI卡顿、阻塞和热点诊断：** 覆盖充分。计划重建了 `Message Part delta -> CodeRenderable -> TreeSitter worker -> TextBuffer -> native` 调用链，并提供了 baseline、highlight scaling、pipeline breakdown和native A/B证据。
- **delta/streaming调度：** 有 `INV-01`、`INV-02`和 delayed stream测试映射，但连续 hung request 的资源生命周期没有被真正闭合，因此该要求当前未满足。
- **Markdown表格、partial row、open/closed fence、长代码段：** stable prefix + full-context tail方向明确，且有 differential、fuzz和prefix-cache证据。最终仍必须验证 `CodeRenderable`及OpenCode `TextPart`/`ReasoningBody`的用户可见输出，而不是只验证 raw highlight tuples。
- **blockquote、list、setext、reference、emphasis：** 已列入支持域和测试计划；边界算法仍需证明跨块语义不会被错误缓存。
- **跨行公式和公式 pass-through：** `INV-07`覆盖五类公式形态，且没有引入未被当前 grammar支持的数学语义。
- **公开异步状态：** `INV-06`覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`和`onChunks`。
- **native bounded traversal：** `INV-05`明确了 Zig owner和 LineInfo 等价性测试，CJK、tab、empty line、trailing newline和range endpoint均有映射。
- **非 Markdown、non-streaming、parser-error和callback兼容：** `INV-09`覆盖，计划没有新增 parser fallback或 plain-text alternate success。
- **source/release/runtime closure：** `INV-08`和`INV-10`覆盖11-asset release family、root override/lock、provenance、installed realpath以及OpenCode实际consumer。后续 staged release授权已被当前用户明确提供。
- **范围约束：** 计划列出的8个生产源码文件、4个测试文件和600–850行生产代码估算在表面上满足用户的甜点级别限制；实际 metadata、lockfile、gitlink和实现diff仍需在 implementation audit 中复核。
- **TDD与回归：** 主要路径均有 red-capable slice，但 request cancellation目前只证明“逻辑结果不可见”，没有证明“底层 hung work 被终止且不形成 backlog”。

## Primary-path and fallback verdict

计划在语义上试图建立一条主路径：

```text
OpenTUI source commit
  -> lockstep 11-asset immutable release
  -> OpenCode catalog/override/lock
  -> installed @opentui package family
  -> CodeRenderable snapshot/invalidation
  -> latest-snapshot scheduling
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callback/styled-text commit
  -> bounded native traversal
  -> TextPart/ReasoningBody visible frame
```

没有发现 parser-after-parser、`createBuffer/updateBuffer`替代成功、source import fallback、native dylib fallback或`drawUnstyledText`逃生路径。

但调度主路径在“request cancellation 是否真正释放底层 one-shot work”这一核心状态上不完整。callback removal 和 response suppression 是结果丢弃，不是 request termination；因此计划当前不能同时成立 `INV-02` 的“无 detached backlog”保证和 Section 10.1 的 cancellation设计。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有 implementation diff，因此无法计算实际 `E/C`，也无法确认最终 TypeScript、Zig、native build、lockfile、release verifier或runtime consumer结果。

计划已承诺实现阶段满足：

```text
C >= max(1, ceil(E * 0.15))
```

但 `E` 的计划估算应在实施阶段把 substantive test/configuration changes 纳入统计，不能直接沿用 Section 17 的范围描述。当前未发现单独的代码质量 blocker；该硬门槛仍需 implementation audit 实际复算。

## Release verdict

**BLOCK**

当前精确审计对象为 `R7`，状态为 `audit-required`，`Approved revision: none`。R7已经解决了R6的 one-slot supersession缺口，并补齐了source/package/runtime闭包和用户授权记录；但 request-level cancellation只定义了客户端回调和worker响应抑制，没有证明底层 hung one-shot 会被终止或不会形成 detached worker backlog。该问题直接违反 `INV-02`，必须修订canonical plan并进行下一轮完整scope审计后，才能批准实施。
````

R7 approval was not granted. R8 replaces response-only cancellation with an isolated one-shot worker channel whose termination is the resource-lifecycle boundary, and requires a new full-scope audit.

### Round 8 Independent Verdict (verbatim record)

````text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 终止失败后的用户可见收敛条件仍需实现阶段固定

Section 20.4/20.5 要求 `PlatformWorkerHandle.terminate()` 完成后才允许创建 replacement channel，并在 termination failure 时显式传播错误且禁止回退；但当前计划没有进一步规定 CodeRenderable 在终止失败时的最终可见状态、错误传播 seam，以及后续 dirty snapshot 是否必须继续获得一个明确的 diagnostic/unavailable 结果。

这不构成当前计划阻塞项，因为：

- `PlatformWorkerHandle.terminate()` 是已有生命周期接口；
- 计划明确禁止回退到共享 buffer worker；
- 终止失败属于现有平台边界的异常路径；
- 计划已要求实现阶段增加实际 worker fixture 和 termination-ordering 测试。

实施时必须保证该错误不会被吞掉，也不会表现为成功的旧内容。

### N-02 稳定前缀算法仍需要实现阶段证明所有声明的 Markdown 边界

Section 10.2 具体定义了 append-only、真实空行、fence、frontmatter、synthetic newline 和 tail full-context 规则，但对 reference definition、setext、emphasis、blockquote/list 等跨块语义没有给出逐一可执行的 boundary state 描述。

这目前不是阻塞项，因为：

- 计划没有要求对这些结构强行进行激进切分；
- `INV-03`/`INV-04` 要求未来完整解析结果等价；
- Section 16 已要求 table、fence、setext、reference、emphasis、blockquote/list 和 formula 进行 independent full-parse differential；
- 计划允许保守地保留更长 tail，而不是制造 alternate parser path。

实现审计必须确认测试观察的是 `CodeRenderable` 的最终 public output，而不仅是内部 highlight tuple。

### N-03 native 测试过滤器依赖尚未创建的精确测试名

Section 18.3 使用：

```text
-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"
```

当前仓库尚未存在该新增 Zig 测试，因此实施时必须确认：

1. 新测试名称与过滤器完全一致；
2. 零匹配会使该验证命令失败，而不是静默通过；
3. full native regression 仍然执行。

这是计划执行精度问题，不是当前行为缺陷。

### N-04 全量 JS 基线失败的 release gate 需要明确接受标准

Section 4 和 Section 18 记录过一次：

```text
4978 pass / 23 skip / 1 fail / 1 error
```

计划将其与并发环境噪声相关联，并要求隔离 TreeSitter 测试；但最终 release gate 尚未给出固定的“基线允许条件”和“改动相关失败判定”格式。

实施时应至少分别记录：

- 完整 JS suite 结果；
- isolated TreeSitter suite 结果；
- 失败测试名称与重现命令；
- 失败是否在改动前同样存在；
- release 是否因任一无法归因的失败而停止。

### N-05 计划阶段的 E/C 仍不是实现承诺的实际证明

Section 17 的 `E=500–750`、`C=75–113` 是可行性估算。政策要求 implementation audit 重新把 production、test、configuration 中所有 substantive changed lines 纳入 `E`，再按：

```text
C >= max(1, ceil(E * 0.15))
```

计算实际邻近中文解释性注释。

计划已经明确承诺实施阶段复算，因此不构成 plan approval blocker。

## Rejected speculation

- 没有将 synthetic native handle ceiling 列为阻塞项。计划和现有材料都没有证明真实 OpenCode Session producer path 能达到该阈值。
- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query。现有 parser/query contract 将公式形态作为普通文本或 escape pass-through，`INV-07` 保留了这一语义。
- 没有要求把所有 streaming 路由切换到现有 `MarkdownRenderable`。当前 `ReasoningBody` 依赖 `CodeRenderable.onChunks` 的可见文本反馈，整路由切换会改变既有布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching 认定为 first divergence。现有 evidence 指向 `CodeRenderable` 的全文异步 highlight、`TextBuffer.setStyledText` 以及 native 全量 `walkLines`。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback、source import fallback 或 native dylib fallback。计划已将这些正确分类为禁止的 alternate success paths。
- 没有把 plan 历史中 R1–R7 的旧 verdict 当作当前结论。当前审计对象是精确的 R8 revision。

## Requirement and traceability coverage

| Requirement / invariant | Audit result |
|---|---|
| TUI 卡顿、阻塞和渲染热点诊断 | 已由 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 调用链、baseline e2e、highlight scaling、pipeline breakdown 和 native A/B evidence 覆盖。 |
| delta/streaming 调度与最新内容收敛 | `INV-01`、`INV-02`、Section 10.1 和 repeated-hung worker TDD slice 建立了 active-job/latest-dirty primary path。R8 使用隔离 one-shot worker 的物理 termination，覆盖 R6/R7 的连续 hung request 和 detached work 缺口。 |
| Markdown table、partial row、open/closed fence、长代码段 | `INV-03`、`INV-04`、Section 10.2 和 Code-level differential tests 覆盖；未采用不完整的 delta-only parser。 |
| blockquote、list、setext、reference、emphasis | 已列入 supported domain、stable-boundary evidence 和 TDD slice；实现阶段需继续验证最终 public output。 |
| 跨行公式及公式 pass-through | `INV-07` 明确保留 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\begin...\end...` 的普通文本语义，不新增 math AST。 |
| public async state invalidation | `INV-06` 覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight` 和 `onChunks`。 |
| native bounded traversal | `INV-05` 明确 owner 为 Zig iterator/text-buffer seam，并映射 CJK、tab、empty line、trailing newline 和 range endpoint 测试。 |
| 非 Markdown、non-streaming、callback、parser-error compatibility | `INV-09` 明确保留现有 full parse 和 parser-error compatibility，不扩大 plain-text 行为为新 fallback。 |
| source/release/runtime closure | `INV-08`、`INV-10` 覆盖 nested source commit、11-asset lockstep release、root catalog/override/lock、provenance、实际 resolver realpath 和 OpenCode `TextPart`/`ReasoningBody` consumer。 |
| request termination | `INV-11`、Section 10.1 和 Section 16.7 将 `AbortSignal` 连接到隔离 one-shot channel、handler cleanup、`PlatformWorkerHandle.terminate()` 和 fresh-channel replay，同时保留共享 buffer worker。 |
| 用户授权边界 | 当前用户消息明确授权“扩展到完整 runtime 闭包”和 staged `smark/main` release gate；R3/R4 的授权阻塞已不再适用。 |
| 文件及规模约束 | 计划列出 6 个 production source files、5 个 test files/scripts，估算 production 500–750 行，满足不超过 8 个代码文件、不超过 1200 行生产代码以及少于 10 个测试文件/scripts 的约束；implementation audit 仍需按实际 diff 复核。 |
| TDD 与回归 | 每个主要 invariant 都映射到可在当前行为上失败的行为测试或已有 red evidence；最终仍需完成 source、native、package、installed-consumer 和原始 e2e 全部验证。 |

## Primary-path and fallback verdict

R8 建立了一个统一的 primary path：

```text
OpenTUI source commit
  -> lockstep 11-asset immutable release
  -> OpenCode catalog/override/lock
  -> installed @opentui package family
  -> CodeRenderable snapshot/invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot worker termination when invalidated
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse contract branch
  -> callback/styled-text commit
  -> bounded native traversal
  -> TextPart/ReasoningBody visible frame
```

未发现以下被禁止的 alternate success path：

- parser A 失败后尝试 parser B；
- `createBuffer/updateBuffer` 替代 Code one-shot；
- callback 删除后伪装成底层 request 已取消；
- `drawUnstyledText` 作为错误逃生路径；
- source checkout 或 native dylib fallback；
- 旧 `.2` runtime 作为 `.3` 发布失败后的替代成功路径；
- parser-error compatibility 被扩展成性能 fallback。

R8 将物理 worker termination 放在 one-shot request 的生命周期 owner 中，并明确不能终止共享 buffer worker；这解决了前一轮 R7 关于“只抑制 response、未释放 worker 内部 work”的阻塞问题。

## Release verdict

**APPROVE**

本 verdict 仅适用于当前精确的 **R8** canonical plan revision，且仅表示 **plan audit 通过**：

- 当前状态仍应保持 `audit-required`，`Approved revision` 在记录本 verdict 前必须按仓库流程设置为 R8；
- 尚未授权直接实施任何代码，除非 canonical plan 正式记录本轮 `No blocking findings` 和 `APPROVE`；
- 尚未证明实际 implementation diff、native build、11 个 release assets、远端 tag、parent lock、installed runtime、完整测试或中文注释比例；
- 后续实施必须严格按 R8 执行，任何行为、scope、owner、fallback、file plan 或测试 seam 变化都必须递增 revision 并重新进行 full-scope plan audit；
- 实施完成后仍必须通过独立 implementation audit，包含实际 diff、完整验证、primary-path/fallback inventory、workaround 删除、runtime closure 以及实际 E/C 计算。
````

R8 is the exact approved plan revision. Implementation is authorized only under the approved-plan-only workflow and the later independent implementation audit.

### R8 Implementation Drift Record

Before production implementation, the approved R8 red slice exposed a reachable existing interface contract that was not explicit in R8: `TreeSitterClient.highlightOnce` supports concurrent callers. The existing tests `client.test.ts:408-440`, `545-613` and `910-934` concurrently submit different filetypes, aliased parsers and Markdown injection requests; the focused command `bun test ./src/lib/tree-sitter/client.test.ts --test-name-pattern "concurrent highlightOnce|fast concurrent markdown|canonical parser assets"` passed `3 tests`, `0 fail` against the current implementation.

Terminating a reusable one-shot channel without preserving those pending logical requests would therefore be a reachable compatibility regression. R9 changes only the lifecycle contract: an abort physically terminates the isolated channel, while non-aborted pending requests retain their logical callback/payload and replay exactly once after the replacement channel initializes. The R8 implementation WIP test/fixture remains red-capable evidence; no production implementation beyond the R8 WIP is authorized until R9 receives a new full-scope plan audit.

### Round 9 Independent Verdict (verbatim record)

````text
## Blocking findings

### B-01 发布授权中的“11 个 assets”与现有 workflow 实际发布的 12 个 assets 未闭合

- Violated invariant: staged release gate 必须严格执行用户明确授权的发布范围；不能把未被授权的额外远程发布副作用纳入 primary path。
- Evidence class: contracted
- Producer and execution path: canonical plan 的 Section 10.4/18.4 将 OpenTUI 发布定义为 11 个 package assets 加 `SHA256SUMS`；现有 `build-native.yml` 先生成 11 个 `.tgz`，随后额外生成 `SHA256SUMS`，而现有 `release.yml` 使用 `artifacts/npm-packages/*` 将两者全部传给 `gh release create`，因此 GitHub Release 实际发布 12 个 assets。用户授权原文明确为“允许现有 GitHub release workflow发布11个assets”。
- Source evidence:
  - `thirdparty/opentui/.github/workflows/build-native.yml:96-109`：生成并校验 11 个 `.tgz`，然后额外生成 `SHA256SUMS`。
  - `thirdparty/opentui/.github/workflows/release.yml:120-134`：对 `artifacts/npm-packages/*` 执行 release 创建，包含 11 个 tarball 和 checksum 文件；workflow 注释也明确写“12个assets”。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:263-269`：计划要求按现有 workflow 发布 11-asset family。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:37-43`：记录的用户授权限定为现有 workflow 发布 11 个 assets。
- Canonical-plan evidence: Sections `1.1`, `10.4`, `11`, `13`, `15`, `18.4`, `20`。
- Responsibility owner: staged release scope与 OpenTUI release workflow 边界；不是 CodeRenderable、TreeSitterClient 或本地 verifier。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 按当前计划执行会在用户授权的 11 个 assets之外，实际创建包含 `SHA256SUMS` 的第 12 个 GitHub Release asset。若将 checksum 视为授权范围的一部分，当前计划没有明确记录该解释；若不视为授权范围的一部分，则现有 workflow 会超出授权。该差异发生在不可逆的远程 release primary path上，不能由本地 package verifier或后续 parent lock 更新补救。
- Why this is not speculative: 现有 workflow 的 glob 发布路径和用户授权文本均已直接可见；第 12 个 asset不是未来输入或假设分支，而是该 release path的必然输出。
- Minimal correction direction: 在 canonical plan中明确并固定“11 个 assets”的精确定义，使用户授权、checksum contract和现有 workflow的实际发布集合一致；在该授权范围闭合前，不得执行或批准远程 tag/release gate。

## Non-blocking findings

### N-01 全量 JS suite 的既有失败仍缺少固定的 release-stop 判定

- `docs/plans/opentui-streaming-markdown-performance-repair.md:117` 和 `:432` 记录过 `4978 pass / 23 skip / 1 fail / 1 error`。
- Section 18 要求报告该基线，但没有把“无法证明与本改动无关的失败必须停止 release”写成明确的 command-level gate。
- 这不单独构成当前 blocker，因为计划已经要求隔离 TreeSitter suite并记录环境噪声；implementation audit必须确认最终 release判定没有隐藏或弱化失败。

### N-02 native filter command 仍依赖未来新增测试名

- `docs/plans/opentui-streaming-markdown-performance-repair.md:380` 使用测试名 `walkLinesInCharRange - matches full walk for bounded ranges`，当前源代码中尚无该测试。
- 计划已要求零匹配应失败，但实现阶段仍需证明 Bun/Zig command在零匹配时确实失败，并确认新增测试名称完全一致。
- 这是执行精度风险，不是当前行为 blocker。

### N-03 稳定前缀实现的可执行边界仍需由最终 public output 证明

- Section 10.2列出了 table、fence、frontmatter、setext、reference、emphasis、blockquote/list 等约束，但没有为每个跨块语义定义独立的状态转移。
- 由于计划允许保守地保留更长 tail，当前设计方向仍可成立；实现审计必须验证 `CodeRenderable`、`TextPart` 和 `ReasoningBody` 的最终可见输出，而不能只比较 raw highlight tuples。

### N-04 R9 历史审计记录包含旧的 R8 approval 叙述

- `docs/plans/opentui-streaming-markdown-performance-repair.md:1171` 保留“R8 is the exact approved plan revision”，而文件头当前是 `Revision: R9`、`Approved revision: none`、`Status: audit-required`。
- 该段被明确标记为历史 drift record，当前状态元数据没有因此失真；但记录当前 R9 verdict时应保持历史结果与当前 approval 状态严格可区分。

## Rejected speculation

- 没有将 synthetic native handle ceiling列为 blocker：计划已记录当前没有真实 OpenCode Session producer trace证明该阈值可达。
- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar或 math query：当前 parser/query证据表明公式形态属于普通文本或 escape pass-through，用户需求没有要求新增数学语义。
- 没有要求把所有 streaming 路由切换到现有 `MarkdownRenderable`：`ReasoningBody`真实依赖 `CodeRenderable.onChunks` 的可见文本反馈，整路由切换会改变既有布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching判定为 first divergence：当前证据链指向 Code 全文异步 highlight、`TextBuffer.setStyledText` 和 native 全量 `walkLines`。
- 没有要求保留 `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback、source import fallback或native dylib fallback；这些均已被当前 R9正确分类为禁止的 alternate success path。
- 没有将当前工作树中的 OpenTUI WIP视为 R9 implementation evidence；计划自身已明确其不是实施授权。

## Requirement and traceability coverage

- TUI 卡顿、阻塞和渲染热点：已映射真实 `Message Part delta -> CodeRenderable -> TreeSitter worker -> TextBuffer -> native` 链路，并有 baseline、scaling、pipeline breakdown和native A/B证据。
- delta/streaming调度：`INV-01`、`INV-02`、`INV-11`覆盖最新 snapshot收敛、隔离 one-shot worker物理终止、连续 hung request和未取消并发请求 replay。
- Markdown table、partial row、open/closed fence、long code：`INV-03`、`INV-04`和stable-prefix/full-context-tail设计覆盖；实现仍须验证最终 public output。
- blockquote/list/setext/reference/emphasis：已列入 supported domain、differential和TDD映射；boundary实现需保持保守 tail语义。
- 跨行公式及公式 pass-through：`INV-07`覆盖五类公式形态，并保持无 math AST的现有语义。
- public async setter invalidation：`INV-06`覆盖 content、filetype、syntaxStyle、conceal、drawUnstyledText、streaming、initialStyledText、treeSitterClient、baseHighlight、onHighlight和onChunks。
- native bounded traversal：`INV-05`明确 Zig iterator/text-buffer owner，并映射 CJK、tab、empty line、trailing newline和range endpoint测试。
- 非 Markdown、non-streaming、callback和parser-error compatibility：`INV-09`覆盖，并明确不扩展既有 plain-text compatibility为性能 fallback。
- source/release/runtime closure：`INV-08`、`INV-10`覆盖 nested source commit、lockstep package family、root override/lock、provenance、installed realpath和OpenCode实际 consumer。
- 请求终止及并发兼容：`INV-11`覆盖 AbortSignal、隔离 channel、handler cleanup、termination ordering和未取消请求 replay。
- 规模约束：计划估算 6 个 production source files、5 个 test files/scripts、550–850 effective production lines，表面满足用户的 8 文件、1200 行和少于 10 个测试文件约束；实际仍需 implementation audit复核。
- TDD与验证：主要行为均有 red-capable slice和明确 package-local commands；尚无 approved implementation或 post-fix evidence。

## Primary-path and fallback verdict

计划建立了单一 primary path：

```text
OpenTUI source commit
  -> lockstep package family
  -> installed OpenTUI resolver graph
  -> CodeRenderable snapshot/invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination when invalidated
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

未发现以下被禁止的 alternate success path：

- parser A失败后尝试 parser B；
- `createBuffer/updateBuffer`替代 Code one-shot；
- callback删除后伪装成底层 request已取消；
- `drawUnstyledText`错误逃生路径；
- source checkout或native dylib fallback；
- `.3`发布失败后复用旧 `.2`作为成功路径；
- parser-error compatibility扩展为性能 fallback。

但当前 primary release path仍存在 B-01：其实际 workflow必然发布 12 个 GitHub assets，而用户授权记录限定为 11 个；因此远程 release范围尚未闭合。

## Release verdict

**BLOCK**

审计对象为精确的 **R9** canonical plan revision，当前状态为 `audit-required`，`Approved revision: none`。技术上的根因、Markdown稳定边界、异步snapshot、隔离 one-shot worker生命周期、native bounded traversal以及 OpenCode runtime closure均已覆盖；但 staged release gate的授权资产集合与现有 workflow的实际12-assets输出不一致。该远程副作用边界必须在 canonical plan中明确闭合，并递增 revision后重新进行完整 scope plan audit。
````

R9 approval was not granted. The user then clarified that “11+256sums” authorizes the existing 11 npm tarballs plus `SHA256SUMS` manifest, so R10 records the exact remote release set as 12 GitHub assets and closes the authorization boundary without changing the existing workflow.

### Round 10 Independent Verdict (verbatim record)

````text
## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 终止失败后的最终用户可见状态仍未完全定义

- `PlatformWorkerHandle.terminate()` 可以返回 rejected Promise；计划要求终止失败必须显式传播、禁止回退，但没有完全固定 `CodeRenderable` 在该错误后的公开状态、错误通知 seam，以及后续 dirty snapshot 的收敛行为。
- 相关证据：`thirdparty/opentui/packages/core/src/platform/worker.ts:192-206`；计划 Section 10.1、Section 20。
- 这不构成当前 blocker，因为计划已经明确禁止共享 buffer worker fallback、禁止把旧结果伪装成成功，并要求实现阶段覆盖 termination failure。
- 实施时应将该错误映射为明确的 diagnostic/unavailable 行为，并由行为测试验证旧 snapshot 不会继续作为成功结果显示。

### N-02 Markdown 稳定边界的部分状态仍需在实现阶段具体化

Section 10.2 明确了 append-only、真实空行、fence、frontmatter、synthetic newline 和 tail 保留规则，但 reference definition、setext、emphasis、blockquote/list 等跨块语义没有逐一给出完整的状态转移。

这目前不是 blocker，因为计划允许保守地保留更长的 tail，并且 Section 16 已要求使用 independent full-parse differential 验证最终结果。实现审计必须验证：

- `CodeRenderable` 的最终 public output；
- `TextPart` / `ReasoningBody` 的实际可见文本；
- callback 和 conceal 映射；
- table、long fence、跨块结构的 settled output。

不能只比较内部 raw highlight tuple。

### N-03 native focused filter 依赖尚未创建的测试名称

计划使用：

```text
-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"
```

当前仓库尚不存在该新增测试，因此实施阶段必须证明：

1. 新测试名称与过滤器完全一致；
2. 零匹配会使命令失败，而不是静默通过；
3. 完整 native regression 仍然执行。

这是验证命令精度问题，不是当前行为 blocker。

### N-04 全量 JavaScript 基线失败的 release gate 仍需固定判定格式

计划记录过：

```text
4978 pass / 23 skip / 1 fail / 1 error
```

并要求隔离 TreeSitter 并发基线噪声。实现阶段仍应分别记录：

- 完整 JS suite 结果；
- isolated TreeSitter suite 结果；
- 失败测试名称及复现命令；
- 失败是否在改动前同样存在；
- 无法归因的失败是否阻止 release。

当前属于 release-verification precision，而非已证明的新增行为缺陷。

### N-05 `E/C` 只能作为计划估算，不能作为实现证明

当前计划的 `E=550–850`、`C=83–128` 符合 plan-mode 可行性估算，但实现审计仍必须按实际 diff 重新统计所有 substantive production、test、configuration 行，并重新验证：

```text
C >= max(1, ceil(E * 0.15))
```

生成文件、纯移动、格式化和 import-only 改动不得计入 `E`；重复代码描述或无约束解释不得计入 `C`。

### N-06 staged release 的阶段边界仍需严格按顺序执行

Section 10.4 已经闭合了资产授权范围，但实际交付仍包含多个不可跳步阶段：

```text
source implementation
-> local native/package preflight
-> 11 tarballs + SHA256SUMS verification
-> nested source commit
-> normal push
-> annotated tag
-> GitHub Release
-> parent metadata/lock update
-> installed-runtime verification
```

实施时不得在 `.3` release 尚未发布前声称 parent runtime closure 已完成，也不得在 local package verifier 失败后执行远程操作。

## Rejected speculation

- 未将 synthetic native handle ceiling 列为 blocker。当前材料没有真实 OpenCode Session producer trace 证明该阈值在目标路径可达。
- 未要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query。当前 parser/query contract 将 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\begin...\end...` 保持为普通文本或 escape pass-through，计划没有虚构新的数学语义。
- 未要求把所有 streaming 路由切换到 `MarkdownRenderable`。`ReasoningBody` 真实依赖 `CodeRenderable.onChunks` 的可见文本反馈，整体切换会改变现有布局责任。
- 未将 OpenCode `sync.tsx` 的 16ms producer batching 判定为 first divergence。现有证据更直接指向 `CodeRenderable` 的全文异步 highlight、`TextBuffer.setStyledText` 以及 native 全量 `walkLines`。
- 未要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、plain-text success fallback、source import fallback 或 native dylib fallback。这些均已被计划正确列为禁止的 alternate success path。
- 未将 R1–R9 历史 verdict 作为当前结论；本次审计对象是精确的 R10 revision。
- 用户的“11+256sums”澄清已足以覆盖现有 workflow 的 11 个 tarball 加 `SHA256SUMS` manifest，即 12 个 GitHub Release assets；不再构成授权范围 blocker。

## Requirement and traceability coverage

- **TUI 卡顿、阻塞和热点定位：** 覆盖充分。计划重建了 `Message Part delta -> CodeRenderable -> TreeSitter worker -> TextBuffer -> native` 的真实路径，并引用 baseline e2e、highlight scaling、pipeline breakdown 和 native A/B 证据。
- **delta/streaming 调度：** `INV-01`、`INV-02`、`INV-11` 覆盖 latest-snapshot convergence、连续 hung request、隔离 one-shot worker termination 和 unaffected-request replay。
- **Markdown table、partial row、open/closed fence、long code：** `INV-03`、`INV-04` 和 stable-prefix/full-context-tail 方案覆盖；没有退回到不安全的 delta-only parser。
- **blockquote/list/setext/reference/emphasis：** 已列入 supported domain、differential 和 TDD slices；最终必须以 public output 验证。
- **跨行公式和公式 pass-through：** `INV-07` 明确保持当前无 math AST 的普通文本语义，并列出五类 literal 形态。
- **公开异步状态：** `INV-06` 覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight` 和 `onChunks`。
- **native bounded traversal：** `INV-05` 指定 Zig iterator/text-buffer owner，并覆盖 CJK、tab、empty line、trailing newline 和 range endpoint。
- **兼容性：** `INV-09` 保留 non-Markdown、non-streaming、parser-error、callback 和既有 full-parse 语义；没有将 parser-error plain text 扩展为性能 fallback。
- **source/release/runtime closure：** `INV-08`、`INV-10` 覆盖 nested source commit、lockstep package family、11 tarballs plus `SHA256SUMS`、root override/lock、provenance、installed realpath 和 OpenCode 实际 consumer。
- **request termination/concurrency：** `INV-11` 覆盖 AbortSignal、隔离 one-shot channel、handler cleanup、termination ordering、unaffected-request replay 以及 shared buffer worker 兼容。
- **原始用户反馈循环：** Section 18 保留 incremental correctness、e2e latency、highlight scaling 和 pipeline breakdown 验证。
- **范围约束：** 计划估算 6 个 production source files、5 个 test files/scripts、550–850 effective production lines，满足不超过 8 个代码文件、不超过 1200 行生产代码和少于 10 个测试文件/scripts 的约束；实际 diff 仍需 implementation audit 复核。
- **正向/反向追踪：** Section 13 和 Section 14 对主要生产概念均给出了 requirement、evidence、owner 和测试映射。没有发现新增 parser、fallback、compatibility adapter 或第二数据源未被理由化。

## Primary-path and fallback verdict

计划建立了单一权威 primary path：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode catalog/override/lock
  -> installed @opentui resolver graph
  -> CodeRenderable unified invalidation/snapshot
  -> latest-snapshot scheduling
  -> isolated one-shot worker termination when invalidated
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse contract branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

未发现以下被禁止的 alternate success path：

- parser A 失败后尝试 parser B；
- `createBuffer/updateBuffer` 替代 Code one-shot；
- callback 删除后伪装成底层 request 已取消；
- `drawUnstyledText` 错误逃生路径；
- source checkout 或 native dylib fallback；
- `.3` 发布失败后复用旧 `.2` 作为成功路径；
- parser-error compatibility 扩展为性能 fallback。

隔离 one-shot worker 不是第二语义路径，而是同一 `highlightOnce` public contract 的生命周期实现；通过 replay 保留未取消并发请求的逻辑身份，且不终止共享 buffer worker。该设计符合“一项责任、一个权威语义路径”的要求。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有 implementation diff，因此无法计算实际 `E/C`，也无法确认最终：

- TypeScript 类型和 repository style；
- Zig/native 编译与测试；
- package family 构建和 checksum；
- installed resolver graph；
- release provenance；
- 中文解释性注释硬门槛。

计划已经承诺在 implementation audit 中重新计算：

```text
C >= max(1, ceil(E * 0.15))
```

并将合格注释限定在 stable-boundary、synthetic newline、fence、formula pass-through、immutable snapshot、native offset、termination 和 stale-completion 等真实约束附近。该承诺可执行，但不能替代后续实际 diff 审计。

## Release verdict

**APPROVE**

本 verdict 仅适用于当前精确的 **R10** canonical plan revision，且仅表示 **full-scope plan audit 通过**。

- 当前计划状态仍应为 `audit-required`，`Approved revision` 在记录本 verdict 时才能按仓库流程设置为 R10。
- 本 verdict 不授权超出 R10 的实现、额外 fallback、额外文件或额外远程副作用。
- 远程 staged release 只能在 source/local package preflight 和对应独立审计通过后执行。
- 实现完成后仍必须通过针对 R10 和实际 implementation diff 的独立 full-scope implementation audit，包含测试结果、runtime closure、release provenance、fallback inventory、workaround 删除以及实际 `E/C` 计算。
````

R10 is the exact approved plan revision. Implementation is authorized only under the approved-plan-only workflow and the later independent implementation audit.

## R9 Authorization Clarification

The R9 blocking finding treated the user's earlier “11个assets” wording literally. The subsequent user clarification is recorded verbatim in Section 1.1 and explicitly authorizes the existing workflow's actual set: 11 package tarballs plus `SHA256SUMS`. The checksum manifest remains required by `verify-release-packages.ts`, and the existing release workflow publishes it alongside the 11 tarballs. This is a scope clarification, not a new production fallback or release path.

### Round 11 Implementation-Phase Plan Revision

During the first R10 full JavaScript release-suite run, the approved `CodeRenderable` path exposed a reachable test-seam contract that was not explicit in the R10 file list. `CodeRenderable.highlightWithAbort` now passes the public optional `AbortSignal` to every `TreeSitterClient.highlightOnce` call. The existing `MockTreeSitterClient` override in `packages/core/src/testing/mock-tree-sitter-client.ts` still accepts only the old two-argument shape and retains aborted promises in `_highlightPromises`.

This divergence is observed and reproducible: the complete core JavaScript suite produced `4980 pass / 23 skip / 4 fail / 1 error`; the two Diff regressions fail independently, and the setter-based ScrollBox visibility test fails independently. Each failing path uses `MockTreeSitterClient`; `Code.test.ts` and the TreeSitter client suite pass independently. The first divergence is the test double's pending-request bookkeeping after an AbortSignal-triggered cancellation, not the production `Diff` or ScrollBox layout owner. The minimal approved correction is to extend that existing test double's public override to accept the signal, remove the pending entry on abort, clear its timer/listener, and reject the logical request with `AbortError`, matching the already-approved one-shot lifecycle contract. This is test infrastructure alignment, not a production fallback or alternate success path.

R11 adds one existing test-support file to the approved test seam. It remains within the user's fewer-than-ten test-file constraint and does not widen production ownership, package API, parser protocol, or release scope. The prior R10 approval is cleared pending full-scope plan re-audit.

### Round 11 Independent Verdict (verbatim record)

````text
## Blocking findings

### B-01 稳定前缀缓存会错误冻结可被后续 reference definition 改变的 Markdown 语义

- **Violated invariant:** `INV-03` 要求已缓存的 stable prefix 在后续 append 后语义不再改变；`INV-04` 要求 reference 等 Markdown 结构最终等价于完整解析结果。当前计划的 boundary 规则不能满足 Markdown reference definition 的向前解析语义。
- **Evidence class:** reachable
- **Producer and execution path:** OpenCode 的 assistant Message Part delta 按 append-only 方式进入 streaming `CodeRenderable`。当内容出现真实空行时，计划允许将此前内容切入 stable prefix cache；后续 delta 仍可追加 `[label]: URL` 或 `[text][label]` 的 reference definition。
- **Source evidence:**
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:154-159`：append-only Markdown、reference 跨 delta 和 Code Markdown seam 被列为支持域。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:255-258`：stable boundary 的生产规则只明确处理真实空行、fence、frontmatter、synthetic newline 和 tail；没有 reference-definition 状态或未决 reference label 规则。
  - `.temp/testing/tui-perf/stable-prefix-adversarial.ts:117-120`：现有诊断材料已经明确包含 `link_ref_definition_late`、`link_ref_used_before_defined` 和 `footnote_definition_late` 这类会反向影响此前文本的输入。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:718-768`：当前 proposed/WIP boundary 实现以空行、fence 和 frontmatter 判定 `stablePrefixEnd`，没有扫描或保存 reference-definition 依赖状态；`line 746-748` 会在空行后直接推进缓存边界。
  - `thirdparty/opentui/packages/core/src/renderables/Markdown.ts:8`、`:545-560`：现有 Markdown owner 使用 `marked` 并对 link token 执行语义渲染，因此 reference 解析会产生用户可见的 link/conceal/style 差异，而不是仅影响内部 metadata。
- **Canonical-plan evidence:** Section 10.2、`INV-03`/`INV-04`、Section 13 的 Markdown differential 映射、Section 16 的 stable-boundary slice。
- **Responsibility owner:** `CodeRenderable` 的 Markdown stable-boundary/cache seam。`CodeRenderable` 决定何时把 prefix 从未来解析中移出；Tree-sitter worker 只负责给它提交的片段产生 highlights，不能恢复已经被错误缓存的前缀语义。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 对如下可达流式输入：

  ```markdown
  See [foo] here.

  [foo]: https://example.com
  ```

  计划可能先缓存 `See [foo] here.\n\n` 的结果，再追加 reference definition。后续完整 Markdown 解析会把此前 `[foo]` 解析为 reference link，而 stable-prefix 路径继续复用旧的未解析结果，导致最终 highlights、conceal 文本、link metadata 或 `onChunks` 输出不同于完整解析。该问题直接违反 `INV-03`/`INV-04`，并且会影响用户可见文本。
- **Why this is not speculative:** 这是 Markdown 的既有 reference 解析行为；producer 是当前真实的 append-only Message Part stream，输入样例已经存在于仓库的 adversarial harness 中。该问题不依赖未来 grammar、恶意输入或假想调用者。
- **Minimal correction direction:** 在 `CodeRenderable` 的唯一 stable-boundary owner 中补齐 reference-definition 依赖的闭合规则：任何仍可能被后续 definition 改变的 reference 使用不得被标记为 stable，或必须让相应依赖区域继续保留在 full-context tail 中。该规则必须由最终 `CodeRenderable` public output differential 测试锁定，不能只增加一个内部 highlight tuple 测试，也不能通过 parser fallback 或第二解析路径规避。

## Non-blocking findings

### N-01 termination failure 的公开 diagnostic contract 仍未完全定义

Section 10.1、Section 20 和历史 R10 记录要求 `PlatformWorkerHandle.terminate()` 失败时进入明确的 diagnostic/unavailable 状态，但没有固定：

- `CodeRenderable` 对外暴露的错误或 unavailable seam；
- 当前 snapshot 是否继续保持 dirty；
- 后续新 snapshot 如何重新获得可见结果；
- OpenCode `TextPart` / `ReasoningBody` 如何观察该状态。

这目前属于计划执行精度问题；但实现审计时不能仅接受 `console.error` 或旧文本显示作为完成证据，也不能把 plain-text fallback 当作新的成功路径。

### N-02 full JavaScript baseline 的 release-stop 条件仍不够可执行

计划记录了历史的 `4978 pass / 23 skip / 1 fail / 1 error` 基线，并要求隔离 TreeSitter 并发噪声，但没有把以下条件写成明确的 release gate：

- 哪些失败必须在实现前后各自复现；
- 哪些失败可以被认定为既有环境噪声；
- 任意无法归因的失败是否停止发布；
- “full suite green”与“已知隔离基线”的关系。

这不构成本轮行为 blocker，但实施审计必须按命令和测试名称给出可复核判定，而不能只引用“并发环境噪声”。

### N-03 native focused filter 仍依赖未来测试名

Section 18.3 使用：

```text
-Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"
```

当前仓库尚未存在该测试。实施时需要证明：

1. 新测试名完全匹配；
2. 零匹配时命令确实失败；
3. 完整 native regression 仍然执行。

这是验证命令精度问题，不是已观察到的生产行为缺陷。

### N-04 计划历史记录较长，当前 R11 状态容易与历史 approval 混淆

Section 22 保留了 R1–R10 的完整 verdict，Section 23 又记录 implementation-phase WIP。虽然文件头已经明确：

```text
Status: audit-required
Revision: R11
Approved revision: none
```

但后续实施或审计引用历史 `APPROVE` 时，必须明确限定为对应历史 revision，不能把 R10 approval 或当前工作树 WIP 当作 R11 approval 或 implementation evidence。

## Rejected speculation

- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query。当前用户要求的是公式及跨行公式的 pass-through 稳定性，计划保留普通文本语义是合理的。
- 没有要求把所有 streaming 路由切换为现有 `MarkdownRenderable`。`ReasoningBody` 依赖 `CodeRenderable.onChunks` 的可见文本反馈，整路由切换会改变现有布局责任。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching 认定为 first divergence。当前证据仍直接指向 `CodeRenderable` 全文异步 highlight、`TextBuffer.setStyledText` 和 native 全量 line walk。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、source import/native dylib fallback 或 `drawUnstyledText` 错误逃生路径。
- 没有把 synthetic native handle ceiling 列为 blocker。当前材料没有证明真实 OpenCode Session producer path 能达到该阈值。
- 没有把当前工作树中的 OpenTUI WIP 当作已批准 implementation evidence；计划自身也明确其不能替代 R11 approval。

## Requirement and traceability coverage

| Requirement / invariant | Audit result |
|---|---|
| TUI 卡顿、阻塞和渲染热点 | 覆盖充分。计划重建了 Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native 链路，并引用 e2e、scaling、pipeline breakdown 和 native A/B 证据。 |
| delta/streaming 最新内容收敛 | 覆盖方向正确。`INV-01`、`INV-02`、`INV-11` 及隔离 one-shot worker termination/replay 处理了连续 hung request 和 detached work 问题。 |
| 禁止 delta-only Markdown 解析 | 覆盖充分。计划明确保留 stable prefix + full-context tail，且将 naive buffer-mode update 列为禁止路径。 |
| table、partial row、open/closed fence、长代码 | 有 producer、owner、cache 规则和 TDD 映射；实现阶段仍须证明最终 `CodeRenderable` / OpenCode public output，而非只证明 highlights。 |
| blockquote/list/setext/emphasis | 被列入支持域和测试计划，但 boundary 规则仍偏概括；需要实现阶段用最终 public output 验证。 |
| reference definition | **当前覆盖不足。** 输入域和测试名存在，但生产 stable-boundary 设计没有 reference dependency/closure 规则，形成 B-01。 |
| 跨行公式和公式 pass-through | 覆盖充分。计划明确不新增 math AST，并列出 `$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\)`、`\\begin...\\end...` 五类 literal 形态。 |
| public async setter invalidation | 覆盖充分。`INV-06` 已包含 content、filetype、style、conceal、streaming、client、callbacks 等公开输入。 |
| native bounded traversal | owner、first divergence 和边界测试映射明确；focused filter 仍需实现阶段固定。 |
| non-Markdown/non-streaming/callback/parser-error compatibility | 计划保留既有 full parse 和既有 parser-error compatibility，未新增 parser-after-parser success path。 |
| source/release/runtime closure | 覆盖充分。11 个 npm tarballs 加 `SHA256SUMS`、即 12 个 GitHub assets 的授权边界已闭合，并包含 resolver、lock、provenance 和 installed consumer。 |
| 文件和行数约束 | 计划估算 6 个生产 source files、6 个测试文件/scripts、550–850 effective production lines，表面满足用户限制；实际 diff 仍需 implementation audit 复核。 |
| TDD 与验证 | 主要路径都有 red-capable slice；reference boundary 的具体生产规则尚未闭合，因此当前不能批准进入实现。 |

## Primary-path and fallback verdict

计划总体建立了单一 primary path：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode resolver/lock
  -> CodeRenderable unified snapshot invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

未发现新增的 parser A → parser B、plain-text catch-and-success、source fallback、native dylib fallback 或 `createBuffer/updateBuffer` 替代成功路径。

但 stable-prefix branch 当前把“真实空行后即可缓存”作为主要闭合依据，未覆盖 reference definition 对此前 inline Markdown 语义的反向影响。因此该 primary path 仍有一个可达的语义分叉，不能在当前 R11 revision 下批准。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有可审计的 approved implementation diff，因此不能计算实际 `E/C`，也不能确认：

- TypeScript/Zig 类型和 repository style；
- native build/test；
- package family 和 checksum；
- installed resolver graph；
- release provenance；
- 中文解释性注释比例。

计划已经承诺实现阶段重新计算：

```text
C >= max(1, ceil(E * 0.15))
```

并将注释集中在 snapshot、stable boundary、synthetic newline、fence、formula pass-through、native offset、termination 和 stale completion 等真实约束附近。该承诺符合 plan-mode 要求，但不能替代 implementation audit。

## Release verdict

**BLOCK**

当前精确审计对象是 canonical plan **R11**，状态为 `audit-required`，`Approved revision: none`。

R11 已补充 AbortSignal 测试替身边界，也保留了完整 runtime closure、isolated worker termination、native bounded traversal 和 primary-path 约束；但是 stable-prefix Markdown 设计没有为可被后续 reference definition 改变的前缀语义建立闭合规则。该缺口直接违反 `INV-03`/`INV-04` 和用户要求的 reference 完整覆盖。

必须修订 canonical plan、递增 revision，并进行下一轮完整 scope plan audit 后，才能进入实施。
````

### R12 Plan Revision

R11 auditor 的 B-01 是一个 confirmed reachable Markdown semantic gap，必须修复 stable-boundary owner，而不能由测试替身或 parser fallback遮盖。R12 将 stable-prefix 规则收紧为：在 streaming Markdown 内容中，只要一个非-fence行包含可能形成 reference usage 的 bracket construct，就把该行及其后续内容保留在 full-context tail 中；reference definition 行本身不被当作普通 usage，但不会让此前已被缓存的行重新获得语义。该保守边界不尝试复制 `marked` 的 reference resolver，也不增加第二 parser。

R12 新增一个最终 `CodeRenderable` public-output differential case，输入先输出 reference usage，随后追加 definition，独立 full parse oracle 必须与 streaming settled output相同。没有 evidence 证明其它 bracket 形态可安全提前闭合，因此它们继续留在 tail；这是性能可控的 conservative contract，不是 speculative parser state。

R12 保留 R11 的 `MockTreeSitterClient` test-seam修复范围，同时新增 stable-boundary owner和public differential test的可执行映射。Production source files和test files/scripts仍分别为6和6，预计effective production范围保持在用户约束内。R11 approval已由 blocker清空，当前不得实施，直到R12获得新的full-scope plan audit approval。

### Round 12 Independent Verdict (verbatim record)

````text
## Blocking findings

### B-01 当前 canonical plan 与实际 repository baseline 已发生实质性漂移

- **Violated invariant:** 计划必须基于当前可审计的 source、tests 和真实 producer-to-consumer path；实现前的 root cause、red-capable feedback loop、文件边界和 verification baseline 必须与当前 repository 状态一致。
- **Evidence class:** observed
- **Producer and execution path:** 当前 `CodeRenderable` 已经包含 unified invalidation、AbortController、Markdown prefix cache、snapshot capture 和 dedicated one-shot worker 调度；当前 `TreeSitterClient` 也已经包含 isolated one-shot worker、termination、request replay/rejection 等 WIP 行为。后续实施若以计划描述的“旧 baseline”继续追加 R12 设计，会把已存在的 WIP 行为当作未实现行为再次设计或覆盖。
- **Source evidence:**
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:308-315` 已实现 unified invalidation、generation 和 abort。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:378-501` 已实现 snapshot、Markdown branch、AbortSignal、stale checks 和 termination-error 分支。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:718-768` 已存在 `stablePrefixEnd`。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:177-305` 已存在 isolated one-shot worker lifecycle、termination 和 replacement。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:670-714` 已公开接受 `AbortSignal`。
  - 计划却仍将 `docs/plans/opentui-streaming-markdown-performance-repair.md:126-148` 的旧行为作为当前行为，并在 `:1664-1682` 明确记录 implementation evidence 为 N/A。
- **Canonical-plan evidence:** Sections `5`, `8`, `15`, `16`, `22`, `23`。
- **Responsibility owner:** canonical plan 的 baseline、approved revision 和 implementation-boundary owner；不是后续实现者自行决定如何合并当前 WIP。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** R12 没有一个唯一明确的可实施 starting state。若把当前 WIP 保留，计划中的 red tests、first divergence 和 expected diff 已不再描述真实行为；若丢弃 WIP，又缺少经当前 source 重现的 red evidence。继续实施会导致重复生命周期实现、错误的 TDD判断或未授权地覆盖 dirty worktree 中的其他行为。
- **Why this is not speculative:** 当前 source 中的相关实现可以直接观察到，且 repository 状态明确包含多个 OpenTUI WIP 文件。计划自身也承认这些 WIP 存在，但没有把它们与 R12 的精确 baseline、保留范围和行为差异逐项闭合。
- **Minimal correction direction:** 在 canonical plan 中重新建立当前工作树的可审计 baseline：明确哪些 WIP 行为属于 R12 必须保留、哪些必须删除、哪些是 R12 尚未实现的差异；重新证明 first divergence、red-capable tests、file-level diff 和 verification commands。不得在未解决 baseline 漂移时批准 R12 或进入实施。

### B-02 termination failure 的用户可见 diagnostic/unavailable contract 仍没有可执行 owner 或行为 seam

- **Violated invariant:** 所有确认的 reachable behavior 必须有明确的 production owner、公开可观察结果和行为敏感测试；worker termination failure 不得被吞掉、伪装为成功旧内容，或通过 plain-text success fallback 隐藏。
- **Evidence class:** reachable
- **Producer and execution path:** `CodeRenderable` 的 active highlight 被 AbortSignal 取消；`TreeSitterClient` 调用 isolated worker 的 `PlatformWorkerHandle.terminate()`；平台实现明确返回可 reject 的 Promise；termination failure 随后回到 `CodeRenderable.startHighlight()` 的 catch 路径。
- **Source evidence:**
  - `thirdparty/opentui/packages/core/src/platform/worker.ts:192-206`：`terminate()` 返回 Promise，并可能 reject。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:270-304`：replacement termination failure 被转成错误并 reject pending requests。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:466-488`：termination error 当前只 `console.error`，随后仍执行 `textBuffer.setText(snapshot.content)` 并清除 dirty 状态。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:437-440`：计划明确要求 termination failure 进入 diagnostic/unavailable、保留 dirty、不得显示旧 snapshot 为成功。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:1526-1535`：计划承认没有定义公开错误/unavailable seam、dirty 行为或后续 snapshot 收敛方式。
- **Canonical-plan evidence:** Sections `10.1`, `13`, `16.7`, `20`, `23`。
- **Responsibility owner:** `CodeRenderable` 的 public rendering/error contract；`PlatformWorkerHandle` 只拥有 worker 生命周期，不拥有 TUI 用户可见状态。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** termination failure 的实际结果仍可能是显示无样式的当前内容并标记 `_highlightsDirty = false`，这与计划要求的 diagnostic/unavailable 和“不得表现为成功旧内容”不一致；同时没有可由 `TextPart`/`ReasoningBody` 或测试观察的明确状态，因此该 failure path 既可能隐藏 worker 生命周期故障，也可能永久停止后续 dirty snapshot 收敛。
- **Why this is not speculative:** `terminate()` 的 rejection 是现有平台接口的可达结果，且计划已经把 termination failure 纳入必需 production behavior。计划当前只描述禁止行为，没有定义实际 interface contract 或可验证的 visible outcome。
- **Minimal correction direction:** 在 `CodeRenderable` 所拥有的既有公开错误/渲染观察 seam 中，固定 termination failure 的明确状态、dirty 保留和后续 snapshot 行为，并添加通过该 seam 验证的行为测试。不得以 `console.error`、旧内容显示或 plain-text fallback 代替 diagnostic contract。

## Non-blocking findings

- `docs/plans/opentui-streaming-markdown-performance-repair.md:1658-1662` 对 reference boundary 的描述已经比 R11 保守，但“possible reference usage bracket construct”仍不是可直接执行的判定定义。由于计划允许保留更长 tail，这目前属于实施精度问题；实现审计必须验证最终 `CodeRenderable` public output，而不是仅验证 raw highlight tuples。
- `Section 18.3` 的 native focused filter 仍依赖未来测试名称：`walkLinesInCharRange - matches full walk for bounded ranges`。实施阶段必须证明名称精确匹配、零匹配会失败，并继续执行完整 native suite。
- `Section 18` 和 `Section 20` 记录过 full JavaScript baseline failure，但尚未把“无法归因的失败必须停止 release”写成明确 command-level gate。实现审计不能仅以“并发噪声”概括。
- 当前计划仍以 `550–850` 行作为 `E` 估算；实现审计必须根据实际 diff 重新计算 `E`/`C`，不能继承该估算。

## Rejected speculation

- 没有将 synthetic native handle ceiling 列为 blocker；当前材料没有证明真实 OpenCode `Session` producer path 可达该阈值。
- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query；当前计划保留公式及跨行公式的普通文本/pass-through 语义，符合已读 parser evidence。
- 没有要求把默认 streaming route 整体切换到 `MarkdownRenderable`；`ReasoningBody` 对 `CodeRenderable.onChunks` 的依赖使该切换改变现有布局责任。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、source import、native dylib 或旧 release fallback；这些作为 alternate success paths 被拒绝是正确的。
- 没有把 OpenCode `sync.tsx` 的 16ms producer batching单独认定为 first divergence；当前证据仍指向 `CodeRenderable` 全文高亮、`TextBuffer.setStyledText` 和 native 全量 line traversal。

## Requirement and traceability coverage

| Requirement / invariant | Audit result |
|---|---|
| TUI 卡顿、阻塞和热点诊断 | 有真实 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 链路及 benchmark evidence；但当前 plan baseline 已与实际 WIP source 漂移。 |
| 最新 delta 收敛、连续 hung request | `INV-01`、`INV-02`、`INV-11` 映射了 latest snapshot、isolated worker termination 和 replay；必须先解决当前 WIP 与 plan baseline 的冲突。 |
| 禁止 delta-only Markdown 解析 | 明确拒绝 naive delta-only parsing，并采用 stable prefix + full-context tail。 |
| table、partial row、open/closed fence、长代码 | 有 boundary 规则、TDD slice 和 differential 映射；最终必须覆盖 public output。 |
| blockquote、list、setext、emphasis | 被列入支持域和测试映射，但 boundary 规则较概括，须由最终 public-output differential 验证。 |
| reference definition | R12 已针对 R11 blocker 收紧规则，但其执行判定仍需实现阶段精确定义；不是本轮主要 blocker。 |
| 跨行公式及公式 pass-through | 覆盖充分，且没有引入新的 math semantics。 |
| public async setter invalidation | 计划覆盖全部列出的 public inputs；但这些行为已部分存在于当前 WIP，不能继续使用旧 baseline 声称其尚未实现。 |
| native bounded traversal | owner、first divergence、等价性测试和 A/B evidence 有映射。 |
| non-Markdown/non-streaming/callback/parser-error compatibility | 计划保留既有 parser-error plain-text compatibility；该路径需与用户给出的“禁止 parser/fallback/escape paths”约束明确区分，不能在实现阶段默认扩大为新的 fallback。 |
| source/release/runtime closure | 11 个 npm tarballs 加 `SHA256SUMS`、12 个 GitHub assets、root lock、provenance 和 installed consumer 均有映射。 |
| termination failure | **覆盖不足且构成 B-02**：计划提出 diagnostic/unavailable 要求，但没有公开 seam、状态转移或行为测试 contract。 |
| 文件和规模约束 | 计划估算 6 个 production source files、6 个 test files/scripts、550–850 effective production lines，表面满足用户限制；实际 diff 尚未可审计。 |
| TDD 与验证 | 多数 slices 具备 red-capable方向，但当前 WIP 漂移使现有 red evidence不能直接证明 R12 的当前 defect。 |

## Primary-path and fallback verdict

计划目标上的 primary path 是：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode resolver/lock
  -> CodeRenderable snapshot/invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

没有发现计划新增 parser A → parser B、delta-only parser、source fallback、native dylib fallback 或旧 release fallback。

但是当前不能批准：

1. 实际 source 已包含未纳入 R12 精确 baseline 的 WIP primary-path行为；
2. termination failure 的 diagnostic/unavailable 分支没有可执行公开 contract，且当前可见实现仍把该错误转入 plain-text success-shaped rendering。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有 approved implementation diff，因此不能计算实际 `E/C`，也不能确认：

- TypeScript/Zig style 和类型正确性；
- native build/test；
- package family/checksum；
- installed resolver closure；
- release provenance；
- 中文解释性注释硬门槛。

计划已承诺实现审计时重新计算：

```text
C >= max(1, ceil(E * 0.15))
```

该承诺不能替代实际 diff 审计。

## Release verdict

**BLOCK**

当前精确审计对象是 canonical plan **R12**。R12 覆盖了原始 TUI 性能问题、latest-snapshot 调度、禁止 delta-only Markdown 解析、table/fence/blockquote/list/setext/reference/emphasis/长代码/公式 pass-through、native bounded traversal 及完整 release/runtime closure。

但当前 revision 仍不能批准：

- plan 的旧 baseline、red evidence 与实际 dirty WIP source 不一致，导致实施起点和 approved diff 不可唯一确定；
- termination failure 的用户可见 diagnostic/unavailable contract 未落到明确 owner、公开 seam 和行为测试。

该 canonical plan 必须递增 revision 并进行下一轮完整 scope plan audit。
````

### R13 Plan Revision

R13 将当前工作树明确作为唯一 implementation starting state，不再把已存在的 WIP 当作“尚未实现”的旧 baseline，也不删除或覆盖父仓库无关修改。当前需保留并先复核的 nested OpenTUI WIP files 是：`Code.ts`、`Code.test.ts`、`tree-sitter/client.ts`、`client.test.ts`、`client-worker.fixture.ts`、`text-buffer-iterators.zig`、`text-buffer.zig`、`text-buffer-iterators_test.zig`、以及现有 `.3` lockstep package manifests和nested lock。R13 不重新设计这些已存在行为；它只在当前 diff上完成尚未闭合的 test-seam、reference boundary、termination diagnostic、parent/runtime closure和验证。

R13 的 termination contract由 `CodeRenderable` owner承载：增加公开 `highlightUnavailable` 状态和 `highlight-error` EventEmitter seam；termination failure只把当前 source snapshot作为未高亮文本显示，不提交旧 highlights、不调用成功 callback，并保持 dirty/unavailable状态以阻止自动重试风暴。新的 public setter/snapshot 到达时清除 unavailable状态并重新进入同一 latest-snapshot primary path；因此后续 snapshot有明确收敛入口。行为测试必须通过该公开状态和事件观察，而不是只检查 `console.error`。

R13 的 reference boundary继续采用保守 full-context tail：实现将定义可执行的 bracket/reference usage判定，并让命中行及其后续内容不进入stable prefix；fence内容和既有 non-Markdown/full-parse branch不被该判定误伤。最终 differential必须先输出reference usage、再追加definition，并比较 `CodeRenderable` public output与独立full-parse oracle。

R13 新增的 WIP baseline evidence：

- `bun test ./src/renderables/Code.test.ts`：`64 pass / 1 skip / 0 fail`（在R12后最新diagnostic test加入前后需重跑）；
- `bun test ./src/lib/tree-sitter/client.test.ts`：`49 pass / 0 fail`；
- `bun run test:native`：`1689 pass / 2 skip`；
- full core JS release suite：`4980 pass / 23 skip / 4 fail / 1 error`，其中两个 Diff测试与setter-based ScrollBox测试可单独复现；该结果是R13 red gate，不能发布；
- OpenCode `bun typecheck`：通过；
- OpenTUI full build、cross-native build和Solid/keymap suites：通过；packed dist smoke受本机仅有Node `v24.13.0`而脚本要求Node `v26.3.0`阻塞，必须在Node26环境重跑。

R13 将 verification gate固定为：任何 full JS failure 若不能由实现前同一测试/命令复现、或不能由已记录的环境前置条件直接解释，均停止 release；只允许在独立命令、测试名、前后结果和原因证据全部记录后分类为既有噪声。当前4 failures/1 error尚未获得该分类。

R13 不新增 parser、math renderer、source/native fallback、旧release fallback或OpenCode TUI route；production source files和test files/scripts仍分别为6和6，parent release closure仍按原R10用户授权顺序执行。

### Round 13 Independent Verdict (verbatim record)

````text
## Blocking findings

### B-01 终止失败分支仍然产生 success-shaped plain-text fallback，违反用户明确禁止的 fallback/escape path

- Violated invariant: 终止 isolated one-shot worker 失败时，系统必须进入可观察的 diagnostic/unavailable 状态，不能把未高亮文本作为成功结果提交；用户明确要求禁止 `parser/fallback/escape paths`，而 policy 也禁止 diagnostic path 产生 success-equivalent output。
- Evidence class: contracted
- Producer and execution path: `CodeRenderable` 的 streaming highlight 在收到新 snapshot 后 abort 当前 one-shot；`TreeSitterClient` 终止 isolated worker；若 `PlatformWorkerHandle.terminate()` 失败，错误回到 `CodeRenderable` 的终止错误分支。
- Source evidence:
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:1800-1804`：R13 明确要求 termination failure 时“显示当前 source snapshot 作为未高亮文本”。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:437-440`：同一计划又要求该 failure 进入 diagnostic/unavailable，不能通过旧内容或 fallback 隐藏故障。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:477-487`：当前 WIP 对 `TreeSitterWorkerTerminationError` 记录日志后执行 `textBuffer.setText(snapshot.content)`，并将 `_highlightsDirty` 设为 `false`。该代码属于当前 dirty baseline，不是批准实现，但直接证明该计划文字会自然落入这一行为。
  - `.opencode/policy/first-principles-engineering.md:129-142`：diagnostic path 不得产生 success-equivalent output、隐藏 primary-path failure 或成为第二生产算法。
  - `.opencode/policy/first-principles-engineering.md:236-273`：禁止 alternate success path；diagnostic path 也不能隐藏失败。
- Canonical-plan evidence: Section 22 `R13 Plan Revision`，尤其 `docs/plans/opentui-streaming-markdown-performance-repair.md:1800-1804`；同时与 Section 10.1 `:243-249`、Section 20 `:437-440` 冲突。
- Responsibility owner: `CodeRenderable` 的公开渲染结果与错误/不可用状态接口；`PlatformWorkerHandle` 和 `TreeSitterClient` 只负责 worker 生命周期及请求生命周期，不应决定 TUI 是否把未高亮文本视为成功。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当终止失败发生时，用户仍会看到当前内容，并且该 snapshot 被标记为非 dirty；从用户可见渲染结果看，这与“高亮失败后回退到普通文本”没有可区分的成功语义。它既绕过了无法完成的 primary highlight path，也可能阻止后续自动收敛。仅增加 `highlightUnavailable` 状态或 `highlight-error` 事件，不能抵消已经提交的 success-shaped plain-text output；调用者若继续把 `plainText` 当作正常内容显示，失败仍被隐藏。
- Why this is not speculative: 这是用户对 fallback/escape path 的明确约束，也是 R13 计划自身承诺的 termination diagnostic contract；当前 WIP 已展示了该错误分支的实际执行形状。该结论不依赖假想输入，只依赖计划明确纳入的可 reject `terminate()` 结果。
- Minimal correction direction: termination failure 必须只通过 `CodeRenderable` 所有者定义的 typed unavailable/error seam 暴露，并保持当前 snapshot dirty；不得在该 diagnostic 分支提交可被正常渲染路径视为成功的未高亮文本。后续新 snapshot 应重新进入同一 authoritative highlight primary path。现有 parser-error 兼容行为如需保留，必须继续限定为既有、独立且有真实消费者的兼容契约，不能扩展到 worker termination failure。

## Non-blocking findings

- `docs/plans/opentui-streaming-markdown-performance-repair.md:1821` 仍写着“Complete only after the approved R10 revision is implemented”，而当前 canonical revision 是 R13；这会造成历史 approval、当前 revision 和 implementation evidence 的阅读混淆，但不单独构成行为 blocker。
- R13 的 `highlightUnavailable` 与 `highlight-error` seam 已指定 owner 和观察方向，但尚未固定事件 payload、一次 termination failure 后的状态读取/清除时序，以及 `TextPart`/`ReasoningBody` 是否实际订阅该 seam。实施阶段必须用公开行为验证，而不能只验证内部布尔值。
- `docs/plans/opentui-streaming-markdown-performance-repair.md:1707` 所记录的 reference boundary 判定仍然较概括。保守地保留更长 tail 的方向可成立，但实现阶段必须证明 reference usage、definition、fence 内文本和普通 bracket 文本的最终 `CodeRenderable` 输出等价。
- `Section 18.3` 的 native focused filter 依赖未来测试名 `walkLinesInCharRange - matches full walk for bounded ranges`；实施阶段需证明精确匹配、零匹配失败，以及完整 native regression 仍执行。
- Full JavaScript baseline 的失败分类 gate 已在 R13 中改善，但仍须在 implementation audit 提供实现前后同一命令、测试名和环境原因证据；不能仅把失败概括为并发噪声。

## Rejected speculation

- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query；当前公式及跨行公式保持普通文本/pass-through 语义符合已读 parser evidence。
- 没有要求把所有 streaming 路由切换到 `MarkdownRenderable`；`ReasoningBody` 对 `CodeRenderable.onChunks` 的现有依赖证明整体切换会改变接口责任。
- 没有把 synthetic native handle ceiling 列为 blocker；当前材料没有真实 OpenCode `Session` producer path 证明该阈值可达。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、source import、native dylib 或旧 release fallback；这些被计划正确列为禁止路径。
- 没有把 16ms producer batching 单独认定为 first divergence；现有 benchmark 证据更直接指向全文 highlight、`setStyledText` 和 native 全量 line traversal。

## Requirement and traceability coverage

- TUI 卡顿、阻塞及热点诊断：覆盖充分，计划重建了 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 链路，并提供 baseline、scaling、pipeline breakdown 和 native A/B 证据。
- 最新 snapshot 收敛、连续 hung request、isolated worker termination 和并发 replay：已映射到 `INV-01`、`INV-02`、`INV-11` 及对应 TDD slices。
- 禁止 delta-only Markdown 解析：覆盖充分；stable prefix + full-context tail 明确保留未闭合上下文。
- table、partial row、open/closed fence、长代码：有 boundary 规则、owner 和 public-output differential 测试映射。
- blockquote、list、setext、reference、emphasis：已列入 supported domain 和测试计划；reference boundary 已针对上一轮 blocker 收紧，但实现仍需证明最终 public output。
- 跨行公式及公式 pass-through：覆盖充分，且没有虚构 math AST。
- public async setter invalidation：`INV-06` 覆盖列出的公开输入，并映射到 immutable snapshot 与 stale checks。
- native bounded traversal：owner、first divergence、等价性及 CJK/tab/empty/trailing-line 边界均有映射。
- non-Markdown、non-streaming、既有 callback 和 parser-error compatibility：计划明确保留，但必须避免把既有 parser-error compatibility 扩展成新的 termination/plain-text fallback。
- source/release/runtime closure：11 个 npm tarballs 加 `SHA256SUMS`、12 个 GitHub assets、root lock、provenance 和 installed consumer 均有映射。
- termination failure：当前仍覆盖不足，原因是 R13 同时要求 diagnostic/unavailable，又要求提交未高亮文本，违反 primary-path/fallback 硬门禁。
- 文件与规模约束：计划估算 6 个 production source files、6 个 test files/scripts、550–850 effective production lines，表面满足用户限制；实际 diff 仍需 implementation audit 重算。
- TDD 与验证：大部分 slice 具备 red-capable 方向；termination failure slice 必须先消除 plain-text success-shaped 行为冲突，才能成为可接受的绿色目标。

## Primary-path and fallback verdict

计划总体建立了单一 primary path：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode resolver/lock
  -> CodeRenderable snapshot/invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

未发现新的 parser A → parser B、delta-only parser、source fallback、native dylib fallback 或旧 release fallback。

但 termination failure 分支仍然绕过该 primary path，将未高亮文本提交为用户可见结果，并清除 dirty 状态。即使它被命名为 diagnostic/unavailable，只要该文本进入正常渲染结果，就仍是 success-shaped escape/fallback path。因此当前 R13 的 primary-path contract 尚未闭合。

## Code quality and Chinese-comment verdict

这是 plan audit，没有 approved implementation diff，因此：

- 无法计算实际 `E/C`；
- 无法确认最终 TypeScript/Zig style、类型和 dead-code 状态；
- 无法确认 native、package、lock、release provenance 和 installed resolver 验证；
- 无法确认 termination diagnostic seam 是否真正被测试和消费者使用；
- 计划中的 `C >= max(1, ceil(E * 0.15))` 只能作为实现阶段承诺，不能替代实际 diff 审计。

## Release verdict

**BLOCK**

当前精确审计对象是 canonical plan **R13**，状态为 `audit-required`，`Approved revision: none`。

R13 已覆盖原始 TUI 性能问题、latest-snapshot 调度、禁止 delta-only Markdown 解析、table/fence/blockquote/list/setext/reference/emphasis/长代码/公式 pass-through、native bounded traversal 以及完整 release/runtime closure。

但 R13 的 termination failure 设计仍违反用户明确的 fallback/escape 约束和仓库 primary-path policy：它要求在 worker termination 失败时提交未高亮文本并清除 dirty 状态，同时又声称该分支是 diagnostic/unavailable。必须修订该 authoritative owner 的行为契约和行为测试，再递增 revision 并进行下一轮完整 scope plan audit。
````

### R14 Plan Revision

R14 修正 termination failure 的唯一 primary behavior：终止失败时，`CodeRenderable` 不得把 source snapshot、旧 styled text或任何成功形状的 plain text写入正常内容buffer，不得调用 `onHighlight`/`onChunks`成功回调，也不得清除 dirty。它只通过公开 `highlightUnavailable` 状态和 typed `highlight-error` event发布 diagnostic，并将buffer置为明确的不可用标记文本（例如 `Highlight unavailable`），该标记不是源内容、不是高亮成功结果，也不进入内容成功contract。

失败状态保持到下一次公开 snapshot/state invalidation；在此期间 `renderSelf`不自动重试，避免终止失败形成重试风暴。下一次新的 content/filetype/style/callback/client等snapshot到达时，清除 unavailable标志并重新进入同一 `highlightOnce -> callback -> StyledText` primary path。该状态转移由 `highlightUnavailable` getter、event payload `{ error, content, filetype }`、diagnostic marker和后续snapshot行为测试共同锁定。

R14 保留R13当前dirty WIP baseline reconciliation、reference full-context tail和AbortSignal-aware mock seam，不增加其它生产文件、parser协议、math语义或fallback。plan Section 23 的“approved R10”历史措辞改为“approved current revision”以避免状态混淆。

### Round 14 Independent Verdict (verbatim record)

````text
# Blocking findings

No blocking findings.

# Non-blocking findings

### N-01 R14 的不可用标记仍需明确与正常内容渲染语义隔离

R14 已明确禁止提交 source snapshot、旧 styled text 或 success-shaped plain text，并将 `Highlight unavailable` 定义为 diagnostic marker。这满足当前 primary-path 和 fallback 硬门槛。

但实现阶段仍需证明：

- marker 不会触发 `onHighlight` 或 `onChunks` 成功回调；
- marker 不会被 `content`、`plainText` 或正常 Markdown 输出接口误认为真实内容；
- `highlightUnavailable` 与 `highlight-error` event 的状态读取和清除顺序一致；
- 新 snapshot 到达后，marker 被同一 `highlightOnce -> callback -> StyledText` primary path 替换，而不是继续保留。

计划已经指定这些观察 seam 和行为测试，因此这是实现精度要求，不是当前 plan blocker。

### N-02 稳定前缀边界的执行定义仍较保守且分散

R14 保留了 reference usage 的 full-context tail 规则，但核心 Section 10.2 仍主要列出空行、fence、frontmatter、synthetic newline 等边界，reference 规则主要记录在后续 revision history 中。

该设计仍可成立，因为保留更长 tail 不会破坏正确性；实施阶段必须通过最终 `CodeRenderable` public output 验证，而不能只比较内部 highlight tuples。至少应覆盖：

- reference usage 先出现、definition 后出现；
- definition 先出现、usage 后出现；
- 普通 bracket 文本；
- fence 内的 bracket 文本；
- table、setext、blockquote/list 与 reference 混合；
- callback、conceal 和最终可见文本。

### N-03 Verification 命令仍依赖未来新增测试名称

计划使用：

```text
bun run test:native -Dtest-filter="walkLinesInCharRange - matches full walk for bounded ranges"
```

实现阶段必须证明：

1. 新增测试名称与过滤器完全匹配；
2. 零匹配时命令失败，而不是静默通过；
3. 完整 `bun run test:native` 仍然执行并通过；
4. bounded iterator 与旧 full walk 的行为等价性通过独立 oracle 验证。

这是验证精度问题，不是已观察到的生产行为缺陷。

### N-04 Full JavaScript baseline 的 release-stop 证据仍需在 implementation audit 中闭合

R13/R14 已规定无法归因的 full-suite failure 必须阻止 release，并记录了历史失败：

```text
4980 pass / 23 skip / 4 fail / 1 error
```

实施阶段仍需提供：

- 改动前后同一命令；
- 每个失败的测试名称；
- 独立复现命令；
- 环境前置条件或实现归因；
- TreeSitter 并发 suite 的隔离结果；
- 无法归因的失败是否触发 release stop。

该要求已存在于计划中，故不构成 R14 的阻塞缺陷。

### N-05 计划中的 E/C 仍只是估算

R14 为 plan audit，尚无实现 diff，无法实际计算中文注释硬门槛。实现审计必须重新计算：

```text
E = 所有 substantive production/test/configuration changed lines
C = 邻近且解释真实约束的中文注释行
C >= max(1, ceil(E * 0.15))
```

不得直接沿用计划中的 `E=550–850`、`C=83–128` 估算。

# Rejected speculation

- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar 或 math query。当前计划保留 `$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]`、`\\begin...\\end...` 的普通文本/pass-through 语义，符合原始要求和当前 parser 证据。
- 没有要求把所有 streaming 路由切换到 `MarkdownRenderable`。现有 `ReasoningBody` 和 `TextPart` 依赖 `CodeRenderable.onChunks`，整体切换会改变既有布局和反馈责任。
- 没有将 OpenCode 的 16ms producer batching 认定为 first divergence。现有证据更直接指向 `CodeRenderable` 全文高亮、`TextBuffer.setStyledText` 和 native 全量 `walkLines`。
- 没有要求保留 naive `createBuffer/updateBuffer`、parser-after-parser、source import、native dylib、旧 `.2` release 或 plain-text success fallback。这些路径已被正确列为禁止的 alternate success paths。
- 没有将 synthetic native handle ceiling 列为 blocker。当前没有真实 OpenCode Session producer trace 证明该阈值在目标调用路径中可达。
- 没有将当前 dirty WIP 本身视为 R14 implementation evidence。R14 已明确要求实施前从当前 dirty baseline 复核并保持 parent 无关 dirty 内容。

# Requirement and traceability coverage

| Requirement / invariant | Audit result |
|---|---|
| TUI 卡顿、阻塞和渲染热点诊断 | 覆盖充分。计划重建了 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 链路，并提供 e2e、highlight scaling、pipeline breakdown 和 native A/B 证据。 |
| 最新 snapshot 收敛、连续 hung request | 由 `INV-01`、`INV-02`、`INV-11` 映射到 unified snapshot、latest-dirty scheduling、isolated one-shot termination 和 unaffected-request replay。 |
| 禁止 delta-only Markdown 解析 | 覆盖充分。计划采用 stable prefix + full-context tail，不把 delta 片段单独作为完整 Markdown 解析输入。 |
| table、partial row、open/closed fence、长代码 | 有 stable-boundary、完整 tail、long-fence 和最终 public-output differential 映射。 |
| blockquote、list、setext、reference、emphasis | 已列入支持域和测试计划；reference usage 通过保守 tail 规则避免此前语义被冻结。 |
| 跨行公式及公式 pass-through | 覆盖充分。计划不新增 math AST，并要求五类公式形态的 literal streaming 验证。 |
| public async setter invalidation | `INV-06` 覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight` 和 `onChunks`。 |
| native bounded traversal | 明确由 Zig iterator 和 `text-buffer.zig` owner 承担，并覆盖 CJK、tab、empty line、trailing newline 和 range endpoint。 |
| non-Markdown/non-streaming/callback/parser-error compatibility | 计划保留既有 full parse 和 parser-error compatibility，没有扩展为性能 fallback。 |
| termination failure | R14 已修正 R13 的 blocker：不得提交 source/plain-text success-shaped 内容，不得调用成功回调，不得清除 dirty；只能通过 typed unavailable diagnostic seam 和明确 marker 暴露。 |
| source/release/runtime closure | 覆盖 nested source commit、11 个 npm tarballs、`SHA256SUMS`、12 个 GitHub assets、immutable root lock、provenance、installed realpath 和 OpenCode 实际 consumer。 |
| 用户规模约束 | 计划估算 6 个 production source files、6 个 test files/scripts、生产代码 550–850 行，低于 8 文件、1200 行和 10 个测试文件限制；实际 diff 仍须在 implementation audit 中核验。 |
| TDD 与反馈循环 | 主要行为均有 red-capable slice，并保留原始 incremental correctness、e2e latency、highlight scaling 和 pipeline breakdown 验证。 |

# Primary-path and fallback verdict

R14 的权威 primary path 为：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode resolver/lock
  -> CodeRenderable unified snapshot invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination when invalidated
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

没有发现新的：

- parser A 失败后尝试 parser B；
- delta-only parser；
- `createBuffer/updateBuffer` 替代 Code one-shot；
- callback 删除后伪装 request 已取消；
- `drawUnstyledText` 错误逃生路径；
- source checkout 或 native dylib fallback；
- `.3` 发布失败后使用旧 `.2` 作为成功路径；
- termination failure 后的 plain-text success fallback。

R14 的不可用 marker 属于明确的 diagnostic output，而不是成功形状的内容结果；计划同时要求保持 dirty、阻止自动重试风暴，并在新 snapshot 到达后重新进入同一 highlight primary path。因此 primary-path 设计已闭合。

# Code quality and Chinese-comment verdict

这是 **plan audit**，没有 implementation diff，因此：

- 无法计算实际 `E/C`；
- 无法确认最终 TypeScript、Zig 类型和 repository style；
- 无法确认 native build、package family、checksum 和 installed resolver closure；
- 无法确认 termination diagnostic seam 是否真正被消费者和行为测试使用；
- 无法确认 dead helper、旧 workaround 或重复 cache 是否被删除。

计划已承诺 implementation audit 重新计算：

```text
C >= max(1, ceil(E * 0.15))
```

并将中文解释性注释限定在 stable boundary、synthetic newline、fence、formula pass-through、immutable snapshot、native offset、termination 和 stale completion 等真实约束附近。该承诺满足 plan-mode 可行性要求，但不能替代实际实现审计。

# Release verdict

**APPROVE**

本 verdict 仅适用于当前 canonical plan 的精确 **R14** revision，且仅表示 **full-scope plan audit 通过**。

R14 已完成：

1. 原始 TUI 卡顿与渲染热点的 producer-to-consumer 证据闭环；
2. latest-snapshot、连续 hung request 和隔离 one-shot worker 生命周期；
3. 禁止 delta-only Markdown 解析的 stable prefix + full-context tail 方案；
4. table、fence、blockquote、list、setext、reference、emphasis、长代码和公式 pass-through 覆盖；
5. bounded native line traversal 优化；
6. OpenTUI immutable package family 与 OpenCode installed runtime closure；
7. termination failure 不再产生 success-shaped plain-text fallback；
8. 单一 primary path、无新增 alternate success path；
9. 用户授权的 11 个 tarballs + `SHA256SUMS`（共 12 个 GitHub assets）发布边界。

当前计划仍为：

```text
Status: audit-required
Revision: R14
Approved revision: none
Implementation allowed: no
```

只有在仓库流程记录本次 R14 的 `No blocking findings` 并将其标记为 approved 后，才可进入 approved-plan implementation。完成实现后仍必须通过针对实际 diff 的独立 full-scope implementation audit，包括测试、runtime closure、workaround 删除、fallback inventory 和实际中文注释比例计算。
````

### R15 Plan Revision

R14 implementation red evidence exposed a reachable test-support timing contract: after `resolveAllHighlightOnce()` resolves the current public highlight request, `CodeRenderable` may finish its line-info continuation and schedule a newer latest snapshot before the existing `settleDiffHighlighting` helper reads `highlightingDone`. The helper then awaits a promise for a newly scheduled request but does not drain that request until the next loop, while its exit condition can observe the queue at the wrong microtask boundary; the focused Diff regression times out even though the production jobs eventually finish during teardown. This is observable in the current WIP run and is independent of the ScrollBox visibility failure.

R15 assigns this timing responsibility to the existing test helper owner. The minimal green behavior is to render twice, drain currently pending mock requests, await the current public `CodeRenderable.highlightingDone` promises, and repeat whenever a new pending request appears; it must not inspect private jobs or assert call counts. The helper remains a test-only synchronization seam and does not add production scheduling, a fallback, or a second semantic path. R15 adds one test helper file, keeping the approved scope at 6 production source files and 7 test files/scripts.

R15 retains R14's diagnostic marker, reference tail, mock AbortSignal contract and current dirty WIP baseline. The R14 approval is cleared pending a new full-scope plan audit.

### Round 15 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 R15 实质修订未成为当前 canonical revision，审计对象无法唯一确定

- **Violated invariant:** 仓库要求任何行为、范围、接口、测试 owner 或文件计划的实质性变更都必须递增 canonical revision；当前审计必须针对唯一且明确的 revision，且未通过完整审计不得实施。
- **Evidence class:** contracted
- **Producer and execution path:** 当前计划头部仍声明 `Revision: R14`、`Approved revision: none`、`Implementation allowed: no`；但文件末尾新增了 `### R15 Plan Revision`，改变了测试文件范围、测试同步责任和当前 implementation baseline，并明确清除了 R14 approval。
- **Source evidence:**
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:3-13`：当前 canonical metadata 仍为 R14。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:2119-2125`：R15 新增测试同步行为、增加一个测试 helper 文件，并声明 R14 approval 已清除。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:2127-2129`：Implementation Evidence 仍写明“current revision is R14”。
  - `.opencode/policy/first-principles-engineering.md:357-363`：实质性计划变更必须递增 revision 并清除 approval；没有精确 approved revision 不得实施。
- **Canonical-plan evidence:** `R15 Plan Revision`、Section 23 `Implementation Evidence`、文件头 metadata。
- **Responsibility owner:** canonical plan revision metadata 与 audit-record owner。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 不能确定本次审计应批准 R14 还是 R15。若按 R14 审计，则遗漏 R15 新增测试文件和同步行为；若按 R15 审计，则文件头、Implementation Evidence 和 audit record 没有记录 R15 的完整 canonical 状态。任何实施授权都会违反“exact approved revision”硬门槛。
- **Why this is not speculative:** R15 明确修改了测试 owner、文件范围和行为验证时序，不是历史说明或纯文字修正；仓库 policy 明确把这些变化定义为必须递增 revision 的 substantive plan change。
- **Minimal correction direction:** 将当前 canonical metadata、Implementation Evidence 和 audit record 统一到唯一的 R15 revision，并在该精确 revision 上重新执行完整 plan audit；在此之前保持 `Implementation allowed: no`。

### B-02 实际 termination-failure 调用链无法到达 R14 要求的 `highlight-error` / `highlightUnavailable` diagnostic contract

- **Violated invariant:** isolated one-shot worker termination 失败时，必须由 `CodeRenderable` 的公开 diagnostic/unavailable seam 暴露失败；不能把失败伪装成普通 abort，也不能静默丢弃 termination failure。
- **Evidence class:** reachable
- **Producer and execution path:** `CodeRenderable.startHighlight()` 调用 `highlightWithAbort()`；该函数同时等待 `TreeSitterClient.highlightOnce(..., signal)` 和本地 `AbortSignal` rejection。公开 setter 更新触发 `invalidateHighlight()`，立即 abort 当前 signal。`TreeSitterClient.abortOneShotRequest()` 随后尝试重启并终止 one-shot worker；若 `terminate()` 失败，它只 reject 原始 `highlightOnce` Promise 并重新抛出错误。
- **Source evidence:**
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:576-588`：`highlightWithAbort()` 使用 `Promise.race([highlightOncePromise, aborted])`；signal abort 会产生本地 `AbortError`。
  - `thirdparty/opentui/packages/core/src/renderables/Code.ts:478-488`：只有捕获 `TreeSitterWorkerTerminationError` 才调用 `markHighlightUnavailable()`；普通 `AbortError` 会直接进入 abort 分支并只 `requestRender()`。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:406-418`：`abortOneShotRequest()` 先从 pending map 删除请求，termination 失败时 reject request、抛出 failure；成功时也只在最后 reject `AbortError`。
  - `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:270-304`：termination failure 在 worker restart owner 内产生并传播。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:1923-1925`：R14 要求 termination-failure contract通过 `highlightUnavailable` 和 typed `highlight-error` 暴露。
  - `docs/plans/opentui-streaming-markdown-performance-repair.md:2034`：计划声称 termination-failure contract已被覆盖。
- **Canonical-plan evidence:** R14 Plan Revision、Section 10.1 termination-failure contract、Section 16 TDD slices、Section 22 R14 verdict。
- **Responsibility owner:** `CodeRenderable` 的公开渲染错误状态与事件接口；`TreeSitterClient` 负责 worker termination，但不能替代 Code 的用户可见 diagnostic contract。
- **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** 在真实 setter-invalidates-current-job 的路径中，本地 `aborted` Promise 会先令 `Promise.race` 以 `AbortError` 完成。因此 `CodeRenderable` 不会进入 `TreeSitterWorkerTerminationError` 分支，不会设置 `highlightUnavailable`，也不会发出 `highlight-error`。termination failure 只会经由 `TreeSitterClient.emitError()` 作为 client-level error 暴露，Code 的 R14 diagnostic contract不会发生，当前 snapshot也可能继续停留在 dirty状态而没有计划定义的不可用状态。
- **Why this is not speculative:** 所有条件都由现有公开接口和当前实现直接连接：公开 setter会abort当前请求；`Code`明确使用本地abort race；`TreeSitterClient`明确在termination失败时拒绝底层Promise。该路径不依赖假设的未来输入。
- **Minimal correction direction:** 在 `CodeRenderable` 与 one-shot cancellation owner 的现有 primary path 中建立可观察且不被本地 abort race吞掉的termination-failure传播契约；必须让实际worker termination failure到达Code的typed unavailable/error seam，并由行为测试通过真实cancellation path验证。不得通过普通文本成功提交、client-level日志或新增fallback隐藏该失败。

## Non-blocking findings

- **N-01：R15 的 helper 时序描述仍未固定 microtask/continuation 边界。** R15 要求“render twice → drain pending → await 当前 `highlightingDone` → repeat”，方向与已观察的 Diff timeout一致，但没有明确在 `highlightingDone` continuation之后如何保证最新request已进入pending集合。实现阶段应以公开 `highlightingDone` 和mock pending状态验证，而不是依赖固定循环次数。
- **N-02：计划保留的 generic parser-error plain-text compatibility 仍需在实现审计中与 termination diagnostic 严格区分。** 当前 `Code.ts:495-501` 仍存在普通 highlight error的plain-text compatibility；这可以作为已有兼容契约保留，但不得覆盖或吞掉worker termination failure。
- **N-03：Full JavaScript suite 的历史失败仍未在 R15 提供新的前后对比证据。** 计划要求无法归因的失败停止release，但当前R15仍只有历史baseline记录；实现阶段必须提供同一命令、测试名、独立复现和归因证据。
- **N-04：稳定 prefix 的 reference boundary 仍主要存在于 revision history 与高层规则中。** 计划已覆盖reference usage/definition、fence、table等测试域；实现审计必须证明最终Code public output、conceal映射和callbacks，而不只比较highlight tuples。
- **N-05：native focused filter 仍依赖未来测试名。** `walkLinesInCharRange - matches full walk for bounded ranges`必须在实现中精确存在，并证明零匹配不会静默通过。

## Rejected speculation

- 没有把 synthetic native handle ceiling列为 blocker；计划与现有材料没有证明该阈值可通过真实OpenCode Session producer path到达。
- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar或math query；保留公式pass-through语义符合已检查的parser contract。
- 没有要求将所有streaming路由切换到现有`MarkdownRenderable`；现有`ReasoningBody` / `TextPart`依赖`CodeRenderable.onChunks`的可见文本反馈，整体切换会改变既有接口责任。
- 没有把OpenCode producer的16ms batching单独认定为first divergence；已有benchmark证据更直接指向全文highlight、`setStyledText`和native全量line walk。
- 没有要求保留naive `createBuffer/updateBuffer`、parser-after-parser、source import、native dylib、旧`.2` release或新的plain-text success fallback；这些路径仍属于被禁止的alternate success paths。

## Requirement and traceability coverage

- **TUI 卡顿、阻塞和渲染热点：** 覆盖充分。计划重建了 `Message Part delta → CodeRenderable → TreeSitter worker → TextBuffer → native` 链路，并列出了 e2e latency、highlight scaling、pipeline breakdown 和 native A/B 证据。
- **最新 snapshot 收敛、连续 hung request：** 已映射到 `INV-01`、`INV-02`、`INV-11`、latest-dirty scheduling、isolated one-shot termination 和 unaffected-request replay；但 B-02 使termination-failure分支的真实公开收敛contract尚未闭合。
- **禁止 delta-only Markdown 解析：** 覆盖充分。设计采用stable prefix + full-context tail，没有把delta片段单独作为完整Markdown parser输入。
- **table、partial row、open/closed fence、长代码：** 有stable-boundary、完整tail、长fence和public-output differential映射。
- **blockquote、list、setext、reference、emphasis：** 已列入supported domain与测试计划；reference仍需实现阶段证明最终public output。
- **跨行公式与公式 pass-through：** 覆盖充分；不新增math AST，并要求五类formula-like形式的literal streaming验证。
- **public async setter invalidation：** `INV-06`覆盖content、filetype、syntaxStyle、conceal、drawUnstyledText、streaming、initialStyledText、treeSitterClient、baseHighlight、onHighlight和onChunks。
- **native bounded traversal：** owner、first divergence、LineInfo equivalence以及CJK/tab/empty/trailing newline/range endpoint边界均已映射。
- **non-Markdown、non-streaming、callbacks、parser-error compatibility：** 有保留策略，但generic parser-error compatibility必须与termination failure严格隔离。
- **source/release/runtime closure：** 已覆盖nested source commit、11 npm tarballs、`SHA256SUMS`、12 GitHub assets、root lock、provenance、installed realpath和实际OpenCode consumer。
- **termination failure：** 当前不足。R14虽已禁止success-shaped source/plain-text fallback，但实际`Promise.race`调用链会把termination failure转换为Code侧普通`AbortError`，因此公开diagnostic seam不可达。
- **范围约束：** R15计划估算仍在8个生产代码文件、1200行生产代码和10个测试文件/脚本以内；实际diff仍需implementation audit重新统计。
- **TDD与验证：** 主要路径均有red-capable方向；但R15 metadata未闭合，且termination-failure行为测试尚未证明真实传播链。

## Primary-path and fallback verdict

计划总体维持单一primary path：

```text
OpenTUI source commit
  -> lockstep package family
  -> immutable release assets
  -> OpenCode resolver/lock
  -> CodeRenderable snapshot invalidation
  -> latest-snapshot scheduling
  -> isolated one-shot termination
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse branch
  -> callbacks / StyledText commit
  -> bounded native traversal
  -> TextPart / ReasoningBody visible frame
```

未发现新增的parser A→parser B、delta-only parser、`createBuffer/updateBuffer`替代成功路径、source/native fallback或旧release fallback。

但当前primary-path contract仍未闭合：termination failure在真实`CodeRenderable → highlightWithAbort → TreeSitterClient.abortOneShotRequest`路径中被本地abort race遮蔽，不能到达计划要求的Code-owned diagnostic seam。该问题不是新fallback，而是已批准primary path的错误传播缺口。

## Code quality and Chinese-comment verdict

这是 **plan audit**，没有可审计的 approved implementation diff，因此：

- 无法计算实际 `E/C`；
- 无法确认最终TypeScript/Zig类型、风格、dead helper和obsolete workaround清理；
- 无法确认native build、package family、checksum、installed resolver closure和release provenance；
- 无法确认R15 helper的实际实现是否满足测试owner责任；
- 计划仍承诺实现阶段满足：`C >= max(1, ceil(E * 0.15))`。

该承诺符合plan-mode可行性要求，但不能替代实现审计中的实际计算。

## Release verdict

**BLOCK**

当前canonical文件的实质内容已经进入R15，但文件头和Implementation Evidence仍标记R14，因此首先违反canonical revision硬门槛；同时，真实termination-failure调用链无法到达R14要求的公开diagnostic/unavailable contract。

必须先将计划统一到唯一的R15 revision，修正termination failure在Code primary path中的传播与行为测试，再进行下一轮完整scope plan audit。
````

### R16 Plan Revision

R16统一canonical metadata为当前唯一revision，并修正R15 B-02的真实传播缺口。`TreeSitterClient.highlightOnce(content, filetype, signal?)`是已批准的 cancellation owner：signal abort后，该public Promise在worker termination完成后才结束；成功终止返回 `AbortError`，termination failure返回 `TreeSitterWorkerTerminationError`。因此 `CodeRenderable.highlightWithAbort`不再创建会抢先完成的本地AbortError race，而是直接等待该public contract，确保termination failure到达 `markHighlightUnavailable`和typed `highlight-error` seam。注入的 `MockTreeSitterClient`和Code测试中的hung mock必须遵守同一可选signal contract；这不是fallback或第二请求路径。

R16保留正常abort的最新snapshot行为：TreeSitter worker成功终止时Code收到`AbortError`、丢弃旧job并由dirty continuation启动最新snapshot；终止失败时Code发布diagnostic marker、保留dirty、暂停自动重试；新snapshot清除unavailable并重新走同一primary path。新增/调整行为测试必须覆盖真实 `signal -> highlightOnce -> termination outcome -> Code event/state` propagation，而不能只手工抛出错误绕过这一链路。

R16把当前dirty WIP明确作为起点，保留R15 helper和mock seam；production source files仍为6，test files/scripts仍为7。R15 approval从未有效记录，当前R16保持 `audit-required`、`Approved revision: none`、`Implementation allowed: no`，等待本轮完整plan audit。

### Round 16 Independent Verdict (verbatim record)

````text
# Blocking findings

No blocking findings.

# Non-blocking findings

- **N-01：Section 21 的审计合同仍引用 R10。** `docs/plans/opentui-streaming-markdown-performance-repair.md:461` 仍写着“read this exact R10 file”，而当前 canonical revision 是 R16。文件头和 R16 元数据已经统一，因此这不会改变当前审计对象，但实施前应将该段更新为 R16，避免后续 implementation audit 错读历史 revision。
- **N-02：reference boundary 的执行规则主要依赖 revision history。** R12 在 `:1662-1668` 已给出可执行的保守规则：包含可能形成 reference usage 的 bracket construct 的行及其后续内容保留在 full-context tail；但当前主设计 `Section 10.2` `:251-259` 没有重复这条规则。实施时必须把该规则落实到 `Code.ts` 的唯一 stable-boundary owner，并验证最终 `CodeRenderable` public output、conceal 映射和 callback 输出，而不能只验证 highlight tuple。
- **N-03：native focused filter 仍依赖未来新增测试名。** `:390` 使用 `walkLinesInCharRange - matches full walk for bounded ranges`。实施阶段必须确认测试名完全匹配、零匹配会使命令失败，并继续运行完整 native suite。
- **N-04：termination diagnostic 的最终测试必须验证真实传播链。** R16 已正确修正设计方向：`CodeRenderable` 不再通过本地 `Promise.race` 抢先产生 `AbortError`，而是等待 `TreeSitterClient.highlightOnce(..., signal)` 的终止结果。实现测试仍必须覆盖真实链路：`AbortSignal -> highlightOnce -> worker termination -> TreeSitterWorkerTerminationError -> highlightUnavailable/highlight-error`。只手工让 `Code` 抛出 typed error 不足以证明该 contract。
- **N-05：计划阶段的 `E/C` 仍只是可行性估算。** 实现审计必须根据实际 diff 重新统计 production、test、configuration 的 substantive lines，并重新验证 `C >= max(1, ceil(E * 0.15))`。

### R17 Plan Revision

R17 records an implementation-stage compatibility fact discovered while closing the approved `.3` runtime path. The exact `OpenTuiSourceRevisionManifest.releaseTag` contract was changed from the retired `.2` identity to `v0.4.3-smark.3`; the existing public provenance test fixture still constructed a `.2` manifest and therefore failed package-local typecheck. The owner-preserving repair is to update that fixture to the current release identity, keep its remote-tag and source-mismatch assertions unchanged, and include the existing test file in the explicit file plan. This is a test-scope correction only; it does not widen the production path, add a fallback, or change the provenance interface semantics.

The temporary `opencode-runtime-consumer.ts` harness named by the earlier plan was not present in the current repository, so R17 does not add a parallel harness. The package-boundary runtime test remains the executable consumer seam; the absent diagnostic harness is recorded as an unverifiable item until the repository supplies it.

R17 clears prior approval pending a complete full-scope plan audit:

```text
Status: audit-required
Revision: R17
Approved revision: none
Implementation allowed: no
```

### Round 17 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 当前 canonical revision 元数据与 R17 实质内容不一致，审计对象无法唯一确定

- **Violated invariant:** 仓库要求任何实质性计划修改都必须递增 revision、清除旧 approval，并且实施只能针对当前 revision 的完整审计结果。当前 canonical plan 必须唯一、内部一致。
- **Evidence class:** contracted
- **Responsibility owner:** canonical plan metadata、audit record 与 implementation-evidence owner。
- **Minimal correction direction:** 将文件头、R17 revision record、Section 22 最新 verdict、Section 23 Implementation Evidence 和 release verdict统一到唯一的 R17 状态；在 R17 上重新执行完整 scope plan audit。修复前保持 `Implementation allowed: no`。

### B-02 计划把生产修改、远程 push、tag 和 GitHub Release 纳入必要交付路径，但当前审计输入没有可独立验证的用户授权

- **Violated invariant:** 计划只能执行原始用户需求明确授权的范围；用户原始需求明确要求原则上不修改当前仓库，并只说明确有必要时可在临时目录或 `.temp/testing` 中修改。未获得可审计的额外授权，不得把当前仓库生产修改或远程发布作为 primary delivery path。
- **Evidence class:** contracted
- **Responsibility owner:** 交付范围与远程副作用授权边界。
- **Minimal correction direction:** 将当前批准范围限制为原始需求允许的临时目录或 `.temp/testing` 诊断/原型路径；或者由用户明确、可审计地授权完整 source/package/release/runtime-closure 路径后，再把该授权作为新的 canonical revision 输入并重新执行完整审计。不得在授权不明确时将远程发布保留为 primary path。

# Non-blocking findings

- `Section 21` 的 Audit Contract 仍要求审计 “this exact R16 file”，而当前文件头为 R17；修复 canonical metadata 时应同步更新为当前 revision。
- `.temp/testing/tui-perf/opencode-runtime-consumer.ts` 不存在，但 Section 18 仍把该路径列为 required verification；应移除 required 命令或提供计划范围内的实际替代 seam。
- Section 22 的历史 R16 `APPROVE` 记录可以保留，但不得继续出现在当前 release verdict 或 Implementation Evidence 中造成现行批准含义。

# Release verdict

**BLOCK**

当前 R17不能release，也不能进入implementation：canonical plan同时保留R17 `audit-required`与R16 `APPROVE`/“current revision is R16”；完整source/package/release/runtime-closure路径依赖本次审计输入中无法独立验证的额外用户授权；缺失的runtime harness仍出现在required verification中。必须先修复canonical revision一致性、明确交付范围及远程副作用授权，并重新执行完整full-scope plan audit。
````

### R18 Plan Revision

R18修复R17的两个blocking finding。当前唯一authority统一为R18；R16和R17 verdict只保留为历史审计记录，不再作为当前release或implementation状态。Section 21、Section 22、Section 23和当前release verdict均明确指向R18。R18通过完整scope plan audit后恢复实施授权。

R18同时把后续用户消息中的授权作为可审计的原始授权输入，而非plan推断：用户明确选择“扩展到完整runtime闭包（推荐）”，并明确“授权 staged release gate（推荐）”，包括nested source commit、`smark/main` normal push、annotated `v0.4.3-smark.3` tag、现有workflow和11个tarballs加`SHA256SUMS`。下一轮plan audit handoff必须逐字提供这些用户授权，以及原始的临时目录限制，供auditor独立判断scope边界。

R18移除当前仓库不存在的`.temp/testing/tui-perf/opencode-runtime-consumer.ts` required verification；已计划的`packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts`是唯一package-boundary consumer seam，不新增平行harness。R17发现的provenance fixture更新仍是唯一新增test-file mapping，production/test预算保持6/8并满足用户限制。

```text
Status: approved
Revision: R18
Approved revision: R18
Implementation allowed: yes
```

### Round 18 Independent Verdict (verbatim record)

````text
# Blocking findings

No blocking findings.

# Non-blocking findings

- **N-01：README 中的 OpenTUI gitlink 版本说明仍是旧版本。** README 中仍写明 submodule 固定到 `v0.4.3-smark.1`；R18 runtime closure完成后文档会与实际 provenance状态不一致，实施阶段可更新说明或明确当前release identity。
- **N-02：native focused test 的测试名仍是未来约定。** 实施阶段必须确认 `walkLinesInCharRange - matches full walk for bounded ranges` 至少匹配一个测试，零匹配不能视为通过。
- **N-03：termination-failure 的可见 diagnostic contract 仍需要真实链路验证。** 必须证明 `AbortSignal -> TreeSitterClient.highlightOnce -> PlatformWorkerHandle.terminate() -> TreeSitterWorkerTerminationError -> CodeRenderable.highlightUnavailable/highlight-error`，不能只在mock中手工抛出typed error。
- **N-04：当前工作树包含 pre-R18 WIP。** implementation audit必须以实际diff为准，不能把现有WIP直接当作R18 approved implementation。
- **N-05：计划中的 `E/C` 只能作为可行性承诺。** implementation audit必须按实际diff重新计算，并验证 `C >= max(1, ceil(E * 0.15))`。

# Release verdict

**APPROVE**

该 verdict 仅适用于当前完整审计的 **R18 canonical plan**，表示没有发现证据充分的 blocking finding；实施完成后仍必须针对实际diff执行一次完整、独立的 implementation audit。
````

### R19 Plan Revision

R19记录R18实施阶段由原始用户可见反馈环捕获的真实starvation回归。R18在真实`Message Part delta` cadence（16ms、240 flushes）下，每次append-only Markdown content setter都会abort当前one-shot并触发物理worker replacement；结果只有2次可见commit、最大间隔4834ms。仅在`.temp`诊断副本中屏蔽active abort，同一负载产生229次commit、gap p95 23ms、post-stream catchup 223ms且无shrink，因此first divergence归属于`CodeRenderable` append-only invalidation，不是renderer capture、producer batching或native bounded iterator。

R19的唯一primary repair是保留当前snapshot/visible-commit安全边界，同时区分可证明的append-only Markdown增长和语义invalidating变化：

- `streaming && filetype === "markdown"` 且新content严格以旧content为prefix时，不abort当前active one-shot；只保留一个latest dirty snapshot，当前请求完成后沿同一主路径继续。
- stale Markdown结果不得提交旧StyledText、不得触发旧`onHighlight`/`onChunks`成功语义；若其parser/cache输入仍与当前semantic inputs兼容，才允许把返回的raw stable-prefix cache作为内部seed，供最新snapshot复用。
- content rewrite、filetype/style/conceal/draw/streaming/client/base/callback等语义setter、destroy和真实worker termination failure继续使用R18的AbortSignal与isolated physical termination；不把append coalescing变成hung-worker fallback。
- 当前公开`content`和最新snapshot仍是唯一可见输出来源；不新增delta-only parser、raw tail success output、`drawUnstyledText`逃生路径或第二worker语义。

R19仍保持6个production source files、8个test files/scripts和用户代码/测试预算；新增行为属于现有`Code.ts` owner、既有Markdown cache和既有worker lifecycle，不新增public API、dependency或route producer改动。当前pre-R19 WIP不得在R19重新审计前视为授权实现。

```text
Status: audit-required
Revision: R19
Approved revision: none
Implementation allowed: no
```

### R20 Plan Revision

R20保留R19的append-only coalescing方向，并补齐B-02的非进展transition，不改变producer、consumer、native owner或public API。Code owner为每个active highlight记录最近成功耗时；当append-only Markdown更新到来时，正常请求继续运行并只合并latest dirty。若同一active请求已有append supersession且超过`max(1000ms, 4 * 最近成功耗时)`仍未完成，则由同一AbortSignal触发isolated one-shot physical termination，等待barrier后启动latest snapshot。初始无历史耗时时使用1000ms窗口；正常完成请求清理watchdog，stale raw cache仍只能按semantic/prefix guard预热，不能提交旧文本。

该自适应窗口有直接证据边界：R18真实240-flush请求最大观测耗时393ms，1s初始窗口保留正常请求余量，同时给真实hung append一个有限终止transition；长代码成功耗时会按实际历史放宽，而不是使用固定上限。测试必须覆盖正常append不被提前终止、append-only hung请求在窗口后终止并收敛latest、semantic setter立即终止，以及无shrink的240-flush visible commit。

用户本轮明确追加十二轮审计上线，授权继续进行R20及后续必要的完整scope plan audit；该授权只解除R19的plan-audit-round-limit blocker，不放宽原始范围、primary-path、fallback、测试、E/C或最终implementation audit门禁。

```text
Status: audit-required
Revision: R20
Approved revision: none
Implementation allowed: no
```

### Round 20 Independent Verdict (verbatim record)

````text
# Blocking findings

### B-01 自适应 supersession watchdog 无法区分合法的长解析与真正 hung request

- **Violated invariant:** `INV-02` 要求正常 streaming 平滑收敛、任意连续 hung request 最终可终止；`INV-04` 要求长代码段最终完整且不截断。
- **Evidence class:** reachable
- **Responsibility owner:** `CodeRenderable` 的 streaming scheduling / supersession seam。
- **Minimal correction direction:** 定义可验证的“无进展 supersession”，明确进展观测、计时器生命周期、合法长解析保护和连续触发后的收敛行为；测试必须覆盖合法长解析超过基础阈值仍能提交，以及真正不返回的append request在有界时间内终止。

# Release verdict

**BLOCK**
````

### R21 Plan Revision

R21把R20的deadline判定收窄为可观测progress contract：`CodeRenderable.highlightMarkdown`每完成一个stable-prefix fragment或当前tail parse阶段都更新本次active job的progress marker；append supersession watchdog只在active job既没有新的progress、又没有完成当前snapshot时计时。合法长解析若持续完成fragment阶段会持续刷新marker并保留当前worker；真正永不返回的append request不会产生progress，才允许触发同一AbortSignal termination barrier。无stable-prefix可安全切分的单一长tail仍必须由独立长解析测试证明在其已知合法耗时内完成，不能用watchdog成功来掩盖截断。

R21的行为片段必须提供独立expected value：正常长Markdown mock在基础窗口之外完成stable fragment并最终完整提交；append-only hung mock不发progress且在有限窗口后被终止、latest content收敛；semantic setter仍立即终止；240-flush真实e2e必须有明确的中间commit与无shrink断言。watchdog timer的创建、progress刷新、completion、abort、destroy cleanup和termination failure diagnostic必须全部在Code owner中闭合，不新增下游补偿路径。

```text
Status: audit-required
Revision: R21
Approved revision: none
Implementation allowed: no
```

### R22 Plan Revision

R22把progress责任移回实际执行parse的worker，而不是让Code猜测不可见Promise状态。`parser.worker.ts`在one-shot parser的真实`ProgressCallback`中发送带`messageId`和`currentOffset`的progress response；injection parser阶段也发送同一contract的阶段progress。`types.ts`只增加同一one-shot response union，`TreeSitterClient.highlightOnce(content, filetype, signal?, onProgress?)`以可选callback转发当前请求progress；现有三参数调用保持兼容，未取消并发请求和replay语义不变。

Code watchdog只在append supersession存在且一段时间没有收到worker progress、最终response或termination outcome时触发；合法长parse的parser offset持续前进，不会被基础窗口误杀；真正await挂起的fixture不产生progress，仍会进入isolated termination barrier。Code只消费progress更新时间和当前job identity，不复制parser逻辑、不添加第二worker或下游fallback。

R22 production source files为8（在用户上限内）：`Code.ts`、`TreeSitterClient`、`tree-sitter/types.ts`、`tree-sitter/parser.worker.ts`、两份Zig owner和两份parent provenance script；test files/scripts保持8。新增行为测试必须覆盖worker progress真实传播、合法长tail超过基础窗口完整提交、append-only hung终止/latest收敛、semantic invalidation、并发replay、240-flush中间commit和无shrink。

```text
Status: audit-required
Revision: R22
Approved revision: none
Implementation allowed: no
```

### Round 22 Independent Verdict (verbatim record)

````text
# Blocking findings

- B-01: `ProgressCallback` coverage misses parser loading/query/injection lifecycle and can misclassify legal work.
- B-02: `types.ts`/`parser.worker.ts` progress production path was absent from the exact file plan and forward/reverse mappings.

# Release verdict

**BLOCK**
````

### R23 Plan Revision

R23 defines a complete one-shot lifecycle progress state machine owned by `parser.worker.ts`: `loading` is emitted before parser/query asset resolution and `parsing` after parser readiness; main and injected parsers emit monotonic byte-offset progress through Tree-sitter's real `ProgressCallback`; `querying` and `injecting` stage transitions are emitted before and after their existing work; final response closes the lifecycle. Code treats byte offsets only as liveness evidence, never as JS character or highlight coordinates.

Stage deadlines are explicit: loading/query/injection use the existing 10-second worker initialization/lifecycle ceiling; parsing uses the short adaptive no-progress window, reset only by strictly increasing parser offsets or a stage transition. Timer creation begins only after the worker has identified the current stage, is not reset by new producer deltas, and is cleared on response, abort, termination failure, job replacement and destroy. Thus legal loading/query phases receive their existing ceiling, legitimate long parse remains alive while offsets advance, and a fixture that enters parsing then never reports offset is terminated.

R23's exact production scope and mappings include `Code.ts`, `client.ts`, `types.ts`, `parser.worker.ts`, two Zig owners and two parent provenance scripts: 8 production files total. Tests remain in the existing eight approved files/scripts and cover each lifecycle stage, monotonic offset forwarding, byte-offset liveness-only use, long parse progress, hung parse termination, replay and 240-flush visible behavior.

```text
Status: audit-required
Revision: R23
Approved revision: none
Implementation allowed: no
```

### R24 Plan Revision

R24 is a canonical-record correction over R23 only: the current primary-path heading, requirement coverage, file-level table, forward/reverse mappings and production budget now consistently authorize exactly 8 production files. R19/R23 labels remain only in historical revision records. The full-lifecycle progress state machine, stage deadlines, parser-offset liveness boundary, TDD slices and fallback inventory are unchanged from R23.

```text
Status: audit-required
Revision: R24
Approved revision: none
Implementation allowed: no
```

### R25 Plan Revision

R25 applies the user's explicit post-R24 choices. The primary repair is limited to the observed normal-stream first divergence: strict append-only streaming Markdown growth retains the active one-shot request, coalesces one latest dirty snapshot and may seed only semantically compatible raw prefix cache; it does not add a timer, watchdog, parser/query/loading progress protocol or second scheduler. Synthetic append-only permanent non-return with no semantic transition is an explicit non-goal. Content rewrite, non-Markdown/non-streaming changes, every semantic setter and destroy preserve the existing R18 AbortSignal/isolated-worker termination contract.

R25 also rebuilds the release baseline from current evidence. Remote `smark/main`, annotated `v0.4.3-smark.3`, its 12 assets and parent `.3` WIP already exist and are not retroactively approved or replayed. The newly authorized final identity is `v0.4.3-smark.4`. Before any new nested commit, push, tag or workflow, the exact source diff, local package family, original 240-flush loop and actual E/C evidence must receive an independent full-scope source implementation `No blocking findings` / `APPROVE`. Only then may `.4` be published and parent closure updated; final parent verification still requires the later full implementation audit.

### R26 Plan Revision

R26 resolves the R25 audit findings without adding a parser, worker protocol or fallback. The existing `CodeRenderable` Markdown owner keeps an open fence in the full-context tail, but a long open fence no longer triggers a full-tail parse for every tiny append: until the fence closes, the owner batches strictly append-only growth behind a bounded line/byte threshold and preserves the last committed highlight. A threshold crossing or fence closure performs the same full-context parse; semantic invalidation bypasses the batching gate and follows the existing termination path. The threshold is a scheduling constraint, not a delta-only parser, and final closed-fence output remains the independent full-parse oracle.

The pre-release source audit uses the policy-approved `implementation-audit-required` status. Its audit object is explicitly limited to the nested OpenTUI source diff, local package artifacts, original feedback loop, actual E/C and source tests; after `.4` publication and parent closure, the same legal status records the complete implementation audit before `verified`.

```text
Status: audit-required
Revision: R26
Approved revision: none
Implementation allowed: no
```

### R27 Plan Revision

R27 closes the R26 scheduling and boundary-state gaps in the same `CodeRenderable` owner. The existing Markdown cache gains an append-only boundary cursor and fence state. For a strict prefix append, boundary resolution scans only the new suffix plus the incomplete line at the cursor; rewrites, semantic setter changes, frontmatter invalidation, reference-usage invalidation and cache loss restart the existing full boundary scan. The cache records `active`, `deferred-open-fence` and `ready` transitions. While an open fence has grown below the 32-line/4096-character threshold, `startDirtyHighlight` and its `finally` continuation leave the job dirty but do not launch another full-tail request; threshold crossing, valid closing marker or semantic invalidation clears the deferred state and re-enters the same primary path. The visible frame remains the last correctly highlighted frame until catch-up; no `drawUnstyledText` escape or success-shaped raw-text fallback is introduced.

R27 also separates opener and closer recognition. A closer must use the opener's marker character and minimum length and contain only optional spaces/tabs after the marker; an info-bearing fence line remains an opener/content line. Differential tests cover invalid trailing closer text, mixed markers, short closers, threshold deferral, threshold catch-up and immediate closure catch-up.

```text
Status: audit-required
Revision: R27
Approved revision: none
Implementation allowed: no
```

### R28 Plan Revision

R28 repairs the R27 final-audit finding at the same `CodeRenderable` scheduling owner. The parser work budget remains unchanged: an unresolved long fence receives a full-context Tree-sitter parse only at 32 added complete lines, 4096 added characters, a valid closer or semantic invalidation. The missing invariant is visibility, not parser selection. Each sub-threshold strict-prefix append therefore captures the current snapshot and commits one provisional `StyledText`: cache-confirmed stable-prefix highlights remain styled, every unresolved-tail character is present with the default style, and the existing current-snapshot `onChunks` transform/conceal mapping executes. It intentionally does not invoke `onHighlight` or fabricate tail syntax ranges. A later threshold/closure full parse replaces provisional style through the same existing Markdown path.

The published `.4` release contains the observed stale-frame defect and is immutable. The user authorized `v0.4.3-smark.5`; after R28 source/local verification and a new independent source implementation audit, only the normal staged `.5` commit/push/tag/workflow path may run. Parent catalog/override/lock/provenance then move from `.4` to `.5` and receive the final implementation audit.

```text
Status: audit-required
Revision: R28
Approved revision: none
Implementation allowed: no
```

### R29 Plan Revision

R29 is a canonical deployment-identity correction over R28 only. Every non-historical final contract now names `.5`: `INV-08`, first-divergence release ownership, file plan, TDD release closure, verification commands, risks and parent resolver/provenance expectations. `.4` remains only where expressly labeled as the published stale-frame baseline or an historical audit record. The provisional visible-tail primary path, files, tests, budgets and staged `.5` authorization are unchanged.

```text
Status: audit-required
Revision: R29
Approved revision: none
Implementation allowed: no
```

### R30 Plan Revision

R30 closes the R29 final-audit liveness gap without adding a second parser or fallback. The provisional `StyledText` transition applies to every current streaming Markdown snapshot, not only a deferred open fence: the first snapshot and an append while a full one-shot is active immediately present current content with cache-confirmed stable-prefix ranges (or no syntax ranges before a cache exists) and default-styled unresolved text. A single private presentation slot serializes `onChunks` work and commits only the still-current snapshot, so an old provisional result cannot overwrite a later append. `onHighlight` remains exclusive to the full-context Tree-sitter result. The open-fence threshold continues to limit only parser work, not text visibility.

```text
Status: audit-required
Revision: R30
Approved revision: none
Implementation allowed: no
```

### R31 Plan Revision

R31 closes the provisional-slot callback invalidation gap at the existing `CodeRenderable` owner. Each queued presentation captures its immutable snapshot; when the slot becomes available it checks `isCurrentSnapshot` before constructing chunks or invoking `onChunks`, then checks again after the async callback before committing `StyledText`. A stale queued snapshot is discarded before public callback side effects, while a stale in-flight callback result is discarded before presentation. The test seam blocks one public `onChunks`, appends newer Markdown, then releases the slot and asserts only the newer snapshot callback begins and only latest content is visible. This is one generation-aware serialization rule, not an additional callback path or retry.

```text
Status: audit-required
Revision: R31
Approved revision: none
Implementation allowed: no
```

### R32 Plan Revision

R32 replaces R31's serialized callback wait with a nonblocking refinement transition in the same `CodeRenderable -> StyledText` presentation path. A current streaming Markdown snapshot immediately commits its base chunks before any `onChunks` Promise is awaited. It then starts the current callback without holding later snapshots; the callback's transformed chunks can replace the base frame only when that same snapshot is still current. A newer append therefore makes its own latest base text visible even if an older callback is slow or never resolves, while no stale callback result can commit. This is not a raw-text error path, retry, second renderer or alternate parser: both commits use the same snapshot, chunk builder, conceal mapping and StyledText owner; the full Tree-sitter parse remains the sole syntax authority.

```text
Status: audit-required
Revision: R32
Approved revision: none
Implementation allowed: no
```

### R33 Plan Revision

R33 preserves the existing public `onChunks` visible-output contract. Generic callbacks can rewrite text, so they remain callback-first and never receive an untransformed provisional frame. Eager visible presentation is instead available only when no callback exists or the caller explicitly sets a narrow `streamingChunksAreIdentity` promise: the callback is synchronous for visible semantics and returns the same chunks. `TextPart` needs no marker; `ReasoningBody` is the only real callback-bearing user path that opts in because its callback only records `chunks.map(...).join("")` and returns `chunks`. `MarkdownRenderable` linkification and any unknown callback remain unopted and unchanged. Tests prove eligible latest visibility, identity callback feedback and no pre-transform frame for a transforming callback.

```text
Status: audit-required
Revision: R33
Approved revision: none
Implementation allowed: no
```

### R34 Plan Revision

R34 closes the new identity-marker state boundary. `streamingChunksAreIdentity` is a public Code option because Solid callers can set it, so its getter/setter uses the same unified invalidation as content, callback and style inputs; the immutable highlight snapshot carries it; active and queued provisional work must re-check that snapshot before any visible commit. The Code behavior test mutates the marker in both directions while a job is active, proving a true-to-false transition cannot display pre-transform text and a false-to-true transition cannot retain stale ineligibility. No callback result inspection, extra renderer or new scheduler is introduced.

### R35 Plan Revision

R35 closes the R34 plan-audit blockers without adding a second Markdown renderer. The Markdown owner sends the current complete document to Tree-sitter whenever a syntax result is required; it then clips the returned full-document ranges at the conservative stable boundary and stores only the confirmed prefix for later reuse. The previous standalone suffix `highlightMarkdownFragment(content.slice(cachedCut))` path is removed. Provisional visibility remains a presentation state for eligible direct OpenCode streams; a callback that can rewrite chunks remains callback-first, so the plan does not claim that arbitrary transforming callbacks can show pre-transform text. OpenCode's actual `TextPart` has no callback and `ReasoningBody` has the explicitly documented identity callback; those are the user-visible streaming paths covered by the immediate-display invariant. The existing `MarkdownRenderable` linkification callback remains unchanged and is covered by callback-first compatibility tests.

### R36 Plan Revision

R36 applies the user's explicit first display semantics without pretending that a default-styled tail has already been Markdown-processed. The open-fence line/byte threshold and `shouldDeferMarkdownHighlight` workaround are removed from the approved path. The active-job gate still coalesces rapid producer deltas into one latest snapshot, but every merged snapshot that needs syntax receives the complete current document as the parser input. Stable-prefix cache remains an output reuse boundary: only ranges proven stable are reused, while the current tail comes from the same full-document parse. Eligible direct OpenCode streams can show a provisional frame while the current parse is pending; callback-transforming consumers remain callback-first and never show pre-transform chunks. This is the single primary path; a future incremental Tree-sitter buffer API is explicitly out of scope until separately designed and audited.

### R37 Plan Revision

R37 uses the existing Tree-sitter buffer owner instead of either forbidden standalone suffix parsing or repeated full-document one-shot parsing. `TreeSitterClient` already owns parser trees, `createBuffer`, `updateBuffer`, edit queues and versioned `HIGHLIGHT_RESPONSE`; it will expose one narrow Code-facing incremental highlight request seam that creates one Markdown buffer, applies append edits, resets on rewrite/semantic invalidation, resolves only the requested current version and removes the buffer on destroy. The worker therefore parses the complete document context incrementally. `CodeRenderable` remains the sole Markdown presentation owner and keeps the existing isolated one-shot path for non-buffer domains and semantic cancellation. Stable-prefix cache becomes the versioned output reuse boundary, not a second parser. The real OpenCode callback-free/identity paths receive every current buffer version; arbitrary transforming callbacks preserve callback-first output semantics.

### R38 Plan Revision

R38 closes the R37 buffer response contract. The buffer worker must emit a versioned successful completion for every edit/reset, including `highlights: []`; no request may wait for a non-empty capture. For Code's Markdown seam, the worker reuses the incrementally edited full parser tree but queries the current document's complete capture set, converts it to the existing character-offset `SimpleHighlight[]` representation with injection/conceal metadata, and returns that same full semantic result with the requested version. The client resolves the Code-facing request only from that versioned completion and rejects stale/destroyed versions. This keeps one full-context incremental parser path: parsing work is incremental, result coordinates and metadata remain the existing Code contract, and no Code-side reconstruction of changed line ranges is allowed.

The current OpenCode user-visible path remains callback-free `TextPart` or explicit identity `ReasoningBody`; arbitrary transforming `onChunks` keeps callback-first compatibility and is not silently given pre-transform provisional text. Empty highlights are still a valid processed Markdown result, so the visible current text and the parser completion are independent but both complete on the same snapshot.

### R39 Plan Revision

R39 makes the incremental buffer path the only Markdown success path in `CodeRenderable`. The Code-facing contract is explicit:

```ts
openMarkdownBuffer(filetype, initialContent, version, signal?): Promise<MarkdownBufferHandle>
MarkdownBufferHandle.update(content, edits, version, signal?): Promise<SimpleHighlight[]>
MarkdownBufferHandle.reset(content, version, signal?): Promise<SimpleHighlight[]>
MarkdownBufferHandle.dispose(): Promise<void>
```

The handle owns one buffer identity and one latest-version completion map. Every `HANDLE_EDITS`/`RESET_BUFFER` carries a requestId and version; every response carries the same requestId, version, `complete: true`, and the complete current-document `SimpleHighlight[]` including empty arrays and existing injection/conceal metadata. A stale response is ignored, an aborted request rejects without committing, and dispose rejects/clears all pending versions before removing the worker buffer. `CodeRenderable` uses this handle for streaming Markdown only; it never calls `highlightOnce` for that domain. `highlightOnce` remains the primary path for non-Markdown/non-streaming and the existing semantic cancellation contract. This removes the ambiguous dual Markdown path rather than adding a fallback.

R39 counts only seven new production code files: `Code.ts`, the existing OpenCode session consumer marker, `TreeSitterClient`, `parser.worker.ts`, `types.ts`, and the two parent provenance scripts. The native bounded iterator is an already-published `.4` baseline and receives no R39 modification. The red tests cover empty completion, request/version matching, full SimpleHighlight metadata, append/reset/dispose, table/reference/fence/full-parse differential, and the actual OpenCode consumer.

```text
Status: audit-required
Revision: R39
Approved revision: none
Implementation allowed: no
```

```text
Status: audit-required
Revision: R38
Approved revision: none
Implementation allowed: no
```

```text
Status: audit-required
Revision: R37
Approved revision: none
Implementation allowed: no
```

```text
Status: audit-required
Revision: R36
Approved revision: none
Implementation allowed: no
```

```text
Status: audit-required
Revision: R35
Approved revision: none
Implementation allowed: no
```

```text
Status: audit-required
Revision: R34
Approved revision: none
Implementation allowed: no
```

# Rejected speculation

- 没有把 synthetic native handle ceiling列为 blocker。当前没有真实 OpenCode Session producer trace证明该阈值在目标调用路径中可达。
- 没有要求新增数学/LaTeX renderer、tree-sitter math grammar或math query。计划保留 `$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]`、`\\begin...\\end...` 的普通文本/pass-through语义，符合当前 parser evidence。
- 没有要求把默认 streaming route整体切换到现有 `MarkdownRenderable`。`ReasoningBody`和`TextPart`依赖 `CodeRenderable.onChunks` 的可见文本反馈，整体切换会改变既有布局责任。
- 没有要求保留 delta-only parser、`createBuffer/updateBuffer` 替代路径、parser-after-parser、source import、native dylib、旧 `.2` release 或 termination-failure 后的 plain-text success fallback。
- 没有把 OpenCode producer 的16ms batching认定为 first divergence。当前直接证据仍指向 `CodeRenderable` 全文 highlight、`TextBuffer.setStyledText` 和 native 全量 `walkLines`。
- 没有将现有 generic parser-error plain-text compatibility列为新 fallback；计划已将其限定为既有兼容行为，并要求与 termination diagnostic严格隔离。

# Requirement and traceability coverage

- **TUI 卡顿、阻塞和渲染热点：** 已有完整 producer-to-consumer路径和实测证据：`Message Part delta -> CodeRenderable -> TreeSitter worker -> TextBuffer -> native`。计划记录了 e2e commit gap、highlight scaling、pipeline breakdown和native A/B结果，能够支持性能优化目标。
- **delta/streaming 最新内容收敛：** `INV-01`、`INV-02`、`INV-11`覆盖normal append latest-dirty、semantic invalidation termination和unaffected-request replay；append-only永久不返回按用户选择明确排除自动恢复。
- **禁止 delta-only Markdown 解析：** 计划明确采用 stable prefix + full-context tail，不将 delta片段当作独立完整 Markdown 文档解析。
- **table、partial row、open/closed fence、长代码：** 由 `INV-03`、`INV-04`、stable-boundary规则和最终 public-output differential测试覆盖。
- **blockquote、list、setext、reference、emphasis：** 已列入 supported domain和TDD slice；reference的保守 tail规则由R12 revision提供，实施时必须落实并验证。
- **公式及跨行公式：** `INV-07`覆盖五类 formula-like形态，保持 pass-through，不引入新的math semantics。
- **公开异步状态：** `INV-06`覆盖 `content`、`filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`initialStyledText`、`treeSitterClient`、`baseHighlight`、`onHighlight`和`onChunks`。
- **native性能路径：** `INV-05`明确由 Zig iterator/text-buffer seam负责，并覆盖 CJK、tab、empty line、trailing newline和range endpoint。
- **兼容性：** `INV-09`保留 non-Markdown、non-streaming、parser-error compatibility、callbacks和既有 full parse semantics；没有新增成功路径。
- **runtime closure：** `INV-08`、`INV-10`覆盖pre-release source implementation audit、`.5` nested source commit、11个npm tarballs、`SHA256SUMS`、12个GitHub assets、parent override/lock、provenance、installed realpath和OpenCode实际consumer。
- **用户规模约束：** 当前计划估算7个 production source files、8个 test files/scripts、620–960 effective production lines，满足用户限制；最终仍需implementation audit复核实际diff。
- **TDD与原始反馈循环：** 调度、worker终止、Markdown结构、native等价性、package closure和原始 e2e均有red-capable或可执行验证映射。

# Current R40 Primary-Path Verdict

R40保留单一Markdown authoritative primary path：append-only Markdown不终止active work；eligible current streaming Markdown snapshot（首次、active append和open-fence growth）立即提交generation-aware provisional StyledText；语法结果只来自Code-owned versioned incremental buffer，transforming callback继续callback-first：

其中`isolated one-shot termination`只适用于non-Markdown/non-streaming或semantic invalidation/物理失败；streaming Markdown始终沿同一buffer handle的latest-version分支收敛。

```text
approved OpenTUI source diff
  -> source/local-package verification
  -> independent source implementation audit
  -> nested source commit + lockstep 11 npm tarballs + SHA256SUMS
  -> immutable `.5` release
  -> OpenCode catalog/override/lock
  -> installed @opentui package family
  -> CodeRenderable unified invalidation/snapshot
  -> latest-snapshot scheduling + serialized visible provisional current snapshot
  -> isolated one-shot termination when invalidated
  -> Markdown stable prefix + full-context tail
     或既有 non-Markdown/full-parse contract branch
  -> current-snapshot callback checks
  -> StyledText commit
  -> bounded native line traversal
  -> TextPart/ReasoningBody visible frame
```

没有发现以下被禁止的 alternate success path：

- parser A失败后尝试 parser B；
- delta-only parser；
- `createBuffer/updateBuffer`替代 Code one-shot；
- callback删除后伪装 request 已取消；
- `drawUnstyledText`错误逃生路径；
- source checkout或native dylib fallback；
- `.5`发布失败后复用已知缺陷的`.4`或旧`.3`；
- termination failure 后提交 plain-text success-shaped output。

隔离 one-shot worker属于同一`highlightOnce` contract的既有生命周期实现，不是第二种语义路径。R30不修改worker protocol，不为append-only永久不返回增加timer或progress；provisional presentation也不是fallback，它在同一snapshot/StyledText路径中只展示真实文本且不声称未解析tail已有语法样式。共享buffer worker保留，未取消的并发请求仍通过同一逻辑request identity replay。

# Code quality and Chinese-comment verdict

这是 plan audit，没有 implementation diff，因此无法计算实际 `E/C`，也无法确认最终 TypeScript、Zig、package、lockfile、release verifier或runtime consumer结果。

计划已经承诺实现阶段满足：

```text
C >= max(1, ceil(E * 0.15))
```

实施审计必须重新计算实际值，并排除 import-only、formatter-only、generated和pure-move changes；中文注释只能计算解释 stable boundary、immutable snapshot、termination、native offset、formula pass-through等真实约束的相邻注释。

# Historical R16 Release Verdict

**APPROVE**

本 verdict 仅适用于历史 canonical plan 的精确 **R16** revision，且仅表示当时的 full-scope plan audit通过。

R16已满足：

1. 原始 TUI 卡顿和渲染热点的证据闭环；
2. latest-snapshot和连续 hung request 收敛；
3. 隔离 one-shot worker 的物理终止与并发 replay；
4. 非 delta-only 的 Markdown stable prefix + full-context tail；
5. table、fence、blockquote、list、setext、reference、emphasis、长代码和公式 pass-through覆盖；
6. bounded native line traversal；
7. OpenTUI immutable package family 与 OpenCode installed runtime closure；
8. termination failure 不再被本地 `AbortError` race遮蔽；
9. 单一 primary path，没有新增 alternate success path；
10. 用户授权的11个 tarballs + `SHA256SUMS`，即12个 GitHub Release assets。

该 verdict 仅保留为R16历史记录，不构成当前R19实施授权：

```text
Status: audit-required
Revision: R16
Approved revision: none
Implementation allowed: no
```

R16历史clean verdict不能替代R19的当前full-scope plan audit；完成R19审计后仍必须对实际implementation diff执行独立implementation audit。
````

# Current Release Verdict

**PLAN-AUDIT-REQUIRED**

当前唯一canonical revision为R39，状态为`audit-required`，`Approved revision: none`，`Implementation allowed: no`。R27/R29 final implementation audits分别发现deferred与ordinary active append的reachable visible-output regression，R30-R38 plan audits补齐callback兼容、identity marker invalidation、full-context tail、门槛内持续Markdown处理、增量buffer owner、空结果/完整SimpleHighlight响应和唯一Markdown路径契约；`.4` release和parent closure只作为不可覆盖baseline。R39必须先对versioned incremental Markdown buffer path和`.5` staged closure完成完整独立方案审计。

## 23. Implementation Evidence

Complete only after the approved current revision is implemented. The current revision is R39 and implementation is not authorized while this plan is `audit-required`. Existing `.4` source/parent evidence is historical and cannot be used as R39 implementation evidence.

### Actual Files and Diff

R27 implementation evidence covers the nested source commit `df4bd31caaa1153944b28509ac13610b4a16ca85`, the published annotated `v0.4.3-smark.4`, parent `.4` catalog/override/lock/provenance and staged gitlink. The R27 final audit blocked the visible deferred-open-fence behavior, so this evidence is historical baseline only. No `.5` source/parent implementation has started.

### Red-Green Test Evidence

R27 red-green slices: the active Markdown append test was red with `Received: false` after the append and green after append coalescing; the open-fence threshold test was red because a sub-threshold append started a pending highlight and green after deferred dirty gating; the invalid closer differential was red under prefix-only marker matching and green after the strict closing-marker contract. Focused R27 tests pass `3/3`; full Code suite passes `66 pass / 1 skip / 0 fail`.

### Verification Commands and Results

- `bun test ./src/renderables/Code.test.ts`: `66 pass / 1 skip / 0 fail`.
- `bun test ./src/lib/tree-sitter/client.test.ts`: `49 pass / 0 fail`.
- `bun run test:js`: `4986 pass / 23 skip / 0 fail`.
- `bun run test:native`: `1689 pass / 2 skip / 0 fail`.
- `bun run build` and `bun run --cwd packages/core build:native --all`: passed; eight native targets built.
- `bun scripts/verify-release-packages.ts --directory artifacts-v4-audit/npm-packages --version 0.4.3-smark.4`: passed, 11 packages on darwin arm64.
- Node26 packed core/solid/keymap/ssh smoke scripts: all passed.
- `bun .temp/testing/tui-perf/e2e-stream.ts --mode=public --flushes=240`: `220 commits`, gap p95 `29ms`, max `308ms`, catchup `218ms`, shrink `0`.
- `bun .temp/testing/tui-perf/prefix-cache-correctness.ts --docs=12`: `163 steps / 0 mismatch`.
- `bun script/verify-opentui-closure.ts` and `bun script/verify-opentui-closure.ts --source-revision-authorized`: both passed; version `.4`, tag `v0.4.3-smark.4`, gitlink/source `df4bd31c`, 11 packages, Solid `1.9.12`, native hash recorded.
- `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts`: `1 pass / 0 fail` against installed `.4` packages.
- `bun test test/script/opentui-provenance.test.ts`: `2 pass / 0 fail`; `bun typecheck`: passed from `packages/opencode`.
- GitHub workflow `30292454580`: all source validation, native/framework/Node smoke, 11-package packing, cross-platform verification and immutable Release publication steps passed.

### Original Feedback-Loop Result

R18 public baseline: `2 commits`, max gap `4834ms`, catchup `757ms`; R27 public result: `220 commits`, gap p95 `29ms`, max `308ms`, catchup `218ms`, `0` shrink.

### Actual Secondary and Replacement Path Inventory

No new alternate success path. Normal append-only Markdown remains the same full-context primary path with deferred scheduling; semantic invalidation uses the existing isolated one-shot termination path. No parser fallback, raw-text success fallback, source/native fallback or `.3` reuse was added.

### Chinese Comment Calculation

| Metric | Actual | Evidence |
| --- | --- | --- |
| Effective changed code lines `E` | `392` conservative | nested production/test/config diff; generated dist, artifacts and pure formatting excluded |
| Qualifying Chinese comment lines `C` | `66` | adjacent Code boundary/cache comments and public behavior-test intent comments |
| Ratio | `16.8%` | `66 / 392` |
| Required minimum | `59` | `ceil(392*0.15)` |

### Remaining Unverified Items

- final independent full-scope implementation audit of the complete nested source plus parent `.4` closure diff.
- final parent commit remains pending the clean implementation-audit verdict; unrelated dirty files must remain excluded.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R27 source pre-release | yes | none | N-01 correct core JS cwd; N-02 expected test warnings; N-03 parent/remote stages remain subsequent | APPROVE | `ses_05b4e77d2ffesIfosBuha4mkOR` |
| 2 | R27 complete implementation | yes | B-01: sub-threshold open-fence append retained stale visible frame under reachable `drawUnstyledText={false}` consumers | audit-mode metadata precision | BLOCK | `ses_05b2ba123ffeVnAHWGLZGY8FxY` |
| 3 | R28 complete implementation | yes | B-01: provisional visible frame did not cover ordinary active append; B-02: non-current revision metadata | legacy upgrader remains intentionally unused | BLOCK | `ses_05b17f333ffezcETZF3EQZZ3ko` |
| 4 | R30 complete implementation | yes | B-01: stale queued provisional `onChunks` callback could begin after invalidation | v2 consumer inventory and runtime-test action metadata | BLOCK | `ses_05b11ece1ffeZXdyGCi1pwP6r0` |
| 5 | R31 complete implementation | yes | B-01: in-flight async `onChunks` blocked later visible provisional frames | `.5` parent fixture remains future implementation work | BLOCK | `ses_05b0c8243ffeWdEFsKLnxV7cCf` |
| 6 | R32 complete implementation | yes | B-01: pre-transform provisional frame violated generic `onChunks` contract | none | BLOCK | `ses_05b04c596ffeVjVvInC0f7LRfi` |
| 7 | R33 complete implementation | yes | B-01: identity marker omitted from public snapshot/invalidation boundary | current verdict wording drift | BLOCK | `ses_05aff0b22ffe0MSZTPT5vsjeyy` |
| 8 | R34 complete implementation | yes | pending independent audit | pending | audit-required | pending |

The task cannot be marked `verified` until an independent full-scope implementation audit returns `No blocking findings` for the approved revision and actual diff.

<!-- 本文是唯一实施合同：保留历史审计原文，当前修订补充组合器语义、全 PR 注释门禁与验收证据。 -->
# Canonical Implementation Plan: Execute async flow

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: user conversation and R4 full-PR comment requirement, 2026-11-07; attached workflow.md (libfile_d461dd102a5c81918d83af11e76b9131) and 已粘贴的文本.txt (libfile_f6dd2d46847481919e413470cb9f8afe)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-07
>
> Target: verified-implementation-and-commit, followed by an explicitly requested draft PR to dev1-smark; never merge.

This is the sole implementation specification. Base: `70670d1b030bee4198887c633ce2607ad6360e66`, verified against `git ls-remote origin refs/heads/dev1-smark`. Remote PR branch: `execute-async-flow`; local branch: `execute-async-published`. R4 appends to existing draft PR #1 at `67a07de994b4000910112b035f0a25ef771b711d`; it never rewrites that commit or updates `dev1-smark`. Sections 22–24 retain historical R1/R2 audit and implementation evidence, not current approval. Section 25 specifies the R4 delta and current acceptance evidence.

## 1. Verbatim Requirement

Latest complete user instruction:

> 很好，你刚刚如上的调研其实整体而言都很好，但是我们的分支主要是 dev1 SMARK，所以我们是基于 1.19 的这套分支去做一个修改的起点。然后呢，有一个问题，就是确实你所说明的那个什么并发呀，等等一些东西，可能会有一些问题，所以你需要按照我给你上传这套 workflow。你可以把这个 workflow 配置在我们这个 Open Code 的仓库，或者说你也能够在我们 Open Code 的仓库里面看到到这个文件。然后你如果去进行这个 Open Code 的一个修改的话呢，我需要你去完全按照 workflow 的流程走，也就是说你需要让，就是你如果去做东西的时候，你一定要按照这个 workflow 去走。然后最终你的验收标准呢，因为你本身其实不具有这个 commit 的 push 能力，所以你进行 commit 之后你进行这个 PR 就 OK 了。最终呢，用户会考虑要不要去合并你的分支。然后目前我们需要做的操作呢，就是首先在这个代码层面去以较小的修改的 chunk 去解决这么一大堆的这些问题，就是把它变得更加，就是我上文描述一样，就是让模型能够更加准确、鲁棒地去调用这些工具。然后呢，就是职责划分要清楚，因为你不应该是一些不必要地抛出错误的东西。就比如说，可能一些工具，就比如说，当然我指的不是在工具层面，blabla，我指的意思就是在 execute 层面。你比如说一些本来它可以自己去处理一些东西，就比如说像是非常简单一个格式化，可能触发了某个，当然我只是举个例子，这可能并不是真实场景。我指的意思是，比如说 execute 内部实现的一套逻辑，然后呢。 本身其实 Agent 并不关心，它只要 Agent 的作用就是调用工具完成任务就 OK。但是你的 execute，假如说你可能写了一段什么代码，要求这个输入的代码必须是格式化的，如果不是格式化就报错。当然这套逻辑是符合标准的，但你这套标准对于实际的 Agent Loop 可能不是比较优秀的。换言之呢，你这种逻辑可能会导致 Agent Loop 它花大量时间去解决本不应该由 Agent 去负责的一些东西。所以你的这个 execute 呢，你这个职责划分的你应该去避免去进行过多这种什么错误，巴拉巴拉的。就是这些错误你应该自己去把它解决掉，不应该去以什么报错等等这种逻辑语义去进行一个中断。对，当然呢，我并不是说你的工具层面的一些东西不能去抛出错误等等的，但是请你注意，就是适当地避免这种原本合法的一个调用被内部的处理机制搞得不合法，然后就报错出来。所以这种情况应该避免。然后你需要按照现在我 flow 的一个完整的逻辑流程去构建 side plan，然后进行。 也就是按照 workflow 进行。对，就是你按照 workflow 进行这个撰写呀，然后以及审计呀，以及这个实施啊，以及再审计呀，然后等等，按照这套流程去走。然后最终呢，用户已经说了，他整体希望这套逻辑架构你不要把它改得非常复杂。也就是相关的 HUNK，尽量保持这个精简泛用，就是一次修改能够泛用多个分支。你不要去一个修改操作能解决的事情，不要去以多个分支去解决。然后包括审计员提出的一些问题，可能本身审计提出的问题可能反映了你的这个最开始所设计的抽象模型不够，就是某一些逻辑你简洁度啊，或者说等等的一些东西，你修改是细枝末节，导致你只修改了一个分支下，分支没考虑到。所以按理来说一个好的抽象模型就天然地能够避免这类细枝末节的一些东西，因为它在根源处就已经消除了这种风险。然后所以按照这套逻辑你去进行构建以及进行这个 PR 的一个提交。然后请注意呢，按理来说你也你的这套操作呢，应该也去吸纳一些，看一看他们这些提词词都是如何去撰写构建的。因为相关提词词最好是逻辑语言通顺，然后细粒度。就比如说到底应该这个东西怎么怎么用啊，或者说比如给出一些这种渐进式的一些，就是保持你这个 SQL 的工具难度曲线，对于难的模型还有对于小的模型，它都是一个这个渐进，这个难度曲线都是一个渐进的一个操作，就是避免你开局直接就…… 写一大堆，或者说避免你这套提示词，直接从一开头就是一大堆复杂的各种技术逻辑，这本身小的模型可能就会避免掉这些东西。所以你这套逻辑应该以较为清晰，而且不会非常引入 Agent 本身不需要知道的一些复杂度去进行这个撰写，blabla的。然后你可以去参考，比如说因为你可以去参考一下什么 Cloud Code，或者说这种高级优秀的提示词的撰写风格，因为他们其实你可以明显看到，他们是以这种散文化呀，或者说一些其他的撰写逻辑。然后你也可以参考我们既有的这个 Tool Code，或者说就是各种工具啊，就是除了 Execute 之外的各种工具的一个提示词的撰写，或者说 PI Agent，或说 Codex等等这些撰写逻辑。你参考那些逻辑去进行这个提示词的一个相应的一些修改，或者说是改造提升，使得这个工具变得更加好用易用，而且上线线更高，而且用起来非常的简单。同时呢，又能够让那个 Agent 它在调用的时候呢，就是这个 sample，或者说这种调用的习惯呢，又能够让它去避免过多地去把一些中间结果去进行一个放到最终回线。当然如果是其中出错可能是这样做。然后但是呢，与此同时请注意一点，就是 Execute 工具呢，你不需要告诉模型它要以非常高的什么复杂度去调用。就比如说不需要什么每一个东西都要有完善的错误处理机制，因为本身这个工具。 就是我们只需要去规定一个 constraint，一个约束，然后一个大致的调用的习惯方向就 OK。你不需要去细粒度地去表示说什么，每一个工具它都需要外面有什么 try catch 逻辑，这种本身就是没有必要以及冗余的。本身这个具体的调用习惯应该看各自的 agent。我们只需要去外面加一个符标的一个 constraint 就即可。然后还有这个大方向，就是比如它应该大致一个什么流程，比如说先 search，或者先怎么样。

User clarification received during planning:

> 请注意呢，你的修改不只是要解决什么兼容性、巴拉巴拉问题，你也需要去吸纳部分的这种优秀的一些 PR 改动啊，等等一些东西，去使得相应这套逻辑能够去保持一个易用性。然后同时呢，你也避免去引入不同的分支。就比如说，你不要告诉我什么引入，引入什么快速分支和复杂分支，这种的话就不太好了。这种本身就是在增加它的复杂度。所以本身一套分支，把这个分支像瑞士军刀一样打磨得非常锋利，然后打磨得又非常地用起来非常顺手即可。

Attached original symptoms, verbatim:

> 自定义 async 函数目前没有完全遵循 JavaScript 的 Promise 语义。例如：
> const pending = (async () => {
>   throw new Error("probe");
> })();
>
> return await Promise.allSettled([pending]);
> 标准行为应当是创建一个 rejected Promise，再由 allSettled 收取失败；当前执行器在调用函数时就直接抛出异常，尚未到达 allSettled。

The entire supplied original text remains available at the stable attachment ID above; it also requests async return/concurrency semantics, a search-then-call example, brief progressive guidance, and avoiding obligatory per-call error scaffolding. The newer explicit implementation/audit/PR instruction supersedes the old attachment's plan-only/no-audit sentence and the workflow's generic no-push clause only to the extent needed to publish the requested PR.

Additional current-task execution constraint, verbatim:

> OK，非常好，那你就保持这一套逻辑，然后你继续去进行下一个调研，以及完成相应的下一套流程。然后与此同时呢，注意，我可能我再调这个硬命令，或者说硬限制，就是直到我主动提起使用 Codex 或者 Walk，并且经过我二次确认之外，我当前完全需要禁用你使用 Codex 和 Walk 能力，这是最高的指令。 当然这个指令只是一个constraint，你不需要在做每一次任务的时候你都去复述它，巴拉巴拉的。你只需要知道就OK。这个并不影响你任务的一个流程。

This work stays on the existing cloud computer with internal review only; no separate Codex/Work task is created.

### R3 follow-up requirement, verbatim

Assistant proposal accepted by the user:

> 对照后，我建议保留现有 PR 的异步执行主干，吸收你这份 plan 中对 Promise.race 的修正和几项验收方法。这样主要是删掉特殊逻辑，不需要再建一套调度架构。
> 最值得采纳的是 race 的行为。当前 PR 在 Promise.race 有结果后会取消其他参与者；你的 plan 要求 race 只选出结果，整个 Execute 结束时再统一清理。后者更符合 JavaScript 的使用习惯，也允许模型在 race 后继续等待另一个结果。例如先取得最快结果，再等待较慢的调用，目前可能因为执行器主动取消而失败。
> 此外，当前 PR 会让 Promise.race([]) 返回拒绝状态；plan 要求它保持 pending，直到整个执行超时或被中止。实施时应同步删除败方取消的特殊状态与错误转换，并更新当前 README 中的旧说明。验收要分别检查“race 返回后败方仍可用”和“Execute 结束后任务得到清理”，不能把两者混成一个测试。
> 你的 plan 中已经由 PR 覆盖的部分包括 async 函数返回 Promise、独立调用帧与共享闭包、await 让出调度、Promise.all 及时暴露后项失败、统一执行作用域，以及 search → 调用 → 精简结果的示例。这些不需要重做。当前 PR 还检查了两个提示词出口；附件只列了其中一个，后续应保留两个出口的检查。
> 值得补强的验证有三项：
> 1. 测试 allSettled 中前一项一直等待、后一项发生宿主中断时，中断能否及时传出。代码目前按顺序观察结果，存在被前一项挡住的风险；这是代码分析，本轮尚未运行复现。普通任务仍可并发执行，不能把顺序观察直接等同于工具串行。
> 2. 用真实宿主入口验证 async 调用的结束、取消和清理，而不仅验证解释器单元测试。
> 3. 比较提示词效果时，同时记录真实任务的正确性、模型往返、失败重试和实际 usage。当前还没有数据支持具体的 token 或费用收益。
> 提示词本身只建议做小修：fetch 由宿主选择是否提供，描述应反映这一点；已有的发现工具、并发和精简输出示例可以保留。无需加入完整 Promise API 清单、强制 try/catch 或命名空间误调用提示。
> 还有一项现有能力应保留：Execute 支持异步 String.replace 回调，你的 plan 没有覆盖它。修正 race 时不应顺手删掉这项行为。
> 按照仓库 workflow，若实施 race 语义变更，需要先更新当前 PR 的计划和验收标准，再走测试与审查；不能直接沿用旧计划对“race 会取消败方”的批准。本轮我只做了对照，没有修改代码或重新运行测试。

User confirmation:

> 可以，是的，你可以按照现在的逻辑流程去更新相应 PR 的一个计划，以及相应的一个验收标准，然后你再走全套流程，然后再去最终去这个调整以及更新相应的一个 PR。也就是说最终把你的那个 PR 那套分支进行一个追，就是按照我的理解，PR 本身就是一个分支树嘛，那你就在那个分支树上你去追加这个 commit 节点，使得相应的 PR 就是保留整体的逻辑是更加优秀准确的。

Earlier publication exception and configuration constraint remain in force:

> 不要去把这种额外的配置纳入 PR。你就直接去提交 PR，大不了你跑完这些东西，你就直接，就是你大不了你这些门禁，反正你本身你已经测过这些东西了。那如果实在不行的话，你就直接去这个提交一个 PR 就 OK，不要去提交主分支，不要 merge。
> 对我说的不要包含这种荣荣余的这种逻辑。

This authorizes publication to the existing feature branch despite an accurately disclosed resource-blocked aggregate gate; it does not authorize skipping targeted checks, hiding failures, changing checker configuration, pushing the target branch, or merging.

## 2. Explicit Non-Goals

No fast/complex modes, second interpreter, new public API, dependency, configuration, retry, fallback, host permission policy, background jobs, output protocol, Promise constructor/chaining, or wholesale newer-version migration. Preserve real tool failures and sanitization. No invented formatter bug: the user's formatting case is explicitly an illustration. Do not change catalog budget or direct V1 tools without evidence.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| AGENTS.md, packages/codemode/AGENTS.md | Minimal cohesive owner changes, no unchecked new types, package-local tests/typecheck; host owns permissions |
| CONTEXT.md, docs/agents/domain.md, docs/adr/README.md | Session/Model Tool Output vocabulary; no applicable accepted async ADR (only triage ADR indexed) |
| docs/workflow.md, .opencode/policy/first-principles-engineering.md, first-principles-planning skill, canonical template | Red-capable loop, exact plan approval before repository implementation, independent full-scope audits, Chinese comment gate |
| packages/opencode/AGENTS.md, test/AGENTS.md | Host integration inspections/tests, Effect ownership and deterministic synchronization |

`diagnosing-bugs` and `tdd` are referenced but unavailable in the repository, local skill roots and selected-environment skill catalog. Their bodies were not fabricated. The explicit workflow/policy feedback-loop and vertical red-green requirements are applied and recorded below. Existing repository workflow already matches the supplied attachment; no duplicate workflow installation is necessary.

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| packages/codemode/src/interpreter/{model,runtime}.ts | Function values, scopes, await, combinators, cancellation, callbacks | observed |
| packages/codemode/src/{values,codemode,tool-runtime,tool-error}.ts; stdlib/promise.ts | Promise value, public seams, discovery/schemas, host failure split, concurrency cap | contracted |
| packages/codemode/test/{promise,stdlib,parity,codemode,signature,enumeration,openapi}.test.ts | Existing compatibility, error, safety and behavior contracts | contracted |
| packages/opencode/src/tool/code-mode.ts; tool/registry.ts; test/tool/code-mode*.test.ts | Execute host, preflight and real tool dispatch, interrupt propagation, output projection | reachable |
| packages/codemode/{README.md,package.json,tsconfig.json}; root package.json/.oxlintrc.json | Documentation, exact test/tooling commands | contracted |
| packages/core/src/system-context/prompt/gpt.txt | Already scopes multi_tool_use.parallel restriction to direct calls; not a reason to add another Execute workflow | observed |
| Isolated /tmp/execute-async-experiment/codemode | Candidate run and all existing package tests; no repository production/test edits before approval | observed |
| Pi official codemode tool.ts at 085c84e98e7f4c950f2be606466fff4f75d8fe7c:113-140 | One short workflow guideline, detailed API separate; compose and filter output | observed |
| Codex description.rs at cce9d3228b5d649cea400bc6d19514a0342ad998 | Preserve honest runtime boundary; do not import its text()/ALL_TOOLS/normalized naming API | observed |

External reference URLs: https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/coding-agent/src/extensions/codemode/tool.ts#L113-L140 ; https://github.com/openai/codex/blob/cce9d3228b5d649cea400bc6d19514a0342ad998/codex-rs/code-mode-protocol/src/description.rs . Claude Code hidden system text was not verified or copied.

### Selective community adoption on the existing path

These are references for bounded improvements, not declarations that open proposals are released features. Recheck metadata before publication.

| Source | Relevant benefit | Decision on dev1-smark |
| --- | --- | --- |
| Upstream v2.2.5 `9bbb8ce18c80f099e0e448775f59d965ead40a21`, codemode/src/interpreter/promises.ts | Promise capability separates invocation from settlement; combinator observes deciding failure rather than index-order wait | Adopt that semantic principle in the existing Effect interpreter. Do not transplant its new object/runner/thenable architecture or expand Promise API. Local source inspected directly. |
| https://github.com/anomalyco/opencode/pull/62176 (open proposal) | Progressive namespace discovery; avoid confusing partial catalog with unavailable capability | Adopt progressive-discovery guidance in the single existing description/catalog: unlisted tools remain searchable. Do not introduce namespace state, a new catalog algorithm, or another context-update path. Existing search already returns full signatures. |
| https://github.com/anomalyco/opencode/issues/62316 and /issues/62336 (issues, not PRs) | Short-schema selection can hide useful tools; namespace is not a callable tool | Teach search by task and exact returned call path. No pin configuration, guessed tool fallback, or automatic recovery calls. |
| https://github.com/anomalyco/opencode/issues/58708 (issue, workload-specific self-report) | Filter/aggregate before sending results to model | Adopt small projected-return example; do not claim the author's cost ratio as this branch's performance. |
| https://github.com/anomalyco/opencode/pull/54251 and /pull/60709 (open proposals) | Preserve interrupted evidence / long-execution supervision | Existing host already records child outcomes and error metadata. Preserve that seam; do not add new job handles, background execution, or change return types in this task. |
| https://github.com/anomalyco/opencode/issues/59566 and https://github.com/code-yeongyu/oh-my-openagent/issues/12028 | Child supervision and plugin compatibility are host/integration concerns | No unverified Ultrawork plugin integration or child-session API in the confined interpreter. |

The new hint is one sentence in the existing partial-catalog section, not a second workflow or execution mode. README budget wording is corrected to reflect already-shipped namespace heading cost, without changing selection.

## 5. Current Behavior

The following diagnosis records the original 70670d1 base. R2 implemented that repair; R4 current-head observations are recorded in section 25.

`model code -> V1 CodeModeTool -> same-runtime permission preflight -> host.begin -> CodeMode.execute -> TS erasure/Acorn -> Interpreter -> host.invoke -> schema/data boundary -> return/log projection`.

Function AST records `async`, but CodeModeFunction drops it. All functions execute inline by replacing one interpreter-wide scope stack. Array callbacks consequently wait for the entire function, throwing before combinators can observe rejection. Promise.all/allSettled/race also run inline, returning values instead of Promise values. Promise.all observes in index order, hiding a later rejection behind an earlier blocked call. Pending cleanup removes a promise when observation is constructed rather than settled. The tools themselves already start eagerly with an eight-call semaphore. Host failures, permissions and output shaping belong outside this repair.

## 6. Supported Input Domain and Reachability

| Condition | Producer/guarantee | Reachable path | Owner | Class |
| --- | --- | --- | --- | --- |
| async declaration/expression/arrow; default params, closures, nested awaits | User script, valid AST | createFunction -> invokeFunction, including array and response callbacks | interpreter | observed |
| tool promise, async result or combinator in arrays | Valid values from existing functions | all/allSettled/race/resolve/await | interpreter | observed |
| shared closed-over mutation and concurrent local bindings | async map or sibling calls | function scope stack | interpreter | reachable |
| unawaited work, fail-fast survivor, timeout/host interrupt | Script exit, rejection or existing host abort | Promise lifetime -> execution completion | execution scope | observed/reachable |
| async string replacement callback | README and stdlib regression | invokeStringReplacer | string replacement owner | contracted |
| absent/bad tool or malformed data | Actual tool tree/schema boundary | existing ToolRuntime | host/runtime validation | contracted, unchanged |

## 7. Required Invariants

| ID | Invariant | Evidence/existing tests |
| --- | --- | --- |
| INV-01 | Async invocation returns a Promise; return adoption and throws settle that Promise | User symptom; new behavior slices |
| INV-02 | Each await yields to its caller; independent async map pipelines overlap; invocation locals do not cross-contaminate, closures stay shared | User order/concurrency; existing map/cap tests |
| INV-03 | all/allSettled/race themselves return composable Promise values; all rejects on first settlement failure while retaining input-order success | JS-facing existing statics; new nested and readiness-gated tests |
| INV-04 | All pending execution work is owned until execute returns; cancellation/timeout is not converted to program success | Existing fire-and-forget/timeout/host interrupt tests |
| INV-05 | Preserve the existing eight-tool cap, exact tools/search/schema, private errors, JSON boundary, async string-replacer compatibility; race ownership follows INV-08 | Existing 264 tests and package contract |
| INV-06 | One concise progressive guide: discover exact signatures, compose deterministic steps, keep dependencies/writes ordered, return only useful evidence; no blanket catch requirement | User full request and Pi/Codex sources |
| INV-07 | Follow exact workflow, independent audits, verified commit and draft PR on correct base without merging | Latest user instruction |
| INV-08 | race chooses the first settlement without canceling member work; race([]) stays pending; execute termination owns cleanup | R3 accepted proposal; public execution probes |
| INV-09 | allSettled preserves ordered ordinary outcomes but a later host interruption cannot be hidden by an earlier pending item | R3 probe; README host-interruption contract |

## 8. First Divergence and Root Cause

| Invariant | Origin -> propagation -> manifestation | Owner/proof |
| --- | --- | --- |
| 01/02 | AST async flag discarded -> inline invokeFunction and shared scopes -> number result, early throw, serialized map | model.ts CodeModeFunction and runtime.ts createFunction/invokeFunction |
| 03 | Combinator observation mistaken for invocation -> inline sequential joining -> rejection occurs before allSettled and fail-fast waits | runtime.ts invokePromiseMethod |
| 04 | Pending ownership conflated with observation -> removed before actual settle -> cannot safely generalize fail-fast/async lifetimes | runtime.ts observePromise/run/createToolCallPromise |
| 06 | Minimal runtime facts lack workflow/projection example; README still describes retired guide and wrong cleanup | code-mode.txt / README Discovery and Supported Programs |

Actual public `CodeMode.execute` red loop on unmodified base, Bun 1.4.4, package cwd:

- `async function f(){return 7}; return [typeof f(),await f()]` => `["number",7]`, expected `["object",7]`.
- Original async throw/allSettled => `ok:false, Uncaught: probe`, expected rejected outcome data.
- `await 1` inside async => `before,after,caller`, expected `before,caller,after`.
- Three async two-tool pipelines => `maxActive=1`, expected overlap; outputs correct but serialized.
- `const p=Promise.all([Promise.reject("probe")]); return await Promise.allSettled([p])` => uncaught failure instead of nested outcome.

Commands executed with `../../node_modules/.bin/bun -e '<public CodeMode.execute scripts + Tool.make Effect.sleep trace>'` from packages/codemode. The regression tests will retain these exact programs, not source assertions.

## 9. Responsibility and Seam

| Concern | Owner/interface | Why here, not elsewhere |
| --- | --- | --- |
| Function identity, lexical frame and async suspension | Interpreter/CodeModeFunction | AST has intent; tools/callers cannot compensate for lost async identity |
| Promise creation, joining, execution lifetime | Interpreter + existing Effect Scope/Fiber | All producers share one confined execution; host must not manage interpreter internals |
| Tool concurrency and authorization | Existing semaphore/host.invoke | Only actual calls consume permits; wrapper functions/combinators must not deadlock the eight slots |
| String replacer compatibility | Existing invokeStringReplacer | Published async replacement is deliberate extension; do not generalize automatic unwrapping to map/filter/data |
| Workflow and output guidance | code-mode.txt, public description | Shared by all models; leaf schemas own output fields and actual failures |

## 10. Single Approved Primary-Path Design

`parsed function metadata -> independent invocation frame + shared lexical Binding maps -> one execution-scoped Promise producer -> existing await/join -> unchanged safe output boundary`.

1. Preserve `async` on CodeModeFunction. Keep every function on one evaluator, but allocate a frame (scopes/lastValue) per invocation. Share an execution object containing tool dispatch, logs, semaphore, fetch response factory and Effect scope. Captured maps are shared references, local scope stacks are separate. Move builtin initialization into the same interpreter factory; no second engine.
2. One `createPromise` helper starts a fiber in the execution's Effect scope. Tool calls retain the semaphore; async bodies and combinator observers do not acquire tool permits. Async bodies adopt returned SandboxPromise; throws/default-binding errors reject instead of escaping invocation.
3. `await` introduces an Effect scheduler yield before consuming either Promise or plain value. Synchronous functions stay synchronous; callback APIs see the actual returned value (so map produces promises, and ordinary filter predicates do not magically await).
4. all/allSettled/race return a Promise around their existing observation logic. Observe all concurrently for fail-fast and allSettled concurrently for host interruption, preserving ordered results and normalized ordinary failures. race observes the first Exit without interrupting member producers; empty race remains pending. Remove race-specific interruption state/conversion. resolve/reject remain immediate promise values.
5. Run the program within one `Effect.scopedWith` lifetime. Remove the pending-set lifecycle and eager observation deletion entirely. Scope teardown interrupts pending work even if an observer was canceled or an async function has already returned a container of promises. No background lifetime, no retry or catch-and-success.
6. Preserve explicitly async string replacers by settling only the async function's result at that existing callback owner. The established missing-await error for a synchronous replacer returning a tool Promise remains, as required by the existing paired stdlib test. Do not add automatic recursive unwrapping at data boundaries.
7. Rewrite code-mode description progressively: purpose/composition, exact discovered paths, await/concurrency/dependencies, concise output/log behavior, one conditional search→parallel projection example using discovered signature, and one partial-catalog reminder that unlisted tools remain searchable by task. Keep catalog scope rules and unavailable APIs honest. No mandatory per-call try/catch. Update only directly stale README discovery/async/lifetime paragraphs. Prompt semantic effect on real models cannot be automatically proven here; executable example and public instruction contracts can.

Plan-stage isolated result: all five red programs become expected outputs, async pipelines `maxActive=3`, shared counter remains 3, returned container of tool promises remains usable. Original 35 Promise tests pass; typecheck passes. Full 264 suite initially detected string-replacer compatibility (async resolved value versus sync missing await), addressed in the candidate at that owning seam, never by weakening the test. Final isolated verification: **264 pass, 0 fail**, 752 assertions, and package `bun typecheck` passes. Baseline host integration command cannot start because `@opentui/solid/preload` is not installed; this is also absent before any changes.

## 11. Secondary and Replacement Path Inventory

| Path | Class | Success? | Disposition |
| --- | --- | --- | --- |
| sync/async function value behavior | Supported primary-contract domain | yes | same evaluator, async result represented as Promise |
| tool permit vs non-tool orchestration | Existing primary ownership | yes | preserve shared eight-call cap only for actual host calls |
| async string replacer | Shipped compatibility | yes | preserve explicit documented callback contract |
| Promise rejection and host interruption | Existing failure outcomes | no | preserve; never swallowed |
| namespace validation, search aliases, direct V1 calls | Existing boundaries | yes/no | unchanged |
| New fast/complex mode, alternate parser, fallback/retry | Forbidden alternate success | no | rejected |

New alternate success paths: zero. New diagnostic decision surface: zero (0%); no added diagnostics. Supported-domain branches represent async metadata and Promise values, not alternate recovery algorithms.

## 12. Workaround Deletion and Replacement

| Existing logic | Replacement |
| --- | --- |
| pendingSettlements tracking, deletion-at-observation, manual interrupt loop | Execution-scoped fiber lifetime owns all pending promises |
| savedScopes swap/restore shared by all functions | Independent frame reusing captured lexical Binding maps |
| sequential Promise.all observation | Concurrent observation with ordered Effect.all result |
| README's obsolete mandatory Workflow/Rules/Language shape and unhandled-wait cleanup claim | Actual public description/catalog and interrupt-at-exit behavior |

The prior uncommitted patch was read but not applied. Its namespace hint is unrelated to a legal-call async failure; its pending-set patch is superseded by correcting lifetime ownership, rather than retaining additional cleanup bookkeeping.

## 13. Forward Traceability

| Requirement/invariant | Path | Files | Behavior test |
| --- | --- | --- | --- |
| 01 | createFunction/invokeFunction | model.ts/runtime.ts | async forms, return/adoption/default failure, original allSettled throw |
| 02 | frame + await | runtime.ts | synchronous prefix/order; concurrent closures/locals; multi-step async map |
| 03 | createPromise/combinators | runtime.ts | identity/nested allSettled, gated fail-fast, ordered success, duplicate awaits |
| 04/05 | execution Scope + existing tool seam | runtime.ts | survivors awaitable while program active; none survive exit/timeout/abort; cap >8; retained safety suite |
| 05 | string replacer owner, fetch response methods | runtime.ts | existing stdlib paired test; async fetch response method composition |
| 06 | shared description/discovery and host description exposure | code-mode.txt, README.md, codemode.test.ts; opencode test/tool/{code-mode,registry}.test.ts | execute literal search then projected parallel example; complete/partial/empty catalog; host description equals shared public definition |
| 07 | canonical plan / audits / final checks | this file | recorded verdicts, command output, exact remote/PR verification |

## 14. Reverse Traceability

| Concept | Requirement | Why existing logic is insufficient |
| --- | --- | --- |
| async metadata | 01 | discarded bit cannot be recovered at a map or tool caller |
| per-invocation frame/shared Execution | 02/04 | one mutable scopes stack cannot suspend two function bodies safely; execution capability owner must remain shared |
| execution-scoped Promise helper | 01/03/04 | tool-only fork lifetime and manual pending set cannot represent composable async bodies and observers reliably |
| await yield | 02 | already-settled/plain values currently run inline, violating observed ordering |
| concurrent all observers | 03 | ordered waiting hides later rejection; must retain success ordering, not sequential settlement |
| explicit async replacer settlement | 05 | shipped documented behavior relied on erased async execution; paired regression proves required distinction |
| concise workflow/example + README correction | 06 | existing facts do not teach composition/projection; current README conflicts with shipped discovery and cleanup |

## 15. File-Level Change Plan

| File | Action/responsibility | Expected substantive delta |
| --- | --- | --- |
| packages/codemode/src/interpreter/model.ts | Preserve async flag | 1–3 |
| packages/codemode/src/interpreter/runtime.ts | Frame/shared execution, Promise owner, await/join, replacer compatibility | ~90–150 excluding relocation/format |
| packages/codemode/src/code-mode.txt | One shared progressive guide and executable example | ~12–20 |
| packages/codemode/test/promise.test.ts | Public async/composition/concurrency/lifetime slices | ~140–220 |
| packages/codemode/test/codemode.test.ts | Replace obsolete description hash with public behavioral example; fetch composition | ~20–40 |
| packages/codemode/README.md | Align directly affected discovery/async/lifetime docs | ~15–30 |
| packages/opencode/test/tool/{code-mode,registry}.test.ts | Replace both obsolete upstream-description hashes with equality to the approved shared CodeMode.description; retain catalog separation | ~6–10 |
| docs/plans/execute-async-flow.md | Canonical evidence, approvals, final verification | documentation |

No production files outside codemode. Both host-level fixed-description hash assertions are affected consumers and remain covered; R3 adds actual host lifecycle coverage in session/execute.test.ts. Host checks remain part of verification when environment dependencies permit.

## 16. TDD Behavior Slices

| Order | Red | Minimal green | Regression |
| --- | --- | --- | --- |
| 1 | original async rejection/type/order, async map overlap | metadata/frame/scoped producer + await yield | sync closures/arrays, errors, private host sanitization |
| 2 | nested combinators and later failure behind gated first call | same producer for combination + concurrent all observation | ordered results, allSettled reasons, race, cancellation |
| 3 | lifetime of adopted/container work, ignored async call/failed join/timeout/host interrupt | shared execution scope rather than observer-owned pending set | no late side effects; surviving Promise reusable before exit |
| 4 | new prompt example absent; public hash intentionally outdated | approved concise guide and literal executable example | discovery exact paths/schema, partial catalog remains visible |

Test actual public `CodeMode.execute`/`make`, independent expected values and host state. Synchronize fail-fast via Deferred/tool signals, not an elapsed-time race. Async pipeline overlap uses actual active-work counters, not implementation call counts. No production helpers solely for tests.

## 17. Chinese Comment Budget

Estimated effective changed production/test code E: 240–360, excluding blank/import/format/moves/prose. Required C: at least ceil(E×0.15), estimated 36–54. Comments adjacent to changed decisions/tests explain frame versus closure ownership, scheduler yield, scoped lifetime, semaphore boundary, ordered-versus-fail-fast settlement, async replacer contract, and each non-obvious safety/test invariant. The final actual count governs; never add superficial translations or split filler to meet the ratio.

## 18. Verification

| Command | cwd | Evidence |
| --- | --- | --- |
| `bun test test/promise.test.ts` (red then green, including original programs) | packages/codemode | Public semantic/concurrency/lifetime slices |
| `bun test` | packages/codemode | Complete codemode regression suite |
| `bun typecheck` | packages/codemode | Package configured tsgo check, not direct tsc |
| `bunx --no-install oxlint packages/codemode/src packages/codemode/test` | repository root | Compare against baseline if existing warnings persist |
| `bunx --no-install prettier --check <changed TS/docs>` | repository root | Changed regions formatting; avoid whole-file unrelated reformatting |
| `bun test test/tool/code-mode.test.ts test/tool/registry.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts` | packages/opencode | Host auth/preflight/metadata/interruption regression if full dependencies available; report exact blocker otherwise |
| `git diff --check`; full status/diff/cached/log inspection | repository root | No unrelated changes, no secrets; commit only task paths after approval |
| Remote head + PR metadata/checks | GitHub / git | Correct base, published commit, draft PR, no merge; disclose CI incomplete |

Bun 1.4.4 is reused from the existing cloud environment. Implementation verification provisioned the exact locked repository dependencies with `bun install --frozen-lockfile` after the initial minimal dependency symlink could not start host tests. No tracked lockfile or package dependencies changed. Normal install hooks were allowed to run.

## 19. Diff Budget

One plan added, eight existing package files modified, no deletions/generated output. Production code ~90–150 effective lines; tests ~160–260; prose ~30–50. Moving globals into the factory and nesting combinator effects may enlarge displayed diff but does not justify unrelated formatting. Complete semantics, not line-count alone, determines necessity.

## 20. Real Risks and Open Decisions

- Confined runtime retains intentional non-native contracts: async string replacers are supported; nested unresolved Promise data is rejected. R3 deliberately changes the previously documented race-loser cancellation per explicit user approval; no external consumer requiring it was found.
- Losing race work continues while execution is active; execution scope closes all still-running producers and wrappers on exit. No arbitrary rollback of already-started tool side effects is promised.
- Host permissions and tool outputs remain real failures. An async rejection does not authorize suppressing it or retrying a partially completed operation.
- Existing package integration dependencies may be absent; this is a verification environment limit, not permission to weaken tests.
- Cannot demonstrate end-to-end model behavior quality without provider access/evaluation fixtures; document this rather than claim measured agent improvements.

### Open Decisions Requiring the User

None currently. User chose one path, current branch, full workflow and PR. No new permission or product mode is introduced.

### Rejected Speculation

Do not add automatic formatting repair (no observed failure), full Promise API, arbitrary callback waiting, catch scaffolding, deeper permissions, new background mode, namespace fallback, or a newer runtime wholesale. The stale README is not authority to restore obsolete behavior.

## 21. Audit Contract

Use repository adversarial-auditor and adversarial-audit skill independently. Audit full original requirement and current canonical revision, actual source/call paths/tests, first divergence/owner, all production concepts, no alternate success paths, preserved contracts, Chinese comment gate and exact verification. Builder summaries are not evidence. Six plan rounds / three implementation rounds maximum.

## 22. Plan Audit Record

| Round | Revision | Full scope | Result | Invocation |
| --- | --- | --- | --- | --- |
| 1 | R1 | yes | BLOCK, B-01 | audit_execute_plan |
| 2 | R2 | yes | APPROVE, no blocking findings | audit_execute_plan |

R2 resolves B-01 by adding both affected host hash assertions. A full repository search additionally found `packages/opencode/test/tool/registry.test.ts:174`; both use the same old hash and receive the same owner-level test correction. No runtime design change.

Verbatim round 1 verdict:

## Blocking findings

### B-01 Host description regression test is excluded from the planned update

- Violated invariant: INV-06 and required regression verification must agree with the intentionally revised public description.
- Evidence class: reachable.
- Producer and execution path: `code-mode.txt` supplies `CodeMode.description`; `CodeModeTool` exposes that description; the host test hashes it against the old upstream text.
- Source evidence: `packages/opencode/src/tool/code-mode.ts:111`; `packages/opencode/test/tool/code-mode.test.ts:141–148`, especially the fixed SHA-256 assertion at line 145.
- Canonical-plan evidence: Sections 10.7 and 15 change the description and replace only the codemode-package hash assertion; section 15 keeps opencode host checks read-only; section 18 requires running the affected host test.
- Responsibility owner: The host description integration test.
- Concrete behavioral consequence: Once host dependencies are available, the required regression command deterministically rejects the intended description change. The current missing preload dependency conceals, rather than resolves, this incompatibility.
- Minimal correction direction: Include the existing host description test in the plan and replace its obsolete upstream hash with assertions for the approved shared-description contract while preserving catalog-separation checks.

## Non-blocking findings

- Missing host dependencies and unmeasured model-level prompt effectiveness are explicitly disclosed. Neither may later be reported as passing verification.
- The isolated experiment’s reported results were not independently rerun in this audit. Permission to inspect its external temporary directory was requested but remained pending when this verdict was issued.

## Rejected speculation

- Full Promise constructor/chaining support, speculative formatter repair, new execution modes, and recursive cancellation of previously started side effects are not required.
- Existing async string-replacement behavior is a genuine compatibility contract, demonstrated by `packages/codemode/test/stdlib.test.ts:188–210`, not an invented fallback.
- Unrelated existing interpreter discrepancies do not block this plan.

## Requirement and traceability coverage

Reviewed the complete original attachment through its stable Library ID, the verbatim latest requirements in R1, repository workflow/policy, applicable instructions, source, and relevant tests.

The substantive design maps the requested async return/rejection/order/concurrency repair to the correct interpreter owner. Source confirms discarded async metadata, mutable shared invocation scopes, inline combinators, sequential `Promise.all` observation, and pending ownership removal at observation construction.

The plan covers exact discovery paths, progressive guidance, projected output, selective community improvements, shared closure ownership, tool limits, cancellation, fetch callbacks, and string-replacer compatibility. Proposed public regression slices can distinguish the original defects. The missing host-description test update is the coverage defect identified above.

## Primary-path and fallback verdict

The proposed runtime repair retains one evaluator and one execution-scoped Promise ownership path. Separate tool permits remain appropriately host-call-owned. No new alternate-success path or diagnostic recovery family is proposed.

The Chinese-comment plan commits to the required 15% implementation target with a feasible estimate. Actual counts and code quality require implementation audit.

## Release verdict

**BLOCK — canonical plan R1, full-scope plan audit, round 1.**

Revise the affected test scope, increment the canonical revision, and request another full-scope audit. No implementation approval is granted.


Verbatim round 2 verdict (audit_execute_plan):

## Blocking findings

No blocking findings.

## Non-blocking findings

- Host integration execution remains dependency-blocked; real-model prompt effectiveness remains unmeasured. Neither is established by this plan approval.
- Independently inspected the isolated candidate’s implementation. Its reported test totals were not rerun during this read-only audit.

## Rejected speculation

No requirement justifies additional Promise APIs, formatter recovery, execution modes, host permission changes, or recursive rollback of started side effects. Existing async string-replacer compatibility remains justified by its paired behavioral test.

## Requirement and traceability coverage

Full-scope review covers the original attachment, latest verbatim requirements, exact R2, affected source and tests, and repository workflow/policy.

R2 resolves B-01: sections 13, 15, and 18 now include both host description consumers, `code-mode.test.ts:145` and `registry.test.ts:174`, while retaining catalog separation. Repository search confirms all three old description-hash assertions are included in the planned updates.

The remaining mappings cover async identity, rejection/adoption, suspension order, isolated invocation frames with shared closures, composable combinators, fail-fast observation, execution lifetime, tool concurrency limits, fetch/string callbacks, discovery guidance, projected output, and the required audit/commit/draft-PR workflow. Regression slices can fail on the original behavior.

## Primary-path and fallback verdict

The plan repairs the interpreter-owned first divergences through one evaluator and one execution-scoped Promise producer. It removes superseded scope swapping and pending-set bookkeeping without introducing alternate-success paths, retries, or execution modes.

The isolated candidate supports the proposed frame, eager scoped-fiber, await-yield, and combinator design. Production implementation and behavioral verification remain separate gates.

The comment budget commits to the required 15% implementation target; actual code quality and E/C counts require implementation audit.

## Release verdict

**APPROVE — canonical plan R2, full-scope plan audit, round 2.**

Approval applies only to exact R2. Record this verdict before implementation; substantive changes require a new revision and full-scope audit.

## 23. Implementation Evidence

Implemented approved R2 on `execute-async-flow`; latest `git ls-remote origin refs/heads/dev1-smark` still reports `70670d1b030bee4198887c633ce2607ad6360e66`.

### Actual Files and Diff

Eight existing files changed plus this canonical plan, exactly the approved scope:

- `packages/codemode/src/interpreter/model.ts`: retain the parsed async flag.
- `packages/codemode/src/interpreter/runtime.ts`: invocation frames, shared execution capability/scope, one Promise producer, await scheduling, composable combinators, concurrent all observation, and existing async replacer compatibility. Remove shared scope swap/restore and pending-set cleanup.
- `packages/codemode/src/code-mode.txt`: concise progressive composition/discovery/output guidance and one executable conditional example.
- `packages/codemode/test/promise.test.ts`: 17 parameterized public regression cases.
- `packages/codemode/test/codemode.test.ts`: execute the prompt example and fetch reader composition; replace the obsolete description hash while retaining catalog contracts.
- `packages/codemode/README.md`: directly stale discovery/async/lifetime descriptions.
- `packages/opencode/test/tool/code-mode.test.ts` and `registry.test.ts`: compare the host description to its shared owner; preserve catalog separation.

Before the plan record, `git diff --stat` reports 448 insertions and 198 deletions across these eight existing files. Runtime's displayed 361-line diff includes retained combinator logic reindented under the shared Promise producer and parameter-binding logic relocated into the independent frame. No new dependency, exported API, configuration, diagnostics, retry, alternate mode or host production change. Unrelated formatter-only changes were removed.

### Red-Green Test Evidence

1. Async slice: the new public async identity/throw/order/concurrency cases were run before the runtime change: 7 failures, 1 pass. After the frame/scoped producer/await repair, Promise plus existing stdlib regressions passed (111 tests). Combinators were still inline in that vertical slice.
2. Combinator slice: new composition/fail-fast tests were then run against the still-inline combinators: 5 intended failures, including the nested rejection and causal-gate timeout. Wrapping their existing logic in the same Promise producer and concurrently observing all made the slice pass.
3. Lifetime coverage holds the host fiber alive 40 ms after execute returns, without a timeout wrapper, to detect late host completion or a second script tool call. Three cases cover caught failure, uncaught failure, and ignored async continuation. Timeout/host interruption remain control failures; returned promise containers remain awaitable before exit.
4. Prompt example test first failed with `Missing executable workflow example`, then executed the literal discovery and projection snippets successfully after the approved prompt change.
5. Final sensitivity check copied only the two new test files into an isolated archive of unchanged base. Running the 19 new cases gave **18 failures, 1 pass**. Failures include all three async forms, original throw, await ordering, overlap, filter truthiness, all three combinator identities, nested rejection, gated fail-fast, all three cleanup cases, timeout concurrency, missing prompt example, and fetch Promise identity. The already-supported promise adoption/cap case passed. No source assertions or private helper tests replaced behavioral feedback.

### Verification Commands and Results

Bun binary directory is `/workspace/shared/opencode-execute-work/deps/node_modules/.bin`; prepend it to PATH for the commands below. All package checks use package-local working directories.

| Command | cwd | Actual result |
| --- | --- | --- |
| `bun test --only-failures` | packages/codemode | 283 pass, 0 fail, 800 assertions, 7 files; rerun after scoped formatting |
| `bun typecheck` | packages/codemode | Pass (`tsgo --noEmit`) |
| `OPENCODE_DISABLE_MODELS_FETCH=true bun test test/tool/code-mode.test.ts test/tool/registry.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts --timeout 30000 --only-failures` | packages/opencode | 102 pass, 0 fail, 367 assertions |
| `node_modules/.bin/oxlint --format json <six changed TS files>` | root and isolated base | Both exit 0: 141 warnings, 0 errors; rule/message multiset unchanged except existing consistent-return warning moved from named method to its anonymous closure |
| `node_modules/.bin/prettier --check <six changed TS files> packages/codemode/README.md` | root and isolated base | Both flag the same four files: runtime.ts, codemode.test.ts, host code-mode.test.ts and registry.test.ts. No whole-file baseline reformat applied; new regions were formatted independently |
| `git diff --check` | root | Pass |
| `bun test test/promise.test.ts test/codemode.test.ts --test-name-pattern 'async function composition\|composable promise combinators\|fetch response readers\|discovery and projection example' --only-failures` | isolated base packages/codemode with new tests only | Intended red: 18 failures, 1 pass, 79 filtered; unchanged base source |
| Extra `bun typecheck`, then same with `GOMEMLIMIT=1536MiB GOGC=20 GOMAXPROCS=2` | packages/opencode | Both terminated with SIGKILL and no TypeScript diagnostic. Not reported as passing. Unchanged base also SIGKILL after 72.92 seconds, maxRSS 4,457,528 KiB, with GOMEMLIMIT=768MiB/GOGC=20/GOMAXPROCS=2; no TS diagnostic |

The first host regression attempt triggered an unrelated background public model-catalog refresh and was stopped by the environment's approval review. Source inspection established `GET https://models.opencode.ai/api.json`, no body, User-Agent only; the test preload already uses the checked-in model fixture and isolated home/XDG with provider credentials cleared. Approval then allowed the supported `OPENCODE_DISABLE_MODELS_FETCH=true` configuration, which prevents that refresh. The successful host regression result above is from that permitted local-fixture run, not from the stopped attempt. No restriction or hook was bypassed.

### Original Feedback-Loop Result

The exact original async IIFE throw is rejected inside allSettled rather than escaping; async calls are Promise values; plain-value await yields; multi-step callbacks overlap while locals remain isolated and shared closure updates remain visible. The causal Deferred gate proves a later rejection can be caught before an earlier blocked member completes, and that earlier Promise remains awaitable. Tests measure outputs and active host effects, not private helper counts or a claimed model-performance speedup.

### Actual Secondary and Replacement Path Inventory

Unchanged from section 11: sync/async function behavior is one supported-domain distinction in the same evaluator; already-shipped explicit async String replacers and race loser interruption are preserved contracts. resolve/reject's immediate settled values are the existing representation. There is no new fallback, alternate success path or diagnostic branch. Host permission, limits, output data validation and error sanitization remain with their existing owners.

### Chinese Comment Calculation

Count nonblank added/substantively modified TS code, excluding imports and comments; match unchanged lines across removed/added blocks after indentation normalization to exclude pure relocation/reindentation. Prose and this plan are excluded. Retained parameter binding, allSettled/race bodies, global initialization and existing error normalization are relocation, not newly invented logic.

| File | E | Qualifying nearby C |
| --- | ---: | ---: |
| interpreter/model.ts | 1 | 1 |
| interpreter/runtime.ts | 71 | 12 |
| test/codemode.test.ts | 40 | 5 |
| test/promise.test.ts | 155 | 22 |
| host test/tool/code-mode.test.ts | 2 | 1 |
| host test/tool/registry.test.ts | 1 | 1 |
| **Total** | **270** | **42** |

Required C = ceil(270 × 0.15) = 41; current C/E = 15.56%. Comments identify scope/closure identity, promise lifetime versus observation, tool permits, ordinary-value suspension, rejection/adoption, callback compatibility, causal-gate and host-fiber lifetime evidence, output projection, or shared description ownership. Independent audit must assess qualification rather than accept this arithmetic as evidence of quality.

### Remaining Unverified Items

Host full-package typecheck has not completed: both current source and unchanged base are killed with SIGKILL before a TypeScript diagnostic; measured base peak RSS is 4,457,528 KiB. This is not treated as a passing check. An unmodified `.husky/pre-push` preflight started the 36-package aggregate typecheck; it warned that Turbo cannot parse pre-existing comments in bun.lock, launched ten compiler tasks, and saturated the cloud environment without completing. The preflight was interrupted (exit 130), not counted as passing. Publication remains gated on normal pre-push completion. Post-push CI has not run. Real-model effectiveness/token savings are unmeasured; no such claim is made. No merge is authorized.

## 24. Implementation Audit Record

Verbatim full-scope implementation audit, round 1, approved R2:

## Blocking findings

No blocking findings.

## Non-blocking findings

- Full host-package typecheck remains unverified: the recorded current and unchanged-base runs terminate with SIGKILL before diagnostics. The required codemode typecheck and targeted host regressions pass.
- Existing formatting debt remains in the same four files on both base and current trees. Oxlint reports the same 141-warning rule counts, zero errors, and exit 0.
- Pre-push aggregate checks, published-commit verification, draft PR, and CI remain subsequent workflow steps. Real-model effectiveness is unmeasured.

## Rejected speculation

No evidence warrants additional Promise APIs, fallback execution modes, recursive rollback of started side effects, or host permission changes. Preserved race-loser cancellation and async string replacement are established contracts.

## Requirement and traceability coverage

**Full scope: yes. Approved revision: R2.**

Reviewed all eight changed-file diffs against `70670d1b030bee4198887c633ce2607ad6360e66`, the untracked canonical plan, original requirements, affected producers/consumers, tests, and repository instructions.

Every implementation hunk maps to R2. Async metadata, isolated invocation frames/shared closures, eager scoped Promise production, await suspension, composable combinators, fail-fast observation, and execution cleanup repair their owning paths. Discovery guidance, executable projection example, documentation, and both host-description consumers match the approved scope.

Independent verification:
- Codemode: **283 tests pass**, 800 assertions.
- Codemode typecheck: **passes**.
- Targeted host regressions: **102 tests pass**, 367 assertions.
- Original baseline reproductions independently confirm early async throw, incorrect return identity, incorrect await ordering, and escaping nested-combinator rejection.
- `git diff --check`: **passes**.

The baseline’s new-test filter matched no tests because its test files had been restored; this was not counted as a successful sensitivity run. Direct baseline reproductions and current behavioral tests establish sensitivity without source assertions.

## Primary-path and fallback verdict

One evaluator and one execution-scoped Promise producer remain authoritative. Tool permits stay restricted to actual host calls. Shared scope swapping and pending-set bookkeeping are removed. No new alternate-success path, retry, diagnostic recovery branch, dependency, or public configuration was introduced.

## Code quality and Chinese-comment verdict

No blocking quality violation found in changed code.

Independently recomputed:
- **E = 270**
- **Qualifying C = 42**
- **C/E = 15.56%**
- Required implementation target: **41 qualifying lines**

Excluded blank lines, imports, comments from E, prose, and unchanged relocated/reindented code. Qualifying comments are adjacent to ownership, lifetime, scheduling, compatibility, and behavioral-test decisions. The implementation meets the 15% target.

## Release verdict

**APPROVE — full-scope implementation audit, round 1, against approved R2 and the inspected diff.**

Invocation reference: `/root/execute_workflow_changes/audit_execute_plan`.

This approves the implementation audit gate, not completion of the remaining commit/publication workflow. Record the verdict verbatim before advancing.

Implementation status is verified under that audit. Commit/publication remain separate steps; no completed PR or aggregate typecheck is implied.


## 25. R4 Plan: Settlement Selection and Execution Lifetime

### Current evidence and reachability

Starting head and worktree verified: `67a07de994b4000910112b035f0a25ef771b711d`, clean, same PR feature branch and base. Root/package AGENTS, workflow, current policy/planning skill/template, CONTEXT and ADR index were reread. No relevant accepted async ADR exists. `diagnosing-bugs` and `tdd` remain unavailable; explicit red-green policy remains mandatory.

Additional evidence: `values.ts` owns the race-only `SandboxPromise.interrupted`; runtime `unwrapPromiseExit`, `invokePromiseMethod` are its only consumers/producers. Existing Promise tests require catchable canceled losers and rejected empty race. Host `test/session/execute.test.ts:760–817` checks race followed by execute return, so it proves exit cleanup but does not distinguish race settlement from cleanup. README's Promise paragraph and shared fetch sentence describe those boundaries incorrectly for the accepted R3 contract. Host `src/tool/code-mode.ts` and `src/session/tools.ts` own permission preflight, abort, child terminal states, metadata and partial receipts; no production host changes are planned.

Public seam experiment: `/tmp/execute-r3/codemode/probe.ts`, a copy of the current package with locked dependencies, Bun 1.4.4. Repository production and tests remain untouched in planning.

| Program | Current-head observation | Isolated candidate observation |
| --- | --- | --- |
| start slow tool; race it against a value; await slow again | ExecutionFailure: race interrupted loser | `["first", 7]` |
| `return await Promise.race([Promise.race([]), "outer"])` | ExecutionFailure: empty race never settles | `"outer"` |
| `return await Promise.allSettled([tools.never({}), tools.stop({})])`, with first `Effect.never`, second `Effect.interrupt` | Success Effect containing TimeoutExceeded after 100ms, not host interruption | failed Effect with interrupt Cause, before timeout |

Isolated candidate `bun typecheck` passes. All 50 existing Promise cases outside the two explicitly replaced race contracts pass; the old canceled-loser and empty-race diagnostic cases fail as expected. No claim of repository-wide verification is made at plan stage.

The original R2 async implementation stays authoritative. New origin/propagation/manifestation chains:
- INV-08: race explicitly interrupts member producer fibers and marks mutable `interrupted` -> later await transforms interruption into a synthetic program error -> valid retained Promise becomes unusable. Owner: combinator observation; producer lifetime already belongs to execution scope.
- INV-08 empty: valid empty iterable -> manual diagnostic -> nested race rejects instead of remaining pending. Owner: same race branch; `Effect.never` expresses the contract without another timer/lifetime.
- INV-09: allSettled waits observations in input order -> pending first item hides a later control interruption -> whole execution eventually reports timeout. Tool bodies already run concurrently; only observation/normalization needs concurrent traversal.

### Authoritative route and deletion

Use the same createPromise/execution scope and Fiber.await seam. Race competes only among observer Exits, unwraps the winning Exit, and leaves producer fibers untouched. A canceled observer never owns producer cancellation. Empty race returns a pending Effect within the same scope. Remove `SandboxPromise.interrupted`, the loser interrupt loop, and synthetic race-error conversions. Exit already implements Effect in the installed Effect version; flattening the observed Exit can replace the now-redundant unwrap helper, without new API or abstraction.

AllSettled traverses each observation and normalization concurrently with ordered Effect results. A successful value produces fulfilled data, ordinary program/tool failure produces the existing normalized rejected data, and pure host interruption fails with its original Cause immediately. Scope teardown then closes other still-running producers. No arbitrary retry, rollback, recursive unwrapping, new scheduler, or background work.

### Forward and reverse mapping / file plan

| Invariant | Owner / files | Behavioral acceptance | Why existing logic is insufficient |
| --- | --- | --- | --- |
| 08 selection versus lifetime | runtime.ts, values.ts | direct and async losing members remain awaitable; rejected loser retains its original reason; shared Promise across races/duplicate member does not get canceled; root exit still interrupts pending work | explicit per-race interruption violates retained-Promise ownership |
| 08 empty race | runtime.ts, promise.test.ts | empty race is an object, loses to an outer settled value, and reaches existing execution timeout if awaited alone | explicit empty-array rejection contradicts accepted contract |
| 09 interruption | runtime.ts, promise.test.ts | gated first pending member plus later host interruption exits with interrupt Cause and cleans first; ordered ordinary fulfilled/rejected results unchanged | sequential observation hides known control failure |
| 04/05/08 host lifetime | opencode/test/session/execute.test.ts | actual SessionTools/CodeModeTool async read/question continuation: normal completion, still-live losing work after race, execute return cleanup, host abort cleanup, completed evidence and no late read/mutation | old host cases only observed return cleanup, interpreter-only tools do not prove Session child lifecycle |
| 06 truthful capability | code-mode.txt, README.md, codemode.test.ts | describe fetch only when host provides it; keep literal search/call example and both host description-consumer checks | shared description currently claims fetch is unconditional |
| 07 workflow / publication | this plan and existing PR #1 | new independent plan/implementation audits, append commit and verify full remote tree/head | R2 approval explicitly preserved a now-changed contract |

No change to `model.ts` async metadata or String.replace owner. No namespace hint, new configuration, dependency, transport, host permission or output protocol. Only update stale adjacent comments/test names whose semantics actually changed. All new concepts reuse existing Effect observation and execution scope; new alternate-success paths and diagnostic decision surface remain zero.

### TDD and verification

1. Replace the two explicitly superseded race tests; add retained direct/async/rejected/shared Promise and empty/nested race cases. Run against unchanged current head to demonstrate red. Implement the approved deletion and race observation change, then green.
2. Add a causally gated allSettled test where the first member is pending before the second interrupts. Assert failed Effect with interrupt Cause, no TimeoutExceeded result, and first-producer cleanup. Run red before concurrent observation, then green; ordinary rejected outcomes retain their order/reasons.
3. Use actual host `resolveTools`/Session/Question services and readiness signals, not elapsed sleeps or mock host callbacks, to test async retained-loser completion and root return/abort cleanup. Assert child terminal states and already completed child facts/parent progress, plus absent after-wait side effects. Existing shell/permission cleanup checks remain and their names distinguish root exit from race.
4. Change only the fetch availability sentence and README Promise semantics, with focused shared-description assertion plus literal example and both host consumer regressions.

Commands: package `bun test test/promise.test.ts --only-failures` red/green; codemode `bun test --only-failures` and `bun typecheck`; host `OPENCODE_DISABLE_MODELS_FETCH=true bun test test/tool/code-mode.test.ts test/tool/registry.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts --timeout 30000 --only-failures`; root changed-file oxlint/Prettier baseline comparison and `git diff --check`; original `.husky/pre-push` with telemetry disabled, no checker/config changes. Resource limits are disclosed, not fixed by PR configuration. Tests use Bun 1.4.4 restored outside the repository at `/tmp/opencode-bun/node_modules/.bin/bun`.

Expected R3 delta: seven existing files including this plan; runtime/values net deletion, ~25–45 effective changed production lines, ~130–210 test lines, ~5 prose lines plus plan evidence. E estimate 160–250, C required ceil(E×0.15) (24–38); final measured value governs. Qualifying Chinese explanations belong next to observer-versus-producer lifetime, control interruption versus ordinary rejection, readiness gates, host evidence and post-exit continuation checks. No filler or mass formatting.

### Current CI, publication, and unverified measurements

Existing PR head CI: typecheck and scope checks pass. Test run `42373519357` fails Linux/macOS `database maintenance CLI > holds the daemon election while initially offline compression runs`, db-maintenance.test.ts:269 (`acquired` true versus expected false). Exact base `70670d1` has the same failure in run `42358565595` attempt 2, Linux job `128366293580` and macOS `128366293547`; identical test blob `e9ff7c059a15c98905b91649c89bc9d585d3be7c`. This is a known baseline failure, not a green suite or reason to change unrelated database code. New-commit CI must be checked after publication.

Earlier full local pre-push reached SIGKILL in TUI; an unchanged full hook with official Turbo serial concurrency still SIGKILLed in opencode typecheck with rising kernel OOM count. The user's quoted exception allows a transparently failing-resource draft, not a false passing report. No singleThreaded/resource setting is committed. Current plan approval does not assert those historic failures recur on the next run.

Real-model prompt benefit remains unmeasured. Any later controlled comparison must use the same representative tasks and model settings and record task correctness, model round trips, failed/retried tool calls, and actual reported usage. No provider run, token saving or cost claim is fabricated or required without an available authorized model-evaluation fixture.

### R3/R4 independent audit record

R3 review was paused before any verdict after the user added the following requirement. No R3 implementation authorization was issued. R4 requires a new full-scope audit of the entire PR.

### R4 full-PR Chinese-comment requirement, verbatim

> 同时，我观察到你好像之前实现的代码里面，有的地方没有按照现在的逻辑流程来。按理来说，你每一处修改的 hunk，都必须要有完整的中文注释。请注意一点，是中文注释。你的修改的每一处 hunk 都要有中文注释。然后同时整体的这个中文注释的，就是你修改的所有的 hunk 的 diff 的中文注释量，按理来说应该大于 15%。也就是说你整个 PR 都要满足这一点。而不是说你只是新增了，或者说你调整哪部分去进行一个调。就是换言之，我指的整个 PR 是你刚刚那一条好像没满足，所以你新的这条 PR 你需要连带着之前那一条一块去满足这么一个注释等等的一些这个逻辑，然后保持相应的这个逻辑清晰，然后改动的 hunk 等等数量是最少的，不要大幅度调整一些不该调整的一些逻辑语义。

Whole-PR baseline is `70670d1b030bee4198887c633ce2607ad6360e66`, not the previous feature commit. Count E/C for all changes from that baseline, with policy exclusions unchanged: effective added/substantively modified production/test/config code, excluding imports-only, blanks, formatter-only, pure moves, generated files and documentation prose. C counts only adjacent Chinese explanations of rationale/invariant/real boundary/test intent. R4 tightens the threshold to strictly greater than 15%, therefore `C >= floor(E × 0.15) + 1` when E > 0. Record total E, C, excluded categories and per-file values; document/prompt comments count for hunk coverage but not code C so they cannot inflate the code ratio.

Independently of the ratio, every actual whole-PR hunk under `git diff --unified=3 70670d1` must contain a relevant added/modified Chinese comment. Include import-only and comment-only hunks in that coverage. Record file, hunk line range, nearby comment and purpose. Do not increase context size to join otherwise-uncommented hunks. Place comments in existing changed regions; avoid unrelated semantic edits or formatter churn solely to reduce hunk count.

Format ownership:
- TypeScript: adjacent `//` comments, including a concise ownership explanation for imports changed to support the new contract. Add only necessary missing explanations to R2 hunks.
- Markdown README and this plan: adjacent `<!-- 中文说明 -->` comments, hidden from rendered prose.
- `code-mode.txt`: the existing `@@` keyed-section parser in tool-runtime.ts:25–33 outputs only `description` and one of `intro.empty/complete/partial` (line 563). Separate `@@ comment.description` and `@@ comment.intro.partial` sections can hold nearby Chinese maintenance explanations without entering model-facing text. No parser/format expansion is needed. Add public-contract checks that CodeMode.description and all catalog intro variants contain no maintenance-comment text/Chinese note. Preserve literal executable examples.
- Correct tool-runtime.ts's directly stale parser comment (it currently says upstream text must remain verbatim) to explain structural sections and selected public outputs, without changing code.

This expands the file plan only for comment coverage: existing original PR files all remain in scope, plus `values.ts`, `tool-runtime.ts` (comment only), and host `test/session/execute.test.ts`. Twelve total whole-PR paths, no new runtime API or config. Whole-PR E is expected around 420–520 after movement exclusions; C must exceed 15% of the measured final E. If a changed format cannot contain non-emitting comments, stop and report the exact conflict rather than silently marking coverage complete. Audit must independently verify all hunks and E/C, including R2 content.

R4 pending full-scope plan audit; implementation remains disallowed.

### R4 plan audit, round 1, verbatim

Invocation: `/root/execute_workflow_changes/audit_full_pr_comments`.

## Blocking findings

No blocking findings.

## Non-blocking findings

- R4 is a plan approval, not certification of the existing PR’s comments. Against `70670d1`, the current whole-PR diff has **33 hunks; 20 lack added Chinese comments**. Section 25 explicitly requires repairing these older gaps alongside the new changes.
- Administrative metadata still names R3 in several current-summary passages and names the working branch `execute-async-flow`; the checked-out branch is `execute-async-published`, at the stated head `67a07de994b4000910112b035f0a25ef771b711d`. The final records should distinguish the local branch, existing PR branch, and historical revisions.
- Aggregate checks and exact newly published commit/CI verification remain later gates. Historical resource failures and the quoted publication exception do not imply passing checks.

## Rejected speculation

No evidence supports another scheduler, fallback execution mode, Promise API expansion, recursive result unwrapping, new host permission policy, or rollback of already-started external effects. The established async String.replace extension remains within the preserved contract.

## Requirement and traceability coverage

**Full scope: yes. Audited revision: R4. Audit mode: plan.**

Reviewed the original requirements, accepted follow-up proposal, latest whole-PR comment requirement, current nine-path diff, all twelve planned paths, applicable instructions, workflow/policy, domain/ADR evidence, and affected interpreter, prompt, and host lifecycle paths.

Verified:

- Async identity, independent invocation frames, shared closures, suspension, adoption, composable combinators, tool permits, and execution-scoped cleanup remain on the existing R2 path.
- The race defect originates in the explicit member cancellation at `runtime.ts:2203–2206`, with synthetic error conversion at `runtime.ts:761–778`. Removing that state and conversion repairs the owning boundary.
- Sequential allSettled observation at `runtime.ts:2156–2185` can hide a later host interruption behind a pending first member. Concurrent observation and normalization address that divergence while retaining ordered ordinary outcomes.
- Existing host tests at `opencode/test/session/execute.test.ts:760–819` observe cleanup after execution returns. They do not establish whether losers remain live between race settlement and execution termination. R4’s readiness-gated host acceptance distinguishes these boundaries.
- The parser at `tool-runtime.ts:25–33` already accepts keyed sections; public selection uses only `description` and the three `intro.*` variants. Dedicated maintenance-comment sections require no parser expansion. R4 includes public-output leakage checks and preserves the executable example and both host description consumers.

Independent execution:

- Current codemode suite: **283 passed**, 800 assertions.
- Current codemode typecheck: **passed**.
- Current targeted host suites: **102 passed**, 367 assertions.
- Current-head probes reproduced the retained-loser failure, incorrect empty-race rejection, and masked allSettled interruption.
- Inspected isolated candidate produced `["first", 7]`, `"outer"`, and an interrupted failed Effect respectively.
- Isolated candidate Promise suite: **58 passed**, 137 assertions; typecheck passed.
- `git diff --check`: **passed**.
- No source, test, configuration, index, or plan edits were made by this audit.

## Primary-path and fallback verdict

One evaluator, one execution-scoped Promise producer, and one host tool-dispatch path remain authoritative. Race selects settlement without owning producer cancellation; execution termination retains cleanup ownership. Concurrent allSettled observation adds no alternative success path.

R4’s comment contract is feasible and explicit:

- Entire PR measured from `70670d1`.
- Every actual default three-context-line hunk must contain a relevant added/modified Chinese explanation.
- Strict threshold: **C ≥ floor(E × 0.15) + 1** for E > 0.
- Documentation/prompt comments cover their hunks without inflating code C.
- Final implementation audit must independently verify coverage, substantive comment quality, and E/C. Plan estimates cannot substitute for that calculation.

## Release verdict

**APPROVE — full-scope plan audit, round 1, for canonical revision R4.**

Record this verdict before enabling implementation. Approval does not certify the eventual diff, comment coverage, commit, publication, or CI.


## 26. R4 Implementation Evidence

### Actual route and files

Implemented the approved delta on local `execute-async-published`, parent `67a07de99`, for remote `execute-async-flow` / PR #1. Twelve paths are in the full diff against `70670d1`, including the unchanged-in-this-commit R2 `model.ts` hunk. The eleven incremental paths are exactly the approved comment/behavior/test/document changes. No dependency, config, hook, host production path, alternate mode or namespace diagnostic changed.

Race now races observer Exits and flattens the winner. Member fibers remain execution-scoped. Empty race uses the same scoped producer with Effect.never. Removed the loser interrupt loop, mutable `interrupted` flag and special synthetic error conversion/unwrap helper. allSettled observes and normalizes concurrently, keeps input-order outcomes and propagates pure host interruption. Existing async frame, closure, eight-tool cap, fetch response and String.replace behavior are retained.

### Red → green and public behavior

- Race slice: six current-head tests fail before the repair (direct/async retained loser, original rejection reason, shared/duplicate member, awaited empty race, nested empty race). After removing per-race cancellation, Promise suite passes 56 tests / 131 assertions while allSettled observation remains sequential.
- allSettled slice: two readiness-gated direct/async host-interruption tests fail with an Effect Success containing TimeoutExceeded against sequential observation. Concurrent observation yields the original interrupt Cause and cleans the pending first producer. Promise suite passes 58 tests / 137 assertions and package typecheck passes.
- Prompt slice: the host-optional fetch assertion fails before wording correction, then passes. Separate maintenance-comment sections do not appear in description or any complete/partial/empty catalog. Existing literal example and both host description consumers remain covered.
- Real host lifecycle: three actual SessionTools/CodeModeTool tests use published Question gates around an async read→wait→read continuation. They verify normal retained-loser completion, root return cleanup, explicit abort cleanup, completed read evidence, no later read on terminated paths, terminal child records and no running parent progress. All three pass. Sensitivity run restoring the original PR runtime/values produces one failure (normal retained-loser completion) and two passing cleanup regressions; the original async wrapper is canceled even though its separately scoped host child is still waiting. The initial test expectation used compact JSON, while the real host pretty-prints it; that fixture expectation was corrected without production changes.

### Final verification

All commands use Bun 1.4.4 from `/tmp/opencode-bun/node_modules/.bin` and the existing locked dependencies.

| Check / cwd | Result |
| --- | --- |
| `bun test --only-failures`, packages/codemode | **289 pass, 0 fail, 821 assertions** |
| `bun typecheck`, packages/codemode | **Pass** |
| `OPENCODE_DISABLE_MODELS_FETCH=true bun test test/tool/code-mode.test.ts test/tool/registry.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts --timeout 30000 --only-failures`, packages/opencode | **105 pass, 0 fail, 389 assertions** |
| `node_modules/.bin/oxlint --format json <all nine changed TS files>`, root; repeat exact files at base with same checkout/config | Current **149 warnings, 0 errors**, base **151 warnings, 0 errors**, both exit 0. Remaining rule counts do not increase; one no-this-alias and one redundant type argument removed |
| Prettier on nine TS paths plus README, current/base | Same six pre-existing TS files flagged; new Promise regions and README formatted. No whole-file unrelated formatting applied |
| `git diff --check`, root | **Pass** |
| `TURBO_TELEMETRY_DISABLED=1 TURBO_CONCURRENCY=1 sh .husky/pre-push`, root | **Failed** in opencode typecheck after 41.342s; 23 successful / 30 tasks, 12 cached. Hook unchanged; concurrency only changes scheduling, not coverage. Submodule stage not reached |
| Direct `bun typecheck`, packages/opencode, to clarify truncated aggregate error | **SIGKILL**, no TypeScript diagnostic; 12.4s, max child RSS 3,922,812 KiB, global OOM counter 15→17. Concurrent type-aware lint makes that RSS/OOM observation unsuitable as an isolated benchmark; it is not presented as heap or exact attribution. Aggregate itself ran without another heavy check |

Initial baseline lint attempts in an external partial copy were invalid (ignore-root panic, then absent tsgolint context); they are not evidence. The recorded comparison above temporarily restored the nine base files in the same checkout, ran the configured check, and restored every byte in a finally block. No other test or check ran while files were substituted.

The full local pre-push remains unpassed, as explicitly permitted for draft publication by the user's exception. No singleThreaded flag/config was added. Existing head CI failure and exact-base evidence remain in section 25; new-head CI will be verified after publication. Real-model correctness/round-trip/retry/usage comparison remains unmeasured and no savings claim is made.

### Whole-PR Chinese comment calculation

Baseline: `70670d1b030bee4198887c633ce2607ad6360e66`. Count nonblank substantive added/modified TS code; remove imports, comments, and same normalized removed/added lines (including reindentation/pure movement). Markdown/prompt prose and their comments do not inflate E/C. The implementation auditor independently checks comment qualification and movement exclusions.

| File | E | C | Whole-PR hunks |
| --- | ---: | ---: | ---: |
| interpreter/model.ts | 1 | 1 | 1 |
| interpreter/runtime.ts | 88 | 25 | 15 |
| src/tool-runtime.ts | 0 | 1 | 1 |
| src/values.ts | 0 | 1 | 1 |
| test/codemode.test.ts | 44 | 7 | 3 |
| test/promise.test.ts | 235 | 31 | 5 |
| host test/session/execute.test.ts | 52 | 7 | 3 |
| host test/tool/code-mode.test.ts | 2 | 2 | 2 |
| host test/tool/registry.test.ts | 1 | 2 | 2 |
| README / prompt / plan | excluded | excluded | 6 / 2 / 1 |
| **Total** | **423** | **77** | **42** |

C/E = **18.20%**, strictly >15%; minimum for E=423 is 64. Even excluding the two comment-only TS-file comments, 75/423 remains >15%. Comments explain ownership, compatibility, control-versus-program failure, fixture causality, shared public descriptions or preservation of completed evidence, not identifier translations.

### Whole-PR hunk-to-comment map

Default `git diff --unified=3 70670d1`; no enlarged context or artificial hunk joining. Each row identifies one actual hunk and its added/modified adjacent Chinese explanation. The plan is one entirely added-file hunk, so its range changes as evidence is appended.

| Path | Hunk (old → new) | Adjacent Chinese explanation |
| --- | --- | --- |
| `docs/plans/execute-async-flow.md` | `new file, all lines` | `<!-- 本文是唯一实施合同：保留历史审计原文，当前修订补充组合器语义、全 PR 注释门禁与验收证据。 -->` |
| `packages/codemode/README.md` | `-62,7 +62,9` | `<!-- 结果边界沿实际解释器行为说明：最后表达式仍可返回，不能误称省略 return 必为 null。 -->` |
| `packages/codemode/README.md` | `-181,7 +183,9` | `<!-- 预算包含已展示的命名空间标题，文档必须反映既有选择算法而非引入第二套预算。 -->` |
| `packages/codemode/README.md` | `-192,10 +196,12` | `<!-- 搜索示例使用当前同步全局入口，同时如实保留旧工具拼写的兼容性。 -->` |
| `packages/codemode/README.md` | `-206,9 +212,10` | `// 翻页复用搜索条件；同步目录查询无需人为加入异步工具调度。` |
| `packages/codemode/README.md` | `-229,7 +236,9` | `<!-- 固定说明承载调用原则，动态目录只承载当下工具签名，避免重复注入工作流。 -->` |
| `packages/codemode/README.md` | `-239,14 +248,16` | `<!-- 函数帧隔离与共享闭包必须同时成立，异步身份不能靠调用者额外包装修复。 -->` |
| `packages/codemode/src/code-mode.txt` | `-1,10 +1,13` | `中文维护说明：组合、等待与结果裁剪由共享说明统一约束，宿主可选能力不能无条件承诺。` |
| `packages/codemode/src/code-mode.txt` | `-15,11 +18,15` | `中文维护说明：局部目录只是展示预算，不表示未列出的工具不可用；精确签名仍由同一搜索入口提供。` |
| `packages/codemode/src/interpreter/model.ts` | `-45,6 +45,8` | `// 保留语法身份，所有调用入口才能共享返回 Promise 的语义。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-1,5 +1,6` | `// Scope 让全部 Promise 共用一次执行寿命，不能把清理责任放回单个观察者。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-219,7 +220,7` | `// catch 与 allSettled 共享普通失败归一化；宿主中断不转换为脚本数据。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-599,33 +600,39` | `// 能力与执行寿命共享，词法栈属于调用帧；并发函数不能互相替换作用域。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-669,8 +676,10` | `// 响应闭包与普通函数共用全局能力，异步读方法不创建第二套宿主状态。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-707,71 +716,48` | `// 工具调用在调用点启动并计入原预算；只有真实宿主调用占用并发许可。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-857,6 +843,8` | `// 统一函数值保留语法身份，所有调用入口据此决定是否返回 Promise。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-1144,7 +1132,8` | `// 各调用帧枚举同一宿主目录，不能复制或扩大原来的工具能力。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-1447,11 +1436,13` | `// await 普通值也必须让出调度，不能把 async 的后半段抢在调用者之前运行。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-1905,9 +1896,9` | `// 发现仍经共享执行器的校验、预算和观察 hooks；读取内存目录直接交付同步值。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-1959,7 +1950,8` | `// 并发帧共享一个日志出口，不能丢掉子调用中已产生的模型可见证据。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-2102,18 +2094,15` | `// 组合器消费已有 Promise，而不是执行另一套工具调度；其返回值仍可继续组合。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-2121,139 +2110,104` | `// 同时观察才能及时暴露后项失败；结果仍按输入保序，取消观察不取消成员。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-2303,6 +2257,8` | `// replacer 结算复用本次执行的解释器边界，不能把既有 async 扩展改成普通回调。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-2346,9 +2302,15` | `// 保留已发布的 async replacer 扩展；同步回调漏 await 仍由原数据边界指出。` |
| `packages/codemode/src/interpreter/runtime.ts` | `-3368,8 +3330,10` | `// 作用域在成功、失败和中断时都先收尾，再把结果交给宿主继续执行。` |
| `packages/codemode/src/tool-runtime.ts` | `-22,7 +22,7` | `// 分段是文件结构；仅 description 与选中的 intro 进入模型，独立维护注释段不输出。` |
| `packages/codemode/src/values.ts` | `-1,7 +1,7` | `// Promise 保存一次结算来源；生命周期归执行作用域，不再携带 race 私有取消标记。` |
| `packages/codemode/test/codemode.test.ts` | `-594,9 +594,33` | `// 示例是模型实际收到的公开内容，直接执行而不是把预期代码再复制一份。` |
| `packages/codemode/test/codemode.test.ts` | `-605,10 +629,15` | `// 维护注释不属于模型任务信息；四种公开出口都必须保持不泄露注释段。` |
| `packages/codemode/test/codemode.test.ts` | `-1150,3 +1179,24` | `// 响应快照只来自一次宿主请求，读取方法的 Promise 身份不能要求代理采用特殊写法。` |
| `packages/codemode/test/promise.test.ts` | `-1,5 +1,6` | `// 用宿主控制原因与就绪门闩观察公开行为，不能用超时或私有状态冒充中断证据。` |
| `packages/codemode/test/promise.test.ts` | `-304,10 +305,48` | `// 就绪信号保证前项确实已挂起；后项发出控制中断，不能等全局超时替它解围。` |
| `packages/codemode/test/promise.test.ts` | `-322,23 +361,51` | `// race 只竞争结算；保留原 Promise 再等待，才能区分选出赢家与结束整段执行。` |
| `packages/codemode/test/promise.test.ts` | `-362,9 +429,18` | `// 空集合没有赢家，沿既有执行超时退出，而不是额外生成脚本可捕获的错误。` |
| `packages/codemode/test/promise.test.ts` | `-452,3 +528,191` | `// 三种语法共享函数值契约，不能只修 map 或箭头回调这一条入口。` |
| `packages/opencode/test/session/execute.test.ts` | `-757,13 +757,13` | `// 中间 glob 使 question 进入宿主等待；两种脚本都在根执行返回时共用清理边界。` |
| `packages/opencode/test/session/execute.test.ts` | `-783,7 +783,8` | `// race 后仍可调用其它工具；最终终态在 Execute 返回之后断言，不归因于 race 自身。` |
| `packages/opencode/test/session/execute.test.ts` | `-818,6 +819,63` | `// 使用真实 SessionTools、权限与 Question 服务；双问题门闩区分 race 结束和 Execute 结束。` |
| `packages/opencode/test/tool/code-mode.test.ts` | `-1,3 +1,5` | `// 共享说明是宿主实际公开的合同来源；引用它可验证出口一致而不锁定过时文案摘要。` |
| `packages/opencode/test/tool/code-mode.test.ts` | `-138,11 +140,11` | `// 宿主沿用唯一共享说明，避免文案更新后仍锁定已废弃的上游摘要。` |
| `packages/opencode/test/tool/registry.test.ts` | `-1,3 +1,5` | `// 注册出口也必须对照同一公开说明，避免只修工具实现而遗漏模型工具清单。` |
| `packages/opencode/test/tool/registry.test.ts` | `-170,8 +172,8` | `// 注册与执行共用一份说明，动态目录仍由 Session 独立交付。` |


### Path verdict and pending gates

One evaluator and one execution scope remain authoritative; observation does not become a producer owner. New alternate-success paths: zero. New diagnostic branches: zero; race diagnostics were removed. Readiness-gated host fixtures exercise existing permission/Question/Session behavior without weakening it. Audit approval, appended commit, leased feature-ref update, complete remote-tree comparison and exact new-head CI status remain pending. No target-branch push or merge is authorized.

## 27. R4 Implementation Audit, Round 1 (Verbatim)

Invocation: `/root/execute_workflow_changes/audit_full_pr_comments`.

## Blocking findings

No blocking findings.

## Non-blocking findings

- `packages/opencode/test/session/execute.test.ts:856` overstates its assertion: an existing Question proves the host child remains present, not that its async wrapper survived. The inspected red run passes that assertion and fails at the final await result, line 863. The complete test is sensitive to the defect; this comment should describe the narrower evidence. I excluded this line from qualifying C.
- Full host typecheck and aggregate pre-push remain unpassed. Inspected logs show SIGKILL without TypeScript diagnostics. The quoted user exception permits transparently reporting this limitation for draft publication; it does not make these checks green.
- Prettier still flags the same six pre-existing TS files. README and Promise tests pass formatting. Oxlint reports 149 warnings and no errors, versus 151 warnings in the recorded baseline comparison.
- Commit, remote-tree/head verification, PR update, and new-head CI remain subsequent gates.

## Rejected speculation

No evidence requires another scheduler, fallback interpreter, new Promise APIs, recursive data unwrapping, additional host permission logic, or rollback of already-started external effects. The existing async string-replacer contract remains preserved.

## Requirement and traceability coverage

**Full scope: yes. Approved revision: R4. Audit mode: implementation.**

Reviewed every hunk across all twelve paths against `70670d1b030bee4198887c633ce2607ad6360e66`, including the earlier R2 implementation.

The diff implements the approved ownership changes:

- Async invocation frames isolate locals while sharing lexical bindings and execution capabilities.
- Promise creation remains execution-scoped; only actual host calls consume tool permits.
- Race selects observer settlement without canceling member producers.
- Empty race stays pending.
- AllSettled observes concurrently, retains ordered ordinary outcomes, and propagates host interruption.
- Obsolete pending-set tracking, race cancellation flags, loser interruption, and synthetic error conversion are absent.
- Real SessionTools tests distinguish retained-loser completion from root return/abort cleanup.
- Shared guidance, literal discovery/projection example, conditional fetch availability, both host description consumers, and all four maintenance-comment leakage checks remain covered.

Independent verification:

- Codemode: **289 passed**, 821 assertions.
- Codemode typecheck: **passed**.
- Targeted host suites: **105 passed**, 389 assertions.
- Changed-file oxlint: **exit 0**, 149 warnings, no errors.
- `git diff --check`: **passed**.
- Public probes confirm the original async throw becomes rejected outcome data, retained race losers remain awaitable, nested empty race loses normally, and later allSettled host interruption propagates.
- Test sensitivity is supported by independently reproduced pre-implementation failures and the inspected host red-run log.

No source, tests, configuration, index, or plan were modified by this audit.

## Primary-path and fallback verdict

One interpreter, one execution-scoped Promise producer, and the existing host dispatch/permission path remain authoritative.

New alternate-success paths: **zero**. New diagnostic branches: **zero**. Removed race diagnostics are not replaced with recovery behavior. No dependency, configuration, hook, or host production change was introduced.

## Code quality and Chinese-comment verdict

Independently checked the complete default-context diff:

- **42/42 hunks** contain relevant added or modified Chinese explanations.
- **E = 423**
- **Qualifying C = 76**
- **C/E = 17.97%**
- Strict minimum: **64 qualifying lines**

Per-file E/C:

- interpreter/model.ts: **1/1**
- interpreter/runtime.ts: **88/25**
- tool-runtime.ts: **0/1**
- values.ts: **0/1**
- codemode.test.ts: **44/7**
- promise.test.ts: **235/31**
- host session/execute.test.ts: **52/6**
- host tool/code-mode.test.ts: **2/2**
- host tool/registry.test.ts: **1/2**

Excluded blank lines, imports, comments from E, unchanged relocated/reindented code, and Markdown/prompt content from E/C. Documentation and prompt comments were checked separately for hunk coverage. One inaccurate host-test explanation was excluded from C, as noted above.

The implementation satisfies both whole-PR comment requirements. No blocking code-quality or ownership violation was found.

## Release verdict

**APPROVE — full-scope implementation audit, round 1, against approved R4 and the inspected whole-PR diff.**

Record this verdict before advancing. This approves the implementation audit gate, with the disclosed verification limitations; it does not certify publication or CI completion.

### Non-blocking correction and release record

The flagged host-test line was corrected without changing executable behavior: “宿主交互仍存在不代表 async 包装存活；后续显式 await 的结果还必须证明包装未被提前取消。” The final reported budget conservatively retains the auditor's **76/423 = 17.97%**, rather than claiming extra credit for this corrected line. All 42 hunks remain covered. No material implementation change followed audit. Publication is limited to an appended commit on existing `execute-async-flow`, targeting `dev1-smark`; no merge.

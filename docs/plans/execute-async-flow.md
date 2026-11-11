# Canonical Implementation Plan: Execute async flow

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: user conversation, 2026-11-07; attached workflow.md (libfile_d461dd102a5c81918d83af11e76b9131) and 已粘贴的文本.txt (libfile_f6dd2d46847481919e413470cb9f8afe)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-07
>
> Target: verified-implementation-and-commit, followed by an explicitly requested draft PR to dev1-smark; never merge.

This is the sole implementation specification. Base: `70670d1b030bee4198887c633ce2607ad6360e66`, verified against `git ls-remote origin refs/heads/dev1-smark`. Working branch: `execute-async-flow`.

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
| INV-05 | Preserve the existing eight-tool cap, exact tools/search/schema, private errors, JSON boundary, direct race-loser cancellation and async string-replacer compatibility | Existing 264 tests and package contract |
| INV-06 | One concise progressive guide: discover exact signatures, compose deterministic steps, keep dependencies/writes ordered, return only useful evidence; no blanket catch requirement | User full request and Pi/Codex sources |
| INV-07 | Follow exact workflow, independent audits, verified commit and draft PR on correct base without merging | Latest user instruction |

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
4. all/allSettled/race return a Promise around their existing observation logic. Observe all concurrently for fail-fast, preserve ordered results, keep allSettled normalized outcomes and race's existing loser behavior. resolve/reject remain immediate promise values.
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

No production files outside codemode. Both host-level fixed-description hash assertions are affected consumers and are updated; other host code remains read-only. Host checks remain part of verification when environment dependencies permit.

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

- Confined runtime retains intentional non-native contracts: direct Promise.race losers are interrupted; async string replacers are supported; nested unresolved Promise data is rejected. These are preserved and documented, not silently generalized.
- Scoped work may include an in-flight tool started by a losing async wrapper; wrapper interruption prevents future script steps, and execution scope closes all still-running work on exit. No arbitrary recursive rollback of already-started tool side effects is promised.
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


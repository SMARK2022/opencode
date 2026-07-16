# Canonical Implementation Plan: Non-Intrusive, Version-Correlated LSP Diagnostics

> Status: implementation-verified-without-independent-audit
>
> Revision: R32
>
> Approved revision: none (user explicitly waived further audit)
>
> Audit mode: plan (full-scope)
>
> Requirement source: User messages `msg_f5af2565200135hMBu5p035qlJ`, `msg_f5af3eabc001pzEn8oXTXXssQa`, `msg_f5afbe632001MQw2m2uweSx2c6`, `msg_f678e69dd001ZDyBFhqKBfKTPf`, `msg_f693d4515001auojbhjLClEf5i`, and the clean-room follow-ups quoted in section 1.
>
> Implementation allowed: yes (explicit user direction to proceed with TDD and no further audit)
>
> Last updated: 2026-07-16

> Active specification: only `R25.1` through `R25.6`, `R26.1` through `R26.9`,
> `R27 Workspace-Diagnostic Boundary`, `R28 Provider-Neutral Authority`,
> `R29 Authoritative-Completion Boundary`, `R30 VS Code-Only Observation`,
> `R31 Existing Timeout Ceiling`, and `R32 One-Second Ceiling` are
> implementation authority. R32 controls every conflict. Sections before R25,
> including their provider-specific commands, readiness terminals, file plans,
> approvals, and test expectations, are historical evidence and audit records
> only; they do not authorize implementation.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 临时实验文件夹:/Users/sunbenteng/Project/opencode/.temp/testing
> 请写系统检查检查LSP的诊断信息，他返回的信息不对,比如说文件本是有错误,但返回没错误,或者出现了新错误,但他显示是既有错误。你可以详细完整在临时工作区中进行完整检查。与此同时,你可以对LSP的opencode/vscode部分的sdk,更新进行一个复核。也检查检查vscode侧是否有相应的钩子hook能够捕获LSP对一个文件的完整检查与更新，这样我们就能避免通过延时固定时间触发而是使用事件触发返回进行反馈的模式,这样能够对LSP,全面完整的检查之前,它就已经完整反馈,进行检查,试验,到底现在有没有这种情况,或者异步的问题。

> 同时你也看看有没有更加鲁棒的hook机制，也就是在有限时间内等待hook返回

> thirdparty/opencode-v1.17.18-smark 不在本次考虑范围内，是packages/opencode

> 下面你需要完整检查一下,当前我看,首先有两个问题。第一个,你可以启动VS Code的扩展宿主机来进行相应的实验。你可以启动VS Code,并打开目录,附加目 .temp/testing这个目录。然后请你对当前的扩展进行检查。我比较好奇我们是否能找到一种更加鲁棒,更加不干扰用户的方式进行LSP的分析。与此同时,相应的 VS Code代码在 .temp文件夹里面有一个vscode,你可以自行进行完整审计检查。也就是理论上来说,目前我想要的是,能够不强制show文件,也就是打开并展示文件,而就能实现相应的完整LSP的依赖的一些钩子或者说一些端点等方式来进行LSP。因为如果频繁地打开文件,可能干扰用户的正常文件编辑,以及甚至用户可能会关掉它,而造成LSP结果不稳定。与此同时,你也可以完整检查VS Code的相关源码,在我们仓库里,来查看其到底是否能够稳定完整地得到相应的LSP的消息,譬如是否有任何的更新广播或者相应的其他内容信息,而不只依赖于相应的LSP的结果变化,因为结果变化可能不稳定。如果有钩子等内容,会更加稳定。所以请你自行详细完整进行相应的扩展调试以及测试。

> 你可以自行vscode打开文件夹然后在.temp/testing文件夹进行编辑实验来获取调试信息；

> 请注意,我希望的是,既能够保证和保持良好的LSP审计效果,也就是保持LSP持续可用且优秀,同时又能够兼顾不会进行新的选项卡的open,同时兼顾较好的速度、流程与体验的一个甜点级别的LSP系统。尽量避免进行提示LSP不可用之类降级或退化行为。

> 同时,如果初次审计轮数不可避免地达到了六次限制,那么我将会允许你调整到十二轮的上限

> 请注意,你在进行方案构建的时候,如果需要进行适当的源码修改以进行相应的扩展主题启动和测试,我是支持和允许的。也就是,你可以不遵循不能修改任何代码的规则,因为这是你所必须的能力。

> 同时我希望LSP能够准确地、适当地利用一些钩子或者等等事件,或者等等相关内容,使得相应的LSP整体不需要直接等一个固定的时间,因为固定的时间整体来说是很不讨巧的,且强烈依赖于相应主机实现的一个东西。如果能够自适应地依赖一些事件分发等内容,则更加好。

> 同时我不希望整体方案过于冗余实现,也就是最好不要写好多轮或者好多套不同的逻辑,理论上来说应该只有一套主逻辑,且我们整体的代码修改量要在整体两千行以内,这个两千行包括相应的注释和测试代码,不包括文档。同时修改的文件数量最好在十二个以内（6个以内更好）。

> https://github.com/beixiyo/vsc-lsp-mcp  与此同时,我找到了这一个仓库,这个是进行相应的LSP的MCP的构建的,你可以以相应的借鉴借鉴其思路。如果你需要git clone它,你可以把它放进.temp文件夹的testing目录里面,进行检查。

> 请注意,12个上文件的修改上限只是推荐的,如果真的需要,你可以自行增加。但整体的目标实际上是要达到我们前面设置的一些需求,及保持最小的干扰性,以及最精准和优秀的诊断反馈,同时尽量避免一些喷定等等的一些操作。同时如果真的需要,你的审计轮数可以提高到18轮。但我建议你不要将任何内容变得很复杂,你可以详细完整思考之后再进行文档构建,比如你可以自行进行相应的VS Code,苏主扩展机的相应实验,检查检查到底什么样才是一个比较甜点级的一个比较好的调用链。

> 下面请你使用Brainstorm的skills完整详细思考思考到底有没有相应的诊断链,因为理论上来说我并不希望实现当前这样。与此同时,我发现你的诊断内容是有问题的。你的诊断启动的扩展主机,但是其相应的LSP是从本窗口,也就是我们之前的扩展中得到的。如果当前这样还是不行的话,你可以试试在project里面新建一个testing的文件夹,然后在那个里面启动我们的VS Code以及编辑。因为现在好像LSP消息的请求会分发到当前的旧扩展的VS Code里面,导致了你观察到的现象。可能这个并不是真正的你的修改的现象。因此请使用Brainstorm等方法进行检查。

> 也就是~/Project/testing

> 请注意,我发现没有诊断的主要原因很可能是因为它并没有安装相应的语言解析器。所以这就导致了其可能存在相应的问题。但这个我并不完全确定,你可以自行看看,它是否会,理论上是否能够获取到真正的诊断信息。如果能的话,就当我什么都没说。或者说如果你之前验证了它能够获得的话,就当我什么都没说。同时我看到你现在打开的是txt。

The plan must preserve the full scope above while treating `packages/opencode`
and `sdks/vscode` as the production implementation scope. The isolated
`.temp/testing` material is experiment and verification support only.

## 2. Explicit Non-Goals

- Do not change `thirdparty/opencode-v1.17.18-smark`.
- Do not claim that the stable VS Code aggregate diagnostics API can prove provider completion, diagnostic generation, or document-version ownership.
- Do not add `showTextDocument` or change the user's active editor as a diagnostic refresh mechanism.
- Do not replace the direct OpenCode LSP clients with the generic VS Code bridge; project typecheck/lint integration is outside this revision.
- Do not add private or public provider-specific diagnostic commands, inspect language/provider/extension identity to select semantics, or infer generic provider completion. Provider-specific command benchmarks are historical evidence only and authorize no production or release-harness branch.
- Do not make a timeout, stale snapshot, or unsupported bridge result produce a success-shaped clean result.
- Do not present a healthy, connected LSP bridge as “unavailable” merely because a generic aggregate diagnostic conclusion is pending; preserve truthful pending/observed feedback.
- Do not use request-external historical diagnostic events as evidence for a current refresh.
- Do not create multiple independent diagnostic implementations or exceed 2,000 substantive changed lines including comments and tests; six files is preferred and twelve is a recommendation, not a correctness cap.
- Do not treat temporary experiment artifacts as production code. The clean-room observer and probe remain test-only Extension Host contract harnesses under the user's explicit experiment authorization.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md:1-181` | Defines `packages/opencode/src/lsp` as the LSP module and identifies v1 as current production. |
| `AGENTS.md:1-141` | Requires package-local verification, no root test execution, and minimal changes. |
| `packages/opencode/AGENTS.md` | Requires Effect service conventions and package-local `bun typecheck`; constrains the LSP service seam. |
| `packages/opencode/src/tool/AGENTS.md` and `packages/opencode/src/lsp/AGENTS.md` if present | Must be rechecked before implementation for local ownership rules. |
| `packages/opencode/test/AGENTS.md` | Requires tests at live Effect seams and event/readiness signals rather than arbitrary sleeps. |
| `docs/adr/README.md:1-50` | No accepted ADR changes the LSP diagnostic ownership found in this area. |
| `.opencode/policy/first-principles-engineering.md:41-400` | Requires first-divergence repair, one authoritative path, explicit reachability, traceability, and no fallback. |
| `.opencode/templates/canonical-plan.md:1-264` | Defines this document's required sections and audit metadata. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/lsp/lsp.ts:388-489` | Current bridge touch, diagnostics snapshot, bridge readiness state, and built-in-client path. | observed |
| `packages/opencode/src/lsp/client.ts:503-581,595-692` | Direct-client diagnostic wait timeout, generation matching, and the current result-discarding contract. | observed |
| `packages/opencode/src/lsp/server.ts:94-100,153-156` | Server extension matching and the reachable set of multiple applicable direct clients. | observed |
| `packages/opencode/src/cli/cmd/debug/lsp.ts:16-28` | Existing public diagnostic CLI that calls touch then diagnostics. | observed |
| `sdks/vscode/src/lsp.ts:1-125` | Current `showTextDocument`, listener timing, fixed quiet delay, timeout, and non-waiting diagnostics endpoint. | observed |
| `sdks/vscode/src/bridge.ts:199-212` | HTTP routing and transport boundary for LSP endpoints. | observed |
| `sdks/vscode/src/bridge-registry.ts:71-80` | Advertised LSP capability and bridge selection. | observed |
| `packages/opencode/src/lsp/diagnostic.ts:22-97` | Diagnostic identity, severity filtering, delta classification, and clean wording. | observed |
| `packages/opencode/src/tool/write.ts:110-169` | Single-file write baseline/current diagnostic flow. | observed |
| `packages/opencode/src/tool/edit.ts:215-266` | Single-file edit baseline/current diagnostic flow. | observed |
| `packages/opencode/src/tool/apply_patch.ts:220-354` | Multi-file patch mutation, baseline, touch, aggregation, and output flow. | observed |
| `packages/opencode/test/lsp/index.test.ts:124-209` | Existing bridge tests and their current shallow success/failure assertions. | observed |
| `packages/opencode/test/lsp/lifecycle.test.ts` | Existing diagnostic delta behavior tests. | observed |
| `sdks/vscode/.vscode-test.mjs:1-5` | Existing VS Code test discovery boundary; no current extension test suite was found. | observed |
| `.temp/testing/LSP_DIAGNOSTICS_AUDIT.md:7-189` | Captured reproduction of timeout success, post-write baseline race, severity upgrade, and event limitations. | observed |
| `.temp/testing/VSCODE_EXTENSION_HOST_AUDIT.md:1-289` | Real VS Code 1.122 Extension Host experiment, public API audit, and current bridge behavior. | observed |
| `.temp/testing/vscode-observer/extension.js` | Observer implementation for document, editor, save, and diagnostic events. | observed |
| `.temp/testing/vscode-observe-probe.ts` | `openTextDocument` versus `showTextDocument` experiment. | observed |
| `.temp/testing/vscode-current-bridge-probe.ts` | Current `/lsp/touch` timing and active-editor reproduction. | observed |
| `.temp/testing/vscode-external-edit-probe.ts` | Hidden-document content/version synchronization experiment. | observed |
| `.temp/testing/lsp-hook-policy.test.ts` | Historical prototype proving first-event completion and timeout-as-success are wrong; its quiet-period experiment is explicitly superseded. | observed |
| Installed VS Code 1.122 declarations and bundled language extensions | Stable API and internal-provider completion boundary review. | observed |
| `.temp/vscode/src/vscode-dts/vscode.d.ts:7010-7016` | Confirms `DiagnosticChangeEvent` contains only URI list. | observed |
| `.temp/vscode/src/vs/workbench/api/common/extHostDiagnostics.ts:320-344` | Confirms aggregate `getDiagnostics` merges current provider collections without provider/version ownership. | observed |
| `.temp/testing/vsc-lsp-mcp/src/lsp/diagnostics.ts:1-64` | External reference reads `languages.getDiagnostics` synchronously; it supplies no freshness/completion hook. | observed |
| `.temp/testing/vsc-lsp-mcp/src/lsp/tools.ts:20-46` | External reference opens hidden documents with `openTextDocument` and never calls `showTextDocument`. | observed |
| `.temp/testing/vsc-lsp-mcp/src/mcp/tools.ts:57-97` | External reference separates provider operations and diagnostics by explicit operation intent. | observed |
| `.temp/testing/vsc-lsp-mcp/README.md:86-92` | Documents diagnostics as a snapshot operation rather than a completion protocol. | contracted |
| `packages/opencode/src/tool/lsp.ts:37-103` | Existing LSP Tool uses the same `touchFile(file, "document")` token as mutation Tools despite requiring only provider warm/open. | observed |
| `packages/opencode/test/tool/lsp.test.ts:33-54` | Existing public LSP Tool test seam. | observed |
| `packages/opencode/src/tool/read.ts:446-450` | Existing one-argument `touchFile(file)` consumer whose only contract is background warm. | observed |
| `packages/opencode/src/tool/write.ts:49-73` | New-file mutation semantics and the reachable absent-before-write case. | observed |
| `packages/opencode/src/tool/apply_patch.ts:223-230` | `Add File` mutation path before any diagnostic refresh. | observed |
| `packages/opencode/test/tool/write.test.ts:88-96` | Public new-file Write Tool behavior. | observed |
| `packages/opencode/test/tool/apply_patch.test.ts:126,611,683` | Public `Add File` Apply Patch behavior. | observed |
| `.temp/testing/vscode-mcp-server/src/tools/diagnostics-tools.ts` and edit tools | Reviewed alternative implementation; it is synchronous and uses editor display in edit paths. | observed |
| `docs/lsp-diagnostics-ui-read-touch-implementation-plan.md:972-985` | Historical workaround decision; live reproduction disproves its “rare” assumption. | observed |
| `docs/lsp-complete-enhancement-plan.md:1155-1171` | Historical pre-edit baseline intent; not implementation authority. | observed |
| `docs/superpowers/specs/2026-07-16-lsp-clean-room-diagnostics-design.md` | Approved isolation topology, zero-tab matrix, exact findings, and result interpretation. | contracted/observed |
| `.temp/testing/vscode-clean-room-probe.ts` and `.temp/testing/vscode-observer/extension.js` | Fresh-profile PID/nonce/registry assertions, direct provider result capture, event capture, tab invariants, and safety deadline. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/lsp-audit-runtime/runs/typescript-semanticDiagnosticsSync-1784186357613-d0f7ed22` | Fresh unopened TypeScript file returned direct code 2322 in 928 ms while aggregate diagnostics stayed empty and no tab appeared. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/lsp-audit-runtime/runs/typescript-externalEditSemantic-1784186357810-6afe87c1` | Hidden document version advanced after an external edit, but tsserver retained old `fileContent` and returned an empty semantic result. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/lsp-audit-runtime/runs/python-externalEdit-1784185440867-6c3eeb30` | Zero-tab clean-to-error edit produced Ruff then Pylance waves and a four-item aggregate in 2.453 s. | observed |
| Installed `vscode.typescript-language-features` manifest and TypeScript server trace | Contributed command `typescript.tsserverRequest`; read-only syntactic, semantic, and suggestion diagnostic requests; exact configured-project response. | contracted/observed |
| `packages/opencode/src/ide/vscode-bridge.ts:66-72,186-230` | Existing bridge transport already accepts an AbortSignal and finite timeout, enabling request cancellation without a new transport. | observed |

## 5. Current Behavior

```text
write/edit/apply_patch mutation
  -> post-write `lsp.diagnostics()` baseline
  -> `packages/opencode/src/lsp/lsp.ts:touchFile`
  -> VS Code bridge `/lsp/touch`
  -> `sdks/vscode/src/lsp.ts:ensureOpen`
  -> `showTextDocument`
  -> listener registration and first matching `onDidChangeDiagnostics` event
  -> 50 ms timer or 2 s timeout
  -> `{ ok: true }`
  -> separate `/lsp/diagnostics` aggregate snapshot
  -> `newErrors` / `checkedMessage`
```

When no bridge is selected, the direct-client path is:

```text
Tool or debug CLI -> `LSP.touchFile` -> direct client `waitForDiagnostics`
  -> timeout/matched-generation result is currently discarded
  -> `LSP.diagnostics` cache -> connected-client status -> positive wording
```

The bridge registers its listener after the activation trigger, returns the
same success shape for an event and a timeout, and reads an aggregate cache
that has no request generation or document-version correlation. In a clean-room VS Code 1.122.0 Extension Host with a unique user-data
directory, extension directory, bridge registry, workspace, PID, and nonce:

- The active editor remained `control.txt`; every target file was opened only as a hidden `TextDocument`, and no target URI entered any tab group or visible editor.
- The built-in TypeScript language extension activated and started bundled TypeScript 6.0.3. Generic provider commands returned values, but generic diagnostic events remained empty.
- The installed read-only `typescript.tsserverRequest` `semanticDiagnosticsSync` command synchronized a fresh unopened target and returned code 2322 in 928 ms. That direct response was not copied into `languages.getDiagnostics` and produced no target diagnostic event.
- After an externally changed hidden TypeScript document advanced to version 2, tsserver still received its old clean `fileContent`; semantic diagnostics and `typescript.reloadProjects` both returned empty. Document version is therefore not provider-buffer freshness proof.
- With Ruff's legacy backend, Ruff and Pylance published separate target waves and reached the exact expected four-item aggregate in 1.3–2.6 seconds, including after a clean-to-error external edit. Ruff native mode remained at `Server: Start requested` without a target diagnostic for 60 seconds.
- Current `/lsp/touch` changed the active editor to the TypeScript or Python target in every corrected bridge run.
- Direct-client timeout and unmatched-generation outcomes are currently discarded, and connected-client existence is used as a positive readiness signal.
- `opencode debug lsp diagnostics <file>` is an existing consumer that performs the two-stage touch/read path.

`write`, `edit`, and `apply_patch` currently capture their alleged baseline
after mutation. The post-write baseline race was reproduced in 8/8 files, so
new diagnostics can be placed in the baseline and reported as existing. A
pre-mutation read of the aggregate cache is not sufficient either: the cache
may be absent or stale before the edit, so baseline qualification must be part
of the LSP service interface. Move operations also need a logical
source-to-destination baseline mapping.

New-file writes are a distinct supported mutation branch: the target is known
to be absent before the Tool writes it, so an empty pre-write baseline is a
fact of the mutation contract rather than an LSP query. The post-write direct
client refresh still has to qualify all applicable server candidates before a clean or
delta conclusion.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Existing or newly written file in a configured VS Code bridge project | `write`, `edit`, `apply_patch` | File mutation succeeds and bridge capability resolves | Tool -> `LSP.auditFile` -> adaptive `/lsp/audit` | `sdks/vscode` refresh protocol plus OpenCode LSP consumer | observed |
| Diagnostic event for a target URI | VS Code language extensions | Event identifies only URI(s), not provider/version/completion | `languages.onDidChangeDiagnostics` -> bridge barrier | VS Code SDK observer | observed |
| Multiple provider waves for one URI | Ruff/Pylance/TypeScript providers | No aggregate completion marker | Multiple events -> adaptive error event or pending deadline | VS Code SDK observer | observed |
| Hidden document content/version update | VS Code file watcher and `TextDocument` | Version/hash can reflect new content before diagnostics | `openTextDocument` -> external edit -> diagnostics snapshot | VS Code SDK freshness correlation | observed |
| Bridge deadline expires before a qualifying snapshot | Bridge request timing | Current code converts timeout to success | `/lsp/touch` -> `callLspBridge` -> tool output | Bridge protocol and OpenCode consumer | observed |
| Warning at a location becomes an error | LSP diagnostic payload | Current key excludes severity | `diagnostic.ts:newErrors` | Diagnostic delta owner | observed |
| Strict “no errors” assertion | OpenCode Tool or debug CLI | Generic VS Code aggregate API supplies no all-provider completion contract | Tool clean wording only after all applicable direct server candidates start and qualify | The LSP service candidate aggregation contract | contracted/reachable |
| Unsupported or stale bridge snapshot | Bridge response/document metadata | No current typed state; malformed/empty shape is treated too positively | `/lsp/diagnostics` -> `bridgeDiagnostics` | Bridge protocol | reachable |
| Existing file with stale or absent pre-edit aggregate diagnostics | `read` light warm followed by `edit` | Light warm explicitly skips diagnostics | `read.warm` -> edit baseline -> post-edit diagnostics | LSP baseline qualification plus Tool orchestration | reachable |
| `apply_patch` move from source to new destination | Apply-patch Tool input | Source exists; destination may not exist before mutation | source baseline -> move -> destination diagnostics | `apply_patch` logical change identity | reachable |
| Selected bridge request fails | Bridge transport or typed response validation | Current catch returns `undefined` | bridge selection -> request failure -> built-in clients | `packages/opencode/src/lsp/lsp.ts` backend selection | observed |
| Fresh hidden TypeScript/JavaScript target | `LSP.auditFile` after mutation or a new target | Installed TypeScript extension contributes read-only diagnostic commands | hidden `openTextDocument` -> `semanticDiagnosticsSync`/syntax/suggestion result | VS Code SDK observed-result owner | observed/contracted |
| Pre-existing hidden TypeScript/JavaScript target after external edit | navigation/warm operation or an earlier audit | `TextDocument.version` can advance while tsserver retains old buffer text | hidden document -> external edit -> stale direct command | VS Code SDK stale-state owner | observed |
| Ruff native server remains at start-requested | Ruff extension configuration | Provider may be active but not ready within finite safety bound | `onLanguage:python` -> server start -> no ready/diagnostic event | VS Code SDK pending provider observation | observed |

Speculative concerns such as undocumented provider-specific internal APIs or a
future provider's completion protocol do not justify production branches.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | No result claims global file clean. A named direct-provider scope may produce delta/clean only when every pull registration in that scope completes and matches the file. Push-only direct and VS Code provider scopes remain observed/pending and never authorize clean. | User symptom; distinct direct/VS Code provider universes. | Existing output and metadata are globally worded. |
| INV-02 | Diagnostic refresh must not change the user's active editor or require `showTextDocument`. | Explicit user requirement; live active-editor experiment. | No current non-interference test. |
| INV-03 | A healthy bridge records target waves only within the mutation coordinator's one shared absolute deadline and never treats the first error as provider completion. Fresh TS/JS may terminate earlier on the three named read-only diagnostic commands; pre-existing hidden TS/JS terminates stale-hidden. Generic VS Code observation has no independent wait beyond the shared deadline and cannot make an incomplete current result successful. No first event, empty event, or timeout claims clean. | Clean-room direct TypeScript response, separate Ruff/Pylance waves, stable API limit, and user's one-second edit-first requirement. | Extension Host/coordinator matrix covers named TypeScript completion, shared-deadline cleanup, stale-hidden, normal POST completion, caller abandonment, and no post-deadline output. |
| INV-04 | Pull capability defines the authoritative direct-provider scope. Every applicable static/dynamic diagnostic source at the request boundary is represented by a canonical identity containing registration ID, identifier, workspace/document scope, and selector; all sources must complete and baseline/current identities must match. Exact-version push proves content ownership only and remains observed, not complete. | LSP registration handlers, clean-room scope evidence, and R11 audit blocker. | Client tests cover selector/source identity, dynamic registration changes, and all-source completion. |
| INV-05 | Baseline selection follows actual target existence before the first mutation and is scoped to the same fully completed pull-provider set before and after mutation. Observed push/VS Code diagnostics are reported but never enter new/existing classification. | 8/8 post-write race, provider-universe distinction, and Add overwrite behavior. | No current scoped baseline test. |
| INV-06 | A warning-to-error transition at the same diagnostic identity is a new error for the “new errors” contract. | `deltaSummary` reproduction `{newCount: 0, existingCount: 1}`. | Existing test does not cover severity transition. |
| INV-07 | One coordinator returns scoped `authoritative` pull results plus `observed` direct-push/VS Code results. Only authoritative scope may classify delta, and wording names that scope; observed scopes are useful diagnostics but never failure-triggered replacements or global clean. | Stable VS Code API audit, distinct provider registries, and current global wording. | No current scoped-result consumer test. |
| INV-08 | A healthy bridge remains connected and useful while a generic diagnostic conclusion is pending; user feedback reports observed errors or pending state, not a false “LSP unavailable” degradation. | User's sweet-spot requirement; current status conflates bridge health with diagnostic readiness. | No current separated-status test. |
| INV-09 | A refresh uses only events observed after its request boundary; request-external diagnostic history cannot qualify the current result. | R4 observer audit and URI-only VS Code event contract. | No current lifecycle test for request-boundary cleanup. |
| INV-10 | Provider navigation/symbol operations use `warmFile`; the existing one-argument `touchFile(file)` remains a warm-only alias for Read Tool; mutation/debug diagnostics use `auditFile`. No diagnostics mode remains on `touchFile`. | Existing Read/LSP/mutation call paths; external reference's operation-by-intent design. | Existing tests do not assert the alias and explicit audit split. |
| INV-11 | Every push, including the first TypeScript push, updates the observed cache and publishes exactly one event; version only labels correlation and pull-registration completion alone controls authoritative qualification. | Current TypeScript first-push early return and waiter's Bus dependency. | No current single-first-push waiter test. |
| INV-12 | A fresh hidden TypeScript/JavaScript document may use the installed extension's read-only semantic, syntactic, and suggestion diagnostic command responses as an observed source; a pre-existing hidden document is stale-risk after external mutation and cannot use that response as current evidence. No VS Code bridge result authorizes global clean or an authoritative mutation baseline. | Clean-room `semanticDiagnosticsSync` response and stale hidden-buffer trace. | Extension Host tests cover fresh direct response, pre-existing hidden skip, and aggregate/event-only states. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-03, INV-07, INV-12 | `awaitDiagnosticsRefresh` converts an empty first event and timeout to success, while the useful generic fact is an error-bearing request-local event or direct provider response; the installed TypeScript command response is currently not represented by the bridge. | `sdks/vscode` diagnostic refresh interface. | `sdks/vscode/src/lsp.ts:17-35`; clean-room direct TypeScript result and Python provider waves. |
| INV-02 | `ensureOpen` calls `showTextDocument` as part of diagnostic refresh. | `sdks/vscode` refresh owner. | `sdks/vscode/src/lsp.ts:6-15`; active editor changed in Extension Host. |
| INV-04, INV-07 | The bridge protocol has no provider/generation ownership and `/lsp/diagnostics` returns an uncorrelated aggregate cache; the consumer also accepts bridge failure by entering built-in clients. | SDK bridge protocol and `packages/opencode` consumer. | `sdks/vscode/src/lsp.ts:92-109`; `packages/opencode/src/lsp/lsp.ts:327-355,436-489`. |
| INV-05 | Tools either capture an authoritative qualified pre-mutation snapshot or explicitly withhold delta classification; move operations currently do not preserve source identity. | `write`, `edit`, and `apply_patch` tool orchestration. | Exact call order at the file locations listed in section 4; 8/8 reproduction and move path. |
| INV-06 | `diagKey` omits severity before membership comparison. | `packages/opencode/src/lsp/diagnostic.ts`. | Lines 26-34 and direct delta output. |
| INV-08, INV-09 | The current plan's persistent per-URI history could treat old URI events as current evidence and current `status()` can conflate bridge readiness with diagnostics completion. | R4 auditor finding; user experience requirement. | New plan must use request-local observation and separate transport health from diagnostic conclusion. |
| INV-10 | `packages/opencode/src/tool/lsp.ts` and mutation Tools use the same `"document"` touch token for different semantics. | `LSP.Interface.touchFile` request intent. | LSP Tool line 80 and Write/Edit/Apply Patch call sites. |
| INV-01, INV-04 | `waitForFreshPush` accepts an unversioned push solely because it arrived after the request boundary while the client advertises `versionSupport: false`. | `packages/opencode/src/lsp/client.ts` qualification owner. | Lines 284-286 and 503-524; existing test lines 96-114. |
| INV-03, INV-11 | TypeScript first push writes `pushDiagnostics` and returns without publishing `Event.Diagnostics`, so an already-waiting audit may reach its deadline. | `packages/opencode/src/lsp/client.ts` push lifecycle. | Lines 134-139, 174-181, 191-207, 503-537. |
| INV-01, INV-04 | Client discovery writes both normal built-in absence and operational failure into one `broken` set, while extension/root matches alone overstate applicability. | `packages/opencode/src/lsp/lsp.ts` provider availability owner. | Lines 225-315 plus optional ESLint/Oxlint/Biome spawn paths. |
| INV-05 | Apply Patch `add` fixes `oldContent` to empty and overwrites an existing target without checking existence, so patch verb cannot prove an empty baseline. | `packages/opencode/src/tool/apply_patch.ts` mutation owner. | Lines 45-60, 223-231 and public overwrite test 604-615. |
| INV-01, INV-04, INV-05 | `requestDocumentDiagnostics` returns when one identifier produces file diagnostics while slower registered identifiers continue in background. | `packages/opencode/src/lsp/client.ts` pull qualification owner. | Lines 394-465 and existing slow-identifier test 339-389. |
| INV-01, INV-04 | Exact document version proves push ownership but current/proposed first-push completion cannot prove no later same-version validation replacement. | `packages/opencode/src/lsp/client.ts` push qualification owner. | Repeatable `publishDiagnostics` handler and LSP 3.17 replacement contract. |
| INV-12 | Hidden external edits update the VS Code `TextDocument` but an already-open hidden TypeScript buffer remains old inside tsserver; `semanticDiagnosticsSync` therefore returns the old result. | `sdks/vscode/src/lsp.ts` observed-result owner. | Clean-room `typescript-externalEditSemantic` trace shows old `fileContent` in `updateOpen` and empty semantic response after version 2. |

Red-capable feedback loops already run and go red:

```sh
cd .temp/testing && bun lsp-bridge-probe.ts --assert-timeout-success lsp-hook-type-error.ts
```

Observed: exit 1 with `FAIL: /lsp/touch reported ok=true after its 2s diagnostics timeout`.

```sh
cd .temp/testing && bun lsp-baseline-race.ts
```

Observed: exit 1; all 8 files allowed newly introduced diagnostics to enter
the post-write aggregate cache. This script remains historical reproduction
evidence only: its assertion that the post-write cache stays empty contradicts
the repaired semantics and is not a release command. The red/green replacement
is the public Tool/LSP integration slice in `test/tool/lsp.test.ts`, which
asserts the qualified pre-write baseline and new-versus-existing result.

```sh
cd .temp/testing && bun test lsp-hook-policy.test.ts
```

Observed: 3 pass, 0 fail. It proves first-event-empty and timeout-as-success are
wrong. R22 uses source-owned terminals only when they finish before the shared
one-second coordinator deadline. Generic VS Code observation has no universal
completion hook, so it becomes explicit incomplete at that deadline; stale
hidden state remains explicit, and only true caller abandonment or the shared
deadline disposes observation.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| VS Code document/diagnostic event and direct-result observation | `sdks/vscode/src/lsp.ts` | Bridge endpoint records every request-local VS Code event and supported fresh-document TypeScript command result; every result carries source/state metadata and never claims global completion | It is the first module with access to VS Code events, `TextDocument` metadata, extension commands, and tab state. | `packages/opencode` cannot observe Extension Host events directly. |
| Adaptive bounded wait, cancellation, and timeout classification | `sdks/vscode/src/lsp.ts` plus `sdks/vscode/src/bridge.ts` | Fresh TS/JS terminates at named command completion only within the remaining shared budget; stale-hidden terminates explicitly; generic providers become incomplete at the same absolute deadline; true caller abandonment disposes the request and normal POST completion never aborts it | The SDK owns provider observation terminals, while the HTTP server owns request/response disconnect classification. | Tool modules cannot distinguish provider timing from transport failure. |
| Snapshot capability and atomic refresh result | SDK bridge protocol | Bridge result is named-source `observed`, generic `observed-pending`, `pending`, `cancelled`, `stale-hidden`, or `unsupported`; it never authorizes direct qualification or global clean | The bridge can read aggregate diagnostics and direct command responses but cannot assign universal provider generation ownership. | `packages/opencode` cannot infer that ownership from URI-only events. |
| Bridge result interpretation and clean gating | `packages/opencode/src/lsp/lsp.ts` | LSP service exposes diagnostic readiness to tools | This is the consumer that currently converts bridge shape into `bridgeDiagnostics` readiness. | The SDK cannot control OpenCode wording or TUI metadata. |
| Scoped baseline qualification | `packages/opencode/src/lsp/lsp.ts` and `packages/opencode/src/lsp/client.ts` | Only pull-capable direct providers can enter authoritative scope; every static/dynamic registration must complete and match before that provider qualifies | The client owns registration completeness and the service owns provider-scope aggregation. | Tools cannot infer scope/completeness from push timing, aggregate maps, or bridge events. |
| Push publication and wake-up | `packages/opencode/src/lsp/client.ts` | Every accepted push updates cache and emits one waiter signal; version controls qualification separately | This is the first owner after `publishDiagnostics`. | The LSP service cannot recover an event the client suppressed. |
| Pre-mutation baseline capture and move identity | `write`, `edit`, `apply_patch` orchestration | Delta compares a qualified before snapshot with the same logical file after mutation; actual pre-mutation absence, not operation label, authorizes empty baseline | These modules own mutation timing, target existence, and source-to-destination identity. | SDK diagnostics cannot recover a baseline after mutation or infer Tool operation semantics. |
| Concurrent evidence coordination | `packages/opencode/src/lsp/lsp.ts` | A strict audit starts bridge and direct evidence together under one absolute deadline set before mutation; the bridge transport and every provider receive only the remaining budget; only a completed named pull-provider scope may authorize scoped delta/clean | It owns bridge discovery, direct startup, the shared deadline, provider-scope aggregation, and result semantics. | Tools and SDK each see only one evidence universe. |
| Provider applicability and state | `packages/opencode/src/lsp/lsp.ts` | Extension/root creates a potential provider; built-in no-handle is absent; returned handle or explicit custom config is applicable and remains ready, failed, or incomplete | Discovery owns built-in availability, custom configuration, spawn, initialization, and active clients. | Successful clients alone undercount failures, while extension matches alone include normally absent optional tools. |
| Request intent | `LSP.Interface` | `warmFile` opens/providers without diagnostics; one-argument `touchFile(file)` is a warm-only alias; `auditFile` performs the strict coordinator path | The interface owner must prevent one token from carrying incompatible latency/qualification semantics while preserving the reachable Read Tool consumer. | Callers choose intent, not backend. |
| Diagnostic feedback wording | `packages/opencode/src/lsp/lsp.ts` and tool consumers | Healthy bridge transport stays connected while diagnostic conclusion is pending; observed errors/pending are not “unavailable” | The LSP service owns the distinction between transport health and diagnostic readiness. | SDK cannot control OpenCode tool/CLI wording. |
| Diagnostic identity | `packages/opencode/src/lsp/diagnostic.ts` | “new error” is location/message/code/source/severity-aware | This module owns delta semantics. | Bridge only transports diagnostics and cannot decide OpenCode's delta contract. |
| Pull source identity | `packages/opencode/src/lsp/client.ts` | Static and dynamic diagnostic registrations are canonicalized with registration ID, identifier, selector, and workspace/document scope; baseline/current equality gates delta | The LSP client receives initialize capabilities and dynamic registration messages. | Tools and SDK cannot observe server registration scope. |

## 10. Single Approved Primary-Path Design

```text
one request-local diagnostic coordinator accepts explicit request intent
  -> set one absolute deadline no later than 1,000 ms from mutation-attempt start
  -> capture actual target existence and a qualified pre-mutation direct-pull baseline
  -> snapshot exact applicable static/dynamic pull-source identity at the request boundary
  -> file mutation and formatter
  -> strict audit starts direct qualification and bridge observation together
  -> bridge registers its observer before opening the target
  -> openTextDocument only; never showTextDocument
  -> fresh hidden TypeScript/JavaScript target may run the three read-only
     `typescript.tsserverRequest` diagnostic commands and return error results
     as named observed evidence
  -> bridge records every request-boundary wave and does not terminate on the
     first error; fresh TS/JS terminates when all three contributed diagnostic
     commands complete, stale-hidden terminates explicitly, and generic
     providers terminate incomplete at the same shared deadline
  -> direct client awaits every applicable pull source in the captured scope;
     push and VS Code evidence remain observed-only
  -> direct OpenCode and VS Code scopes run concurrently; provider success does
     not cancel another scope, but the shared deadline disposes every unfinished wait
  -> return one atomic typed refresh result with transport, authoritative,
     observed, pending, cancelled, and stale-hidden states; observed snapshots
     contain every wave received before that terminal
  -> delta/clean wording names only the completed equal pull-provider scope;
     no global clean
```

The primary repair is one diagnostic coordinator with scoped concurrent
evidence, not two implementations or a failure-triggered fallback. Pull-capable
direct providers form the only authoritative named scope for baseline, delta,
and scoped clean. Direct pushes and VS Code providers form observed scopes that
can report an error but never authorize global clean. Both channels begin at
strict-audit entry. The bridge observer is request-local, registered before
`openTextDocument`, and never uses `showTextDocument`.

The bridge records an error-bearing direct command response or aggregate event
immediately, but that signal never terminates the request by itself. This is the
critical completeness rule: later Ruff/Pylance/other target waves remain
eligible for the same atomic observed snapshot. For a fresh TS/JS target, the three contributed read-only diagnostic commands
provide a named provider terminal only if they complete inside the remaining
shared budget. For a pre-existing hidden TS/JS target, the stale-hidden
classification is the terminal and no stale command result is used. Generic
providers such as Pylance/Ruff have no stable all-provider completion signal,
so they become explicit incomplete when the same shared deadline arrives; the
clean-room 2.453-second wave remains useful evidence for why a one-second result
cannot call that bridge scope complete, not a reason to wait longer. A caller
truly abandoning the HTTP response or the shared deadline disposes the observer.
An empty event, an empty direct command response, unchanged diagnostics, or
silence never proves clean. Provider success never cancels another scope, but no
scope can extend the returned Tool result beyond the shared deadline.

At the shared deadline, the bridge returns `complete: false` and state
`incomplete`; it does not attach a partial diagnostic array or update the Tool
output later. The fresh TypeScript command set may return
`complete: true` only for its explicitly named three-command source scope; that
scope is still observed-only in OpenCode and cannot authorize baseline, delta,
or global clean.

Because stable VS Code exposes only URI-level aggregate diagnostic events and
mixes provider collections, the generic bridge cannot certify provider
completion, an empty result, or a qualified baseline. It can expose observed
diagnostics without claiming they are complete. `observed`, `pending`,
`cancelled`, `stale-hidden`, `incomplete`, and `unsupported` are states of this
one coordinator, not alternate success paths. The OpenCode consumer keeps healthy transport distinct from diagnostics and
reports a concise incomplete state rather than “LSP unavailable”. It never emits the current global
`no errors in this file` wording while observed provider scopes exist. A clean
or delta message names only the completed direct pull source identity and
states that VS Code/push observations are best-effort.

The SDK invokes the installed TypeScript extension's contributed read-only
`semanticDiagnosticsSync`, `syntacticDiagnosticsSync`, and
`suggestionDiagnosticsSync` commands only for a target that was not already
open at the request boundary. The fresh hidden-file trace proves this path can
return code 2322 without a tab. The stale hidden-file trace proves that a
pre-existing hidden document can retain old tsserver text after an external
edit, so that case returns `stale-hidden` and is never used as current evidence.
The direct command response is retained as observed evidence because VS Code
does not rebroadcast it through `onDidChangeDiagnostics`.

The mutation attempt records an absolute deadline at `startedAt + 1_000 ms`
before baseline acquisition and filesystem mutation. Baseline acquisition,
provider startup, formatter execution, direct terminals, bridge transport, and
SDK observers all receive only `max(0, deadline-now)`; if mutation/formatting
consumes the budget, diagnostics return incomplete immediately after the edit.
The existing two-second bridge default remains unchanged for unrelated bridge
operations, but the LSP audit call always supplies the shorter remaining budget.
`sdks/vscode/src/bridge.ts` creates an AbortController for the LSP
request, listens to the request's actual `aborted` condition, and treats a
`ServerResponse.close` as abandonment only while `response.writableEnded` is
false. It does not use `IncomingMessage.close`, which also represents normal
request completion. All transport listeners and the diagnostic observer are
disposed on response, abandonment, or deadline.

Within each direct client, push ownership and completion are separate. The
client advertises `publishDiagnostics.versionSupport: true`; exact-version
pushes are correlated observed diagnostics, while omitted/mismatched pushes are
uncorrelated observed diagnostics. No push alone qualifies clean, baseline, or
delta because another same-version validation push may replace it. A pull-
capable provider qualifies only after every applicable static and dynamic source
in the captured request-boundary scope completes. Each source identity includes
registration ID, identifier, workspace/document scope, and normalized selector;
a registration-set change makes the attempt incomplete rather than silently
expanding it. Identifier pulls remain parallel for speed, but one fast
identifier cannot finish the provider; timeout/unmatched sibling requests mark
the provider incomplete. Every push, including the first TypeScript push, uses
one cache-update plus `Event.Diagnostics` publication path so observations wake
immediately without being upgraded to completion.

The LSP service distinguishes potential from actual providers. Extension/root
matching creates a potential built-in provider; `spawn() === undefined` means
that optional provider is normally absent and does not enter the strict gate.
A built-in provider becomes applicable when it returns a handle. A provider
explicitly selected through `cfg.lsp` is applicable by contract. Applicable
providers remain represented as `ready`, `startup-failed`, or
`qualification-incomplete`; successful clients cannot erase a failed applicable
provider. The authoritative scope contains only pull-capable applicable
providers, and every registration in each member must complete. Push-only
providers stay in observed scope rather than blocking or authorizing pull-scope
clean. Initialization failure, explicit-config startup failure, or pull timeout
is reported incomplete for that named provider while concurrent observed scopes
remain useful. This is one result calculation, not a retry or backend switch.

The mutation Tool path requests and validates each baseline before the first relevant
mutation or formatter/event publication. It checks actual target existence at
that point. Any existing Write/Edit/Add/Move target receives a qualified
pre-mutation baseline; only a confirmed absent target receives an explicit empty
baseline, regardless of patch hunk label. The baseline records the complete canonical pull-source identity, not only
provider IDs. Delta is computed only when the exact same provider/source set
fully qualifies after mutation; otherwise current diagnostics are reported
without new/existing classification. If only observed scopes are available, the
tool reports those diagnostics without a clean conclusion. For a move,
`apply_patch` captures the source baseline before mutation and carries it to the
destination comparison for the same logical file. Diagnostic identity includes
severity so an escalation to `ERROR` is new under the existing contract.

Intent selection is part of the same interface: navigation/symbol callers use
`warmFile`, which performs hidden document/provider warm without diagnostic
waiting; the existing one-argument `touchFile(file)` remains an exact warm-only
alias for the Read Tool and has no diagnostics argument; mutation and
debug-diagnostic callers use `auditFile`, which starts both evidence channels
at once. A direct startup/timeout result remains
incomplete while already-running bridge observation may still return observed
errors or pending. No channel is activated because another failed, and no
bridge state authorizes clean/delta.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| SDK request-local event/direct-result observation | Proposed | supported evidence channel within the primary contract | named complete diagnostics only when its terminal finishes inside the shared deadline; otherwise explicit incomplete with no partial array | Concurrent observation channel | start with strict audit; stop at named TypeScript completion, stale-hidden, true caller abandonment, or the shared deadline; never activate after direct failure |
| Direct OpenCode LSP clients | Existing | scoped authoritative and observed channels within the primary contract | named clean/delta only for completed pull-provider scope; pushes remain observed | Concurrent direct channel | start with strict audit; await every registration; never infer global clean |
| Project typecheck/lint command | Outside this revision | Not a production path in this plan | no | 0% | do not add command discovery or execution |
| `openTextDocument` without display | Proposed operation inside primary path | primary-contract branch | no by itself | Included in primary | use only as synchronization/activation input, never as completion proof |
| Request-local `onDidChangeDiagnostics` observer | Proposed operation inside primary path | primary-contract branch | no by itself | Included in primary | record target waves without first-error completion; generic provider observation ends incomplete at the shared deadline or true caller abandonment; never treat an event or timeout as clean |
| `showTextDocument` refresh | Current | forbidden fallback/workaround | yes currently | Remove | delete from diagnostic refresh path |
| First event + 50 ms | Current | forbidden workaround | yes currently | Remove | replace with bounded event barrier |
| Timeout returning `{ok:true}` | Current | forbidden fallback | yes currently | Remove | return typed incomplete/timeout |
| Separate touch then stale aggregate read | Current | forbidden workaround | yes currently | Remove | return atomic refresh snapshot |
| Sequential direct attempt -> bridge after direct failure | Rejected proposed boundary | forbidden fallback | yes | Remove | strict audit starts bridge observation and direct qualification concurrently; bridge never authorizes success |
| Provider-specific internal tsserver hooks | Investigated | speculative | no | 0% | reject; no stable generic contract |
| Installed TypeScript contributed diagnostic commands | Proposed scoped branch | supported evidence channel within the primary contract | observed errors only; never clean or delta qualification | 1 bounded branch | use only on fresh hidden TS/JS documents; mark pre-existing hidden documents stale-risk; no private tsserver IPC |

No new alternate success path is proposed. Diagnostic statuses are explicit
non-success outcomes and remain within the primary protocol.

The generic bridge's new diagnostic-only decision surface is estimated at 6
branches (observed, pending, deadline, unsupported, listener registration, and
request cleanup) against approximately 92 total modified executable decision
branches, or 6.6%. It does not produce an
alternate success path and remains below the policy's 10% diagnostic budget.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `ensureOpen` -> `showTextDocument` for diagnostics | Empirically triggered providers | It interferes with active editor and is not needed as a correctness guarantee | `sdks/vscode/src/lsp.ts` |
| First event plus fixed 50 ms | Attempted to wait for provider refresh | Neither first empty nor first error event proves generic provider completion; named TypeScript commands may complete inside the shared budget and all other generic observation ends explicitly incomplete at its deadline | `sdks/vscode/src/lsp.ts` |
| Timeout resolved as success | API had only `Promise<void>` | Typed result must expose incomplete state | `sdks/vscode/src/lsp.ts` and bridge response types |
| `/lsp/touch` followed by `/lsp/diagnostics` | Existing two-endpoint protocol | Atomic refresh carries the same request's snapshot and freshness metadata | `sdks/vscode/src/lsp.ts`, `packages/opencode/src/lsp/lsp.ts` |
| Post-write baseline capture | Historical assumption that VS Code learned later | Live file-watcher experiment disproves it | `write.ts`, `edit.ts`, `apply_patch.ts` |
| Unqualified aggregate baseline | Existing cache read was treated as pre-edit truth | Stale/empty pre-edit cache can invert new/existing classification | `lsp.ts`, `write.ts`, `edit.ts`, `apply_patch.ts` |
| Bridge failure falling through to built-in clients | Existing catch-to-`undefined` behavior | One coordinator starts both channels at entry and keeps bridge failure non-success instead of switching semantics | `packages/opencode/src/lsp/lsp.ts` |
| Severity-free diagnostic key | Existing delta identity | It cannot represent warning-to-error escalation | `packages/opencode/src/lsp/diagnostic.ts` |
| Unqualified TypeScript command response | Not currently consumed | The contributed command is a real fresh-file observation but is not an aggregate event and becomes stale for pre-existing hidden buffers | `sdks/vscode/src/lsp.ts` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 / no global false clean | One coordinator returns named authoritative pull scope plus observed scopes | `sdks/vscode/src/lsp.ts`, `packages/opencode/src/lsp/lsp.ts`, Tool output paths | Consumer tests prove direct clean names providers and never implies VS Code/push completion |
| INV-02 / no active-editor interference | Hidden `openTextDocument` and request-local observers | `sdks/vscode/src/lsp.ts` | Isolated Extension Host test asserts active editor unchanged |
| INV-03 / event-driven bounded observation | Pre-registered bridge observer records all waves; fresh TS/JS ends at named command completion, stale-hidden ends explicitly, generic providers use the four-second safety terminal, and only actual abandonment cancels | `sdks/vscode/src/lsp.ts`, `sdks/vscode/src/bridge.ts`, `packages/opencode/src/lsp/lsp.ts` | Clean-room/coordinator tests prove later Ruff/Pylance waves are retained, direct OpenCode completion does not truncate them, normal POST does not cancel, actual abandonment disposes, and five-second outer timeout cannot preempt SDK terminal |
| INV-04 / pull-scope completeness | LSP service snapshots applicable static/dynamic sources with canonical selector identity; every source completes and registration changes invalidate the attempt; pushes remain observed | `packages/opencode/src/lsp/lsp.ts`, `packages/opencode/src/lsp/client.ts` | Tests cover optional absence, failed providers, selector/source identity, slow identifier error, repeated same-version push, and complete pull scope |
| INV-05 / scoped actual-existence baseline | Target existence chooses qualified or empty baseline; complete canonical source identities must match before/after; move maps source baseline to destination | `lsp.ts`, `client.ts`, `write.ts`, `edit.ts`, `apply_patch.ts` | Tool tests cover absent/overwrite Add, source identity change withholding delta, stale baseline, introduced diagnostics, and move |
| INV-06 / severity escalation | Severity included in `diagKey` | `packages/opencode/src/lsp/diagnostic.ts` | Lifecycle/delta test for warning -> error |
| INV-07 / truthful strict-clean boundary | Consumer gates clean wording on all-client direct-LSP qualification; project checker integration remains outside scope | `packages/opencode/src/lsp/lsp.ts`, tool output paths | Bridge/direct-client integration tests assert incomplete never produces green clean |
| Existing debug diagnostic CLI | Same typed diagnostic contract | `packages/opencode/src/cli/cmd/debug/lsp.ts` | Package-local CLI command verification asserts observed/pending output is not presented as complete clean |
| INV-08 / sweet-spot feedback | Transport health stays connected while diagnostic conclusion is pending | `packages/opencode/src/lsp/lsp.ts` and Tool consumers | LSP service test asserts pending does not produce “LSP unavailable” when bridge transport is healthy |
| INV-09 / request boundary | Request-local observer is registered before trigger and disposed after result | `sdks/vscode/src/lsp.ts` | Extension Host test emits a pre-request event and proves it cannot qualify the new request |
| INV-10 / explicit request intent | Existing LSP Tool's `touchFile(file, "document")` remains a warm-only compatibility alias; mutation/debug consumers use explicit `auditFile` | `packages/opencode/src/lsp/lsp.ts` (`tool/lsp.ts` remains an unchanged warm caller), `packages/opencode/src/tool/read.ts` (unchanged caller) | Client/coordinator tests prove warm aliases do not enter diagnostic wait while audit tests do |
| INV-11 / first-push wake-up | Unified push cache/event publication before version qualification | `packages/opencode/src/lsp/client.ts` | Fake server sends one first TypeScript push; waiter resolves from that event without a second push |
| INV-12 / fresh hidden TypeScript direct result | Fresh hidden TS/JS files use contributed read-only diagnostic commands as observed evidence; pre-existing hidden buffers are stale-risk | `sdks/vscode/src/lsp.ts` | Clean-room Extension Host proves direct 2322 response, no tab, aggregate-event distinction, and stale external-edit result |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Typed refresh result union | INV-01, INV-07 | Current timeout and event both return `{ok:true}` | Boolean success cannot represent incomplete/stale/unsupported semantics. |
| Request-local observer lifecycle | INV-03, INV-09 | Listener must be registered before the trigger and disposed at request completion | Persistent history cannot establish current diagnostic generation and adds lifecycle state without a contract. |
| Document version/content metadata | INV-04 | Hidden external edit changed version/hash before diagnostics | Metadata remains observational only; aggregate diagnostics has no generation ownership or freshness relation to requested content. |
| Adaptive bridge observation terminal | INV-03 | Clean-room proves TypeScript has a named read-only command terminal while Python providers publish multiple waves without a universal completion event | Use the named TypeScript terminal when contracted, stale-hidden when proven, and the finite generic safety terminal otherwise; never terminate on first event or unrelated direct-provider completion. |
| LSP bridge timeout hierarchy | INV-03, INV-08 | Current outer default is two seconds while observed Python waves reach 2.453 seconds | Set only the LSP audit call to five seconds around the SDK's four-second terminal; preserve unrelated bridge defaults and add no retry. |
| True HTTP abandonment signal | INV-03 | Node `IncomingMessage.close` represents normal request completion, while request aborted and response close-before-writable-ended identify abandonment | The bridge server owns transport lifecycle and must not leak normal body completion into diagnostic cancellation. |
| Atomic refresh snapshot | INV-01, INV-07 | Touch response preceded real errors; separate read observes later unrelated cache | Two independent requests cannot prove the snapshot belongs to the touch. |
| Pre-write baseline placement | INV-05 | 8/8 post-write race reproduction | A post-write read can already include new diagnostics. |
| Severity in diagnostic identity | INV-06 | Direct warning/error delta reproduction | Existing key explicitly omits severity. |
| Consumer readiness/status distinction | INV-01, INV-07 | `bridgeDiagnostics = "ok"` accepts empty structurally valid stale responses | SDK response alone cannot change OpenCode's clean wording unless the consumer interprets it. |
| Scoped concurrent bridge/direct evidence | INV-01, INV-07, INV-08 | Direct and VS Code provider universes differ | Starting both at audit entry avoids fallback; only a named completed pull scope may authorize scoped delta, never global clean. |
| Fresh-file TypeScript command observation | INV-12 | Installed extension exposes read-only semantic/syntactic/suggestion requests; clean-room returns 2322 without a tab | Existing bridge only reads aggregate events and cannot expose the direct command response; private tsserver IPC is not needed. |
| Stale-hidden classification | INV-12 | External edit changes hidden document version while tsserver keeps old `fileContent` | Existing aggregate/command result lacks provider-buffer generation, so a pre-existing hidden target must not be treated as current evidence. |
| Canonical dynamic pull-source identity | INV-04, INV-05 | Dynamic registration handlers currently retain only IDs/identifiers and baseline stores no selector/source set | Provider registration ownership is available only in the LSP client; tools cannot reconstruct it from merged diagnostics. |
| Explicit `warmFile` / `auditFile` intent | INV-10 | Current `"document"` token carries navigation warm and strict mutation semantics | One interface owner must name latency/qualification intent so callers never infer backend policy. |
| Qualified baseline result | INV-05 | Read warm skips diagnostics and aggregate cache may be stale before edit | Baseline placement alone cannot prove the pre-edit diagnostic state. |
| Move source-to-destination baseline identity | INV-05 | `apply_patch` supports moves and destination does not exist before mutation | A destination-keyed pre-write lookup loses the supported source file's diagnostics. |
| Built-in diagnostic wait result | INV-01, INV-05, INV-07 | `waitForDiagnostics` currently drops timeout and generation matching | `client.ts` is the owner of the direct protocol wait and must expose its qualification to the LSP service. |
| Pull-only completion qualification | INV-01, INV-04 | Same-version pushes can repeat/replace; current pull helper returns after one fast identifier | Only the client owns the complete registration set and can await every pull while keeping pushes observed-only. |
| Provider-scoped result and wording | INV-01, INV-05, INV-07 | Direct and VS Code provider sets are different and current `checkedMessage` is global | The LSP service and Tool outputs own provider IDs, baseline scope equality, and user-visible claim boundaries. |
| Unified first-push publication | INV-03, INV-11 | TypeScript seed path writes cache and returns before Bus publication | One update/event path removes the lost-wake race without adding a timer. |
| Potential/applicable provider distinction | INV-01, INV-04 | Optional built-in spawn methods normally return undefined when dependencies are absent, while custom configuration is explicit | The LSP service owns registry provenance and spawn result, so it can exclude normal absence and retain applicable failures without changing every server implementation. |
| Applicable provider status | INV-01, INV-04, INV-05 | Current discovery drops applicable initialization/explicit startup failures before aggregation | The LSP service already owns matching and startup, so it must retain status through the same coordinator result. |
| Actual-existence baseline branch | INV-05 | Apply Patch Add overwrites existing targets while fixing `oldContent` to empty | Mutation owner can query existence before first write; operation label cannot. |
| Debug CLI typed-result consumer | INV-01, INV-07 | `packages/opencode/src/cli/cmd/debug/lsp.ts:16-28` performs touch then diagnostics | Existing CLI would otherwise bypass the migrated result contract. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `sdks/vscode/src/lsp.ts` | modify | Replace display-based refresh with request-local all-wave observation, fresh-hidden TypeScript named command completion, stale-hidden classification, four-second generic safety terminal, typed pending/cancelled response, and separate bridge health. | +125/-55 |
| `sdks/vscode/src/bridge.ts` | modify | Use request `aborted` plus response close-before-`writableEnded` to build the LSP AbortSignal, pass it to the audit route, and clean transport listeners without treating normal POST completion as cancellation. | +24/-4 |
| `packages/opencode/src/lsp/lsp.ts` | modify | Own warm/audit coordinator, provider applicability, scoped pull-authoritative versus push/VS Code observed results, canonical source-set equality, explicit five-second LSP transport timeout, independent scope terminals, and truthful feedback. | +190/-75 |
| `packages/opencode/src/lsp/client.ts` | modify | Advertise push version support for correlation, keep all pushes observed-only, canonicalize static/dynamic source identity including selectors, await every source in the captured scope, unify first-push publication, and return typed scope readiness. | +115/-45 |
| `packages/opencode/src/lsp/diagnostic.ts` | modify | Include severity in identity and format only explicitly named authoritative provider-scope claims. | +15/-3 |
| `packages/opencode/src/tool/write.ts` | modify | Capture provider-scoped baseline before mutation, use empty baseline only for absence, and render scoped authoritative plus observed results without global clean. | +35/-15 |
| `packages/opencode/src/tool/edit.ts` | modify | Apply provider-scoped baseline equality and authoritative/observed wording semantics. | +28/-12 |
| `packages/opencode/src/tool/apply_patch.ts` | modify | Use actual existence, provider-scoped baselines, Add overwrite/source/destination mapping, move identity, and no global clean. | +70/-30 |
| `packages/opencode/src/cli/cmd/debug/lsp.ts` | modify | Consume the coordinator's typed result and expose observed/pending/incomplete states without a second unqualified read. | +18/-8 |
| `packages/opencode/test/lsp/client.test.ts` | modify | Test all pushes observed-only, repeated same-version error replacement, every pull identifier including slow error, first TypeScript push, provider applicability/failure, and scope readiness. | +315/-35 |
| `packages/opencode/test/tool/lsp.test.ts` | modify | Exercise the singular coordinator through warm alias, audit result states, known-empty baseline, formatter-inclusive mutation, delayed watcher duplicate, sibling invalidation, current diagnostics, and Tool wording. | +150/-20 |
| `packages/opencode/src/file/watcher.ts` | modify | Make LSP-enabled Project observation default, expose truthful ready/unavailable observation state and sequence, preserve event origin/attempt metadata, and keep subscription establishment on the awaited owner boundary. | +65/-25 |

This is 12 modified files: 10 production files and 2 existing focused test
files. The three mutation Tool files remain separate owners of write ordering;
the coordinator/event contract is tested through the existing LSP client suite
and the existing Tool regression suites remain in the verification command. The
existing `tool/lsp.ts` caller is intentionally unchanged because its
`touchFile(..., "document")` operation is defined as the warm-only alias, not a
second diagnostic path. No new production file or dependency is justified. The
TypeScript command branch is one bounded observed-evidence branch inside the
same SDK coordinator, not a second diagnostic implementation.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | A generic bridge refresh that receives Ruff then Pylance before its four-second terminal returns both waves; neither first empty nor first error event ends observation. A fresh TypeScript request ends when all three named read-only commands complete. | Current promise resolves after first event plus 50 ms and R12 would have resolved on first error. | Request-local observer records every request-boundary snapshot; use named TypeScript completion where contracted and the bounded generic terminal otherwise. | INV-03, INV-12 and the clean-room matrix. |
| 2 | Normal POST body completion does not cancel a refresh; an actual caller-aborted response disposes the observer; safety deadline returns `pending` and never `{ok:true}` or “LSP unavailable”. | Current timeout calls the same resolver as success and R12 selected `IncomingMessage.close`, which also represents normal request completion. | Use request `aborted` and response-close-before-`writableEnded` semantics, typed result, and separate transport-health status. | INV-01, INV-03, INV-07, INV-08 and the normal/aborted transport harness. |
| 3 | Refreshing a hidden file leaves the active editor unchanged. | Current `ensureOpen` calls `showTextDocument`. | Use `openTextDocument` and observers only for diagnostics. | INV-02 and the live Extension Host result. |
| 4 | A diagnostic event recorded before the request boundary cannot qualify the new request, while a direct-client generation mismatch is incomplete. | Persistent history has no generation ownership; direct client owns its generation stream. | Use request-local observers and direct-client qualification separately. | INV-04, INV-09 and hidden external-edit/source audit. |
| 5 | OpenCode renders named pull-provider clean/delta separately from direct-push and VS Code observed scopes, and never emits global `no errors in this file`. | Current consumer treats any mapped response as globally ready and wording has no provider scope. | Typed scoped result, exact baseline provider IDs, neutral observed/pending wording, and separate bridge health. | INV-01, INV-05, INV-07. |
| 6 | Direct OpenCode pull completion cannot truncate the independent VS Code provider universe; fresh TypeScript uses its named command terminal while generic Python observation retains Ruff/Pylance waves through its bounded terminal. | R10 would have cancelled VS Code on direct completion, R11 always used deadline, and R12 would have stopped at first error. | Start both channels at audit entry and await each scope's own terminal; no provider universe cancels the other. | INV-01, INV-03, INV-07 and real provider waves. |
| 7 | Pull-provider timeout or unmatched registration never becomes scoped clean. | `waitForDiagnostics` discards timeout and `status()` checks only client existence. | Propagate provider/registration readiness and gate named clean/baseline/delta. | INV-01, INV-04, INV-05 and client source path. |
| 8 | Unversioned, mismatched, and exact-version pushes all remain observed-only; a pull provider qualifies only after every static/dynamic identifier finishes and matches, including a slow identifier that adds an error. | Current time boundary accepts pushes and document pulls return after one fast diagnostic batch. | Advertise version support for correlation, remove push completion, await all pull registrations in parallel, and supersede the early-return slow-identifier test. | INV-01, INV-04 and direct-client protocol. |
| 9 | A single first TypeScript push wakes an already waiting audit without requiring a second push or fixed delay. | Current first-push seed branch returns before `Event.Diagnostics`. | Route first and later pushes through one cache-update/event path. | INV-03, INV-11. |
| 10 | A missing optional ESLint/Oxlint/Biome provider does not block qualified TypeScript, while an explicit or handle-returning provider that fails initialization/qualification does block. | Current discovery conflates no-handle absence and failure in `broken`; extension/root alone overmatches optional tools. | Preserve registry provenance and classify built-in no-handle as absent, explicit/initialized provider failure as incomplete. | INV-01, INV-04, INV-07 and optional server paths. |
| 11 | A stale/empty generic cache or a changed pull-provider set cannot become or compare against an authoritative baseline. | Current tools read an unqualified aggregate snapshot and store no provider scope. | Store completed pull-provider IDs with baseline and classify delta only when post-write scope exactly matches. | INV-05 and reachable stale/provider-change paths. |
| 12 | A confirmed absent Write/Add target uses empty baseline, but Add File overwriting an existing target captures qualified pre-write diagnostics and preserves existing classification. | Current Add hunk fixes `oldContent` to empty and can overwrite an existing file. | Query existence before first mutation and choose baseline from that fact, not hunk type. | INV-05 and absent/overwrite public Tool paths. |
| 13 | A newly introduced diagnostic is not included in its own baseline. | Current tools read baseline after mutation. | Move qualified baseline capture before the mutation transaction for existing files. | INV-05 and 8/8 baseline race. |
| 14 | A pure move preserves the source baseline when comparing diagnostics at the destination. | Current `apply_patch` keys the pre-write lookup by a destination that does not yet exist. | Carry source baseline by logical move identity to the destination result. | INV-05 and supported move path. |
| 15 | The debug diagnostic command does not bypass the typed result contract. | Current command performs touch then a separate diagnostics read. | Consume one typed result and render pending/observed states truthfully. | INV-01 and INV-07. |
| 16 | Warning -> error at the same location is counted as a new error. | `diagKey` omits severity. | Add severity to the identity used by `newErrors`. | INV-06. |
| 17 | Hover/definition/symbol and Read Tool warm operations open a hidden document without entering strict diagnostic startup or deadline. | Current LSP Tool passes the same `"document"` token as mutation diagnostics while Read uses one-argument touch. | Replace the LSP Tool token with `warmFile`, retain one-argument `touchFile` as warm-only alias, and route mutation/debug callers to `auditFile`. | INV-10 and public LSP/Read Tool paths. |
| 18 | A fresh hidden TypeScript error returns code 2322 through `semanticDiagnosticsSync` without a tab, while a pre-existing hidden external edit is rejected as stale-risk. | Current bridge only reads aggregate events and cannot distinguish the tsserver stale buffer. | Run the three contributed read-only commands only for fresh hidden TS/JS documents; preserve direct response as observed and mark pre-existing hidden state stale. | INV-12 and the clean-room direct/stale traces. |
| 19 | Baseline/current direct diagnostic scopes with different dynamic registration IDs, selectors, or identifiers cannot produce a delta. | Current identity stores only provider IDs and omits dynamic source scope. | Canonicalize and persist the complete applicable source identity at both boundaries; mismatch yields incomplete/no delta. | INV-04, INV-05 and dynamic registration integration tests. |
| 20 | A Python bridge result observed at 2.453 seconds reaches OpenCode instead of being preempted by the current two-second outer timeout. | `VscodeBridge.callBridge` defaults to two seconds when the LSP caller supplies no timeout. | Set the LSP audit transport timeout to five seconds around the SDK's four-second terminal and assert the real OpenCode-to-bridge path. | INV-03, INV-08 and the clean-room latency trace. |

Tests must use public bridge/LSP/Tool results and independent literal expected
statuses/counts. The real Extension Host test must use event/readiness signals;
fixed sleeps may only model the provider-wave timing in the dedicated race
harness, not establish production completion.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 1,300 | Includes substantive production and test/harness code across adaptive bridge results, fresh TypeScript command observation, stale-hidden state, provider applicability, canonical dynamic source identity, complete pull registrations, observed pushes, actual-existence baseline, CLI, tools, and regression slices; excludes imports, comments, formatting, generated files, and pure moves. |
| Required Chinese explanatory comments `C` | 195 | `ceil(1,300 * 0.15) = 195`; implementation must distribute qualifying comments adjacent to changed decisions, including test-intent comments. |

Qualifying comments must explain non-obvious constraints rather than restate
control flow. Planned topics are: why `onDidChangeDiagnostics` is evidence but
not universal provider completion; why an empty generic snapshot is pending;
why the first useful error is not generic provider completion; why cancellation is not a fallback;
why the observer is registered before opening; why a fresh hidden TypeScript
command response is observed but not global clean; why a pre-existing hidden
document is stale-risk after external edits; why version/hash are observational
metadata rather than provider-buffer freshness proof; why provider universes
retain independent terminals; why the four/five-second timeout hierarchy does
not apply to unrelated bridge calls; why generic/global clean wording is
withheld; why concurrent evidence is not fallback; why direct pull completion
awaits every applicable static/dynamic source; why registration IDs/selectors
belong in baseline identity; why all pushes remain observed; why the first
TypeScript push must wake waiters without bypassing version checks; why failed
applicable providers remain in the all-client gate while normally absent optional
providers do not; why Add File uses actual existence; why the Read Tool alias is
warm-only; why provider scope must match baseline/current; why move baselines
follow logical file identity; and why severity belongs in identity. Test comments
will explain the user-visible race each regression locks; they count in `C` and
the user's total-line budget, not in `E`.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/lsp/index.test.ts test/lsp/client.test.ts test/lsp/lifecycle.test.ts test/tool/lsp.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts` | `packages/opencode` | One coordinator, provider applicability, direct-client aggregation, warm/audit intent, canonical source identity, five-second LSP-only bridge timeout over a delayed 2.453-second fake bridge response, severity delta, Add overwrite, move identity, and all affected existing tests. |
| `bun typecheck` | `packages/opencode` | Core type safety. |
| `bun run check-types` | `sdks/vscode` | SDK type safety. |
| `bun run lint` | `sdks/vscode` | SDK lint and API usage checks. |
| `bun run compile` | `sdks/vscode` | Builds the changed TypeScript source into ignored `dist/extension.js`; Extension Host launch is forbidden unless this succeeds in the same verification run. |
| `bun .temp/testing/vscode-clean-room-probe.ts typescript` | repository root | Fresh isolated hosts prove TypeScript parser activation, direct semantic/syntactic/suggestion result handling, zero-tab state, stale-hidden classification, adaptive pending/cancellation, and current bridge non-interference. |
| `bun .temp/testing/vscode-clean-room-probe.ts python` | repository root | Fresh isolated hosts prove Pylance/Ruff event waves, clean-to-error updates, provider-source observation, zero-tab state, and native/legacy provider readiness behavior. |
| `bun lsp-bridge-probe.ts --assert-timeout-success lsp-hook-type-error.ts` | `.temp/testing` | Original timeout symptom must become green by asserting that timeout is not success. |

Do not run tests from the repository root. The unavailable
`.temp/testing/vscode-mcp-server` dependency installation remains a documented
verification limitation; its source audit and the real Extension Host probes
are the relevant evidence for this task.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Reuse existing production, test, and `.temp/testing` harness files. |
| Files modified | 13 | Ten production owners plus three existing focused test/harness files; the recommendation is exceeded only for the transport cancellation seam and the already-authorized clean-room harness. |
| Files deleted | 0 | Remove obsolete logic in place; no deletion is evidenced. |
| Production lines | 650 | One scoped coordinator path across adaptive SDK observation, transport cancellation, fresh TypeScript command observation, provider applicability, complete pull registration, observed pushes, diagnostic identity, mutation owners, warm intent, and debug CLI. |
| Test/harness lines | 650 | Covers clean-room isolation, direct TypeScript result/stale-hidden behavior, Python waves, cancellation, provider scope, repeated pushes, slow identifiers, Add overwrite, provider-set changes, warm intent, baseline/move, and severity. |
| Total implementation/test/comment lines | 1,495 | Includes the estimated 650 production lines, 650 test/harness lines, and approximately 195 qualifying/explanatory comment lines; below the user's 2,000-line limit. |
| Generated lines | 0 tracked | `bun run compile` creates ignored `sdks/vscode/dist/extension.js` only as a verification artifact; it is never manually edited or included in the implementation diff. |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

- None required for the canonical repair direction. The user has already specified the non-intrusive, bounded-hook objective and the production scope.
- The generic bridge's result must be described as bounded best-effort rather than universal provider completion; this follows the stable VS Code API evidence and is not an unresolved design choice.

### Real Risks

- The stable VS Code API cannot expose a universal all-provider completion marker. The plan therefore prevents false certainty but cannot make the generic aggregate cache authoritative.
- Different providers may emit no diagnostic event when the result is unchanged. The bridge scope returns pending, pull scope is named separately, and silence never becomes global clean or “LSP unavailable”.
- An external edit during a refresh can invalidate the requested version. The correct result is stale-document, not a retrying alternate success path.
- Moving baseline capture earlier must preserve existing permission, formatter, and partial-patch semantics; tool-level tests must verify the mutation transaction remains unchanged apart from baseline ordering.
- Existing downstream callers may expect `{ok:true}`. The bridge consumer owns the compatibility change and must be updated in the same primary path; no truthy-object compatibility fallback is allowed.
- A pre-mutation position is not enough to establish a baseline. The LSP service must return a qualification state, and tools must avoid delta claims when it is absent or stale.
- A move changes the path but may preserve the logical diagnostic identity. The source baseline must be transferred only through the supported move operation, not through a general path-matching fallback.

### Rejected Speculation

- A stable generic `executeDocumentDiagnosticProvider` command was not found; no production design is based on it.
- TypeScript's internal `requestCompleted` and JSON server pull-refresh paths are provider/internal details, not reachable generic extension contracts. The contributed read-only diagnostic command is different: it is present in the installed extension manifest, allow-listed by the command implementation, and verified in the clean-room host.
- Installing missing dependencies for `.temp/testing/vscode-mcp-server` is not necessary to establish the observed production behavior and would introduce unrelated network/lifecycle risk.
- A longer fixed delay is not a completion protocol and is rejected by the real multi-provider traces.
- `vsc-lsp-mcp` is a useful reference for hidden `openTextDocument` and operation-by-intent routing, but its synchronous `getDiagnostics` snapshot is not a freshness/completion protocol and is not copied as one.
- A universal “all provider waves complete” event is not exposed by VS Code stable APIs. The primary path therefore returns useful error evidence early, keeps empty/no-error evidence pending, and never converts the bridge channel into authoritative clean.
- A pre-existing hidden TypeScript document cannot be repaired by `reloadProjects` in the observed host because tsserver retains the old `fileContent`; the plan marks this state stale-hidden rather than adding a restart/reopen fallback.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

The user explicitly authorizes extending the default six-round plan-audit limit
to eighteen rounds if needed to reach a complete clean verdict.
This exception does not reduce full-scope or evidence requirements.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01 The proposed settled state can still certify an erroneous hidden file as clean`; `B-02 The existing bridge-to-built-in diagnostic fallback is not removed or correctly classified`; `B-03 Pre-mutation placement alone does not make the baseline fresh or authoritative`; `B-04 apply_patch move operations lose the source baseline`; `B-05 The Chinese-comment budget excludes tests and therefore commits below the hard minimum` | `N-01 The Extension Host verification row is not an executable command` | `BLOCK — canonical plan revision R1 is not approved.` | `ses_0985f06bbffeu2xgYQ4BPmrKEd` |
| 2 | R2 | yes | `B-01 VS Code 聚合诊断无法按文档版本完成计划所声称的关联`; `B-02 内置 LSP 路径的 timeout/unqualified 结果仍会被当作检查完成`; `B-03 初始 backend 选择仍让 generic bridge 取代更强的诊断契约`; `B-04 /lsp/touch 加 /lsp/diagnostics 的现存诊断消费者未纳入迁移` | `N-01 文件计划仍包含条件式变更位置` | `BLOCK — canonical plan revision R2 is not approved.` | `ses_0985740c4ffeu7tfOWYM6TVznN` |
| 3 | R3 | yes | `B-01 多个直接 LSP client 的资格结果没有聚合契约`; `B-02 “authoritative project checker”是未映射的成功路径` | `R3 does not provide a concrete decision-surface calculation for the generic bridge’s observed-only/incomplete diagnostic behavior`; `The planned Extension Host command relies on sdks/vscode/.vscode-test.mjs, whose current configuration only specifies out/test/**/*.test.js and does not open .temp/testing as a workspace.` | `BLOCK — canonical plan revision R3 is not approved.` | `ses_0984df6bbffetWt7i62Qy9s4Rr` |
| 4 | R4 | yes | `B-01 新建文件没有可执行的合格基线语义`; `B-02 持久化 per-URI observer 把请求前事件引入当前刷新，却没有提供诊断代际证明` | `§10 第238-248行没有完全区分 observed-only 与 incomplete`; `packages/opencode/src/ide/vscode-bridge.ts 当前 callBridge() 已原样返回 unknown payload`; `§18 的 Extension Host 验证说明需要程序化打开 .temp/testing，但当前 .vscode-test.mjs 只配置测试文件 glob.` | `BLOCK — canonical plan revision R4 is not approved.` | `ses_0984681faffeOtXrLsnL1yjx5A` |
| 5 | R5 | yes | `B-01 基线竞态验证脚本无法因计划中的修复而转绿`; `B-02 Backend 选择契约无法同时满足“执行前选择”和 generic bridge 可用性`; `B-03 现有 LSP Tool 消费者未映射到新的 capability mode` | `Audit mode 元数据写为 full-scope，而本次输入模式是 plan.`; `§18 的测试命令未运行现有 test/tool/edit.test.ts 和 test/lsp/client.test.ts`; `adaptive quiet boundary 尚未给出具体计算规则.` | `BLOCK — canonical plan revision R5 is not approved.` | `ses_0983c5e38ffedEVtlgtV4bmcHM` |
| 6 | R6 | yes | `B-01 直接 LSP 的无版本 push 仍可能被错误认定为当前内容的合格诊断`; `B-02 TypeScript 首次 push 被缓存但不发布等待信号，计划中的权威通道可固定等到超时`; `B-03 真实 Extension Host 验证没有对计划承诺的 SDK 行为作可失败断言` | None | `BLOCK — canonical plan revision R6 is not approved.` | `ses_0983290beffe3P4uz2WmJYTJA4` |
| 7 | R7 | yes | `B-01 read.ts 现有调用方未纳入显式请求意图迁移`; `B-02 计划没有为“适用 direct client 启动失败”建立可执行的完整性判定` | `lsp-bridge-probe.ts 的参数名 --assert-timeout-success 与其实际行为相反`; `§15 仍将 .temp/testing/vscode-current-bridge-probe.ts 作为修改文件，但 §2 明确禁止把临时实验材料作为生产实现` | `BLOCK` | `ses_0982ae657ffe7BwLI41YM2NGar` |
| 8 | R8 | yes | `B-01 “适用 server”判定会把未安装的可选 LSP 永久计为失败候选`; `B-02 Add File 并不保证目标不存在，空 baseline 会再次误报“新错误”` | `§17 对 E 是否包含解释性注释的表述不够一致`; `§15 将 severity-delta 测试列在 test/lsp/client.test.ts，而当前该职责的测试集中在 test/lsp/lifecycle.test.ts` | `BLOCK — canonical plan revision R8 is not approved.` | `ses_09824e8eaffeMPXJeXgGUY5lIX` |
| 9 | R9 | yes | `B-01 首个非空诊断事件仍会在后续 provider 发布前返回不完整结果`; `B-02 Extension Host 验证启动的是未构建的旧 bundle，而不是计划修改的 SDK 源码` | `§18 的 focused package test 命令没有运行现有的 packages/opencode/test/lsp/lifecycle.test.ts` | `BLOCK — canonical plan revision R9 is not approved.` | `ses_0981ca463ffeE93E8HcFK1VOMH` |
| 10 | R10 | yes | `B-01 Direct-client completion can cancel the VS Code channel before VS Code’s actual providers publish errors`; `B-02 A single matched pull response is treated as complete while other registered diagnostic sources are still running`; `B-03 Exact document-version correlation is incorrectly elevated to push-diagnostic completion` | None | `BLOCK — canonical plan revision R10 is not approved.` | `ses_09814d15fffeKPeFnc401miRZQ` |
| 11 | R11 | yes | `B-01 Baseline identity omits the dynamic diagnostic-registration scope`; `B-02 A healthy bridge always terminates at a fixed hard deadline instead of using an adaptive event-driven completion`; `B-03 The real probe pre-opens the fixture and does not prove zero-tab diagnostics for a fresh unopened erroneous file` | Audit verdict details were retained in the session audit result but not administratively recorded before this revision. | `BLOCK — canonical plan revision R11 is not approved.` | independent plan-audit result retained in session context; exact invocation reference unavailable after context compaction |
| 12 | R12 | yes | `B-01 The first useful VS Code error truncates reachable later provider diagnostics`; `B-02 IncomingMessage close is not a caller-disconnect signal`; `B-03 The existing two-second outer transport deadline can preempt the proposed bridge terminal` | `N-01 The timeout regression flag is named opposite to its assertion`; `N-02 The plan exceeds the preferred file count but remains within the user-authorized range`; `N-03 The clean-room harness currently accepts pending, but R12 plans to modify it` | `BLOCK — canonical plan revision R12 is not approved.` | `ses_0961e6902ffek4FSv4oseDg78F` |
| 13 | R13 | yes | `No blocking findings.` | None. | `APPROVE` | `ses_0960d6d1dffehNEBA5lCDVGL0t` |

R13 resolves the R12 findings in the owning primary path. Generic observation
no longer terminates on first error and retains all waves through its bounded
four-second terminal; fresh TypeScript uses the three named command-completion
signals and stale-hidden remains explicit. HTTP cancellation uses request
aborted plus response close-before-writable-ended rather than normal request
close. The OpenCode LSP call uses a five-second outer timeout so it cannot
preempt the SDK terminal, while unrelated bridge defaults remain unchanged.
R13 remains at 13 files and below 2,000 implementation, test, and comment lines.
R12 remains unapproved. Independent full-scope audit of exact R13 returned
`No blocking findings.` and `APPROVE`.

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

Not applicable before approval.

### Red-Green Test Evidence

Not applicable before approval.

### Verification Commands and Results

Not applicable before approval.

### Original Feedback-Loop Result

Not applicable before approval.

### Actual Secondary and Replacement Path Inventory

Not applicable before approval.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | N/A | No implementation permitted. |
| Qualifying Chinese comment lines `C` | N/A | No implementation permitted. |
| Ratio `C / E` | N/A | N/A before implementation. |
| Required minimum `C` | N/A | N/A before implementation. |

### Remaining Unverified Items

Implementation and post-approval verification are intentionally unperformed.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| pending | N/A | pending | pending | pending | pending | pending |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

## R15 Active Specification

This addendum is the active canonical specification for Revision R15. It was
added after the R13 approval because the user added a stricter requirement:
the edit result must be synchronous, complete, unique, and real within one
second, with no pending/empty success result. R13's generic four-second
observation design is therefore superseded and is retained above only as audit
history.

### R15.1 Verbatim Delta Requirement

The active requirements are:

> 我不希望整体来说存在异步返回,也不希望存在那些说未完成我返回一个没有完成,或者返回一个空。理论上要返回一个准确的、唯一的、真实的值,不能进行异步返回,同时也不能操作时间大于一秒钟。

> 有的项目比较大,有的项目比较小,有的项目可能几万个文件,如果全部都进行预热的话也不现实。

> 我希望LSP能够准确地、适当地利用一些钩子或者等等事件,使得相应的LSP整体不需要直接等一个固定的时间。

These requirements do not authorize a fallback success path. They require a
provider-owned completion terminal or a hard failure.

### R15.2 New Evidence Matrix

| Provider | Terminal owned by provider | Result |
| --- | --- | --- |
| Pyright 1.1.408 | Full `textDocument/diagnostic` response | 20,001-file Project: first 665 ms, then 2-10 ms; 12/12 under 1 s. |
| Ruff 0.15.21 | Full `textDocument/diagnostic` response | 20,001-file Project: max 22 ms; 12/12 under 1 s. OpenCode needs a Ruff owner. |
| TypeScript server 5.3.0 | All three public `typescript.tsserverRequest` diagnostics commands | 20,002-file Project: warm-up 3,862 ms; after warm-up max 84 ms; 12/12 exact. |
| ESLint 3.0.24 | Full `textDocument/diagnostic` response | 20,001-file Project: max 216 ms; 12/12 exact. |
| clangd 17 | Full push with `publishDiagnostics.version === didChange.version` | 12/12 exact; max 64 ms. |
| JDT LS 1.59 | `java.project.refreshDiagnostics` plus next normalized target publication | 12/12 exact; max 76 ms. |
| rust-analyzer 0.3.2971 | `experimental/serverStatus` `ok/quiescent`, then full pull | Readiness 4.7-10.9 s; after readiness 12/12 exact; max 12 ms. |
| VS Code aggregate/Pylance/Ruff events | URI-only aggregate event | No all-provider terminal; observed only, never strict clean. |

The 20,000-file fixtures are in the Project tree. They are not opened in tabs
and no workspace diagnostic request is used. The evidence proves that process
and Project readiness must be separated from current-file edit latency.

### R15.3 Current Divergence and Owner

The first divergence is the completion interface, not parser availability:

1. `sdks/vscode/src/lsp.ts` calls `showTextDocument`, then resolves on the first matching URI event or timeout.
2. `packages/opencode/src/lsp/lsp.ts` treats a bridge as a successful replacement for direct clients and reads a separate aggregate snapshot.
3. `packages/opencode/src/lsp/client.ts` returns after one pull result, discards timeout/source qualification, and suppresses the first-push wake-up.
4. Write/Edit/Apply Patch capture baseline after mutation or infer it from operation labels.

The owning repair is one coordinator at the LSP service/client boundary. It
must not be repaired by adding another aggregate reader or a retry after the
bridge fails.

### R15.4 Active Invariants

| ID | Active invariant | Evidence |
| --- | --- | --- |
| R15-INV-01 | A successful Tool output contains one complete current diagnostic result; no pending, partial, or false-empty success is possible. | User requirement and direct benchmarks. |
| R15-INV-02 | Completion is the provider request/version/command terminal; a fixed quiet period is never completion. | Pyright/Ruff/ESLint pull, clangd version, JDT command, Rust status evidence. |
| R15-INV-03 | The strict edit budget is one second; timeout, stale source, provider failure, or readiness failure is a hard Tool error. | User requirement and timeout reproduction. |
| R15-INV-04 | The target document contents and source identity match the result. | TypeScript stale hidden buffer and dynamic registration evidence. |
| R15-INV-05 | Diagnostics never alter active editor, visible editor, or tab groups. | Zero-tab Extension Host matrix. |
| R15-INV-06 | Provider process existence and provider readiness are separate. | Rust early-empty benchmark. |
| R15-INV-07 | Baseline precedes mutation, uses actual existence, and matches current provider identity. | 8/8 baseline race and Apply Patch Add/move paths. |
| R15-INV-08 | Only direct provider terminals or recognized versioned/command-scoped push terminals are authoritative. | VS Code stable API boundary. |
| R15-INV-09 | Every required source in the captured provider scope completes before the scope completes. | Existing slow-identifier test and protocol matrix. |
| R15-INV-10 | Warm/read/navigation starts current-file providers only and does not become strict diagnostic output. | Read warm path and large Project evidence. |
| R15-INV-11 | Severity participates in diagnostic identity. | Warning-to-error reproduction. |
| R15-INV-12 | A healthy bridge stays transport-healthy when strict analysis fails; it is not reported as a false clean or an unexplained unavailable state. | User sweet-spot requirement. |

### R15.5 Single Primary Path

```text
read/first contact
  -> discover applicable providers for the current file
  -> share one per-Project client/process
  -> background warm the current document and provider readiness

write/edit/apply_patch
  -> check actual existence
  -> obtain completed pre-mutation baseline with source identity
  -> perform the existing filesystem mutation
  -> send current didChange to all required providers
  -> run one parallel provider coordinator with a 1,000 ms deadline
  -> await every provider-specific terminal
  -> return one complete scoped diagnostic result immediately
  -> otherwise return one hard diagnostic error, never pending/empty success
```

The required provider strategies are:

- Pyright, Ruff, and ESLint: full pull response, where explicit empty `items` is a real clean result.
- TypeScript: all three public `workspace/executeCommand` calls for `semanticDiagnosticsSync`, `syntacticDiagnosticsSync`, and `suggestionDiagnosticsSync`.
- clangd: versioned full `publishDiagnostics` matching the sent document version.
- JDT LS: `java.project.refreshDiagnostics` followed by request-local full publication for the normalized URI.
- rust-analyzer: `experimental/serverStatus` `health=ok, quiescent=true` before pull.

Pylance and generic VS Code aggregate diagnostics are retained as observation
data only. They cannot authorize a clean/baseline/delta claim because stable
VS Code exposes no provider identity or all-provider completion.

### R15.6 Readiness and Large Project Behavior

Read warm-up is detached and current-file-only. It starts the relevant server,
sends `didOpen`, and lets the provider build its Project/configuration state in
the background. It never walks 20,000 files and never adds a visible tab.

The first strict edit shares this client and waits only until the shared
one-second deadline. If a provider is still cold, the edit returns a hard LSP
diagnostic error. A later edit after readiness returns as soon as the provider
terminal resolves. This is the only way to meet both the large-Project and
one-second requirements without lying about completion.

Provider configuration errors, including Ruff's observed directory-as-config
failure, are represented as provider failure. An initialized process is not a
clean provider.

### R15.7 Zero-Tab VS Code Contract

`sdks/vscode/src/lsp.ts` changes diagnostics refresh to use hidden
`openTextDocument` only. It registers request-local listeners before opening,
normalizes paths, and disposes listeners at completion/abandonment/deadline.
`showTextDocument` is removed from the diagnostic path. The bridge may expose
the three advertised TypeScript diagnostic commands, but no private tsserver
IPC or hidden reopen/reload fallback is allowed.

`onDidChangeDiagnostics` can record evidence but cannot be the strict terminal.
The generic bridge-only path fails hard at the one-second boundary if no
provider-specific terminal exists.

### R15.8 Mutation and Baseline Contract

Write/Edit capture a completed baseline before mutation. Apply Patch checks
filesystem existence before interpreting Add, carries a source baseline across
moves, and audits all changed targets concurrently under one deadline.

The current filesystem mutation contract is preserved. If the post-mutation
audit times out or fails, the Tool returns a hard diagnostic error and does not
render a success confirmation or clean summary. Automatic rollback is not part
of R15 because no transaction contract currently owns it; adding one would be
a separate design rather than a hidden fallback.

### R15.9 Secondary Path Classification

| Path | Classification | Active decision |
| --- | --- | --- |
| Direct pull/versioned push/JDT command terminals | Primary-contract branches | Implement. |
| Hidden bridge open and navigation warm | Pass-through within primary contract | Preserve, no diagnostic success by itself. |
| Generic VS Code aggregate observation | Diagnostic path | Preserve only as non-authoritative evidence. |
| Timeout/provider/readiness error | Diagnostic failure | Implement hard failure. |
| Typecheck/lint command | Forbidden alternate success | Reject. |
| Quiet delay/first event/timeout clean | Workaround | Delete. |
| Retry through another provider after primary failure | Forbidden fallback | Reject. |

New diagnostic branches are estimated at 8 of approximately 120 changed
decision branches, 6.7%, below the 10% diagnostic budget. There is no new
alternate success path.

### R15.10 Active File Plan

| File | Responsibility |
| --- | --- |
| `packages/opencode/src/lsp/client.ts` | Typed provider terminal, source-set join, version/push handling, TypeScript/JDT commands, cancellation. |
| `packages/opencode/src/lsp/lsp.ts` | Single coordinator, applicability/readiness, warm/audit intents, direct authoritative scope, baseline/current result. |
| `packages/opencode/src/lsp/server.ts` | Ruff owner and provider strategy/readiness metadata. |
| `packages/opencode/src/lsp/diagnostic.ts` | Severity-aware identity and complete scoped wording. |
| `packages/opencode/src/tool/write.ts` | Pre-mutation baseline and hard-failure output. |
| `packages/opencode/src/tool/edit.ts` | Pre-mutation baseline and hard-failure output. |
| `packages/opencode/src/tool/apply_patch.ts` | Actual existence, move identity, multi-file audit. |
| `packages/opencode/src/tool/lsp.ts` | Warm intent for navigation. |
| `packages/opencode/src/cli/cmd/debug/lsp.ts` | One typed audit result, no aggregate second read. |
| `sdks/vscode/src/lsp.ts` | Zero-tab hidden open and provider-specific bridge terminal. |
| `sdks/vscode/src/bridge.ts` | True abandonment and finite audit cancellation. |
| `packages/opencode/test/lsp/client.test.ts` | Protocol terminal/readiness/source tests. |
| `packages/opencode/test/lsp/index.test.ts` | Service coordinator/applicability/warm tests. |
| `packages/opencode/test/lsp/lifecycle.test.ts` | Severity and wording tests. |
| `packages/opencode/test/tool/lsp.test.ts` | Public Tool baseline/output/error integration tests. |
| `.temp/testing/vscode-clean-room-probe.ts` | Zero-tab and direct command assertions. |

Expected substantive total is approximately 1,338 lines: 720 production, 430
tests, and 188 qualifying Chinese explanatory comments. The file count is 16
because the existing ownership seams are separate; no new production module or
dependency is justified.

### R15.11 TDD Slices

1. Make timeout/provider failure return a hard error instead of successful clean.
2. Make a fast provider terminal return before the deadline without sleeping.
3. Join every dynamic pull source and include the slow source's diagnostics.
4. Unify first-push cache update and waiter publication.
5. Require Rust `ok/quiescent` before accepting a pull result.
6. Require clangd matching version and JDT normalized request-local publication.
7. Require all three TypeScript diagnostic commands and ESLint pull where applicable.
8. Prove hidden VS Code diagnostics preserve active editor and tab groups.
9. Capture baseline before mutation and fix Add overwrite/move identity.
10. Include severity in delta identity and separate bridge transport health.
11. Re-run exact alternating error/clean probes for Python, TypeScript, JavaScript, Java, C++, and Rust.

Each slice must fail at the public seam before its production change, use
independent expected values, and avoid private-method/source-text assertions.

### R15.12 Verification Commands

| Command | Directory | Proof |
| --- | --- | --- |
| `bun test test/lsp/client.test.ts test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/tool/lsp.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts` | `packages/opencode` | Public LSP/Tool behavior and provider coordination. |
| `bun typecheck` | `packages/opencode` | Core types. |
| `bun run check-types` | `sdks/vscode` | SDK types. |
| `bun run lint` | `sdks/vscode` | SDK lint. |
| `bun run compile` | `sdks/vscode` | Fresh SDK bundle before host tests. |
| `bun .temp/testing/lsp-pull-diagnostics-benchmark.ts` | repository root | Pyright/Ruff large Project. |
| `bun .temp/testing/typescript-direct-diagnostics-benchmark.ts` | repository root | TypeScript readiness and warm direct completion. |
| `bun .temp/testing/eslint-pull-diagnostics-benchmark.ts` | repository root | ESLint pull completion. |
| `bun .temp/testing/clangd-versioned-diagnostics-benchmark.ts` | repository root | clangd version completion. |
| `bun .temp/testing/jdtls-diagnostics-barrier-benchmark.ts` | repository root | JDT command/push completion. |
| `bun .temp/testing/rust-analyzer-pull-diagnostics-benchmark.ts` | repository root | Rust readiness/pull completion. |
| `bun .temp/testing/vscode-clean-room-probe.ts typescript warmSeries 1000` | repository root | TypeScript zero-tab host behavior. |
| `bun .temp/testing/vscode-clean-room-probe.ts python warmSeries 1000` | repository root | Python zero-tab host behavior. |

### R15.13 Comment and Risk Gate

For effective changed code `E=1,250`, the minimum qualifying Chinese
explanatory comments is `ceil(1,250*0.15)=188`. Comments must explain the
non-obvious completion, readiness, URI normalization, zero-tab, source-set,
baseline, severity, and hard-failure invariants; comments that restate syntax
do not count.

Real risks are cold readiness, provider configuration failure, dynamic source
identity changes, versionless JDT pushes, and the existing post-mutation
filesystem contract. These are handled by explicit readiness, source identity,
command/version barriers, or hard failure. No user decision remains.

### R15.14 Audit Contract and Release Gate

The independent auditor must read the original requirement, this canonical file,
and the repository. The handoff must contain only the original requirement,
canonical path, repository root, and `Audit mode: plan`. The auditor must check
the complete original scope, not only this addendum, and require evidence for
every blocking finding.

R15 is not approved. Implementation is forbidden until the exact R15 receives
an independent full-scope `No blocking findings.` and `APPROVE`. Any substantive
finding increments the revision, clears approval, and requires another
full-scope audit.

## R16 Active Specification

R16 supersedes R15 where they conflict. It resolves the independent R15 audit
blockers without adding a fallback success path.

### R16.1 Audit Findings Being Resolved

The independent R15 audit returned `BLOCK` with these exact blocking findings:

- `B-01 The plan does not satisfy the required one-second complete-result contract`.
- `B-02 TypeScript and Java completion strategies have no executable owner in the production path`.

The audit also recorded non-blocking metadata drift in file count, effective
line estimate, and the lack of a dedicated SDK test command. These are corrected
in this addendum.

### R16.2 Cold Readiness Is an Edit Precondition

The evidence proves a hard physical boundary: TypeScript Project readiness took
3,862 ms and rust-analyzer readiness took 4,706-10,934 ms, while warm current-
file diagnostics stayed below one second. It is impossible to both analyze a
cold Project completely and return that result within one second without
returning false or incomplete diagnostics.

R16 therefore changes the mutation contract at the owning Tool/LSP seam:

```text
write/edit/apply_patch
  -> prepareForEdit(file or files)
  -> start only applicable provider processes and readiness work
  -> if required providers are not ready, fail before filesystem mutation
  -> if ready, capture baseline and mutate
  -> run current diagnostics with a total 1,000 ms audit deadline
  -> return the complete result or a hard diagnostic error
```

The precondition failure is not a successful edit result, not `pending`, not an
empty diagnostic result, and not a claim that LSP is unavailable. It means the
Tool did not perform the requested mutation because the only truthful one-
second contract was not available. `read` and navigation warm-up remain the
normal way to make this precondition ready; warm-up starts only the current
file's applicable providers and never opens all Project files.

Once `prepareForEdit` reports ready, every mutation that proceeds has a complete
current diagnostic result within one second or returns a hard error. No edit is
allowed to write first and discover after the fact that cold analysis exceeded
the deadline. This is the single primary path, not a failure-triggered retry.

### R16.3 Direct TypeScript Owner

The authoritative TypeScript path does not depend on VS Code contributed
commands. `packages/opencode` launches the cached `typescript-language-server`
5.3.0. That direct LSP server advertises `workspace/executeCommand` with the
public command `typescript.tsserverRequest`; its production bundle implements
the request and accepts `semanticDiagnosticsSync`,
`syntacticDiagnosticsSync`, and `suggestionDiagnosticsSync`.

`packages/opencode/src/lsp/client.ts` is the owner:

```text
direct typescript-language-server connection
  -> workspace/executeCommand
  -> typescript.tsserverRequest(command, { file: uri })
  -> require all three successful responses
  -> map the current file diagnostics into the authoritative scope
```

The VS Code SDK's installed extension command remains an optional observed
probe only. It is not used for the direct authoritative baseline or delta.

### R16.4 Direct Java Owner

The authoritative Java path also uses the direct process already launched by
`packages/opencode/src/lsp/server.ts`. JDT LS advertises
`java.project.refreshDiagnostics` in its `executeCommandProvider`; the direct
LSP connection can send the standard `workspace/executeCommand` request.

`packages/opencode/src/lsp/client.ts` is the owner:

```text
direct JDT LS connection
  -> arm normalized request-local publishDiagnostics listener
  -> workspace/executeCommand(java.project.refreshDiagnostics, [uri, thisFile, false, true])
  -> require the command response and the next full publication for uri
  -> merge that publication as the authoritative current-file result
```

The publication has no version field, so the command and request-local URI
boundary are both required. Raw URI strings are normalized before matching.
The VS Code Java extension is not required for this path.

### R16.5 Provider Matrix and Precondition

| Provider | Prepare gate | Edit-time terminal |
| --- | --- | --- |
| Pyright | initialized client and current-file open | full `textDocument/diagnostic` report |
| Ruff | initialized client, valid configuration, current-file open | full `textDocument/diagnostic` report |
| TypeScript | initialized direct TLS plus all three command requests can be scheduled | all three `typescript.tsserverRequest` responses |
| ESLint | initialized client and valid config/library | full `textDocument/diagnostic` report |
| clangd | current document opened | `publishDiagnostics.version === didChange.version` |
| JDT LS | initialized service and request command available | refresh command plus normalized full publication |
| rust-analyzer | `experimental/serverStatus` health `ok`, `quiescent=true` | full `textDocument/diagnostic` report |

Optional built-in providers that return no handle are absent. Explicitly
configured providers that fail preparation remain hard failures. A process that
exists but has not crossed its gate cannot contribute an empty clean result.

### R16.6 Zero-Tab and Bridge Scope

`showTextDocument` remains removed from every diagnostic path. The VS Code bridge
uses hidden `openTextDocument` for warm/navigation and request-local event
observation. Stable VS Code aggregate diagnostics remain non-authoritative. The
strict edit path uses direct providers for the authoritative scope; a bridge
cannot replace them after a direct failure.

The bridge still has a finite cancellation boundary for callers and records
observed provider events, but it never returns pending/partial/empty success.
Its generic provider-only path fails the edit precondition or strict audit
instead of claiming clean.

### R16.7 Baseline and Mutation

Baseline capture occurs only after `prepareForEdit` succeeds and before any
filesystem mutation. It uses actual target existence. Add-overwrite uses a real
baseline; absent Add uses an explicit empty baseline. Move maps the source
baseline to the destination by logical operation identity. Baseline and current
authoritative provider/source sets must be equal before delta wording is
allowed.

The filesystem mutation is not rolled back on a later diagnostic error because
rollback is not an existing Tool transaction contract. The Tool returns a hard
error and no success output; the user-visible result never pretends that the
edit was checked when it was not.

### R16.8 Corrected Scope and Budget

The active file plan has 16 existing files: 11 production owners, 4 package
test owners, and 1 temporary Extension Host harness. The effective code-line
estimate is `E=1,150` (720 production plus 430 test code; comments are excluded
from `E`). The required qualifying Chinese comment minimum is
`ceil(1,150*0.15)=173`; the budgeted 188 comments exceed that minimum. The
implementation must recompute actual `E` and `C`; it may not copy the older
1,250/188 estimate.

The SDK behavioral seam is the isolated Extension Host probe. Verification must
include a dedicated command that exits non-zero for active-editor changes,
target tabs, first-event/timeout success, stale results, or missing direct
TypeScript completion. SDK `check-types`, lint, and compile remain additional
checks rather than the behavioral proof.

### R16.9 Audit Gate

R15 is recorded as blocked and unapproved:

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | R15 | yes | `B-01 The plan does not satisfy the required one-second complete-result contract`; `B-02 TypeScript and Java completion strategies have no executable owner in the production path` | Revision metadata contains internally inconsistent file-count claims; the `E` estimate is inconsistent across the active addendum; verification plan lacks a dedicated `sdks/vscode` test command. | `BLOCK` | `ses_0954878f1ffeE4MTH35zgS4v9g` |

R16 is the exact current revision and
remains `audit-required` with implementation disallowed. A new independent
full-scope audit must verify both the original requirement and these corrections.
Only an exact R16 result containing `No blocking findings.` and `APPROVE` may
change the metadata to `Status: approved`, `Approved revision: R16`, and
`Implementation allowed: yes`.

## R17 Active Specification

R17 supersedes R16 where they conflict and resolves the three blocking findings
from the independent R16 audit.

### R17.1 Audit Findings Being Resolved

The independent R16 audit returned `BLOCK` with these exact blocking findings:

- `B-01 TypeScript preparation checks schedulability, not provider readiness`.
- `B-02 The one-second budget is applied only to post-mutation diagnostics`.
- `B-03 A first matching clangd push is not a provider completion terminal`.

The R16 audit invocation was `ses_09543d6c6ffeUcNwDWdaINJBwM`.

### R17.2 TypeScript Readiness Is a Completed Warm Terminal

`prepareForEdit` must not treat initialized `typescript-language-server`, an
open document, or schedulable requests as ready. For a TypeScript/JavaScript
file, readiness is true only after the direct server has completed all three
current-file commands:

```text
typescript-language-server initialize
  -> didOpen current file
  -> semanticDiagnosticsSync response
  -> syntacticDiagnosticsSync response
  -> suggestionDiagnosticsSync response
  -> all three successful responses stored as ready for this file content
```

`read` warm-up performs this terminal in its detached per-Project client before
the normal edit path. The edit path only checks the stored completed terminal;
it never starts a cold 3.8-second warm-up and then mutates. If the terminal is
not ready at edit entry, the mutation Tool fails before any filesystem write.
The failure is a precondition failure, not a pending or empty diagnostic result.

The ready record includes normalized path, content hash, provider identity, and
the TypeScript project root. A changed file or changed project invalidates it.

### R17.3 One End-to-End Deadline

The mutation Tool creates one deadline at public Tool entry:

```text
deadline = toolEntry + 1,000 ms
```

That same deadline is passed through:

1. ready-state validation and source-scope capture;
2. completed pre-mutation baseline acquisition;
3. filesystem/formatter work that must precede diagnostic notification;
4. current-document notification;
5. all provider terminal requests and result aggregation.

No phase creates a new independent one-second timer. If the ready precondition
is false, the Tool rejects before mutation rather than spending the deadline on
cold startup. If the baseline/current chain exhausts the shared deadline, the
Tool returns a hard diagnostic error and never renders success, clean, pending,
or a partial array. The public Tool integration tests measure the entire chain,
not only an individual provider request.

The deadline is a maximum wait guard, not a sleep. A complete 40 ms chain
returns at approximately 40 ms.

### R17.4 clangd Provider-Owned Completion

clangd's matching `publishDiagnostics.version` is necessary but not sufficient.
The direct client must use the clangd extension contract:

```text
initialize(initializationOptions.clangdFileStatus = true)
  -> didChange(version, wantDiagnostics = true)
  -> request-local fileStatus for the target reaches state "idle"
  -> request-local publishDiagnostics has the same version
  -> full diagnostic result is complete
```

The clangd protocol documentation states that `wantDiagnostics: true` requests
diagnostics for exactly that file version, while `textDocument/clangd.fileStatus`
reports the per-file worker activity. The client requires both events after the
request boundary. A first matching push without the idle/status barrier is
observed only and cannot qualify clean or baseline.

The corrected 12-round benchmark used the same protocol and completed every
error/clean round under one second, maximum 24 ms, in
`.temp/testing/clangd-versioned-diagnostics-benchmark.ts` output
`result-1784202551830.json`.

### R17.5 Active Provider Table

| Provider | Readiness terminal | Edit completion terminal |
| --- | --- | --- |
| Pyright | initialized client plus current-file open | full pull report |
| Ruff | initialized client plus valid configuration/current-file open | full pull report |
| TypeScript | all three direct diagnostic command responses for current hash | all three responses for post-change hash |
| ESLint | initialized client plus valid config/library | full pull report |
| clangd | initialized file worker | `wantDiagnostics=true` + request-local idle + matching-version full push |
| JDT LS | service ready | refresh command + normalized request-local full push |
| rust-analyzer | `health=ok` and `quiescent=true` | full pull report |

VS Code aggregate/Pylance/Ruff events remain observation-only. They cannot
replace any terminal in this table.

### R17.6 Baseline and Mutation Ownership

Write/Edit/Apply Patch pass the shared deadline into the LSP baseline/current
coordinator. Baseline is captured before mutation and includes actual existence,
provider strategy, normalized source identity, content hash, and remaining
deadline. Add-overwrite and move behavior remain as specified in R16.

The current filesystem mutation contract remains unchanged: a later hard
diagnostic error does not silently roll back the file, but no success-shaped
output claims that the file was checked. A cold provider is rejected before
mutation, so the known TypeScript cold-start defect cannot leave a newly changed
file behind with a misleading clean result.

### R17.7 TDD Additions

Add these public behavior slices before implementation:

- Cold TypeScript `prepareForEdit` returns precondition failure and Write/Edit/Apply Patch do not modify the target.
- Warm TypeScript preparation stores all three completed command responses and permits the mutation path.
- A single shared one-second deadline covers baseline plus current diagnostics; a fake provider that makes the combined chain exceed it returns hard error without clean output.
- clangd first matching versioned push without `fileStatus=idle` does not complete; `wantDiagnostics=true` plus idle plus matching version completes.
- The public Tool test records total elapsed time from Tool entry, not only provider request time.

### R17.8 Corrected Budget and Verification

The active estimate remains `E=1,150` effective code/test lines and `C=188`
qualifying Chinese explanatory comments, exceeding the required
`ceil(1,150*0.15)=173`. The actual implementation must recalculate both.

In addition to the existing package checks and provider benchmarks, the SDK
behavioral verification command must be explicit:

```sh
bun .temp/testing/vscode-clean-room-probe.ts typescript warmSeries 1000
bun .temp/testing/vscode-clean-room-probe.ts python warmSeries 1000
```

The command is behavioral evidence because it exits non-zero for target tabs,
active-editor changes, stale results, missing TypeScript command completion, or
timeout-as-success. The package-local SDK checks remain type/lint/build gates.

### R17.9 Release Gate

R16 remains blocked and unapproved. R17 is the exact current revision,
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. A new independent full-scope audit must inspect
the original requirement plus all R17 corrections. Only an exact R17 result of
`No blocking findings.` and `APPROVE` can authorize implementation.

## R18 Active Specification

R18 supersedes R17's mutation precondition behavior in response to the user's
latest explicit clarification:

> 如果LSP的provider在一秒之内没有启动的话,那理论上来说,即便没有ready也只能改文件,因为整体我们不希望去拖太久我们的文件编辑。那个时候可能只是表示说这个LSP就是要么是incomplete或者是什么都行,但是尽量避免这种情况,也就是不要因为LSP超时而阻塞过久我们的文件编辑。

### R18.1 Edit Must Not Be Blocked by Provider Readiness

Provider readiness is no longer a mutation precondition. The primary path is:

```text
Tool entry
  -> start applicable provider warm-up without waiting for readiness
  -> use the latest exact completed baseline if available; otherwise mark baseline incomplete
  -> apply the requested filesystem edit without waiting for provider startup
  -> send current contents to providers that are available
  -> wait at most one shared 1,000 ms diagnostic budget
  -> complete result if every required provider terminal finishes
  -> otherwise return edit-applied + diagnosticState=incomplete
```

The edit itself is never rejected merely because a provider is cold, still
loading, or absent from the one-second terminal. The Tool must not say that the
file is clean in this state. It returns a synchronous typed incomplete result
that explains that the edit was applied but this attempt did not obtain a
complete LSP report. It does not return `pending`, an empty diagnostic array,
or a later asynchronous continuation in the current output.

This is not a fallback success algorithm. There is one mutation path and one
diagnostic coordinator with two terminal states: `complete` and `incomplete`.
`incomplete` is an explicit non-clean outcome permitted by the user's latest
clarification; it never authorizes baseline delta, clean wording, or a claim
that no errors exist.

### R18.2 Shared One-Second Diagnostic Budget

The shared deadline starts when the Tool begins the edit's LSP audit work and
covers baseline lookup, current provider requests, and result aggregation. The
filesystem mutation is not held behind readiness. If a completed exact baseline
is already cached for the current pre-mutation content, it is used immediately.
If no exact baseline exists, the coordinator records `baseline=incomplete` and
does not delay the edit to manufacture one.

After mutation, all available required provider terminals run in parallel until
the same deadline. A provider that becomes ready and completes before the
deadline contributes to the complete result. A provider that does not complete
does not block the file edit beyond the deadline and does not produce a partial
success result.

The public Tool result has this shape conceptually:

```text
edit applied
diagnosticState: complete | incomplete
diagnostics: present only for complete
delta: present only when complete baseline/current source identities match
```

For `incomplete`, output names the provider/readiness/timeout reason and says
that no clean conclusion was made. It does not tell the model to run a second
LSP call as part of the same result and does not silently replace LSP with a
shell command.

### R18.3 TypeScript Warm-Up

The R17 correction remains for readiness semantics: schedulability is not
readiness. The TypeScript warm record is created only after all three direct
`typescript.tsserverRequest` commands complete successfully for the current
file hash. However, mutation no longer waits for that record. `read` warm-up
still performs it in the background so normal later edits are complete and
fast. A cold mutation may return `diagnosticState=incomplete` after one second,
while the file edit itself is already applied.

### R18.4 clangd Completion

The R17 clangd correction remains active. The direct client sends
`wantDiagnostics=true`, enables `clangdFileStatus`, and requires both the
request-local `fileStatus=idle` and matching-version full publication for
`complete`. If either terminal misses the shared deadline, the mutation remains
applied and the result is `incomplete`, never false clean.

### R18.5 Baseline and Delta Semantics

An incomplete baseline cannot be used to classify new versus existing errors.
An incomplete current result cannot be used to classify delta. The Tool still
stores any exact complete cached baseline for future use, but it omits
`diagnosticSummary` and new-error metadata from an incomplete result rather
than guessing.

Actual existence continues to control empty baseline for a new file. Add
overwrite and move source identity remain as specified in earlier active
revisions, but they only produce delta output when the complete source scope
matches before and after mutation.

### R18.6 Zero-Tab and Provider Scope

No change: `showTextDocument` remains forbidden. Hidden `openTextDocument`,
direct LSP clients, provider-specific request terminals, and normalized path
correlation remain the only supported mechanisms. VS Code aggregate events and
Pylance/Ruff push waves remain observed-only and cannot turn `incomplete` into
complete.

### R18.7 TDD Changes

Add or revise public behavior tests for:

- Cold TypeScript provider: mutation is applied, returns `diagnosticState=incomplete` within the one-second budget, and emits no clean/empty success.
- Cold Rust/JDT/Pyright or invalid Ruff configuration: same edit-applied/incomplete behavior, with provider reason.
- Warm TypeScript and Python: all required terminals complete and result is `complete` without waiting a fixed delay.
- A slow provider does not block filesystem mutation beyond the shared one-second diagnostic budget.
- Incomplete baseline/current results omit delta and diagnostic summary.
- clangd requires `wantDiagnostics=true`, idle status, and matching version for complete.
- Zero-tab invariants remain true for both complete and incomplete bridge observations.

### R18.8 Requirement Reconciliation

The earlier “no incomplete result” wording was superseded by the latest user
clarification. The active rule is narrower and explicit:

- no incomplete **clean/success diagnostic claim**;
- incomplete is allowed as a synchronous diagnostic state when the edit must
  proceed;
- the edit must not wait beyond the one-second diagnostic budget for readiness;
- no asynchronous follow-up is appended to the current Tool output.

This is the only way to satisfy the latest “must edit even without ready” rule
without reproducing the original false-clean defect.

### R18.9 Release Gate

R17 is superseded before approval. R18 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. It requires a new independent full-scope audit
covering the original requirement and the R18 edit-applied/incomplete contract.
Only an exact R18 `No blocking findings.` and `APPROVE` result may authorize
implementation.

## R19 Active Specification

R19 resolves the independent R18 audit blocker:

> `B-01 Cached baselines do not account for provider-relevant Project changes`

The R18 audit invocation was `ses_09539a8e6ffetigCYEMHRZfcjB`. The audit
returned `BLOCK`; R19 remains implementation-disallowed until re-audited.

### R19.1 Project Diagnostic Generation

Every cached baseline carries a Project diagnostic generation in addition to:

- normalized target path;
- target content hash and actual existence;
- provider identity and readiness generation;
- complete canonical static/dynamic source identity.

The LSP service owns a per-Project monotonic `diagnosticGeneration`. It
increments when the existing `FileWatcher.Event.Updated` stream reports any
create/change/delete under the Project, and when provider configuration,
readiness, or diagnostic registration changes. The generation is deliberately
Project-wide rather than dependency-graph-specific: conservative invalidation
is cheaper and more truthful than trying to reconstruct each provider's hidden
dependency graph.

The existing watcher is the reachable producer for external and Tool file
changes (`packages/opencode/src/file/watcher.ts:101-103`). Write/Edit/Apply
Patch already publish the same event after mutation. The LSP state subscribes
to it within the per-Project `InstanceState`, so a sibling dependency/config
change invalidates a target baseline even when the target file hash is
unchanged.

### R19.2 Baseline Qualification

```text
cachedBaseline.path == target
cachedBaseline.contentHash == current pre-mutation hash
cachedBaseline.projectGeneration == current diagnosticGeneration
cachedBaseline.providerEpoch == current providerEpoch
cachedBaseline.sourceIdentity == current complete source identity
  -> baseline is qualified for delta

otherwise
  -> baselineState = incomplete
  -> edit still proceeds under R18 edit-first rules
  -> no new/existing/delta/clean classification is emitted
```

A generation change does not block mutation. It only prevents stale baseline
reuse. If a fresh complete baseline cannot be obtained before the shared
one-second budget, the edit returns `diagnosticState=incomplete` and omits
delta metadata. A complete current diagnostic result may still be stored as a
future baseline at the new generation, but it cannot be compared with an old
generation snapshot.

### R19.3 Provider Epoch

`providerEpoch` changes when a required client starts, stops, fails readiness,
changes configuration, or changes its static/dynamic diagnostic source set.
This protects against a stable Project generation with a changed analysis
universe. The source identity remains in the baseline for human-readable
scope, while the epoch gives the coordinator a cheap invalidation boundary.

### R19.4 Required Regression Test

The public LSP/Tool test seam must cover this reachable sequence:

1. Obtain a complete baseline for target `a`.
2. Change sibling dependency/configuration file `b` through the existing file watcher/mutation path.
3. Keep `a`'s content hash unchanged.
4. Edit `a` and verify that the old baseline is rejected because the Project generation changed.
5. Verify the edit is applied, the output is `incomplete` when no fresh baseline fits the deadline, and no stale new/existing classification is emitted.
6. Verify a complete fresh baseline/current pair at the new generation restores delta output.

This test uses the public diagnostic result and Tool output, not a private cache
field. It is independent of whether the provider's hidden dependency graph is
Pyright, TypeScript, Java, C++, Rust, or ESLint.

### R19.5 Active Contract Retained

R18's edit-first timeout contract remains unchanged: cold/not-ready providers
do not block the file edit; complete provider terminals within one second yield
complete diagnostics; otherwise the synchronous result is edit-applied plus
`diagnosticState=incomplete`, with no clean, partial, empty-success, delta, or
asynchronous continuation.

### R19.6 Release Gate

R18 is superseded before approval. R19 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. A new independent full-scope audit must verify
Project-generation invalidation, provider-epoch invalidation, the sibling
dependency regression, and the complete original requirement. Only an exact R19
`No blocking findings.` and `APPROVE` result may authorize implementation.

## R20 Active Specification

R20 resolves the independent R19 audit findings:

- `B-01 Project generation has no causal boundary around the audited mutation`.
- `B-02 The proposed watcher cannot observe external Project changes in the default packages/opencode runtime`.
- `B-03 A stale baseline suppresses a complete current diagnostic result`.

The R19 audit invocation was `ses_09533933fffeqrKuzYVHZk2RDY`. R20 remains
implementation-disallowed until an exact full-scope audit approves it.

### R20.1 Causal Mutation Attempts

Project generation is split into an external-change generation and an active
mutation attempt. The current Tool mutation is not treated as an intervening
external change.

Before Write/Edit/Apply Patch mutates files, it opens one LSP mutation attempt
containing:

- attempt ID;
- expected normalized paths and add/change/unlink operations;
- expected post-mutation content hashes where a target remains;
- pre-attempt external generation.

The existing `FileWatcher.Event.Updated` payload gains an explicit origin and
optional attempt ID. Tool-originated events carry the active attempt ID; native
watcher events carry `origin=external`. The LSP coordinator consumes events as
follows:

```text
tool event with active attempt ID and expected path
  -> expected mutation; do not invalidate the attempt baseline

native event for an expected path with matching post hash
  -> duplicate notification of the same mutation; ignore for this attempt

any event for an unexpected path, operation, attempt, or content hash
  -> intervening Project change; invalidate delta/baseline qualification
```

At attempt completion, the coordinator advances the Project generation once
for the expected mutation set and stores complete current state against the new
generation. Duplicate native events cannot increment it twice for the same
attempt. An unexpected event during the attempt marks `interveningChange=true`
and prevents old baseline use, but does not block the file edit.

This is a causal boundary, not a second diagnostic algorithm. The same current
provider coordinator still produces the only current diagnostic result.

### R20.2 Default External Change Observation

The default runtime must observe external Project changes whenever strict LSP
diagnostic auditing is enabled. The existing watcher currently subscribes to the
Project tree only behind `OPENCODE_EXPERIMENTAL_FILEWATCHER`; that flag cannot be
the correctness prerequisite for baseline invalidation.

The owning change is in `packages/opencode/src/file/watcher.ts`: retain the
existing ignore/configuration rules and native backend, but enable the Project
subscription by default when `cfg.lsp !== false`. The experimental flag may
still explicitly disable or extend the watcher according to its existing
contract, but an enabled LSP service cannot silently run without an external
change signal.

This does not prewarm or analyze files. It subscribes to filesystem events and
lets the LSP coordinator invalidate cached qualification conservatively. If the
native binding/backend cannot be created, the LSP baseline owner records
`externalObservation=incomplete` and refuses to use cross-operation cached
baselines; it still lets the edit proceed under R18.

### R20.3 Independent Current/Baseline/Delta States

The typed result is no longer a single `complete/incomplete` bit:

```text
currentState: complete | incomplete
baselineState: complete | incomplete | absent
deltaState: complete | incomplete | not-applicable
```

Rules:

- `currentState=complete` means every required current provider terminal finished. Current diagnostics are returned exactly, even if baseline is stale or absent.
- `currentState=incomplete` means no current diagnostic array is returned and the result names provider/readiness/timeout reasons.
- `baselineState=complete` requires target hash, provider epoch, source identity, external generation, and causal attempt boundary to match.
- `deltaState=complete` requires both current and baseline complete with equal identity. Only then may new/existing/delta/clean-transition wording be emitted.
- `currentState=complete, baselineState=incomplete` returns current diagnostics and explicitly says new/existing classification was not performed. It never calls current errors “existing” or “new” by guesswork.
- `currentState=complete` with zero current errors may say the current file has no current diagnostics, but it may not say that the edit introduced no new errors when baseline is unavailable.

This preserves the user's edit-first rule while retaining the most accurate
current value available. It does not convert baseline uncertainty into an LSP
unavailable message or hide a complete current error list.

### R20.4 Updated Tool Output Contract

The mutation Tool output has one synchronous result:

```text
edit applied
currentState: complete | incomplete
baselineState: complete | incomplete | absent
currentDiagnostics: present only when currentState=complete
deltaDiagnostics: present only when deltaState=complete
```

For a complete current result with incomplete baseline, output includes the real
current diagnostics (if any) and a short line saying that new/existing
classification is unavailable for this edit. It does not append a second LSP
request or a shell fallback.

### R20.5 Regression Tests

The public Tool/LSP suite must cover:

1. The Tool's own watcher events do not invalidate its pre-mutation baseline.
2. A duplicate native watcher event for the same post hash does not create a second generation.
3. An external sibling/configuration event invalidates the baseline in the default runtime with no experimental flag.
4. An unexpected event during the mutation attempt suppresses delta but does not block the file edit.
5. A complete current error result is returned even when baseline is stale/incomplete.
6. A current clean result with incomplete baseline does not claim “no new errors introduced.”
7. A complete fresh baseline/current pair restores exact delta classification.
8. The 20,000-file Project remains current-file/event driven and does not scan every file.

### R20.6 Historical File and Budget Update

R20 added the existing `packages/opencode/src/file/watcher.ts` as an owner because
the default external-change producer had to be corrected at its source. The
superseded R20 draft listed 17 modified existing files. Its planning estimate
was:
`E=1,220` effective production/test lines and `C=190` qualifying Chinese
explanatory comments; the required minimum is `ceil(1,220*0.15)=183`. The
implementation must recalculate actual values and remain below 2,000 total
substantive lines where feasible.

### R20.7 Historical Release Gate

R19 was superseded before approval. R20 was also superseded before approval by
R21. The exact current release gate is defined only by R21. No R20 audit result
authorizes implementation.

## R21 Active Specification

R21 supersedes the R20 active addendum and resolves the independent R20 audit
findings while keeping one coordinator, the edit-first contract, zero visible
tabs, and the existing owner seams. The R20 audit invocation was
`ses_09529c248ffe2InXtUi5sMedZW`; R21 remains implementation-disallowed until
an exact full-scope audit approves it.

### R21.1 Known-Empty Baseline

Confirmed target absence is an authoritative empty baseline, not an unknown
baseline. The result keeps the distinction explicit:

```text
currentState: complete | incomplete
baselineState: complete | incomplete | absent
baselineAuthority: existing | known-empty | unavailable
deltaState: complete | incomplete | not-applicable
```

`baselineState=absent` is emitted only when the mutation owner observed that the
logical target did not exist before the transaction and therefore means
`baselineAuthority=known-empty`. Unknown or stale cache absence is
`baselineState=incomplete` with `baselineAuthority=unavailable`.

`deltaState=complete` requires `currentState=complete` and either:

- `baselineState=complete` with matching target/provider/source/generation
  identity; or
- `baselineState=absent` with `baselineAuthority=known-empty` and the same
  logical target identity.

Thus a newly created file can report every current diagnostic as introduced by
the edit, while a missing cached baseline can never be silently treated as an
empty file.

### R21.2 Watcher Observation Boundary

`FileWatcher.Interface` exposes a truthful per-Project observation state instead
of only `init(): Effect<void>`:

```text
observation: ready | unavailable
epoch: number
sequence: number
```

The Project subscription is awaited by the FileWatcher instance-state owner.
`init()` returns `ready` only after the native subscription is established;
unsupported backend, missing binding, subscription failure, and subscription
timeout return `unavailable` and advance the observation epoch. Bootstrap may
still initialize services concurrently, but LSP baseline qualification reads
this state at the boundary rather than assuming that a forked subscription has
started.

A cached baseline stores the observation epoch and sequence. It is qualified
only when observation was `ready` before the baseline was captured, remained
ready through the mutation attempt, and the external generation/sequence did
not change unexpectedly. Any unavailable gap makes the baseline incomplete;
the edit still proceeds under R18.

`packages/opencode/src/file/watcher.ts` enables the existing Project watcher
when `cfg.lsp !== false`, without prewarming or scanning files. The experimental
flag no longer determines whether LSP correctness has an external observation
source. Existing ignore rules and the native backend remain the single watcher
implementation.

### R21.3 Complete Tool-Owned Mutation Boundary

The mutation attempt remains active from before the first filesystem write
through formatting, BOM synchronization, final content hashing, and explicit
Tool event publication. The expected post hash is measured at the end of this
whole sequence, not before `Format.file`.

Native events for expected paths received while the attempt is active are held
as candidate events and are not rejected merely because they describe an
intermediate formatter output. Events for unexpected paths or operations still
mark an intervening external change. At completion, the final filesystem
content and operation set decide whether the expected path events belong to the
Tool transaction.

The event payload continues to carry `origin=tool|external` and the Tool
attempt ID. Write, Edit, and Apply Patch publish their explicit event only
after their complete formatter-owned sequence. Formatting stays inside the
existing mutation owner; no formatter-specific diagnostic path is added.

### R21.4 Content-Signature Duplicate Boundary

The coordinator stores the final mutation event signatures with the current
generation:

```text
(normalized path, operation, final content hash or confirmed absence)
```

If a delayed native event arrives after attempt completion and its operation and
current content signature match the stored Tool signature, it is a duplicate
and does not advance generation or invalidate the newly stored current result.
If it differs, it is an external change and advances generation. The signature
is replaced by the next qualified state; no fixed time window or timer is used.

This is content-based causal deduplication at the watcher/LSP boundary. It does
not add a second diagnostic source and does not suppress a semantically changed
file. A delete signature uses confirmed absence instead of a content hash.

### R21.5 Independent Result States

The R20 three-state rules remain, with the known-empty qualification above:

- `currentState=complete` returns the complete current diagnostics even when
  baseline qualification is unavailable.
- `currentState=incomplete` returns no diagnostics array, clean claim, delta, or
  asynchronous continuation.
- `baselineState=complete` requires a qualified existing baseline and matching
  identity; `baselineState=absent` is the separately qualified known-empty
  baseline.
- `deltaState=complete` is the only state that permits new/existing/delta or
  edit-introduced-clean wording.
- Complete current diagnostics with an incomplete/unavailable baseline are
  returned without new/existing classification. Current zero diagnostics may be
  reported as current clean, but never as “no new errors introduced.”

### R21.6 Red-Capable Verification

The existing `packages/opencode/test/lsp/client.test.ts` is the focused public
coordinator seam and gains cases for:

1. known-empty new-file baseline producing introduced diagnostics;
2. unknown baseline absence remaining unclassified;
3. watcher `ready/unavailable` state and baseline qualification sequence;
4. default LSP-enabled observation with no experimental watcher flag;
5. formatter intermediate events remaining inside one mutation attempt;
6. delayed matching native duplicate not advancing generation;
7. unexpected sibling/configuration event invalidating delta without blocking the
   edit;
8. complete current diagnostics being returned when baseline is stale;
9. incomplete current diagnostics containing no false success fields.

The existing Tool tests for Write, Edit, and Apply Patch remain in the focused
package verification command and exercise their real mutation/formatting paths;
their event payloads and result assertions are updated only where the approved
typed contract requires it, without adding another test harness.

### R21.7 File and Budget Gate

R21 modifies 12 existing files: 10 production owners and 2 existing test files
(`packages/opencode/test/lsp/client.test.ts` plus the already-listed focused
Tool regression owner). No new production file, dependency, timer, retry, or
fallback path is introduced. The three mutation Tools remain separate because
they own distinct write, formatter, and multi-file/move transactions; the
coordinator remains singular.

Recalculated planning estimate is `E=1,360` effective production/test lines and
`C=205` qualifying Chinese explanatory-comment lines. The hard minimum is
`ceil(1,360*0.15)=204`; implementation must recalculate actual values and stay
below 2,000 substantive lines. The preferred six-file target is not feasible
because the existing SDK, watcher, LSP, three mutation owners, and public test
seams are independently reachable responsibilities; 12 remains the intended
upper planning target.

### R21.8 Release Gate

R20 is superseded before approval. R21 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. A new independent full-scope audit must verify
the original requirement plus known-empty baseline semantics, watcher readiness,
formatter-inclusive causal boundaries, delayed duplicate handling, default
watcher red tests, zero-tab behavior, and the complete no-fallback contract.
Only an exact R21 `No blocking findings.` and `APPROVE` result may authorize
implementation.

## R22 Active Specification

R22 supersedes every conflicting timeout, test-file, file-count, and output
statement in R21 and all earlier revisions. The R21 independent audit invocation
was `ses_0951fe150ffe2EaFzFh7rx4ZbA`; it returned `BLOCK` because the historical
four/five-second bridge path exceeded the shared one-second requirement and the
planned test seam did not execute the real mutation Tools. R22 remains
implementation-disallowed until an exact full-scope audit approves it.

### R22.1 One Shared Absolute Deadline

The mutation owner creates one absolute deadline no later than 1,000 ms from
mutation-attempt start, before baseline acquisition and the first filesystem
write. It passes only the remaining budget to every LSP operation:

```text
deadline = mutationAttemptStartedAt + 1_000 ms
remaining = max(0, deadline - monotonicNow)
```

Baseline qualification, provider startup, direct provider terminals, bridge
transport, SDK observers, and post-mutation current diagnostics all use this
same deadline. There is no SDK-specific four-second wait and no LSP-specific
five-second transport timeout. The existing two-second bridge default remains
unchanged only for unrelated non-LSP bridge calls; mutation diagnostics always
supply the shorter remaining budget.

Filesystem mutation and configured formatting are not rolled back or abandoned
when the deadline arrives. If those required mutation steps consume the budget,
the Tool returns the applied edit and an immediate incomplete diagnostic state
without starting another wait. LSP therefore adds at most the remaining portion
of the shared one-second budget to the Tool operation.

Direct and bridge work starts concurrently. Completion of one scope does not
cancel another scope, but the shared deadline disposes all request-local waits
and transport listeners. Nothing updates the Tool output after return. Provider
processes may remain warm for a later request, but no request-specific observer
or result continuation survives.

### R22.2 Complete and Incomplete Scope Semantics

The authoritative current/baseline/delta scope is the named set of applicable
direct OpenCode providers. A complete direct scope may return complete current
diagnostics even when generic VS Code observation is incomplete; the result
names the direct provider/source identities and does not merge partial bridge
diagnostics into that array.

The bridge has its own state:

```text
bridgeState: complete | incomplete | stale-hidden | unavailable
```

Only a contracted named bridge terminal, such as completion of all three fresh
TypeScript diagnostic commands, may be `complete` inside the shared deadline.
Generic VS Code aggregate observation has no all-provider completion marker, so
it is `incomplete` at the shared deadline and carries no diagnostic array. It
cannot upgrade or downgrade a complete direct scope, authorize baseline/delta,
or extend the Tool response.

If no applicable direct provider completes, `currentState=incomplete` and no
current diagnostic array, bridge partial array, clean claim, delta, or
asynchronous continuation is returned. A 2.453-second Ruff/Pylance wave is
therefore evidence that the bridge scope cannot be certified inside this edit,
not a reason for the Tool to wait 2.453–5 seconds.

The R21 known-empty, baseline-authority, current/baseline/delta separation,
watcher readiness, formatter-inclusive mutation boundary, and content-signature
duplicate rules remain unchanged.

### R22.3 Real Mutation TDD Seams

The navigation-only `packages/opencode/test/tool/lsp.test.ts` is not modified and
is not evidence for Write/Edit/Apply Patch mutation behavior. R22 modifies the
three existing public mutation test files directly:

- `packages/opencode/test/tool/write.test.ts` uses its existing formatter layer
  to prove that the mutation attempt spans initial write, formatter rewrite, BOM
  synchronization, final hash, Tool event publication, known-empty baseline,
  and delayed matching native-event deduplication.
- `packages/opencode/test/tool/edit.test.ts` proves an existing-file baseline,
  create-via-empty-oldString known absence, Tool attempt identity, external
  sibling invalidation, complete-current/incomplete-baseline output, and the
  one-second incomplete boundary without a fixed sleep.
- `packages/opencode/test/tool/apply_patch.test.ts` proves Add overwrite versus
  true absence, move source-to-destination identity, multi-file attempt
  finalization, unlink signatures, unexpected Project event invalidation, and
  no partial diagnostic output at deadline.

These tests execute the real public Tool `execute` path with the existing temp
instance, filesystem, formatter, Bus, and permission fixtures. They observe
public Tool output/metadata and published events. Synchronization uses Bus
subscriptions and `Deferred`/latches; fixed sleeps do not establish readiness or
completion.

`packages/opencode/test/lsp/client.test.ts` remains the focused provider and
watcher/coordinator test owner. It proves direct source completion, absolute
deadline propagation, watcher `ready/unavailable` observation state, default
LSP-enabled Project watching without the experimental flag, delayed native
duplicate sequence behavior, and disposal at deadline.

### R22.4 Exact File Plan

R22 modifies 14 existing files, below the user's hard ceiling of 20:

1. `sdks/vscode/src/lsp.ts`
2. `sdks/vscode/src/bridge.ts`
3. `packages/opencode/src/lsp/lsp.ts`
4. `packages/opencode/src/lsp/client.ts`
5. `packages/opencode/src/lsp/diagnostic.ts`
6. `packages/opencode/src/file/watcher.ts`
7. `packages/opencode/src/tool/write.ts`
8. `packages/opencode/src/tool/edit.ts`
9. `packages/opencode/src/tool/apply_patch.ts`
10. `packages/opencode/src/cli/cmd/debug/lsp.ts`
11. `packages/opencode/test/lsp/client.test.ts`
12. `packages/opencode/test/tool/write.test.ts`
13. `packages/opencode/test/tool/edit.test.ts`
14. `packages/opencode/test/tool/apply_patch.test.ts`

No new production file, dependency, retry, timer-based completion, fallback,
project scanner, or formatter adapter is introduced. The 14-file count is the
natural owner/test mapping: three mutation implementations require their three
real public tests, while watcher, SDK transport, LSP protocol, and CLI are
separate existing reachable interfaces. The unchanged clean-room harness is
rerun as verification rather than changed to manufacture evidence.

The implementation remains structurally compact:

- one per-Project coordinator state in `lsp/lsp.ts` owns deadline, mutation
  attempt, generation, provider scope, baseline, and result assembly;
- `file/watcher.ts` owns only subscription state, sequence, and event origin;
- each mutation Tool only opens/finalizes the shared attempt around its existing
  write/format/event sequence and renders the typed result;
- provider-specific completion stays in existing `client.ts`/SDK branches;
- no single-use compatibility helper or parallel result implementation is added.

### R22.5 Budget

Recalculated estimate is `E=1,450` effective production/test lines and `C=220`
qualifying adjacent Chinese explanatory-comment lines. The hard minimum is
`ceil(1,450*0.15)=218`; estimated substantive production/test/comment total is
1,670 lines, below 2,000. Implementation must recompute actual `E`, `C`, and
total lines before implementation audit.

### R22.6 Release Verification

The focused package command is:

```sh
cd packages/opencode
bun test test/lsp/index.test.ts test/lsp/client.test.ts test/lsp/lifecycle.test.ts test/tool/lsp.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts
```

Required red/green assertions include:

1. a bridge/provider that cannot finish before the shared deadline returns one
   incomplete Tool result no later than the one-second boundary and never later
   updates it;
2. a fast direct provider returns immediately on its terminal rather than
   sleeping until the deadline;
3. a simulated 2.453-second bridge wave cannot extend the Tool result or appear
   as a partial current array;
4. normal POST completion is not caller abandonment, while caller abandonment
   and shared-deadline disposal both clean request-local listeners;
5. all Write/Edit/Apply Patch causal-boundary and public output cases in R22.3
   fail on the current implementation and pass only through the planned primary
   path.

The existing package-local typecheck, SDK check-types/lint/compile, direct
provider benchmarks, and zero-tab Extension Host probes remain required. Their
LSP mutation assertions use the shared one-second contract; no historical
four/five-second success assertion remains a release condition.

### R22.7 Release Gate

R21 is superseded before approval. R22 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. The next independent full-scope plan audit is the
third and final intended planning audit after the user's latest round-limit
instruction. Only an exact R22 `No blocking findings.` and `APPROVE` result may
authorize implementation.

## R23 Active Specification

R23 supersedes R22 only to restore the already-required direct Ruff owner to the
exact file and test plan. The R22 independent audit invocation was
`ses_09516a6a5ffe2uBlSVtGMd544Q`; its only blocking finding was that R22 omitted
`packages/opencode/src/lsp/server.ts` even though the provider matrix requires
Ruff. The shared one-second deadline, zero-tab behavior, mutation causality,
three-state result contract, no-fallback rule, and real Tool tests are unchanged.

### R23.1 Direct Ruff Owner

`packages/opencode/src/lsp/server.ts` adds one built-in `Ruff` `Info` beside the
existing Python providers:

```text
id: ruff
extensions: .py, .pyi
root markers: pyproject.toml, ruff.toml, .ruff.toml, setup.cfg, requirements.txt
command: <resolved ruff> server
```

Resolution follows the existing Python server style: current `PATH`, active
`VIRTUAL_ENV`, then Project `.venv`/`venv` platform-specific binary paths. R23
does not add a package download, installer, alternate executable, or VS Code
fallback. If no Ruff binary exists, the built-in returns no handle and remains
normal optional absence. If Ruff is explicitly configured or returns a handle,
startup/initialization/terminal failure remains an applicable-provider failure
inside the singular coordinator.

Ruff participates in the same applicable-provider enumeration already owned by
`packages/opencode/src/lsp/lsp.ts`. Its authoritative terminal is the observed
full `textDocument/diagnostic` report; pushes remain observed-only. Pyright and
Ruff run concurrently under the same remaining absolute deadline. A Python
direct scope is complete only when every applicable provider/source in that
captured scope completes; Ruff can never be silently omitted after it returned
a handle.

The server uses Ruff's Project configuration discovery and does not pass the
workspace directory as a configuration file. This avoids reproducing the
observed VS Code setting failure `Is a directory (os error 21)`.

### R23.2 Ruff Tests

`packages/opencode/test/lsp/index.test.ts` is added to the modified test plan. It
uses the existing server-registry seam to prove:

1. a Python target considers both Pyright and Ruff by default;
2. a missing optional Ruff handle does not block a completed Pyright scope;
3. a handle-returning or explicitly configured Ruff failure remains applicable
   and makes the current scope incomplete;
4. disabling Ruff excludes only Ruff without changing Pyright;
5. Ruff receives the resolved Project root and the shared provider flags.

`packages/opencode/test/lsp/client.test.ts` retains the protocol-level full-pull
test and timeout/source-identity assertions. The unchanged direct Ruff
20,001-file benchmark remains release evidence that full reports complete under
the intended warm one-second path; it is rerun, not copied into production.

### R23.3 Exact File and Budget Update

R23 modifies 16 existing files: the exact 14-file R22 list plus:

15. `packages/opencode/src/lsp/server.ts`
16. `packages/opencode/test/lsp/index.test.ts`

Sixteen is below the user's hard ceiling of twenty. The two added files are the
existing production registry owner and its existing public registry test; no
new abstraction or helper subsystem is introduced.

Recalculated estimate is `E=1,500` effective production/test lines and `C=228`
qualifying adjacent Chinese explanatory-comment lines. The hard minimum is
`ceil(1,500*0.15)=225`; estimated production/test/comment total is 1,728 lines,
below 2,000. Implementation must recompute actual values.

### R23.4 Release Gate

R22 is superseded before approval. R23 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. A new independent full-scope audit must verify
the complete original requirement and the direct Ruff owner/test mapping. Only
an exact R23 `No blocking findings.` and `APPROVE` result may authorize
implementation.

## R24 Active Specification

R24 supersedes R23 before audit completion because the user clarified that this
repository is redistributed into environments with different VS Code extensions
and LSP servers. Provider names, versions, executable locations, extension IDs,
and environment variables therefore cannot define completeness.

The additional requirement is preserved verbatim:

> 相应的扩展内容并不一定是完全准确的provider,因为这个仓库是要给别人进行二次分发的,所以可能别人用的不是完全确定的,所以我的意思是你大概找一个比较大范围的,也就是说你不要强烈于固定的依赖于某一个版本或者某一个provider的实现。你要有一些相应的先验,比如说你不能直接把RAF定死为相应的完整的owner或者完整的东西,你应该做的是保持相应的兼容性,同时实现相应的较好的效果。

> 代码一开始就不需要或者不能完全依赖于provider。譬如说即使是未知provider,你的结果也应该保持鲁棒。不能先判定这个provider是不是A,再判定这个provider是不是B。

> 代码也不要显示地依赖于读取不同LSP等等的环境变量等等内容；大概率这些东西只是安装在VS Code里面。

R24 keeps the R22 shared one-second, edit-first, causal mutation, watcher, real
Tool test, zero-tab, and no-fallback contracts. It replaces the closed provider
matrix and R23 Ruff registry change with an open capability-based diagnostic
source contract.

### R24.1 Open Diagnostic Source Domain

The coordinator never branches on LSP server ID, extension ID, executable name,
installed version, or environment variable. Every direct or VS Code diagnostic
source is classified only from capabilities exposed at the current request
boundary.

For direct LSP clients, the captured source descriptor contains:

```text
client instance identity
document selector and normalized target
static/dynamic textDocument/diagnostic registrations
advertised public completion capabilities/commands
document version support
provider epoch and observation generation
```

The descriptor intentionally omits provider name/version as a semantic switch.
Names may appear only in logs/user-facing source labels; they cannot select a
completion algorithm or authorize clean.

For the VS Code bridge, the descriptor contains only public Extension Host
facts available to this extension: target URI/version, hidden-document state,
public commands currently present, request-local diagnostic events, and the
absolute caller deadline. The implementation does not inspect extension install
directories, extension-private modules, child processes, PATH, VIRTUAL_ENV, or
other LSP executable environment variables.

### R24.2 Capability Lattice

All sources enter the same ordered capability lattice:

```text
standard pull scope
  -> complete only after every captured textDocument/diagnostic source returns
     a full report for the target generation

public completion capability
  -> complete only when the capability is present at runtime and its documented
     terminal returns a complete target result before the shared deadline

versioned push or VS Code diagnostic event without a completion capability
  -> observed only; currentState remains incomplete for that source

no applicable capability/evidence
  -> unavailable or incomplete, never clean
```

Selection is feature detection, not provider detection. An arbitrary fake or
third-party LSP server advertising `diagnosticProvider` follows exactly the same
pull path as a locally benchmarked server. Static and dynamic registrations are
snapshotted by canonical selector/identifier/scope identity; registration drift
invalidates completion and baseline equality.

Optional public completion capabilities are admitted only when the current
runtime explicitly advertises them and their response contract proves a full
target result or an event barrier. The coordinator does not infer command
semantics from an LSP server name. Absence of such a capability falls through to
the observed/incomplete state, not to another success attempt.

### R24.3 Unknown Source Behavior

An unknown LSP server is a first-class supported input:

- If it exposes standard pull diagnostics, it can produce a complete named
  current scope without any code change or identity allowlist.
- If it exposes only versioned pushes, those pushes prove content ownership but
  not finality; the synchronous result is incomplete unless a separately
  advertised public completion capability exists.
- If it exists only inside VS Code, hidden `openTextDocument` activates it and
  request-local events are observed, but URI-level aggregate events cannot prove
  all-source completion. The bridge returns incomplete at the shared deadline.
- Unsupported, slow, silent, failed, and dynamically changing sources all return
  typed incomplete reasons and never false clean, empty success, partial arrays,
  delta, shell fallback, or asynchronous output continuation.

This behavior is intentionally conservative but useful: already available
standard capabilities complete quickly, while unknown sources remain safe and
do not interfere with the edit or the user's editor.

### R24.4 Cross-Provider Priors

Cross-provider observations may justify generic mechanics only when the same
behavior is evidenced independently and does not claim a stronger protocol
guarantee. The benchmark matrix supports:

- start applicable sources concurrently rather than serially;
- use one absolute caller deadline;
- keep analysis current-file/dependency driven instead of Project-wide prewarm;
- use request-local listeners and exact target identity;
- return immediately on a real terminal.

The matrix does not support “all updates arrive together.” The observed Ruff
and Pylance waves arrived separately, and same-version LSP pushes can replace
one another. Therefore event-loop idleness, first event, first error, one
aggregate snapshot, or a quiet delay cannot become generic completion.

Provider-specific benchmark names and versions remain evidence examples only.
They do not create required installations, identity branches, or compatibility
gates in production.

### R24.5 Existing Discovery Is Reused, Not Expanded

R24 does not modify `packages/opencode/src/lsp/server.ts` and does not add a
built-in Ruff owner. Existing built-in and explicitly configured direct clients
continue to be discovered by the current registry. Once a client exists, the
new coordinator classifies it from runtime protocol capabilities rather than
its registry name.

No new executable discovery is introduced. In particular, R24 does not add
`which("ruff")`, PATH scanning, virtual-environment scanning, extension-folder
inspection, binary extraction, downloads, or shell commands. VS Code-installed
servers remain owned by their extensions and are reached only through public
Extension Host APIs.

### R24.6 Public TDD Slices

`packages/opencode/test/lsp/client.test.ts` uses fake servers with arbitrary,
non-allowlisted IDs to prove behavior by capability:

1. an unknown server with static `diagnosticProvider` returns complete only
   after its full report;
2. an unknown server dynamically registering two diagnostic sources completes
   only after both full reports;
3. registration/source identity drift makes current or baseline incomplete;
4. an unknown push-only server remains incomplete after versioned pushes and
   does not return a partial array;
5. an advertised public completion capability is used because the capability
   exists, with the same behavior under a different server ID;
6. removing that capability yields incomplete rather than a second success path;
7. no test supplies provider identity, version, PATH, VIRTUAL_ENV, or extension
   filesystem location to select behavior.

The real Write/Edit/Apply Patch tests from R22 continue to verify the complete
mutation and output path. The unchanged Extension Host probes use fresh profiles
with different installed extension sets and assert the same zero-tab/incomplete
contract when no public completion capability is present.

### R24.7 Exact File and Budget Plan

R24 returns to the exact 14-file R22 list. `packages/opencode/src/lsp/server.ts`
and `packages/opencode/test/lsp/index.test.ts` are not modified because this task
does not add or identify a built-in LSP server:

1. `sdks/vscode/src/lsp.ts`
2. `sdks/vscode/src/bridge.ts`
3. `packages/opencode/src/lsp/lsp.ts`
4. `packages/opencode/src/lsp/client.ts`
5. `packages/opencode/src/lsp/diagnostic.ts`
6. `packages/opencode/src/file/watcher.ts`
7. `packages/opencode/src/tool/write.ts`
8. `packages/opencode/src/tool/edit.ts`
9. `packages/opencode/src/tool/apply_patch.ts`
10. `packages/opencode/src/cli/cmd/debug/lsp.ts`
11. `packages/opencode/test/lsp/client.test.ts`
12. `packages/opencode/test/tool/write.test.ts`
13. `packages/opencode/test/tool/edit.test.ts`
14. `packages/opencode/test/tool/apply_patch.test.ts`

Recalculated estimate is `E=1,380` effective production/test lines and `C=210`
qualifying adjacent Chinese explanatory-comment lines. The hard minimum is
`ceil(1,380*0.15)=207`; estimated production/test/comment total is 1,590 lines,
below 2,000 and the file count remains below 20.

### R24.8 Release Gate

R23 is superseded before approval. Its interrupted audit produced no release
verdict and grants no authority. R24 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. A new independent full-scope audit must verify
the open capability domain, unknown-source behavior, no environment/executable
discovery, one shared deadline, zero-tab contract, real mutation tests, and the
complete original requirement. Only an exact R24 `No blocking findings.` and
`APPROVE` result may authorize implementation.

## R25 Active Specification

R25 is the final design candidate before the remaining independent audit
opportunities. It supersedes the R24 “public completion capability” tier,
provider-specific terminal branches, Project-wide watcher generation protocol,
and the separate bridge-state model. R24's independent audit invocation was
`ses_0950bf8edffe4Ys2rwMvZR5uDa`; it correctly identified that a generic
`executeCommandProvider` entry has no standard diagnostic-completion contract.
R25 removes that undefined success path instead of trying to specify it.

The user's final scope clarification is part of this active contract:

> 我们要找的并不验证每一个路径或者每一个能力是否真的准确地都有LSP完全支持,而是我们要找到一种相对来说更加自然,更加适合大部分LSP等模块的内容。也就是说这个地方你不需要证明,也不需要证据。

> 不知道能力的 LSP 大概率会在文件修改之后进行 LSP 消息更新，不应因为找不到稳定端点就直接返回 Incomplete，而应等待适当的 LSP 消息更新机制，尽量避免 Incomplete，同时保持泛化和稳定。

R25 therefore targets the majority behavior of normal LSP implementations and
does not promise impossible completeness for a source that emits no usable
diagnostic result at all.

### R25.1 One Source Contract

Every diagnostic source is represented by one runtime-neutral source record:

```text
source identity
document selector
document version/text hash
pull registration scope
source generation
current source result
```

No semantic branch reads server ID, provider name, extension ID, installed
version, executable path, PATH, VIRTUAL_ENV, or any other environment variable.
Existing direct server discovery remains unchanged; after a client exists, the
diagnostic coordinator uses only the protocol messages that client emits.

The coordinator recognizes only these generic message contracts:

1. `textDocument/diagnostic` full reports for every captured static/dynamic
   registration. This is an authoritative complete source terminal.
2. `textDocument/publishDiagnostics` with a matching document version. It is a
   complete replacement set for that publication and proves content ownership,
   but the protocol has no final-publication marker and permits another
   replacement for the same version. It is therefore observed evidence only.
3. A request-local unversioned `publishDiagnostics` or VS Code aggregate
   diagnostics change. It is also real observed evidence but not an
   authoritative clean/delta terminal.

Anything else is not guessed into a success path. The coordinator waits for
these standard messages until the shared deadline; only absence of a usable
message produces incomplete.

### R25.2 Direct LSP Completion

At client initialization, advertise `publishDiagnostics.versionSupport=true`.
Capture the static `diagnosticProvider` capability and every dynamic
`textDocument/diagnostic` registration, including selector, identifier, and
workspace/document scope.

For a target edit:

- if the captured source scope supports pull, send all target document pull
  requests concurrently and require every response to be a full report;
- otherwise arm a request-local waiter for target pushes only to obtain
  observed evidence; neither matching-version nor unversioned push is a
  completion terminal;
- keep every accepted full replacement as observed current evidence, using a
  matching version only to correlate it with the requested content; do not call
  it clean or use it for baseline/delta classification;
- if registration changes, the source generation changes, or the target version
  is not the requested version, the current source is incomplete for this edit;
- if the source sends no message before the shared deadline, return incomplete
  with the concrete source reason and no success-shaped diagnostic payload.

The existing client cache is the only baseline cache. Only a prior complete
pull-full snapshot can be a qualified baseline, and only when its source scope,
source generation, document version, and content hash match the file immediately
before mutation. Push replacements remain observed cache entries and invalidate
an older qualified baseline; they never become one. Source generation increments
on accepted push replacement, pull result, dynamic registration/unregistration,
and `workspace/diagnostic/refresh`. This uses the LSP protocol's own invalidation
signals and does not add a Project-wide file watcher or dependency scanner.

If no qualified cached baseline exists, the edit proceeds immediately and the
current result may still be complete; only new/existing/delta classification is
omitted. A confirmed absent target remains a known-empty baseline. Add overwrite
checks actual existence before choosing that branch.

### R25.3 VS Code Hidden-Document Observation

The SDK diagnostic route uses only `workspace.openTextDocument`; it never calls
`showTextDocument`. It registers the request-local document freshness and
diagnostic listeners before opening/activating the target, then verifies the
hidden document text hash matches the edited file.

VS Code's `onDidChangeDiagnostics` is backed by the Extension Host's
`DebounceEmitter` and already merges collection updates in its own event path.
The SDK does not add a second fixed quiet delay. It reacts to the first target
diagnostic event after document freshness:

```text
aggregate snapshot contains diagnostics
  -> observed-errors, return those real diagnostics immediately
     without clean/new/existing/delta wording

aggregate snapshot is empty
  -> observed-empty-not-certified; never claim clean or empty-success

no target event before the shared deadline
  -> incomplete; no diagnostic array and no later continuation
```

An observed snapshot is not merged into an authoritative direct pull scope. It
is nevertheless useful synchronous feedback for VS Code-only or unknown
extensions, which prevents a real error from being hidden merely because the
extension exposes no generic completion endpoint. The direct/VS Code sources
start concurrently; a complete direct source can return immediately, while a
VS Code observed result can win only when no authoritative direct result has
completed.

The aggregate event cannot authorize clean or delta because the public event
contains URIs but no source owner/version/completion marker. An empty aggregate
is therefore explicitly non-certified rather than false clean.

### R25.4 Single Shared Deadline and Immutable Result

The Tool records one monotonic absolute deadline at mutation-attempt start, no
later than 1,000 ms. Direct source pulls/pushes and the hidden VS Code observer
receive the remaining budget. Fast source terminals return immediately; no
fixed sleep follows them. When the deadline arrives, request-local listeners,
pull requests, and bridge calls are disposed/cancelled through the existing
`VscodeBridge` timeout/signal interface.

The file edit and existing formatter transaction are not rolled back. If they
consume the budget, the Tool returns the applied edit and an immutable
incomplete result immediately after the mutation. No later provider event
updates that Tool result. Providers may remain warm for future requests, but
that is not an asynchronous result continuation.

### R25.5 Minimal Result Model

The result has one current union and one optional baseline:

```text
current:
  complete { scopeKey, diagnostics }
  observed-errors { diagnostics, source: "vscode" | "lsp-push" }
  observed-empty-not-certified { source: "vscode" | "lsp-push" }
  incomplete { reason }

baseline:
  complete { scopeKey, diagnostics }
  known-empty
  unavailable { reason }

delta: present only for current.complete + qualified baseline
```

`observed-errors` is not a clean success and never receives new/existing/delta
classification. `observed-empty-not-certified` is not an empty-success result;
its explicit state prevents the consumer from rendering clean. `incomplete` has
no diagnostics array, no clean claim, no delta, and no async continuation.

This replaces the separate bridgeState, baselineAuthority, deltaState,
Project generation, provider epoch, watcher epoch/sequence, mutation attempt
ID, event origin, expected-hash candidate queue, delayed duplicate timer, and
provider-specific completion-helper tree.

### R25.6 One Coordinator and Real Tool Tests

The single LSP coordinator owns source aggregation, deadline, baseline
qualification, result assembly, and delta derivation. `LSPClient` owns protocol
source scope, document version, push/pull generation, and standard message
waiters. The SDK owns hidden document/event observation. Write/Edit/Apply Patch
own only their existing filesystem/formatter/move transactions and call the
same baseline/audit interface. The debug CLI consumes the same result.

The focused public tests are the existing:

- `packages/opencode/test/lsp/client.test.ts`: arbitrary server IDs with pull,
  dynamic registration, versioned push, unversioned push, refresh invalidation,
  source generation, and deadline behavior;
- `packages/opencode/test/tool/write.test.ts`: known-empty/existing baseline,
  formatter final content, observed/incomplete output, and current diagnostics;
- `packages/opencode/test/tool/edit.test.ts`: real existing/create edit path,
  cached baseline qualification, version mismatch, and observed errors;
- `packages/opencode/test/tool/apply_patch.test.ts`: Add overwrite, move,
  multi-file current aggregation, and delta omission when any source is not
  complete.

The hidden Extension Host probe remains a verification harness, not a
production file change. It asserts active editor, visible editor, and tab groups
remain unchanged and records first-event/empty-event/deadline behavior.

### R25.7 Exact File and Budget Plan

R25 modifies 12 existing files:

1. `sdks/vscode/src/lsp.ts`
2. `packages/opencode/src/lsp/lsp.ts`
3. `packages/opencode/src/lsp/client.ts`
4. `packages/opencode/src/lsp/diagnostic.ts`
5. `packages/opencode/src/tool/write.ts`
6. `packages/opencode/src/tool/edit.ts`
7. `packages/opencode/src/tool/apply_patch.ts`
8. `packages/opencode/src/cli/cmd/debug/lsp.ts`
9. `packages/opencode/test/lsp/client.test.ts`
10. `packages/opencode/test/tool/write.test.ts`
11. `packages/opencode/test/tool/edit.test.ts`
12. `packages/opencode/test/tool/apply_patch.test.ts`

The count includes all four existing test files. No new production file,
dependency, environment probe, provider allowlist,
watcher protocol, bridge state machine, retry, fixed quiet delay, or shell
fallback is added. `file/watcher.ts`, `sdks/vscode/src/bridge.ts`,
`packages/opencode/src/lsp/server.ts`, `packages/opencode/src/tool/lsp.ts`, and
the clean-room harness are unchanged production-plan files.

Recalculated estimate is `E=1,090` effective production/test lines and `C=165`
qualifying adjacent Chinese explanatory-comment lines. The hard minimum is
`ceil(1,090*0.15)=164`; estimated substantive production/test/comment total is
1,255 lines, below 2,000. Implementation must recompute actual values.

### R25.8 Release Gate

R24 is superseded before approval. R25 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. The next audit handoff must include the user's
final scope clarification that the audit is checking a completed majority-case
design, not inventing support for arbitrary capability-less LSP modules. Only an
exact R25 `No blocking findings.` and `APPROVE` result may authorize
implementation.

## R26 Active Specification

R26 is the final substantive plan revision. It supersedes R25 and resolves the
five blocking findings from independent audit invocation
`ses_094e9542fffenxCeu9RMgF5IeP` without restoring provider identity branches,
Project-wide watcher state, fixed quiet delays, or alternate success paths.
Implementation remains disallowed until the exact R26 revision receives a clean
full-scope audit.

### R26.1 Complete Means All Applicable Direct Sources

The coordinator captures a closed candidate set for every target at the audit
request boundary. Candidate discovery uses the existing registry and custom LSP
configuration, never provider identity for diagnostic semantics.

A candidate decision is one of:

```text
not-applicable
  built-in candidate returned no handle before the deadline

applicable
  client handle initialized successfully
  OR explicit custom configuration matched the target
  OR a candidate returned a handle and then failed initialization

unresolved
  root/spawn/initialization decision did not settle before the shared deadline
```

Root and spawn decisions run concurrently. A complete current result requires a non-empty applicable direct-source set and:

1. every captured candidate decision settled;
2. every applicable client exposes captured document-pull registrations and
   every registration returned a full report for the target;
3. no source registration/scope/revision drift occurred before aggregation.

Any unresolved candidate, push-only applicable source, failed pull, or empty
applicable-source set prevents `current.complete`.
Optional built-ins that settle as no-handle are excluded rather than reported as
failures. Explicit custom sources and handle-returning sources cannot disappear
from the join after failure.

For a single file, `scopeKey` is the canonical sorted identity of all applicable
clients and their captured static/dynamic diagnostic registrations. For Apply
Patch, the overall current result is complete only when every non-deleted target
has a complete all-applicable-source result. A fast client can contribute a real
observed error, but it cannot create success-shaped complete output while another
applicable client remains pending.

Aggregation behavior is exact:

```text
every target has at least one applicable direct source and all applicable
document-pull registrations complete
  -> current.complete with the merged complete diagnostic sets

any fresh direct/VS Code observed snapshot contains errors before full join
  -> current.observed-errors; may return early, never clean or delta

no errors observed, but at least one fresh empty observed snapshot exists and
the complete join is still unavailable at the deadline
  -> current.observed-empty-not-certified

no usable source message before the deadline, including a settled empty
applicable-source set with no VS Code event
  -> current.incomplete
```

Complete current diagnostics remain independent of baseline availability.
Delta is derived per target only after the complete current join.

### R26.2 Minimal Source Revision Boundary

R26 does not restore FileWatcher generations. Instead, the LSP service exposes a
two-phase mutation boundary already required by the three mutation Tools:

```text
beginMutation(targets, deadline)
  -> capture qualified cached baselines synchronously
  -> increment each active direct client's source revision once
  -> return expected revision/scope for this mutation

auditFiles(finalTargets, deadline, boundary?)
  -> discover/apply all current sources concurrently
  -> when boundary is present, bind didChange/current results to its revision
     and derive qualified deltas
  -> without a boundary, perform a read-only current audit for debug consumers
```

`beginMutation` runs after edit permission is granted and immediately before the
first filesystem write. It never waits for provider startup or diagnostics, so
the file edit begins immediately. It invalidates every active client's cached snapshots for
future requests, even when the changed target is a sibling/configuration file or
its own post-mutation audit later times out. This is conservative and source
local: one integer revision per active client, not a Project watcher protocol.

The boundary carries each client's expected post-invalidation revision. The
Tool's own `didChange` is bound to that revision and does not increment it a
second time. A second Tool mutation, warm-path content change,
registration/unregistration, or diagnostic refresh increments the revision
again. If current revision differs from the boundary's expected revision,
current diagnostics may still complete, but the passed baseline is unavailable
for delta. `auditFiles` with a mutation boundary qualifies delta only when the
current revision equals the boundary's expected revision and source scope
matches. The debug CLI calls `auditFiles` without a boundary, so it cannot
invalidate or manufacture a mutation baseline.

Newly spawned clients have no baseline in the current boundary but participate
fully in current completion. Baseline/current scope mismatch omits delta without
hiding complete current diagnostics.

`LSPClient` advertises:

```text
workspace.diagnostics.refreshSupport = true
textDocument.publishDiagnostics.versionSupport = true
```

The `workspace/diagnostic/refresh` handler increments source revision and marks
cached complete snapshots stale before acknowledging the request. Static/dynamic
registration changes do the same. A pull full report or accepted push stores the
latest snapshot at the current revision; it does not create another invalidation
revision. A later same-version replacement updates that current snapshot.

Navigation/read warm outside a mutation boundary increments revision only when
it actually synchronizes changed document content. This covers every mutation
notification that the client receives without adding event origin, attempt ID,
content-signature deduplication, or filesystem scanning.

The public regression is:

1. establish complete cached diagnostics for `a`;
2. mutate sibling/configuration file `b` through a real Tool;
3. make `b` diagnostics time out;
4. edit unchanged `a` and return its complete current diagnostics;
5. assert `a` has no new/existing delta because `b`'s beginMutation advanced the
   source revision.

### R26.3 Exact VS Code Bridge Contract and Harness

R25's SDK semantics remain: listeners are registered before hidden
`openTextDocument` and document hash freshness is required. A non-empty
post-freshness debounced aggregate event yields observed-errors immediately. An
empty event is recorded but the request continues waiting for a later non-empty
event, a complete direct join, or the shared deadline; only at the deadline does
it yield observed-empty-not-certified. No event by the shared deadline is
incomplete.

The two existing clean-room files become modified verification owners:

- `.temp/testing/vscode-observer/extension.js` records the exact atomic
  `/lsp/touch` response and exposes deterministic error-event, empty-event, and
  no-event scenarios without matching provider names.
- `.temp/testing/vscode-clean-room-probe.ts` exits non-zero unless the response
  exactly satisfies the R26 union and forbidden-field rules.

The Extension Host assertions are:

```text
fresh non-empty event
  state = observed-errors
  diagnostics is non-empty
  no clean, delta, new/existing, pending-success, or later continuation field

fresh empty event
  state = observed-empty-not-certified
  no clean/delta/new/existing claim

deadline without target event
  state = incomplete
  no diagnostics array or success-shaped empty value
```

Every scenario also asserts target absent from all tab groups and visible
editors, active editor unchanged, and hidden document hash equal to the edited
file. The harness performs a post-response mutation followed by another
request; an event emitted after the first response cannot qualify the second
request. This verifies request-local listener disposal/history isolation and
that the first returned JSON result never changes later.

The OpenCode bridge caller supplies only the remaining shared deadline through
the existing `timeoutMs`/`AbortSignal` seam. `sdks/vscode/src/bridge.ts` remains
unchanged.

### R26.4 Navigation Is Warm-Only

`packages/opencode/src/tool/lsp.ts` is an affected public caller and changes its
pre-operation call from `touchFile(file, "document")` to explicit
`warmFile(file)`. Hover, definition, references, symbols, and call hierarchy do
not enter diagnostic waiting.

`packages/opencode/test/tool/lsp.test.ts` uses the public Tool seam and an LSP
service layer whose audit operation fails if called; navigation must complete
through warm-only behavior. The Read Tool's one-argument `touchFile` remains a
temporary internal warm alias in this revision so `read.ts` need not change;
mutation/debug callers use the two-phase audit result. No diagnostics mode
remains on that alias.

### R26.5 Severity-Aware Delta Test

`packages/opencode/src/lsp/diagnostic.ts` includes severity in diagnostic
identity. `packages/opencode/test/lsp/lifecycle.test.ts` adds the public
warning-to-error regression:

```text
baseline: same location/message/code/source, severity Warning
current:  same location/message/code/source, severity Error
expected: one newly introduced error, not one existing error
```

The expected counts are literal and do not reproduce `diagKey` in the test.

### R26.6 Public Result and Multi-File Rules

The R25 result union remains the only Tool/CLI result model. For Apply Patch:

- all non-deleted targets are audited concurrently under one deadline;
- deleted targets have no current diagnostic request;
- move carries the source baseline to the destination logical target;
- `current.complete` requires the complete target/source join from R26.1;
- per-target delta is present only for a qualified complete/known-empty baseline;
- any unresolved target prevents overall complete wording;
- real errors from completed or observed sources may be returned only under
  `observed-errors`, never as a partial complete result;
- an all-empty but unresolved result is observed-empty-not-certified or
  incomplete, never clean.

Write, Edit, Apply Patch, and debug CLI render the same union. No consumer issues
a second `diagnostics()` read.

### R26.7 Exact TDD Mapping

The final red-capable mapping is:

| Behavior | Public owner/test |
| --- | --- |
| Static/dynamic pull full reports, versioned/unversioned push observed-only behavior, repeated same-version replacement, refresh revision | `packages/opencode/test/lsp/client.test.ts` |
| Concurrent candidate/applicable-source join, explicit failure retention, and zero-applicable-source incomplete result | `packages/opencode/test/lsp/index.test.ts` |
| Warning to error is new | `packages/opencode/test/lsp/lifecycle.test.ts` |
| Navigation uses warm only | `packages/opencode/test/tool/lsp.test.ts` |
| Known-empty/existing baseline, formatter, atomic result | `packages/opencode/test/tool/write.test.ts` |
| Create/existing edit, revision mismatch, observed errors | `packages/opencode/test/tool/edit.test.ts` |
| Add overwrite, move, multi-file join, sibling timeout invalidation | `packages/opencode/test/tool/apply_patch.test.ts` |
| Zero-tab observed-errors/empty/deadline/no-continuation | `.temp/testing/vscode-observer/extension.js` and `.temp/testing/vscode-clean-room-probe.ts` |

Each production behavior is tested through a public service, Tool, CLI-equivalent
result, protocol client, or real Extension Host route. Fixed sleeps may simulate
late input in a race fixture but never establish completion; readiness uses
Deferred/latches, Bus events, protocol responses, or Extension Host events.

### R26.8 Exact File and Budget Plan

R26 modifies 18 existing files:

1. `sdks/vscode/src/lsp.ts`
2. `packages/opencode/src/lsp/lsp.ts`
3. `packages/opencode/src/lsp/client.ts`
4. `packages/opencode/src/lsp/diagnostic.ts`
5. `packages/opencode/src/tool/write.ts`
6. `packages/opencode/src/tool/edit.ts`
7. `packages/opencode/src/tool/apply_patch.ts`
8. `packages/opencode/src/tool/lsp.ts`
9. `packages/opencode/src/cli/cmd/debug/lsp.ts`
10. `packages/opencode/test/lsp/client.test.ts`
11. `packages/opencode/test/lsp/index.test.ts`
12. `packages/opencode/test/lsp/lifecycle.test.ts`
13. `packages/opencode/test/tool/write.test.ts`
14. `packages/opencode/test/tool/edit.test.ts`
15. `packages/opencode/test/tool/apply_patch.test.ts`
16. `packages/opencode/test/tool/lsp.test.ts`
17. `.temp/testing/vscode-observer/extension.js`
18. `.temp/testing/vscode-clean-room-probe.ts`

The count is below the user's hard ceiling of 20. The extra files over the
preferred 12 are existing public caller/test owners required for source joining,
navigation warm behavior, severity delta, and real Extension Host assertions.
No new production file, dependency, watcher protocol, provider allowlist,
environment lookup, retry family, fixed quiet delay, or shell fallback is added.

Recalculated estimate is `E=1,340` effective production/test/harness lines and
`C=205` qualifying adjacent Chinese explanatory-comment lines. The hard minimum
is `ceil(1,340*0.15)=201`; estimated production/test/harness/comment total is
1,545 lines, below 2,000. Implementation must recompute actual values.

### R26.9 Verification and Release Gate

Focused package command:

```sh
cd packages/opencode
bun test test/lsp/index.test.ts test/lsp/client.test.ts test/lsp/lifecycle.test.ts test/tool/lsp.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts
```

Then run `bun typecheck` from `packages/opencode`; `bun run check-types`,
`bun run lint`, and `bun run compile` from `sdks/vscode`; the generic push/pull
benchmarks; and the exact zero-tab Extension Host contract scenarios from the
repository root. Extension Host probes are standalone harness commands, not
package tests. The `test/lsp/index.test.ts` suite also launches the debug LSP
command against a fixture and asserts it consumes the same typed audit result,
so the CLI cannot retain a second touch-then-diagnostics read.

R25 is superseded before approval. R26 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. This plan will be submitted only once more for
the user's final independent audit opportunity after local mapping and
consistency checks. Only an exact R26 `No blocking findings.` and `APPROVE`
result may authorize implementation.

## R27 Active Specification

R27 is a contract correction after the final allowed audit returned one
blocking finding: standard LSP `workspace/diagnostic` was reachable in the
current client but was not represented in the current-file source contract.
The audit invocation was `ses_094dd7b33ffe71bZbLbA6FrILc`.

R27 does not call `workspace/diagnostic` from the one-second current-file Tool
audit. That request has workspace scope and can require a whole-Project
diagnostic computation, which conflicts with the explicit no full-Project
prewarm/scan requirement. This is an explicit supported-domain exclusion, not a
silent omission:

```text
workspace diagnostic registration only
  -> currentState=incomplete
     reason=workspace-scope-out-of-current-file-sla
  -> no workspace request, no clean, no delta, no false current success

document diagnostic registration(s) present
  -> current-file scope may complete through textDocument/diagnostic
  -> scopeKey records document-only authority
  -> output never claims workspace/global clean

document and workspace registrations both present
  -> document scope may return complete current-file diagnostics when all
     document sources complete
  -> workspace scope remains explicitly unqueried/out-of-scope
  -> baseline/delta are limited to the document scope and named as such
```

The direct client keeps its existing workspace-registration model only to
classify and report this boundary. It does not send the already-implemented
`requestWorkspaceDiagnosticReport` from the mutation current-file path. The
client test adds a public protocol assertion that a workspace-only source
returns the explicit out-of-scope reason and that no `workspace/diagnostic`
request is emitted. A document-plus-workspace source proves document-scope
completion remains named and cannot be rendered as global clean.

R27 otherwise preserves the complete R26 primary path: all applicable
current-file document sources join before `current.complete`; versioned and
unversioned pushes use the standard-message rules; observed VS Code errors are
returned without clean/delta claims; empty events wait until later evidence or
the shared deadline; source revision invalidates stale baselines; navigation is
warm-only; and the real Tool/Extension Host tests remain required.

The canonical plan is now `Status: audit-required`, `Approved revision: none`,
and `Implementation allowed: no`. The user's two final audit opportunities have
been consumed; this correction is not independently approved. No production
implementation is authorized without a further user-approved audit opportunity.

## R28 Provider-Neutral Authority

R28 resolves the only blocking finding from independent full-scope R27 audit
invocation `ses_094901b27ffe06IOtuZcOtHGZn`: the historical R13 body and current
clean-room observer still authorized a TypeScript-only
`typescript.tsserverRequest` branch. The user granted two additional approval
opportunities; that audit used the first and R28 is prepared for the second.

### R28.1 Exact Authority Boundary

Only the R25 standard-message contract, R26 all-applicable-source/mutation/test
contract, R27 workspace-diagnostic boundary, and this R28 correction authorize
implementation. R24 and every earlier revision are retained only as experiment
and audit history. In particular, no earlier TypeScript, JDT LS, clangd,
rust-analyzer, Ruff, Pyright, Pylance, or extension-specific command/readiness
branch survives into production merely because its benchmark remains recorded.

The runtime and release harness must not use any of these facts to select
diagnostic semantics:

- target language ID or file extension;
- LSP server/provider/extension name, ID, version, executable, path, or
  environment variable;
- contributed VS Code command identifiers or provider-specific
  `workspace/executeCommand` commands;
- provider-specific status, idle, quiescent, or refresh notifications.

Those facts may remain in historical benchmark tables and logs, but they cannot
enter a production conditional, source terminal, readiness gate, clean/delta
claim, or release-test expected value.

### R28.2 Sole Diagnostic Message Contract

Every direct client follows the R25 generic contract without identity checks:

```text
all captured textDocument/diagnostic registrations return full reports
  -> that direct source generation is complete

matching-version or unversioned publishDiagnostics replacement
  -> observed evidence only; version correlates content but proves no finality

no qualifying standard message by the shared deadline
  -> incomplete
```

The direct-source join, source-revision invalidation, one-second absolute
deadline, baseline/delta qualification, and R27 document-only workspace boundary
remain exactly as specified by R26/R27. No generic `executeCommandProvider`
entry is interpreted as a diagnostics capability.

The VS Code source uses only hidden `workspace.openTextDocument`, exact document
hash freshness, request-local `languages.onDidChangeDiagnostics`, and
`languages.getDiagnostics(uri)` at that event:

```text
fresh non-empty aggregate event
  -> observed-errors immediately

fresh empty aggregate event
  -> keep waiting; observed-empty-not-certified only at the shared deadline

no fresh target event by the shared deadline
  -> incomplete
```

The VS Code source never returns `complete`, clean, or delta. There is no fixed
quiet delay, provider-command dispatch, provider identity check, asynchronous
continuation, second diagnostic request, or failure-triggered fallback.

### R28.3 Release Harness Correction

`.temp/testing/vscode-observer/extension.js` deletes the existing
`typescript.tsserverRequest`/semantic/syntactic/suggestion command branch and
all language-ID gating from the route used by release verification. Its
deterministic non-empty, empty, and silent event scenarios exercise the exact
same result union regardless of fixture language. Real TypeScript and Python
Extension Host runs remain useful zero-tab compatibility checks, but neither is
allowed a language-specific completion expectation. A TypeScript host that
emits no aggregate event truthfully returns incomplete rather than receiving a
special command path.

`.temp/testing/vscode-clean-room-probe.ts` fails if the observer invokes a
contributed diagnostic command, returns a provider-specific state, opens a tab,
changes the active editor, reports empty success/clean/delta, or mutates a
returned result after the response. The existing arbitrary-ID direct-client
tests prove that server identity does not select pull/push behavior.

### R28.4 File, Budget, and Release Gate

R28 adds no file to the exact R26 18-file plan. The observer was already a
planned modified verification owner; deleting its provider-specific branch is
part of that responsibility. The conservative R26 upper estimate remains
`E=1,340`, `C=205`, minimum `ceil(1,340*0.15)=201`, and total 1,545 lines.
Implementation must recompute actual values and remain below 2,000 substantive
production/test/harness/comment lines.

R27 is superseded before approval. R28 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. One user-authorized additional plan-audit
opportunity remains. Only an exact R28 full-scope `No blocking findings.` and
`APPROVE` result may authorize implementation.

## R29 Authoritative-Completion Boundary

R29 resolves both blocking findings from the second and final user-authorized
additional R28 audit, invocation `ses_094838b96ffebf77w5Dqa59fkw`:

1. matching-version push was promoted to complete without a protocol finality
   barrier;
2. a settled empty applicable-source set could satisfy the all-source join
   vacuously and return false clean.

### R29.1 Push Is Correlated Observation, Never Completion

`publishDiagnostics.version` correlates a replacement set with document content,
but the protocol permits later replacement publications for the same version.
The first matching-version publication therefore has no finality authority.

All versioned and unversioned pushes use one observed path:

```text
non-empty push replacement before the deadline
  -> current.observed-errors
     diagnostics may return immediately
     no complete, clean, baseline, new/existing, or delta

empty push replacement before the deadline
  -> record observed-empty evidence and continue waiting
     at deadline: current.observed-empty-not-certified

later same-version replacement
  -> replace the observed cache and increment source revision
     cannot mutate an already returned Tool result
```

Only all captured `textDocument/diagnostic` registrations returning full reports
can complete a direct source. A push-only applicable source remains incomplete
for clean/delta purposes through the shared deadline, even when its publication
version matches the Tool's document version. Push storage remains useful for
observed errors and for invalidating stale pull baselines; it never creates a
qualified baseline.

The public client regression sends two same-version publications: first empty,
then an error. It asserts that the first cannot complete or authorize clean, the
second is observed-errors, and neither enters delta classification. An
unversioned replacement follows the same observed-only state contract.

### R29.2 A Complete Join Requires Evidence

The coordinator may return `current.complete` only when every non-deleted target
has a non-empty applicable direct-source set and every member supplies complete
document-pull full reports for every captured registration. Universal
quantification over an empty set is explicitly not completion.

```text
candidate decisions settle; applicable set is empty
  -> keep the VS Code request-local observer alive for the remaining deadline
  -> fresh non-empty event: observed-errors
  -> fresh empty event at deadline: observed-empty-not-certified
  -> no event at deadline: incomplete(reason=no-applicable-diagnostic-source)

one or more applicable pull sources; all full reports complete
  -> current.complete

any applicable push-only, failed, pending, or drifted source
  -> cannot return current.complete
```

`packages/opencode/test/lsp/index.test.ts` adds a public coordinator regression
whose matching optional built-ins all settle as no-handle. It asserts that the
result is not complete, contains no clean/delta/empty-success payload, and uses
the exact incomplete reason after the shared deadline when the VS Code source is
silent. A second case proves a real VS Code error remains useful
`observed-errors` in the same zero-direct-source condition.

### R29.3 Scope, Budget, and Release Gate

R29 changes no owner or file from the R26/R28 18-file plan. Both corrections
belong to the existing `client.ts`, `lsp.ts`, `client.test.ts`, and
`index.test.ts` responsibilities. The conservative `E=1,340`, `C=205`, minimum
201, and total 1,545-line estimate remains an upper bound; implementation must
recalculate actual values.

R28 is superseded before approval. R29 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. Both additional user-authorized audit
opportunities have been consumed. R29 is not independently approved, so no
production/test/config/generated implementation or commit is authorized without
a further explicit audit opportunity and an exact full-scope `APPROVE`.

## R30 VS Code-Only Observation

R30 incorporates the user's final deployment clarification: this diagnostic
path obtains LSP information only through the VS Code extension bridge. OpenCode
does not use its built-in direct LSP clients as a diagnostic source or as a
fallback when the VS Code bridge is missing or fails.

The existing `packages/opencode/src/lsp/lsp.ts` path currently does this:

```text
VS Code bridge fails
  -> collect built-in OpenCode LSP diagnostics
```

R30 removes that fallback from the mutation/debug diagnostic path. A bridge
failure is reported as the bridge's truthful unavailable/observation state; it
does not silently switch diagnostic semantics to another LSP implementation.
Navigation and other non-diagnostic compatibility behavior is outside this
diagnostic result contract and is not used to judge the mutation result.

### R30.1 Simple Result Rule

The VS Code extension cannot know whether every internal language service has
finished pushing. Therefore this path intentionally returns an observation, not
a claim that VS Code's LSP work is complete:

```text
start hidden open + request-local diagnostic listener
set deadline = mutation start + 1,000 ms

while before deadline:
  receive a diagnostic update for the target
  read languages.getDiagnostics(target)
  if diagnostics is non-empty:
    return "发现错误" + the current diagnostics

at deadline:
  read languages.getDiagnostics(target)
  if diagnostics is empty:
    return "未发现错误"
  return "发现错误" + the current diagnostics
```

`未发现错误` means only that no diagnostic was present in the latest VS Code
snapshot within the one-second observation window. It does not mean every
language service has finished, and it does not claim that a later update is
impossible. This is the accepted existing behavior for the VS Code-only route,
not a blocking correctness defect.

An error-bearing event returns immediately so short files do not wait for the
deadline. Empty or unchanged diagnostics do not need a completion event because
the product deliberately reports the latest observed result at the deadline.
There is no fixed post-event quiet sleep, second LSP call, shell fallback, or
visible editor operation. The result is immutable after the Tool response.

### R30.2 VS Code Owner and Tool Mapping

`sdks/vscode/src/lsp.ts` owns hidden `openTextDocument`, request-local
`onDidChangeDiagnostics`, the one-second deadline, and the latest
`languages.getDiagnostics(target)` snapshot. It never calls
`showTextDocument`.

`packages/opencode/src/lsp/lsp.ts` owns only bridge resolution, typed bridge
failure/observation mapping, and the diagnostic result consumer. Its diagnostic
route no longer calls `s.clients` after a bridge failure. Write/Edit/Apply Patch
and the debug CLI consume this one VS Code observation result; they do not issue
a second diagnostics read and do not call direct LSP clients.

The public result uses plain user-facing semantics:

```text
edit applied
diagnostic result: 发现错误 | 未发现错误 | VS Code bridge unavailable
diagnostics: present only when errors were observed
```

`未发现错误` is deliberately not rendered as “LSP complete”, “globally clean”,
or “no future errors”. The bridge-unavailable state does not roll back the file
edit or block it beyond the shared one-second budget.

### R30.3 TDD and Scope

The first red test is the real bridge fallback regression: a bridge that returns
an empty latest snapshot must produce `未发现错误`, while a bridge failure must
not invoke built-in clients. The next vertical slices cover:

1. hidden diagnostics leave active editor and tab groups unchanged;
2. an error event returns immediately with the error;
3. an empty/unchanged snapshot at the deadline returns `未发现错误`;
4. a late event cannot mutate the already returned Tool result;
5. write/edit/apply-patch/debug all consume the same single bridge result.

The exact owner/test set is limited to the existing bridge SDK, LSP service,
mutation Tool, debug CLI, clean-room harness, and their public tests. Direct
LSP-client completion, matching-version push finality, and empty direct-source
set tests are removed from this diagnostic path because those sources are not
part of the user's VS Code-only deployment.

### R30.4 Release Gate

R29 is superseded before approval. R30 is the exact current revision with
`Status: audit-required`, `Approved revision: none`, and
`Implementation allowed: no`. R30 has not received an independent full-scope
audit. No production/test/config/generated implementation or commit is
authorized until R30 receives `No blocking findings.` and `APPROVE`.

## R31 Existing Timeout Ceiling

R31 incorporates the user's timeout correction: the VS Code diagnostic wait
must not be shortened to one second and must not be extended beyond the current
implementation's maximum. The existing SDK `awaitDiagnosticsRefresh` default is
`2,000ms`; R31 keeps that exact ceiling and does not add a second timer, quiet
period, retry, or post-deadline continuation.

The VS Code-only result rule is therefore:

```text
error snapshot/event before 2,000ms -> return observed errors immediately
empty latest snapshot at 2,000ms   -> return "未发现错误"
no snapshot at 2,000ms             -> return the existing bridge failure/empty observation state
```

The file edit is never delayed beyond the current bridge timeout contract, and
the new implementation must not pass a larger timeout to the SDK than the
existing default.

## R32 One-Second Ceiling

R32 supersedes R31 after the user's final timeout correction: the observation
window is explicitly reduced to `1,000ms`. No code path may extend it to the
previous `2,000ms` value, add a second timer, add a quiet period, retry, or
continue after the response.

The OpenCode bridge call owns the `1,000ms` end-to-end ceiling. The VS Code SDK
uses an `800ms` internal observation timer so hidden open and local HTTP return can
finish before that same outer deadline; this is not a second wait window.

```text
error snapshot/event before 1,000ms -> return observed errors immediately
empty latest snapshot at 1,000ms   -> return "未发现错误"
no snapshot at 1,000ms             -> return the existing bridge observation failure state
```

## R32 User-Directed Implementation Record

The user explicitly classified the remaining “latest empty snapshot” behavior
as non-blocking, required the existing behavior to return “未发现错误”, directed
the work to enter TDD, and then said `No more audit`. No independent plan or
implementation approval is claimed.

Implemented files:

- `sdks/vscode/src/lsp.ts`: hidden document only, listener-before-open, immediate
  non-empty return, `800ms` internal timer within the `1,000ms` outer budget,
  latest empty snapshot return, no `showTextDocument`, no 50ms quiet timer.
- `packages/opencode/src/lsp/lsp.ts`: one bridge touch result cached for Tool
  consumption, no second diagnostics HTTP request, no built-in LSP fallback for
  diagnostic touch, explicit bridge failure state.
- `packages/opencode/src/lsp/diagnostic.ts`: user-facing empty wording changed
  from absolute “no errors” to observational “no errors found”.
- `packages/opencode/test/lsp/index.test.ts` and
  `packages/opencode/test/lsp/lifecycle.test.ts`: red/green regressions for
  no-fallback, one bridge request, empty/error snapshot caching, one-second outer
  timeout, and observational wording.
- `.temp/testing/vscode-observer/extension.js` and
  `.temp/testing/vscode-clean-room-probe.ts`: provider-specific command branches
  removed from the release harness; bridge empty responses terminate as accepted
  “未发现错误” observations.

Verification evidence:

```text
packages/opencode:
  bun test test/lsp/index.test.ts test/lsp/client.test.ts
    test/lsp/lifecycle.test.ts test/tool/lsp.test.ts
    test/tool/write.test.ts test/tool/edit.test.ts
    test/tool/apply_patch.test.ts
  -> 164 pass, 0 fail, 382 assertions

packages/opencode:
  bun typecheck
  -> pass

sdks/vscode:
  bun run compile
  -> check-types, lint, and esbuild pass

real isolated Extension Host:
  Python bridgeTouch     -> 846ms, no tab/focus/visible-editor change
  TypeScript bridgeTouch -> 950ms, no tab/focus/visible-editor change

diff gate:
  effective changed implementation/test lines E = 132
  qualifying adjacent Chinese explanatory comments C = 23
  required ceil(132 * 0.15) = 20
```

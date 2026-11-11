# @opencode-ai/codemode

Effect-native confined code execution over explicit, schema-described tools.

CodeMode lets a model write a small JavaScript program that can call only the tools supplied by the host. The program can sequence calls, transform plain data, branch, loop, and run independent calls in parallel without receiving ambient filesystem, process, network, module, or application authority.

The package is currently private to this workspace. Its API is designed around one-shot and reusable execution:

```ts
// One execution
yield * CodeMode.execute({ tools, code })

// A reusable runtime
const runtime = CodeMode.make({ tools, limits })
yield * runtime.execute(code)
```

## Install

Within this workspace:

```json
{
  "dependencies": {
    "@opencode-ai/codemode": "workspace:*"
  }
}
```

Hosts interact with CodeMode through `effect` (tool `run` implementations, `Effect`-typed results), so they should depend on `effect` themselves.

## Quick Start

Define tools with Effect Schema, then place them in the object tree exposed to programs as `tools`:

```ts
import { CodeMode, Tool } from "@opencode-ai/codemode"
import { Effect, Schema } from "effect"

const lookupOrder = Tool.make({
  description: "Look up an order by ID",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  run: ({ id }) => Effect.succeed({ id, status: "open" }),
})

const runtime = CodeMode.make({
  tools: {
    orders: {
      lookup: lookupOrder,
    },
  },
})

const result =
  yield *
  runtime.execute(`
  const order = await tools.orders.lookup({ id: "order_42" })
  return { id: order.id, needsAttention: order.status !== "complete" }
`)
```

`result` is always a `CodeMode.Result`. Program, validation, limit, and tool failures are returned as diagnostics rather than failing the Effect. Host interruption remains interruption.

<!-- 结果边界沿实际解释器行为说明：最后表达式仍可返回，不能误称省略 return 必为 null。 -->

Successful result values are JSON-safe data. An explicit `return` is preferred; otherwise the final top-level expression is the result. A program whose result is `undefined` produces `null`; nested `undefined` values are normalized to `null` as well.

## API

### `Tool.make`

```ts
const tool = Tool.make({
  description,
  input, // Effect Schema (validating) or JSON Schema (render-only)
  output, // optional; same choice
  run,
})
```

`input` and `output` each accept a validating Effect Schema or a render-only JSON Schema document (the natural shape for adapter-provided tools whose schemas arrive as JSON Schema, e.g. MCP definitions). Effect Schema input is decoded before `run` is invoked, and `run` returns the encoded representation of an Effect Schema `output`, which CodeMode decodes and copies before exposing it to the program. JSON Schemas only shape the model-visible signature; values pass through unvalidated (they still cross the plain-data boundary).

`output` is optional. Without it the tool's signature advertises `Promise<unknown>` and the host result is exposed as-is.

The description and schemas are part of the model-visible tool contract. Keep descriptions concrete and put authorization in `run` or in the service it calls.

Public tool types are grouped under the same namespace: `Tool.Definition`, `Tool.Options`, `Tool.SchemaType`, and `Tool.JsonSchema`.

<!-- 签名只展示原始合同；简写仍由实际编码 schema 推导并在原校验器前转换，不从展示文档猜主键。 -->

Effect Schema tools infer deterministic scalar-to-object input forms. For an object with one required scalar property, or a single optional scalar property, `tool(value)` is accepted alongside `tool({ key: value })`. Scalar-only tools keep their original scalar contract; arbitrary single-field objects are not unwrapped. The signature shows the original input contract; these shorthand forms remain accepted at runtime. `undefined`, arrays, ambiguous objects and unsupported schema structures retain their original contract; names such as `path` or `query` are never guessed.

For render-only JSON inputs, an adapter that retains its actual validator may provide `inputContract: actualDecoder`. This one contract supplies the signature, searchable fields and deterministic input forms; it does not add a second decoding step. Without it, JSON schemas remain display-only. Inference reads encoded structure without running transformations or defaults, and normalization precedes the original validator. Authorization still belongs to the tool.

### JSON-text projection

<!-- 结构化文本是宿主显式选择的合同；弱来源不改变业务字段，也不绕过输出校验。 -->

`CodeMode.fromJsonText(text)` lets a host opt an otherwise untyped JSON-text result into structured access. A representable standalone JSON object or array becomes ordinary data; malformed JSON, primitives or values outside the data boundary remain the original string. This is not automatic envelope detection. Declared output schemas still validate the original business data before any convenience alias is installed.

Projected objects retain their original source for `String(value)` and template interpolation. A nonenumerable readonly `.text` alias is available only when the object has no own `text` field. Business fields always win. Mutating the object changes its data/JSON view, not its source snapshot. Retained Notebook values keep that provenance; new objects made by spread or parsing do not inherit it. Ordinary final results and tool arguments contain business data only.

This is intentionally not full string compatibility: use `String(value)` before string methods or `JSON.parse` when handling an opted-in result. The host must choose this policy only where changing untyped object/array JSON text to data is appropriate.

### `CodeMode.execute`

Use `CodeMode.execute` for a single execution:

```ts
const result =
  yield *
  CodeMode.execute({
    tools: { orders: { lookup: lookupOrder } },
    code: `return await tools.orders.lookup({ id: "order_42" })`,
    limits: { maxToolCalls: 10 },
    onToolCallStart: (call) => Effect.logDebug("CodeMode tool started", call),
    onToolCallEnd: (call) => Effect.logDebug("CodeMode tool settled", call),
  })
```

The Effect environment is inferred from the supplied tools. CodeMode does not erase service requirements introduced by tool implementations.

### `CodeMode.make`

<!-- make 继续复用目录与策略；只有显式传入 environment 才复用变量，宿主仍负责生命周期。 -->

Use `CodeMode.make` when the tool set and execution policy are reused. Without an explicit `environment`, each execution starts with fresh JavaScript bindings:

```ts
const runtime = CodeMode.make({
  tools: { orders: { lookup: lookupOrder } },
  limits: { timeoutMs: 30_000 },
})

runtime.catalog() // structured tool descriptions
runtime.instructions() // model-facing syntax and tool guide
runtime.execute(source) // CodeMode.Result
```

`CodeMode.Input`, `CodeMode.Result`, `CodeMode.Success`, `CodeMode.Failure`, `CodeMode.Diagnostic`, and `CodeMode.DiagnosticKind` are both Effect schemas and their inferred TypeScript types. Hosts can combine `CodeMode.Input` and `CodeMode.Result` with `runtime.instructions()` and `runtime.execute()` when constructing a framework-specific agent tool.

All other CodeMode types use the same namespace: `CodeMode.Options`, `CodeMode.ExecuteOptions`, `CodeMode.Runtime`, `CodeMode.ExecutionLimits`, `CodeMode.DiscoveryOptions`, `CodeMode.DataValue`, `CodeMode.ToolDescription`, and the `CodeMode.ToolCall*` observation types.

### Notebook environments

<!-- 复用的是词法值和闭包，不是旧解释器、权限或后台任务；同一环境由宿主串行调用。 -->

Create an environment when variables, functions and closures should survive between calls. Hosts must serialize calls that share it. Calls still use fresh tool capabilities, logs, limits and execution scope:

```ts
const environment = CodeMode.createEnvironment()
yield * CodeMode.execute({ environment, code: "let count = 0; const next = () => ++count; return next()" }) // 1
yield * CodeMode.execute({ environment, code: "return next()" }) // 2
```

A new cell may redeclare a top-level name from an earlier cell; a retained closure reading that name sees its current binding. Same-cell duplicate declarations and assignments to a current `const` binding still fail. Factory closures keep their own local bindings. Mutations before an error, timeout or cancellation remain; parse failure executes nothing. Cells and external effects are not transactions.

<!-- 只保留结算后的值；上一单元结束时取消的 Promise 在下次 await 只作为可捕获失败，不复活生产者。 -->

Completed Promise outcomes may be reused without repeating the producer. Pending work is interrupted and joined at the end of its cell. Awaiting that interrupted Promise in a later cell rejects with an originating-cell-ended error; real host interruption within the current cell remains uncatchable. State is not serialized or restored after process restart.

### Results

```ts
type Result = Success | Failure

interface Success {
  readonly ok: true
  readonly value: CodeMode.DataValue
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: boolean
  // 未观察的后台失败不改变脚本值，由宿主决定如何附加事实提醒。
  readonly unobservedFailure?: boolean
  readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
}

interface Failure {
  readonly ok: false
  readonly error: CodeMode.Diagnostic
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: boolean
  readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
}
```

`toolCalls` contains the names of calls admitted by the runtime in call order. It is retained on failure so hosts can audit partial execution without exposing inputs or host failures. `truncated` is present when capture reached `maxLogBytes` or the value/logs were cut to fit `maxOutputBytes` (see Execution Limits).

### Tool-call hooks

`onToolCallStart` receives `{ index, name, input }` after input decoding and before tool execution. The input is decoded host-side data and may include values produced by schema transformations; applications should avoid logging sensitive tool arguments indiscriminately.

<!-- 根作用域收尾也产生终态事件；宿主必须等这些事实完成后再投影父回执。 -->

`onToolCallEnd` receives `{ index, name, input, durationMs, outcome, message? }` when an admitted call settles. `outcome` is `"success"` or `"failure"`; `message` is the model-safe failure message and is present only on failure. Interrupted calls (for example when the execution timeout fires) produce a failure end event with an interruption message. Both hooks are Effect-returning and must not fail.

### OpenAPI tools

`OpenAPI.fromSpec` turns an OpenAPI 3.x document into a tool subtree - one tool per operation. Dotted `operationId` values form namespaces such as `v2.session.get`. Missing IDs receive a flat method/path fallback such as `getUsersById`; names are sanitized and deduplicated. The host places the subtree under a key in its `tools` tree; that key is the model-visible namespace.

```ts
import { CodeMode, OpenAPI } from "@opencode-ai/codemode"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

const api = OpenAPI.fromSpec({
  spec: await Bun.file("openapi.json").json(), // parsed document (no YAML)
  auth: {
    resolve: ({ name, scopes, operation }) =>
      name === "BearerAuth" ? Effect.succeed({ type: "bearer", token }) : Effect.succeed(undefined),
  },
})

const runtime = CodeMode.make({ tools: { opencode: api.tools } })
const result = await Effect.runPromise(runtime.execute(code).pipe(Effect.provide(FetchHttpClient.layer)))
```

`fromSpec` is synchronous and returns `{ tools, skipped }`. The initial adapter supports query `form`/`deepObject`, path/header `simple`, JSON request bodies, JSON responses, and text responses; unsupported parameter encodings, non-JSON request bodies, binary responses, and streaming operations land in `skipped` instead of producing broken tools. Operation and path servers take precedence over document servers unless `baseUrl` explicitly overrides all of them. Tool inputs flatten path, query, header, and closed object-body fields into one model-facing object while retaining their HTTP locations internally. Cross-location name collisions receive a location prefix such as `path_id` and `query_id`; composed, nullable, dictionary, conditionally-required, and non-object JSON bodies remain under `body`. Auth is never model-visible. Responses are limited to 50 MiB, and non-2xx responses become safe tool failures carrying the status and a size-capped body summary. Deferred capabilities are tracked in `src/openapi/TODO.md`.

Supported bearer, basic, header, and query authentication follows OpenAPI `security` semantics and is resolved host-side via `auth.resolve` - credential storage, OAuth flows, and token refresh never enter the compiler. Cookie authentication alternatives are discarded; an operation is skipped when it has no supported alternative. See the option docstrings in `src/openapi/types.ts` for the full semantics. Generated tools require `HttpClient.HttpClient` (from `effect/unstable/http`) in the Effect environment - provide `FetchHttpClient.layer` or a custom/test client layer at execution. The supplied client owns redirect policy; credentialed hosts should reject redirects or strip credentials when the origin changes.

## Discovery

<!-- 同一紧凑签名用于目录、搜索和误调用恢复；优先级只影响展示，不改变可调用集合。 -->

The agent-tool instructions use a budgeted catalog. Every namespace is listed with its tool count. Inline entries, search results and namespace-call diagnostics share one compact TypeScript signature generated from the tool definition. Tool descriptions remain; field JSDoc and schema tags are not included in compact signatures. Detailed search results provide `inputSchema` and, when declared, `outputSchema` with field descriptions, defaults, formats and `$defs`. Inputs use the encoded contract and outputs use the decoded contract. An Effect schema that cannot be emitted is `null` on that side and named in `schemaUnavailable`; the tool and other results remain discoverable. Original schema validation still applies.

Hosts may supply `discovery.priority` as canonical internal paths, such as `["$opencode.read", "$opencode.glob"]`. Priority entries are considered before other entries; each group is ordered by signature length and path. Entries that do not fit are skipped; namespace stubs and selected entries share the budget. Equal inputs render identically regardless of insertion order. Zero budgets and oversized signatures can omit even priority tools; full discovery remains available.

The catalog-entry budget defaults to 2,000 estimated tokens (characters / 4, the same heuristic OpenCode uses). It includes namespace headings and compact tool entries shown in the catalog; fixed instructions are not counted. Override it when constructing a runtime:

```ts
const runtime = CodeMode.make({
  tools,
  discovery: { catalogBudget: 6_000 },
})
```

The budget must be a non-negative safe integer.

<!-- 搜索示例使用当前同步全局入口，同时如实保留旧工具拼写的兼容性。 -->

The runtime search tool is always registered - including when the catalog is fully inlined - and exposed as the synchronous global `search(...)`; the older `tools.$codemode.search(...)` spelling remains supported. It is only advertised in the instructions when the inlined list is partial:

```ts
const matches = search({
  query: "order status",
  namespace: "orders", // optional: scope to one top-level namespace
  limit: 10,
  offset: 0,
})
```

`search` performs deterministic, additive field-weighted matching. The query is tokenized (camelCase boundaries split; every non-alphanumeric character is a separator; empties and `*` are dropped), and each term scores every tool: exact path or path-segment match (20), path substring (8), description substring (4), and searchable-text substring (2). Each term also carries naive singular variants (trailing `s`/`es` stripped), and a field check passes when the term or any variant matches - so a plural query term (`issues`) still finds a tool whose text only says `issue`, without changing the weights. The searchable text also includes the input schema's property names and their description strings, so a query naming a parameter finds its tool, and substring matching means partial words match. Scores sum across terms; matches are sorted by score (ties broken alphabetically by path), then sliced from the zero-based `offset` (default 0) to the configured `limit` (default 10). Default results include the tool description and compact signature, without full schemas. Set `detail: true` for full field contracts; detailed pages contain at most three tools, even if a larger limit is requested. Exact-path lookups automatically return one tool with full field contracts, even when `detail` is omitted. Pages also use a 16,384-character soft budget measured on the complete serialized response. The first whole entry that reaches or crosses the budget is included, so a single oversized tool stays accessible; `limit` remains a count ceiling. `remaining` counts matches after the current page. `next` is `{ offset }` when another page exists and `null` on the final page; spread it into the original request to preserve its query, namespace, and limit.

```ts
// 翻页复用搜索条件；同步目录查询无需人为加入异步工具调度。
const request = { query: "order status", namespace: "orders", limit: 10 }
const page = search(request)
const nextPage = page.next ? search({ ...request, ...page.next }) : undefined
```

<!-- 紧凑类型不伪装成完整字段文档；可选字段与返回类型仍来自同一 schema。 -->

Each result contains the exact path, description, and the same complete compact signature used inline, for example:

```ts
tools.github.list_issues(input: { owner: string; after?: string; perPage?: number }): Promise<unknown>
```

Result paths are rendered as JavaScript expressions rooted at `tools` (`tools.orders.lookup`, or `tools.context7["resolve-library-id"]` for non-identifier segments), so each `path` is directly usable as the call site. An empty query browses the catalog alphabetically by path; combined with `namespace` (`{ query: "", namespace: "orders" }`) it lists everything in that namespace. A query that names one tool path exactly (canonical path, `tools.`-prefixed path, or rendered JavaScript expression) is treated as a lookup and returns that tool alone.

<!-- 固定说明承载调用原则，动态目录只承载当下工具签名，避免重复注入工作流。 -->

The shared `CodeMode.description` carries a short composition workflow and an example that searches only when a needed tool is not shown. `runtime.instructions()` carries the current complete, partial, or empty catalog separately. Search by the task when a needed tool is not shown, use the exact returned path and signature, compose deterministic steps in code, and return only useful evidence. Independent calls can use `Promise.all`; use `Promise.allSettled` when partial results matter without hiding failures. Dependent calls and conflicting writes stay sequential. No blanket per-call `try`/`catch` scaffolding is required.

A host cannot define its own `$codemode` top-level namespace.

## Supported Programs

CodeMode executes a deliberately bounded JavaScript subset. It supports:

- Plain data literals, property access, assignment, and destructuring.
- `if`, conditional expressions, `switch`, `for`, `for...of` (arrays, strings, Maps, Sets), `for...in` (own keys of plain objects, index strings of arrays, and namespace/tool names of `tools` references - anything else is an error suggesting `for...of` or `Object.keys`, rather than real JS's surprising behavior of indices for strings and zero iterations for Maps/Sets), `while`, and `do...while`.
<!-- 函数帧隔离与共享闭包必须同时成立，异步身份不能靠调用者额外包装修复。 -->
- Synchronous and async arrow functions, function expressions, and declarations with closures, defaults, rest parameters, and destructuring. Async calls return promises, adopt returned promises, and reject on body or parameter-binding errors; each invocation has independent locals and shares captured lexical bindings.
- Optional chaining, nullish coalescing, templates, spread (arrays, strings, Maps, Sets), and `try`/`catch`.
- Common array, string, number, `Object`, `Math`, and `JSON` operations. Mutating array methods include `push`/`pop`/`shift`/`unshift`/`splice` (removes in place and returns the removed elements)/`fill`/`copyWithin`; array `keys`/`values`/`entries` return **arrays** (matching the Map/Set convention) and work with `for...of` and spread. String methods include `localeCompare` (locale/options arguments ignored), `normalize`, and the `trimLeft`/`trimRight` aliases. `Object.keys` also accepts arrays (index strings, as in JS) and tool references: `Object.keys(tools)` lists the top-level namespaces, including `$codemode`, and `Object.keys(tools.ns)` lists the names at that node (a callable tool enumerates as `[]`; an unknown path is an `UnknownTool` diagnostic). `Object.values`/`Object.entries` on a tool reference fail with a pointer at `Object.keys(tools)` and `tools.$codemode.search`.
- `Date` - `Date.now()`/`Date.parse()`/`Date.UTC()`, `new Date(...)`, the getter methods, and date arithmetic/comparison via the time value. Dates stringify as ISO (`toString` included, for determinism across host timezones).
- Regular expressions - `/literals/` and `new RegExp(...)` with `test`/`exec` (stateful `lastIndex` for `g`), plus string `match`/`matchAll`/`replace`/`replaceAll`/`split`/`search` with patterns. Match results are arrays carrying `index` and named `groups` as own properties (`input` is omitted). `replace` and `replaceAll` accept function replacers with captures, offset, input, and named groups; callbacks run sequentially, may await tool calls, and have their results coerced to strings. Invalid patterns, invalid flags, and missing-`g` calls fail with catchable errors that say what was wrong and how to fix it (escaping hints, the exact `/pattern/g` to write). Patterns run on the host engine, so pathological backtracking is bounded only by the execution timeout.
- `Map` and `Set` - construction from entries/arrays/strings, `get`/`set`/`add`/`has`/`delete`/`clear`/`size`/`forEach`, and `keys`/`values`/`entries` returning **arrays** (not iterators).
- URL helpers - `URL` resolution and mutation, linked `URLSearchParams`, `URL.canParse`/`URL.parse`, URI and URI-component encoding/decoding, and query parameter construction, lookup, mutation, sorting, callbacks, and materialization. URLSearchParams iteration methods return arrays, matching the Map/Set convention.
<!-- race 只选择结果，根执行负责终止未完工作；两种边界不可再次混成私有取消政策。 -->
- First-class promises - tool calls and async functions start eagerly; `await` yields before resolving a promise or passing through a plain value. `Promise.all`, `Promise.allSettled`, and `Promise.race` return composable promises over arrays or supported collections mixing promises and plain values. `Promise.all` preserves success order and rejects on the first observed failure. `allSettled` preserves input order and catch-normalized rejection reasons, while host interruption propagates immediately. `race` chooses the first settlement without canceling its members; retained promises remain awaitable. An empty `race` stays pending until execution timeout or interruption. `Promise.resolve`/`Promise.reject` construct settled promises. `.then(onFulfilled, onRejected)` and `.catch(onRejected)` share the collection callback surface, adopt returned promises, and preserve host interruption; missing or non-function handlers pass the settlement through. Only actual tool calls consume the shared eight-call limit. All promises belong to one execution scope: pending work is interrupted when execution ends, not extended into background work or converted into an unhandled-rejection replacement for an explicit result. Already-started external side effects cannot be rolled back. The deliberate async string-replacer extension remains as described above; ordinary collection callbacks receive normal function return values (for example, async `map` produces promises).
<!-- 等待沿用当前根作用域，不占工具许可；异步迭代只扩展既有集合，不引入另一套执行器。 -->
- `sleep(ms)` returns a scoped promise for a finite numeric duration from `0` through `2**31 - 1` milliseconds. Fractional durations are accepted. It works as a saved alias or callback, does not consume tool-call limits, and its pending timer is released when the execution ends. A saved alias in a later Notebook cell belongs to that new cell.
- `for await...of` supports the same arrays, strings, Maps and Sets as `for...of`. Each yielded promise settles before binding and the body runs sequentially; Map entry pairs are not recursively awaited. Rejection, `break`, `continue`, `return` and cancellation retain the existing loop/root cleanup behavior. Custom async iterators and generators are not provided.
- `throw value` and `throw new Error(message)` for explicit program failure. `Error` (and `TypeError`/`RangeError`/`SyntaxError`/`ReferenceError`/`EvalError`/`URIError`) are real constructors, callable with or without `new`; error values are plain `{ name, message }` data that additionally satisfy `instanceof Error` (a specific type matches itself and `Error`, as in JS). Every caught failure - thrown errors, interpreter runtime errors, and tool failures - is `instanceof Error` in a `catch` block; a thrown non-error value (`throw "text"`) is not, matching JS. Caught failures carry the `name` the equivalent real-JS failure would have - `JSON.parse` and invalid regex patterns produce a `SyntaxError` (satisfying `instanceof SyntaxError`), an unknown identifier a `ReferenceError`, assigning to a constant a `TypeError`, a bad `normalize` form a `RangeError`; failures with no specific analogue (including tool failures) are named `"Error"`. `instanceof` also recognizes `Date`, `RegExp`, `Map`, `Set`, `URL`, `URLSearchParams`, `Array`, `Object`, and `Promise`; any other right-hand side is a catchable error.

Inside a program, standard-library values stay live everywhere: the internal data checkpoints (`Object.*` helpers, spread, coercion inputs) preserve the instances, so `Object.values({ d: date })[0].getTime()` and a spread copy of an object holding a Map keep working. Only at the host boundary (final result, tool arguments, `JSON.stringify`) do they serialize exactly as `JSON.stringify` would: Date and URL become strings (an invalid Date becomes `null`), while RegExp, Map, Set, and URLSearchParams become `{}`. Promise values never cross a data boundary: an un-awaited promise in a result or tool argument produces a diagnostic that says to await it, instead of serializing to `{}`.

It does not expose `eval`, dynamic imports, modules, classes, generators, timer handles (`setTimeout`/`setInterval`), host globals, prototype mutation, custom promise constructors (`new Promise`), `Promise.prototype.finally`, or arbitrary method calls. Unsupported syntax returns an `UnsupportedSyntax` diagnostic with a source location when available.

CodeMode is an orchestration language, not a general JavaScript runtime.

<!-- 误调用提供当前目录的有限完整签名；这不是另一条自动恢复执行路径。 -->

Calling a namespace instead of a function remains an `UnknownTool` error. The diagnostic includes up to 2,000 characters of whole compact member signatures, plus an omitted-count hint when needed. It never guesses a member and executes it. Search remains available for member signatures that do not fit.

### OpenCode host behavior

<!-- 显示选择与执行权限分开；隐藏直接工具不能删除Execute内部可用定义。 -->

The host reads `OPENCODE_EXECUTE` and `OPENCODE_EXECUTE_KEEP_TOOLS` at startup; both default to `true`. Set `OPENCODE_EXECUTE=false` to keep only the original tools. With Execute enabled, `OPENCODE_EXECUTE_KEEP_TOOLS=false` hides script-callable tools from the direct provider list while retaining them inside Execute. Restart after changing these process-level switches. Permission filtering still applies to both paths; control tools keep their existing role.

<!-- 宿主识别自身工具和 MCP 传输事实，通用库不猜测来源或剥离任意业务信封。 -->

OpenCode gives current native `read`, `grep`, `glob` and `edit` tools inline priority when their actual captured validator is available. Filtered tools stay absent; same-named custom or MCP tools do not inherit native priority. Global `search(...)` remains discovery, not a fabricated native search tool.

For a successful MCP result with no declared output schema or native structured content, OpenCode opts a single text block into JSON-text projection. Media attachments may accompany that text. Multiple text blocks, resource content, transport errors, declared outputs and existing structured results keep their established handling. SDK validation is not bypassed. In particular, declared strings and JSON primitives remain strings.

<!-- 只提示未观察失败；已 catch 或 allSettled 的失败留在调用审计，不再重复告警。 -->

OpenCode keeps the script's return value separate from admitted tool-call outcomes. When a normally returning script leaves a failed or interrupted Promise unobserved, its result carries `unobservedFailure` and the host adds a short warning. Deliberately caught or allSettled-observed failures remain in tool-call metadata without an extra warning. Successful calls and already-started external effects are not rolled back. The script value itself is unchanged; the host also prefixes the environment handle described below.

<!-- 完整句柄只是同会话同位置的查找键；省略表示新建，错误句柄不能自动退回新环境。 -->

Each OpenCode call starts a new environment unless `environmentID` is supplied. Responses begin with `Environment: env_...`; pass that complete ID in the next call to resume its variables, functions and closures. IDs also appear in ordinary error/timeout output and tool metadata. Unknown, evicted or wrong-owner IDs fail without running a replacement cell. A handle is scoped to the current Session, directory and workspace, not an access token. Each cell still performs current permission and tool-availability checks; saved helpers do not retain old approvals.

<!-- 每个owner保留最近调用的八个唯一状态；忙项先等清理，再按最新顺序淘汰。 -->

Environments are process-local, with the eight most recently used unique IDs retained per Session and Location. Reusing an ID refreshes its position at admission; completion order does not. When a ninth environment is requested and the oldest still has active or queued leases, admission waits for its cleanup and then rechecks the latest order. A canceled admission does not allocate a new environment or cancel the holder. There is no time-based expiry. The count limit does not bound retained bytes or peak heap. Session deletion/movement and instance disposal retire affected environments; compaction does not. Same-environment cells wait for prior cleanup; different environments can run concurrently, and canceling a waiter does not cancel its holder.

<!-- 展示包装只规范一次，审批与真实执行必须观察同一份代码。 -->

The host accepts either raw source or one complete JS/TS code fence with no surrounding prose or other fences. It removes that presentation envelope once before preflight, permission review and execution; the library itself continues to receive plain source. TypeScript annotations use the existing transpilation path, without a separate execution mode.

<!-- 预跑只修改环境副本；无法复制或探测不完整时，真实调用仍经过权限入口。 -->

Before review, the host deep-copies the leased environment for a best-effort probe with a 2,000ms execution budget. Old variables and helpers are visible in the copy. Unsupported copy state stops the probe; calls collected before an ordinary probe failure are retained. Current runtime permissions still apply to every real call. The copy is released after its execution scope closes. As with execution itself, a cooperative timeout cannot preempt synchronous cloning or compilation.

<!-- 父进度合并不影响子调用审计和最终持久化；全文交给既有截断服务。 -->

Parent progress uses a 100ms opportunity window without a background timer. Initial metadata and final settlement are durable; intermediate progress is ephemeral. Final metadata includes every admitted call. The complete textual result uses the shared output truncation service and its recoverable file path, without changing the program value.

## Execution Limits

The limits are optional host-selected bounds:

| Limit            |              Default | Bounds                                                               |
| ---------------- | -------------------: | -------------------------------------------------------------------- |
| `timeoutMs`      |    none - no timeout | Wall-clock execution time.                                           |
| `maxToolCalls`   |     none - unlimited | Tool calls admitted during the execution.                            |
| `maxOutputBytes` | none - no truncation | Model-facing output: the serialized result value plus captured logs. |
| `maxLogBytes` | none - unlimited | UTF-8 bytes retained while appending logs; later lines are counted but not stored. |

<!-- 库默认值与应用策略分离：十分钟只由 OpenCode 宿主选定，不能改变独立库调用者的合同。 -->

The library has no default limits: execution budgets are host policy. OpenCode's `execute` tool accepts an optional integer `timeout` from 1 to 2,147,483,647 milliseconds and defaults to 600,000ms. The execution budget begins after any same-environment queue wait, preflight and whole-script review. Runtime questions and permission approval pause it; the last overlapping wait resumes only the remaining budget. Ordinary tool work and admission queues still consume it. User cancellation and leaf-tool limits still apply independently. OpenCode also owns model-output truncation, so it leaves the library's `maxOutputBytes` unset and uses the existing output byte limit for `maxLogBytes`. Other hosts should choose the bounds appropriate to their tool and output contracts.

Pass only the overrides you need:

```ts
const runtime = CodeMode.make({
  tools,
  limits: {
    maxToolCalls: 20,
    timeoutMs: 60_000,
  },
})
```

Limits are safe integers. `timeoutMs` must be between `1` and `2,147,483,647`; the others may be `0`. Invalid configuration throws a `RangeError` when `CodeMode.make` or `CodeMode.execute` is called. An explicitly `undefined` value is the same as leaving the limit unset.

Exceeding a configured `maxOutputBytes` never fails the execution. An oversized result value is replaced by its truncated serialized text plus an explanatory marker, logs are kept from the start until the remaining budget is exhausted (with a final marker line noting the cut), and the result carries `truncated: true`.

When configured, the timeout interrupts in-flight tool Effects, including eagerly started calls the program has not awaited (their fibers are supervised by the execution). The interpreter yields cooperatively between steps, so the timeout also interrupts pure busy loops (`while (true) {}`) - no separate work budget exists. Tool implementations remain responsible for making their external operations interruptible or independently bounded.

<!-- 工具排队与实际叶调用分开，不能把原本不存在的通用单调用计时器写成已修复缺陷。 -->

The shared eight-slot semaphore surrounds tool invocation before decoding, admission accounting, hooks and execution. Synchronous discovery bypasses it; timers do not occupy slots. Queued calls are not reported as running and can be canceled without later host work. Leaf-tool and fetch timers start only when their implementations begin after admission; no additional generic per-call timeout is introduced. The script timeout still includes waits for tool slots.

Two runtime internals are fixed constants rather than knobs: at most 8 tool calls run concurrently, and values crossing a data boundary may nest at most 32 levels deep (deeper values fail as `InvalidDataValue`, which reads better than a native stack-overflow error). Neither is part of the public contract.

## Diagnostics

Failures are data:

| Kind                    | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                                                     |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                                                       |
| `UnknownTool`           | A program referenced a tool the host did not provide.                                                    |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.                                                  |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.                                                 |
| `InvalidDataValue`      | Program data violated the plain-data contract (depth, circularity, blocked properties, non-data values). |
| `ToolCallLimitExceeded` | Calls exceeded `maxToolCalls`.                                                                           |
| `TimeoutExceeded`       | Execution exceeded `timeoutMs`.                                                                          |
| `ToolFailure`           | A tool refused or failed.                                                                                |
| `ExecutionFailure`      | The program threw or another execution error occurred.                                                   |

Unknown host failures, defects, invalid outputs, and copying failures are sanitized. To return a safe operational refusal, fail with `toolError`:

```ts
import { toolError } from "@opencode-ai/codemode"

run: ({ id }) => (authorized(id) ? loadOrder(id) : Effect.fail(toolError("Order is unavailable")))
```

Only the supplied message is model-visible. The optional cause is never returned in `CodeMode.Result`; hosts should perform any required internal logging before crossing this boundary.

## Authority Boundary

CodeMode confines programs to the supplied tool tree, but it does not decide what those tools may do.

The host owns:

- Authentication and authorization.
- Tool selection and immutable scope.
- Credentials and network clients.
- Persistence, idempotency, approval, and durable side effects.
- Logging and redaction policy.

CodeMode owns:

- Parsing and interpreting the supported subset without `eval`.
- Schema boundaries around tool calls.
- Plain-data copying and blocked prototype members.
- Resource limits, call accounting, and normalized diagnostics.
- Model-facing tool discovery and instructions.

A program cannot gain authority through prose or generated code. It can only exercise authority already present in the supplied tools. Do not expose a broad tool and expect the prompt to restrict it.

## Laws

The public contract is guided by these equivalences:

- `CodeMode.execute({ ...options, code })` is equivalent to `CodeMode.make(options).execute(code)`.
- A tool implementation is not invoked unless its input has decoded successfully.
- A tool result is not visible to the program unless its output has decoded and crossed the plain-data boundary successfully.
- Unknown host failures do not become model-visible diagnostics; `ToolError` is the explicit safe-message channel.
- Host interruption remains interruption rather than a `CodeMode.Failure`.

## Non-Goals

- Generic permission prompts or approval workflows.
- Durable pause/resume, replay, or storage adapters.
- Exactly-once external side effects.
- Application authorization or product policy.
- A filesystem or process sandbox for arbitrary JavaScript.
- Compatibility with the full JavaScript language or npm ecosystem.

Applications that need approval or durable consequences should model those above CodeMode and expose only the currently authorized tools.

## Testing

From the package directory:

```sh
bun test
bun run typecheck
```

The direct suite covers public projections, discovery, schema boundaries, diagnostic sanitization, resource limits, tool-call observation, and interruption.

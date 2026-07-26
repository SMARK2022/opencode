# Canonical Implementation Plan: Session Prompt Preflight Latency and Lazy Snapshot

> Status: verified
>
> Revision: R34
>
> Approved revision: R34
>
> Audit mode: implementation
>
> Requirement source: Session GOAL and the quoted clarifications below
>
> Implementation allowed: yes
>
> Last updated: 2026-07-26

This file is the sole implementation specification for this task. Chat summaries,
superseded revisions, `stash@{0}`, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，检查当前行为设计，先写 tokens=0
> snapshot.track() 在 create 时同步 应该改成首个副作用工具调用之前进行相应的snapshot构建（同时每个工具可以添加一个相应的metadata，尽量保持整体风格一致，同时metadata中，edit/write/apply_patch/bash这几个增加相应的副作用参数;）
> 第二笔 updateMessage(估算);MessageV2.chronology 在工具goal启动才进行扫描、同时只扫描最近两个lastturn部分（避免因为最近的compaction导致识别错误）
> 1. Messages 历史（user / assistant / 已发生的 tool 调用与结果） 已完成前缀基本稳 要优化（filter 窗口 + toModelMessages 前缀缓存 + 后缀增量）。
> 然后针对完整问题进行完整的修改，请确保修改后的内容不会出现红测问题，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在12个代码文件以内，同时代码修改不超过1200行。
>
> 默认 "none"：不把 ambient worktree 变化算作本工具副作用。仅影响 snapshot/revert 归因，不进 LLM schema。
>
> none 不认领 worktree 文件变更；declared 只认工具 metadata 声明的文件，适用 edit/write/apply_patch；ambient 可能有不透明副作用，适用 bash/shell、未知 MCP，task 子 agent 间接改文件时需另议。
>
> 其中所有非none的会触发第一次snapshot。
>
> 自行提高上限到16；同时保持整体克制实现。
>
> 额外授权一次 R32 full-scope plan audit，以补齐 warm cache 下本地
> `tool.definition` freshness 测试。
>
> 授权一次 R33 full-scope plan audit，以先收缩重复测试代码再完成剩余行为。
>
> 授权一次 R34 full-scope plan audit，合并动态 surface 测试并补 exact
> full-hit 性能信号。

The later clarification replaces, rather than preserves, the zero publication:

> 谁要求保留两笔了？那个是我让检查的内容，也就是需要修改的内容。
>
> **先写 tokens=0** 对发模型零收益；只制造 UI 闪 0 和一次多余 DB/sync 写。

The cache contract is one replaceable entry with full, prefix, or no hit:

> 如果缓存的内容是不能用的,那么我们这一次就要重新进行完整的序列化等等操作。而如果这一次前缀部分没有变,只增加了后面的东西,那理论来说缓存是可以用的。
>
> 缓存了A、B、C、D、E、F、G,当前从G我们用户撤销到了E,那么我们理论上来说A到E的所有内容都是可以用的。
>
> 整体列表最好只保留一个 [...] 如果全都命中不了,那么我们就直接进行撤销,重建就可以。

Additional binding clarifications:

> 注意整体有可能是增量也有可能是撤销甚至撤销压缩的marker
>
> 前缀不是一直稳定的
>
> 请focus on 任务而非过度的defensive
>
> 集中堆放不是计0而是完全不通过！禁止存在
>
> 一个方案应该进行完整的方案构建,然后再完整地进行方案实施,而不能进行方案构建,实施,构建,实施。

Audit-cycle authorization recorded verbatim from the 2026-07-26 user decision:

> 授权新六轮周期 (Recommended)

This answered the exact question: “是否明确授权本任务从 R25 起重新开始最多
6 轮独立 full-scope plan audit，并将 R1-R24 仅作为历史记录、不计入这个新周期？”
R26 was round 1, R27 round 2, and R28 is round 3 of that newly authorized cycle.

Target terminal state: verified implementation, independent implementation audit,
and one commit containing only this GOAL.

## 2. Explicit Non-Goals

- Do not cache Tool schemas, Permission decisions, control-panel selection, MCP
  connection state, system instructions, or Plugin Tool-definition output.
- Do not replace `TokenEstimate`, omit `inputBreakdown`, or ask the Provider for
  pre-dispatch usage; Provider usage does not exist before dispatch.
- Do not add a persisted cache, migration, EventSequence dependency, asynchronous
  dirty subscriber, per-Session cache Map, or multiple retained generations.
- Do not change Snapshot storage, patch format, pruning, restore semantics,
  Provider request format, or generated SDK contracts.
- Do not infer exact files for `ambient`; its Snapshot patch is best-effort.
- Do not assign Task child-Session worktree ownership in this revision.
- Do not add malformed-row cleaning or speculative compatibility branches.
- Do not touch unrelated CI/voice, HttpApi search, Git asset, LSP, VS Code, or
  Windows precheck worktree changes.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `AGENTS.md` | Small natural changes, package-local verification, no unrelated edits. |
| `packages/opencode/AGENTS.md` | Effect service/module and database ownership conventions. |
| `CONTEXT.md` | Canonical Session, Message, Tool, Snapshot, Revert, Project and InstanceState language. |
| `docs/adr/README.md` | No ADR is needed for this bounded repair. |
| `docs/adr/0001-...` | Unrelated to Session preflight. |
| `.opencode/policy/first-principles-engineering.md` | First-divergence repair, one path, no fallback, full traceability and independent audit. |
| `.opencode/templates/canonical-plan.md` | Required artifact fields and audit transitions. |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `session/prompt.ts:1142-1388,2546-3044` | Tool/MCP adapters, repeated history assembly, loop-head Goal scan, zero and estimate writes, Plugin transform, dispatch | observed |
| `session/processor.ts:105-212,490-819,917-1127` | eager Snapshot, Tool event ordering, Patch and cleanup | observed |
| `session/message-v2.ts:818-959,989-1394,1508-1756` | hydration, conversion, pagination, Compaction filter, chronology and latest | observed |
| `session/compaction-boundary.ts:1-74` | completed boundary currently ordered by ID | observed |
| `session/revert.ts:46-136,157-209` | lexical tail/range/cleanup and declared intersection | observed |
| `session/session.sql.ts:164-217`, `storage/schema.sql.ts:3-10` | persisted Message/Part row identity and timestamps | contracted |
| `session/session.ts:726-759,878-925` | authoritative writes, paging and removals | observed |
| `tool/tool.ts:45-93`, `tool/registry.ts:365-391` | Tool metadata owner and internal projection | observed |
| `tool/edit.ts`, `write.ts`, `apply_patch.ts`, `shell.ts` | declared and ambient Tool owners | observed |
| `tool/goal.ts:1-166` | trusted GoalTurnContext consumer | contracted |
| `server/.../handlers/session.ts:399-430` | reachable public Message/Part mutations; no new guard is planned because admission is exact | reachable |
| `test/session/prompt.test.ts` | public SessionPrompt/TestLLM, Goal, Compaction, queued and Revert fixtures | observed |
| `test/session/snapshot-tool-race.test.ts` | existing execute-before-event Snapshot race | observed |
| real opencode DB and Snapshot benchmark | 5405-Message chronology and git contributor timings | observed |
| `stash@{0}` | superseded implementation archive, diagnostic history only | observed |

## 5. Current Behavior

```text
SessionPrompt.runLoop iteration
  -> filterCompactedEffect: identify boundary, page and hydrate complete window
  -> latest + full MessageV2.chronology even if Goal Tool is never called
  -> create Assistant(tokens=0)
  -> durable updateMessage(0), visible to Sync/TUI
  -> SessionProcessor.create -> Snapshot.track()
  -> resolve fresh builtin/MCP Tools
  -> mutate working Messages through reminders/Plugin transform
  -> toModelMessagesEffect over complete window
  -> sanitize/stringify final body and compute breakdown/estimate
  -> durable updateMessage(estimate)
  -> Provider dispatch
```

Every continuation or later run repeats complete hydration and conversion.
`inputBreakdown` also scans the final request, but that scan is required for the
actual estimate/TUI snapshot and is not the avoidable database/cold-hydration
cost. Snapshot is captured before Tool selection proves a worktree mutation is
possible. Text-only, read-only, denied and Provider-executed steps therefore pay
git work before dispatch.

Ordering is inconsistent: pagination persists `(time_created,id)`, while
Compaction boundary selection, `filterCompacted`, `latest`, and Revert tail/range
logic use lexical ID order. Public callers can supply a later low ID, so IDs are
identifiers rather than chronology.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| text/read-only step | Agent + local Tool | no worktree ownership | Prompt -> Processor -> Provider | Prompt/Processor | observed |
| edit/write/apply_patch | builtin Tool | declared files are reported in Tool metadata | local execute adapter | Tool/Processor/Revert | observed |
| bash/shell | builtin Tool | arbitrary worktree mutation is possible | local execute adapter | Tool/Processor/Revert | observed |
| connected MCP Tool | MCP client | side effects are opaque | MCP execute adapter | Prompt/Processor | reachable |
| Provider-executed Tool | Provider stream | local execute adapter is not called | Processor event | Processor | observed |
| Tool set changes | permission/control panel/MCP/plugin | current step owns availability | resolveTools | Prompt | observed |
| queued user Message | public prompt while busy | append is persisted | next iteration | Prompt/MessageV2 | observed |
| Revert A-G to A-E | SessionRevert | selected suffix becomes hidden | later run | Revert/MessageV2 | observed |
| successful Compaction | SessionCompaction | window reorders while old rows may remain | same/later run | CompactionBoundary/MessageV2 | observed |
| caller-selected low ID | public Message input | ID need not reflect creation time | latest/Revert/Compaction | MessageV2 | observed |
| Plugin Message transform | plugin hook | may mutate any historical working Message | pre-dispatch hook | Prompt | reachable |
| different Session/model | another request | conversion is not transferable | later Prompt run | Prompt | reachable |

Speculative malformed rows, downstream normalization and serialization recovery
cannot justify production branches.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A normal Provider attempt has no durable zero Assistant; its first durable Assistant contains estimate/breakdown before dispatch. | explicit clarification; current two writes | partial token/Prompt coverage |
| INV-02 | Pre-dispatch failure/interruption remains one durable completed typed-error Assistant; preflight Compaction leaves no dangling attempt. | current early publication supplies visibility | partial interruption coverage |
| INV-03 | A step with no local non-`none` Tool performs no Snapshot git operation. | explicit requirement; eager create | absent focused matrix |
| INV-04 | The first local declared/ambient Tool awaits one shared pre-Tool Snapshot before plugin, Permission, MCP client or mutation. | explicit requirement; observed event race | race coverage partial |
| INV-05 | Provider-executed Tools never trigger local Snapshot. | ownership boundary | no sensitive Prompt test |
| INV-06 | worktree defaults none, stays outside Provider schema, persists only at the existing `ToolPart.metadata.worktree` primitive key through every lifecycle transition, and drives declared exact or ambient same-Assistant Revert. | explicit policy; reachable metadata replacement | ambient/lifecycle coverage absent |
| INV-07 | One replaceable cache supports full hit, common-prefix hit including A-G -> A-E, or full rebuild; miss is not an error fallback. | explicit cache contract | absent |
| INV-08 | Admission proves the raw Compaction window before hydration; every reminder, queued wrapper, decide rewrite or Plugin transform invalidates/reconverts its affected working suffix without mutating cached canonical data. | timing red; reachable working transforms | absent |
| INV-09 | Tool/MCP/Permission/control-panel/schema resolution remains fresh each step. | explicit clarification | partial dynamic tests |
| INV-10 | Prompt, Compaction, latest/tasks, cache and Revert use persisted `(time_created,id)` chronology. | low-ID producer; R22 B-01 | Goal low-ID only |
| INV-11 | Ordinary steps do no Goal chronology query; actual Goal Tool start reads at most two canonical eligible turns. | explicit requirement | latency seam absent |
| INV-12 | Estimate/breakdown still describe the final Provider request and are replaced by confirmed usage only after response. | accounting contract | token tests exist |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | `runLoop` durably writes a new all-zero Assistant before assembly has produced an estimate or error. | SessionPrompt Assistant lifecycle | `prompt.ts:2788-2803,3034-3044` |
| INV-03/04/05 | `SessionProcessor.create` captures before a Tool exists; event-side rescue is not the local execute barrier. | SessionProcessor + Prompt Tool adapter | `processor.ts:189-202,712-749`; race output below |
| INV-07/08 | each loop fully filters/hydrates before any prefix admission and converts the complete window. | MessageV2 window + SessionPrompt cache owner | `prompt.ts:2581,2892`; timing red below |
| INV-09 | moving dynamic definitions into the cache would cross `resolveTools` ownership. | SessionPrompt.resolveTools | `prompt.ts:1206-1385` |
| INV-10 | consumers compare caller-controlled IDs after storage defines persisted order. | MessageV2/CompactionBoundary/Revert | current ranges and R22 B-01 |
| INV-11 | `deriveGoalTurn(MessageV2.chronology(sessionID))` executes at each loop head. | SessionPrompt + MessageV2 | `prompt.ts:2587-2591` |
| INV-12 | no divergence; final-body estimate scanning is required and retained. | TokenEstimate/Prompt | `prompt.ts:2897-2981` |

### Red-capable feedback loop

The following read-only command was run from the repository root. It exercises
the two current preflight contributors against the user's real database and
active Snapshot repository, and exits non-zero when the current path reproduces
either material latency contributor. The command body below is the reproducible
shape; the concrete Session ID and active gitdir are selected from the local
read-only fixture at execution time:

```bash
python3 - <<'PY'
import json, os, sqlite3, statistics, subprocess, time

db = sqlite3.connect(os.environ.get("OPENCODE_DB", "/Users/sunbenteng/.local/share/opencode/opencode.db"))
session_id = os.environ.get("OPENCODE_SESSION", "ses_1296dfec8ffeF4HyjYjd4NbDUk")

def chronology():
    messages = db.execute(
        "select id, session_id, time_created, data from message where session_id = ? order by time_created, id",
        (session_id,),
    ).fetchall()
    parts = db.execute(
        "select message_id, json_extract(data, '$.type'), json_extract(data, '$.synthetic'), json_extract(data, '$.metadata.goal_continuation') from part where session_id = ? order by message_id, id",
        (session_id,),
    ).fetchall()
    for message in messages:
        json.loads(message[3])
    return len(messages), len(parts)

def median_ms(action):
    samples = []
    for _ in range(7):
        started = time.perf_counter()
        action()
        samples.append((time.perf_counter() - started) * 1000)
    return statistics.median(samples), min(samples), max(samples)

counts = chronology()
chronology_ms = median_ms(chronology)
repo = os.getcwd()
snapshot_ms = median_ms(lambda: (
    subprocess.run(["git", "diff-files", "--quiet"], cwd=repo, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
    subprocess.run(["git", "ls-files", "-m"], cwd=repo, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
))
print("RED preflight chronology:", counts, chronology_ms)
print("RED preflight snapshot-track-like:", snapshot_ms)
if chronology_ms[0] >= 20 or snapshot_ms[0] >= 80:
    raise SystemExit("RED: reproduced a material preflight contributor")
PY
```

Observed result on 2026-07-25:

```text
RED preflight chronology: session=ses_1296dfec8ffeF4HyjYjd4NbDUk messages=5405 parts=20834 min=65.2ms median=70.5ms max=437.1ms
RED preflight snapshot-track-like: gitdir=.../8cc856836d9ad45b7e458478c8844c8d30569ac0 min=105.2ms median=122.7ms max=131.3ms
```

Minimized reproduction: a Session with no active Goal still pays a full
chronology query; a text-only or read-only step still pays one pre-stream
Snapshot track. The standalone command records contributor cost and deliberately
does not claim call-path removal after implementation; focused SessionPrompt
tests provide that path evidence. The benchmark does not include Provider
latency.

R21 implementation then established the cache-specific red through the approved
public SessionPrompt/TestLLM seam:

```text
bun test --timeout 60000 test/session/prompt.test.ts \
  --test-name-pattern "reuses one retained Message prefix across Session runs"

full toModelMessagesEffect median: 3.3ms
next-run dispatch: 236.41ms
approved threshold: 42.13ms
result: 0 pass, 1 fail
```

The 2048 valid closed-turn fixture removes Provider latency as an explanation:
the local TestLLM response is immediate, and the literal request body remains
the independent correctness oracle. Full conversion alone is too small to
explain the observed dispatch cost. Therefore a design that hydrates the whole
canonical window before checking the cache cannot turn this feedback loop green;
MessageV2 must prove an unchanged raw prefix before full hydration.

### Execute-boundary race feedback

The first R4 implementation slice added a real SessionPrompt test with a public
Snapshot observer and a wrapped builtin Tool execute. The command:

```text
bun test test/session/prompt.test.ts --test-name-pattern "first declared tool snapshots once"
```

went red with the observed sequence:

```text
expected: track, track:end, execute, track, track:end, patch
received: track, execute, track:end, track, track:end, patch
```

This is a reachable AI SDK ordering fact: handling `tool-input-start` begins an
Effect, but the SDK may begin the local Tool execute before that handler's
asynchronous `snapshot.track()` has completed. Therefore an event-only capture
cannot satisfy the before-mutation invariant; the actual local execute wrapper
must await the processor-owned capture immediately before invoking the Tool
implementation.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Assistant pre-dispatch lifecycle | SessionPrompt.runLoop | first normal durable state is estimated; failures remain durable | Prompt owns assembly/dispatch | TUI cannot repair database timing |
| Tool worktree policy | Tool.Def + `ToolPart.metadata.worktree` | definition semantics and one durable server-owned key in the existing metadata record | definition knows semantics; Processor owns preservation | Snapshot/Revert cannot infer names or use state metadata |
| shared lazy Snapshot | SessionProcessor Handle called by Prompt adapters | first non-none local execute awaits one baseline | Processor owns one request | individual Tools cannot coordinate |
| fresh Tool availability | SessionPrompt.resolveTools/MCP | build current callable set every step | existing availability owner | Message cache contains history only |
| fresh control-panel state | SessionPrompt.runLoop | re-read current persisted Session at each while step before Tool/Permission resolution | queued prompt can update permission while busy | loop-entry Session snapshot becomes stale |
| proof/hydration/conversion | MessageV2 | one Compaction-aware row-to-model seam | owns rows, cold hydration and conversion | Prompt must not duplicate storage/filter logic |
| retained entry | SessionPrompt service closure | full/prefix/miss replacement | owns request lifetime | no global or per-Session authority |
| Goal turn tail | MessageV2 query lazily called by Prompt | latest two canonical turns | storage owns bounded SQL | Goal Tool should not scan persistence |
| Revert range/files | SessionRevert | persisted chronology and declared/ambient attribution | owns hide/restore scope | cache cannot compensate downstream |

## 10. Single Approved Primary-Path Design

### 10.1 One estimated Assistant write

`runLoop` creates the Assistant only in memory. Processor creation becomes a
cheap lazy-Snapshot setup. Prompt resolves fresh Tool/system surfaces, builds
the final Message body, computes `inputBreakdown` and `estimatedInput`, then
performs the first normal `updateMessage` immediately before dispatch.

```text
create in-memory Assistant(tokens=0)
  -> fresh tools/system/messages/estimate
  -> durable Assistant(estimate + breakdown)
  -> provider dispatch
```

The zero value remains an internal constructor default, never a Sync/TUI event.
A pre-dispatch failure or interrupt writes that same Assistant once with the
existing typed error and `time.completed`, then propagates. Successful preflight
Compaction discards the unpersisted attempt because no Provider attempt occurred.
`TokenEstimate`, request serialization and raw-parts breakdown remain after cache
assembly because they describe the request actually dispatched.

### 10.2 Tool worktree policy and lazy Snapshot

Add the requested server-owned field to `Tool.Def`:

```ts
worktree?: "none" | "declared" | "ambient"
```

Policy assignments:

| Tool source | Policy |
| --- | --- |
| edit, write, apply_patch | `declared` |
| bash/shell | `ambient` |
| task | no assignment; child-Session ownership remains deferred |
| connected unknown MCP Tools | `ambient` for the current step |
| all unannotated Tools | `none` |

Registry forwards this field only to internal Prompt resolution; it is absent
from Provider descriptions and schemas. Persistence uses the existing open
`ToolPart.metadata` record and one primitive server key:

```text
part.metadata.worktree = "declared" | "ambient"
```

Absence means `none` and preserves old rows without Schema, HttpApi, SDK or
migration changes. Tool result/progress metadata remains in
`part.state.metadata` and is never a policy authority. Provider replay already
accepts only object-valued provider namespaces from `part.metadata`, so this
primitive marker is excluded; the final Provider-body test remains authoritative.

`SessionProcessor.Handle` exposes one internal pre-execute operation. Builtin
and MCP adapters invoke it as their first effect, before plugin, Permission, MCP
client or Tool implementation. For non-`none`, the Processor writes the server
key and awaits one processor-scoped cached `snapshot.track()` attempt. The
existing Tool permit is extended to every persisted Tool Part read-update-write,
not only terminal writes, so pre-execute, `tool-call`, progress, complete, error
and cleanup cannot overwrite one another from stale Parts. The central update
path carries the latest server key across provider-metadata replacement; terminal
and cleanup transitions spread that latest Part. Only pre-execute sets the key,
and it overrides any same-named provider value. `none` is a no-op.
Provider-executed Tools never enter the local adapter and receive no key. Concurrent local
non-`none` calls share the same Snapshot attempt.

Remove capture from Processor creation and `start-step`. Post-step/cleanup patch
generation runs only when a pre-Tool baseline exists; Patch Part creation remains
the only delta producer. Revert reads only the exact primitive
`ToolPart.metadata.worktree`: declared Tools continue to use existing
result metadata for exact files, while an Assistant containing an ambient Tool
admits that Assistant's Patch files as best-effort. Missing/none admits nothing;
no shell parser, state-metadata lookup or fallback is added.

### 10.3 Message window and one-entry cache

`MessageV2` adds one Compaction-aware window seam. Its proof operation reads an
ordered window without hydrating business objects. Each Message and ordered Part
proof contains exact raw SQLite `data`, ID, persisted timestamps, cold reference,
hex key and cold stats. Primitive tuple comparison avoids hash, timestamp and
concatenation ambiguity. The same structural filter orders proof and hydrated
windows; no second Compaction algorithm is introduced.

The second operation hydrates only supplied proof Message IDs and converts that
suffix through existing semantics, returning per-Message output chunks.
Characterization tests prove chunk concatenation equals full conversion for
text, Tool output/error, media and Compaction shapes.

SessionPrompt owns one replaceable Project-scoped entry:

```text
{ sessionID, model identity, ordered proof, canonical Messages, conversion chunks }
```

Admission compares proof from the beginning. Full match reuses all data. Common
prefix retains that prefix and hydrates/converts only the suffix. Current A-E
after cached A-G slices and reuses A-E. No prefix, different Session or model
hydrates/converts the authoritative full window and replaces the same entry.
A miss is a normal pre-serialization branch, not failure recovery. There are no
older generations or Session-keyed entries.

Before any request-only rewrite, Prompt clones the admitted canonical view. The
single final conversion path carries the earliest dirty Message index. Existing
rewriters update that one boundary instead of creating another serializer:

- `insertReminders` returns the latest-user index only when it actually injects
  a disabled-Tool, decide, plan or build reminder;
- queued-user wrapping lowers the boundary to its earliest rewritten user;
- ordinary requests reuse chunks strictly before the boundary and reconvert the
  dirty suffix;
- Plugin Message Transform may rewrite arbitrary history, so its boundary is 0;
- decide sanitizes Tool/Reasoning history and selects candidate suffixes, so a
  decide request fully converts its selected working history while still using
  the admitted canonical hydration.

No request-only Message or converted output is written back into the retained
entry. A reminder persisted as a Part changes the next raw proof and is admitted
normally. Every step still resolves ToolSelection, Permission, Plugin Tool
definitions and `mcp.tools()` fresh. At the start of each `while` step, Prompt
re-reads the current persisted Session before calling `resolveTools`; queued
`prompt({ tools })` updates therefore affect the immediately following Provider
step rather than waiting for a new runLoop.

### 10.4 Bounded Goal continuity

Remove the loop-head full chronology call and unbounded export. A bounded
MessageV2 query selects newest canonical user turns in persisted order, excludes
lineaged wrappers and all-technical Compaction/synthetic Messages with the
current classifier, and returns at most two eligible turns.

Prompt owns a run-local lazy loader. Only actual local `goal` Tool execution
invokes it; read and transition calls in one eligible turn share the mutable
trusted GoalTurnContext. Ordinary active-Goal steps and disabled Goal Tools run
no chronology query.

### 10.5 Persisted chronology and Revert

Define one MessageV2 comparator using `time.created`, then ID only as a
same-millisecond tie. Apply it to `filterCompacted`, `latest`, task cutoffs,
Compaction boundary, proof ordering and Revert. `fromMessageID` keeps its
interface but resolves the referenced row's persisted cursor before selecting
the inclusive tail. Revert computes diff and cleanup ranges with the comparator.
No schema or migration is added.

### 10.6 No fallback

There is one Message filter/converter, one retained entry, one Tool policy
source and one Snapshot attempt. Snapshot, proof, hydration, conversion, Plugin
or Provider failure propagates through existing typed paths. No alternate
serializer or fallback request is attempted.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| exact full cache hit | proposed | primary-contract branch | yes | proof comparison | add |
| exact common-prefix hit | proposed | primary-contract branch | yes | suffix hydrate/convert | add |
| authoritative miss/rebuild | proposed | primary-contract branch | yes | one full window | add as deterministic admission |
| mutable Plugin Message transform | current | existing compatibility | yes | full working conversion | preserve |
| fresh Tool/MCP resolution | current | contracted pass-through | yes | every Provider step | preserve outside cache |
| Provider-executed Tool | current | contracted pass-through | yes | no local execute | preserve without Snapshot |
| declared/ambient Revert | current/proposed | primary-contract branches | yes | deterministic policy | preserve/extend |
| alternate serializer/catch-and-success | rejected | forbidden fallback | n/a | 0 | reject |

Alternate-success-path ratio: `0%`. Diagnostic decision surface: `0%`.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| zero Assistant then estimate write | early pending visibility | estimated publication plus typed failure finalization | `session/prompt.ts` |
| eager create Snapshot and start-step rescue | attempted event-race protection | awaited local execute barrier | `session/processor.ts`, `session/prompt.ts` |
| loop-head full Goal chronology | easy shared context construction | lazy two-turn Tool-start loader | `session/prompt.ts`, `message-v2.ts` |
| full hydrate/convert before admission | no prefix proof seam | raw proof then suffix hydration/conversion | `session/message-v2.ts`, `session/prompt.ts` |
| lexical ID chronology | generated IDs assumed monotonic | persisted time + ID tie | MessageV2/Compaction/Revert |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02 | Assistant assembly -> dispatch/error | Prompt single publication/finalizer | first state estimated; failure durable; overflow no dangling Assistant |
| INV-03/04/05 | local Tool adapter -> Processor gate | lazy shared Snapshot and provider exclusion | text/read zero; declared/ambient ordering; concurrent one; provider zero |
| INV-06 | Tool.Def -> registry -> pre-execute -> `part.metadata.worktree` -> Revert | policy assignment, permit-preserved lifecycle and file admission | Provider excludes primitive key; builtin/MCP pending-running-progress-terminal matrix; declared/ambient/none Revert |
| INV-07/08 | proof -> admission -> canonical chunks -> working dirty suffix | exact one-entry cache and one final converter | full/prefix/miss, A-G -> A-E, reminder, queued wrapper, decide, Plugin and literal body |
| INV-09 | resolveTools per step | keep dynamic surfaces outside cache | Tool/MCP change between equal-history steps |
| INV-10 | storage order -> all consumers | comparator and inclusive cursor | low-ID queued Message, Compaction, Revert diff/cleanup |
| INV-11 | Goal Tool execute -> bounded query | lazy latest-two context | ordinary no penalty; current/previous across Compaction |
| INV-12 | final body -> estimate | retain estimator/breakdown | token suites and first Assistant assertions |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Tool.Def worktree policy | INV-03/06 | explicit user table | names/arguments cannot express custom semantics |
| server-owned `part.metadata.worktree` key | INV-06 | top-level Provider metadata is replaced by reachable lifecycle transitions, while the existing record is already persisted and SDK-typed as open metadata | permit-serialized central preservation gives Revert one authority without changing public Schema or reading state metadata |
| Processor pre-execute gate | INV-04/05 | observed event race | create/start are too early or not an await barrier |
| exact raw window proof | INV-07/08 | 236ms red; R18 timestamp finding | hydration defeats admission; IDs/timestamps/events are not exact |
| per-Message conversion chunks | INV-07 | A-G -> A-E and suffix reuse | one flat output cannot be sliced safely |
| one Prompt retained entry | INV-07 | explicit cardinality | per-Session Map and run-only cache violate contract |
| earliest dirty working index | INV-08 | reminder, queued wrapper, decide and Plugin rewrites are reachable before Provider conversion | canonical proof cannot represent request-only mutation; one boundary preserves the same converter without invalidating untouched prefix |
| shared chronology comparator | INV-10 | low IDs and R22 B-01 | local lexical fixes leave consumers inconsistent |
| bounded Goal query | INV-11 | full scan benchmark/latest-two requirement | current chronology scans every Message/Part locator |
| ambient Patch admission | INV-06 | opaque bash/MCP side effects | declared metadata cannot name ambient files |

No production concept remains unmapped.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/prompt.ts` | modify | single publication, one entry, working dirty boundary, fresh Tools, lazy Goal loader, pre-execute calls | 105-160 |
| `packages/opencode/src/session/processor.ts` | modify | remove eager capture; shared lazy Snapshot; permit-serialized Tool Part lifecycle; conditional Patch | 55-90 |
| `packages/opencode/src/session/message-v2.ts` | modify | proof, suffix hydration/chunks, comparator, persisted tail, bounded Goal query | 120-190 |
| `packages/opencode/src/session/compaction-boundary.ts` | modify | persisted latest-boundary order | 2-8 |
| `packages/opencode/src/session/revert.ts` | modify | persisted range/cleanup and ambient admission | 25-50 |
| `packages/opencode/src/tool/tool.ts` | modify | optional worktree field | 3-8 |
| `packages/opencode/src/tool/registry.ts` | modify | internal policy projection | 2-6 |
| `packages/opencode/src/tool/edit.ts` | modify | declared assignment | 1-3 |
| `packages/opencode/src/tool/write.ts` | modify | declared assignment | 1-3 |
| `packages/opencode/src/tool/apply_patch.ts` | modify | declared assignment | 1-3 |
| `packages/opencode/src/tool/shell.ts` | modify | ambient assignment | 1-3 |
| `packages/opencode/test/session/prompt.test.ts` | modify | all public behavior/performance slices; first consolidate repeated turn/input fixture code before adding R33 signals | final file diff at most 590 changed lines |
| `packages/opencode/test/session/revert-compact.test.ts` | modify | existing legacy fixtures explicitly persist declared/ambient authority so missing remains none | 2-6 |

Exactly 13 code/test files, below the user-authorized ceiling of 16; no
added/deleted code file, migration or generated artifact. The thirteenth path
is required because shipped Revert tests previously encoded implicit Tool-name
ownership, which conflicts with R28's audited missing-means-none authority.

### 15.1 R33 executable diff contraction

The current 12-path implementation diff is 1197 changed lines. R33 must perform
the following contraction before adding remaining behavior:

1. Add one reused test helper that performs the repeated
   `user -> llm.text -> prompt.loop` turn and one helper that returns the latest
   TestLLM Provider input. Replace at least ten existing repeated sequences in
   the cache matrix. Net reduction: at least 25 changed lines after counting the
   helper definitions.
2. Factor the typed provider-executed finish event's repeated usage fields into
   the existing shared fixture value and compact the two literal events without
   changing event order or assertions. Additional net reduction: at least 8
   changed lines.
3. Do not remove any behavior slice, Chinese invariant comment, Provider-body
   equality assertion, timing assertion or failure signal to obtain the saving.
4. Remove the standalone cross-runLoop Plugin-definition and MCP-freshness test
   bodies only after moving their assertions into the queued same-runLoop
   continuation test. This consolidation must save at least 30 additional lines
   while strengthening, not dropping, the original signals.

Only after at least 33 lines are removed may implementation add:

- per-step Session re-admission in `prompt.ts`: at most 2 changed lines;
- queued Permission/control-panel real bash execution: at most 9 net lines;
- warm public Revert+cleanup body assertion: at most 4 net lines;
- dynamic local `tool.definition` v1/v2 Provider-body assertion: at most 8 net
  lines by extending the existing transforming Plugin fixture/test;
- two explicit Revert fixture authority markers: exactly 2 lines.
- unchanged exact full-hit versus one-entry eviction/rebuild public timing:
  at most 10 net lines in the existing 2048-turn test.

Budget proof: `1197 - 33 - 30 + 35 = 1169`, strictly below 1200. Production remains
at most `586 + 2 = 588`. If actual contraction is smaller or additions exceed
these caps, implementation must stop rather than weaken coverage.

## 16. TDD Behavior Slices

Agreed seams are public `SessionPrompt.prompt/runLoop` through TestLLM,
`SessionRevert.revert/cleanup`, actual Tool registry definitions, and persisted
Messages through Session APIs. Tests do not call private cache helpers, inspect
source text, assert internal calls, or reproduce conversion logic.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | first Assistant state is estimated; assembly failure durable; Compaction no zero attempt | zero write first | move publication and add one finalizer | TUI flash/dangling attempt |
| 2 | text/read request records no Snapshot | create tracks eagerly | remove eager/event capture | pre-dispatch git latency |
| 3 | first declared/ambient builtin and MCP Tool snapshots before plugin/Permission/execute; concurrent calls share; policy survives real pending/running/progress/terminal metadata updates | no execute barrier and replaceable metadata | permit-serialized preservation of one existing-record server key plus cached Processor gate | mutation-before-baseline and lost ownership marker |
| 4 | provider-executed ambient-named Tool records no local Snapshot | event path owns capture | local adapter sole trigger | provider/local confusion |
| 5 | Provider excludes worktree; after real builtin/MCP metadata updates Revert restores declared/ambient but not none-only files | no durable policy/ambient admission | dedicated Part authority and one Revert branch | schema leak/lost marker/wrong restore |
| 6 | proof full/prefix/miss, A-G -> A-E and warm public Revert+cleanup produce expected bodies; unchanged 2048-turn Session is timed as exact full hit, then another Session replaces the sole entry and the unchanged original is timed as rebuild | full window hydrates first, equality can rebuild, and deletion alone cannot prove hidden invalidation | one entry + suffix seam; real Revert hidden mutation; public full-hit versus eviction timing | stale/multi-generation/reverted history and fake full hit |
| 7 | in one queued Tool continuation, step1 waits while public prompt changes bash deny→allow, local `tool.definition` v1→v2 and MCP enabled→disabled; step2 Provider body must use v2/no MCP and successfully execute bash; reminder, decide and historical Message Plugin transforms retain their signals | resolving dynamic surfaces once per runLoop or using loop-entry Session remains stale | every while step re-admits Session and calls current ToolRegistry/Plugin/MCP; dirty suffix and decide/Plugin conversion remain separate | stale Permission/Tool schema/MCP, missing reminder and unsafe decide history |
| 8 | later low-ID Message wins; Compaction/Revert hide and diff persisted suffix | lexical ID | shared comparator | reverted history replay |
| 9 | ordinary Goal step avoids chronology; Goal Tool gets two eligible turns | loop-head full scan | Tool-start bounded query | repeated latency/wrong lineage |
| 10 | 2048-turn later dispatch beats paired rebuild while literal body remains equal | admission after hydration | proof-before-hydrate | performance regression |

Each slice runs red -> minimal approved green -> focused regression. Timing uses
five paired samples and `cached <= 0.65 * full median + 40ms`; literal Provider
body equality is the primary correctness oracle.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 600-900 | excludes import-only, formatting, generated and pure moves |
| Required Chinese explanatory comments `C` | 90-135 | actual gate is `ceil(E * 0.15)` |

Qualifying comments will be adjacent to:

- worktree policy default and why it stays outside LLM schema;
- first non-none execute-boundary ordering and provider-executed exclusion;
- one-Snapshot-per-processor and one permit-serialized Tool Part lifecycle;
- declared exact attribution versus ambient best-effort Revert;
- exact raw proof and common-prefix replacement;
- canonical clone versus mutable reminder/Plugin working copy;
- model/Session replacement and dynamic Tool exclusion;
- persisted chronology tie and Revert boundary;
- latest-two Goal classifier and Tool-start timing;
- independent literal/timing test intent.

Every comment must sit beside the exact branch/test it explains. Declaration
essays, repeated identifier translation, obvious narration and split-line
padding are forbidden; any concentrated pile fails regardless of the ratio.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 60000 test/session/prompt.test.ts --test-name-pattern 'estimated Assistant|assembly failure|preflight Compaction|Snapshot|worktree|retained Message prefix|A-G to A-E|low MessageID|Goal chronology'` | `packages/opencode` | new vertical slices |
| `bun test --timeout 60000 test/session/prompt.test.ts` | `packages/opencode` | complete directly modified suite |
| `bun test test/session/snapshot-tool-race.test.ts test/session/message-v2.test.ts test/session/messages-pagination.test.ts` | `packages/opencode` | Tool race, conversion, pagination and Compaction |
| `bun test test/session/compaction.test.ts test/session/revert-compact.test.ts test/session/summary-tool-diff.test.ts` | `packages/opencode` | Compaction/Revert/declared ownership |
| `bun test test/session/processor-effect.test.ts test/token/accounting.test.ts test/token/estimate.test.ts` | `packages/opencode` | Processor cleanup and token accounting |
| `bun typecheck` | `packages/opencode` | Package type correctness |
| rerun 2048-turn public timing slice five times | `packages/opencode` | cache feedback turns green with literal body equality |
| rerun real DB/Snapshot contributor harness | repository root | contributor baseline plus focused call-path removal |
| `git diff --check -- <all GOAL paths>` | repository root | whitespace integrity |

No generated output, migration, SDK build, or root-level test command is
required because this plan changes no public generated schema or database.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 code/test | reuse current modules |
| Files modified | 13 code/test | below explicit 16-file ceiling |
| Files deleted | 0 | no replacement module |
| Production lines | 300-490 | below approximately 600-line expectation |
| Test lines | 280-430 | consolidated in one existing suite |
| Total changed code/test lines | 580-920 | reserve below 1200 |
| Generated lines | 0 | no generated contract change |

Hard implementation budget: at most 16 code/test files and fewer than 1200
changed code lines. R29 plans exactly 13. The plan document is not counted as
production code.

## 20. Real Risks and Open Decisions

### Real Risks

- `toModelMessagesEffect` depends on current Provider/Model for reasoning/media
  behavior. The cache must key and invalidate on exact current model identity.
- Compaction reorders a visible window while retaining old rows; proof and full
  hydration must use one structural filter.
- Current Assistant Parts grow under one MessageID; proof must include ordered
  Part rows, not only Message IDs.
- `insertReminders` mutates the latest user in memory and sometimes persists a
  Part. Its actual injection must mark the latest user dirty, and neither the
  working Message nor its conversion may enter the retained entry.
- queued-user wrapping changes only a persisted suffix, while decide and Plugin
  transforms may change selection or arbitrary history; their dirty boundaries
  must remain explicit in the final converter.
- Ambient Snapshot patch files can include concurrent external worktree changes.
  This is the explicit best-effort policy and must remain observable as ambient,
  never reclassified as declared summary evidence.
- MCP Tool definitions can change by notification or connect/disconnect. Fresh
  per-step resolution is mandatory.
- Raw proof reads bounded-window row bytes. It must satisfy the public timing
  slice; failure requires plan revision, not a second authority.
- Old Compaction markers without `goalTurnID` require the current canonical-turn
  classifier rather than assuming every unlineaged user is eligible.

### Open Decisions Requiring the User

None. The user explicitly authorized a fresh maximum-six-round full-scope plan
audit cycle. R1-R24 remain historical; R28 is round 3/6.

### Rejected Speculation

- Timestamp-only proof is rejected because same-millisecond mutation is reachable.
- EventSequence/Bus invalidation is rejected because availability/subscriber
  ordering does not prove admission.
- Per-Session Maps and retained generations violate the one-entry rule.
- Caching Tool/MCP schemas was rejected by explicit user clarification and
  observed dynamic producers.
- Inferring worktree policy by arbitrary Tool name or shell command parsing was
  rejected; the definition owner supplies policy, and ambient remains opaque.
- Recomputing exact ambient file diffs from Tool output was rejected; Snapshot
  Patch is the only evidence available and is explicitly best-effort.
- Replacing local estimate with Provider preflight usage was rejected because no
  such Provider contract exists before dispatch.
- Public Part busy guards are not added solely for cache correctness; exact row
  admission handles mutation without expanding the HTTP contract.

## 21. Audit Contract

The independent auditor must read this exact revision and original requirement,
reconstruct current behavior, treat summaries and `stash@{0}` as untrusted, and
audit full scope. It must check first-divergence ownership, traceability, no
fallback, exact one-entry cardinality, proof-before-hydration, dynamic Tool and
Plugin exclusions, persisted chronology, Snapshot ownership, 12 files, under
1200 total lines, production restraint, and the distributed 15% Chinese-comment
gate. Any blocker requires a revised full-scope audit; only a clean exact-revision
verdict may permit implementation.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | R1 | yes | B-01 将 Task 标记为 `ambient` 超出原始需求授权；B-02 Message 前缀缓存未覆盖现有可变的 Plugin Message Transform seam | §10.2 default normalization seam and §18 benchmark path need explicit implementation evidence | BLOCK | `ses_06751a49cffedigXU5AkDV1MMT` |
| R2 | R2 | yes | B-01 Cache boundary can promote in-place prompt decorations (`insertReminders` / queued-user wrappers) into replayed canonical history; B-02 removing the initial write leaves reachable non-interruption pre-dispatch failures without a durable Assistant boundary | §8 benchmark body should be reproducible; §10.2 normalization seam should be named | BLOCK | `ses_06749b6eeffeWzmepbqOQk6YwC` |
| R3 | R3 | yes | B-01 run-local Message cache does not invalidate after successful automatic Compaction; B-02 connected MCP Tools have no behaviorally sensitive worktree-policy test | §8 benchmark exit semantics were inverted and standalone operations cannot alone prove call-path removal | BLOCK | `ses_0669d31c7ffebK868eOQPkd223` |
| R4 | R4 | yes | No blocking findings. | Registration operation/persisted worktree metadata location should be explicit in implementation evidence; standalone benchmark is contributor evidence while SessionPrompt tests remain authoritative; MCP wrapper/Tool.Def distinction must be preserved; final approval remains tied only to R4. | APPROVE | `ses_06693a720ffe3TMgltXNw157Db` |
| R5 | R5 | yes | B-01 Canonical plan baseline drifted from current repository: create/start-step eager capture was already removed in the current worktree, so required red slices no longer targeted the audited source behavior | concurrent capture synchronization and concrete focused command need explicit implementation evidence | BLOCK | `ses_06672de0affePJM5BMDhWcpn00` |
| R6 | R6 | yes | No blocking findings. | N-01 partial worktree changes require actual-diff implementation audit; N-02 slice 1 is characterization rather than red-green; N-03 standalone benchmark is contributor evidence only and focused path tests are authoritative. | APPROVE | `ses_0666b29fbffeS51g1QLvcO8E84` |
| R7 | R7 | yes | B-01 Goal chronology is still scanned on every active-Goal provider step instead of at the `goal` Tool-start boundary; B-02 non-`none` Tools do not unconditionally trigger the first Snapshot because MCP permission/plugin work runs before `ensureToolSnapshot` | Benchmark approximation and comment-budget estimate remain non-blocking | BLOCK | `ses_06623e73cffeQN5DfIkITIkYg1` |
| R8 | R8 | yes | B-01 Canonical plan baseline is contradicted by the current repository: the current source already has no durable zero Assistant update and substantial planned implementation, so stale red slices cannot fail | E/C remains implementation evidence; standalone benchmark remains contributor-only evidence | BLOCK | `ses_06619f200ffewGvzsBz1xYINN7` |
| R9 | R9 | yes | No blocking findings. | N-01 verification command must explicitly execute all mapped behavior slices; N-02 implementation must inject the lazy Goal result into the same trusted `GoalTurnContext` consumed by Goal read/transition. | APPROVE | `ses_0660a85f3ffe4q2YF2EXnHyZUl` |
| R9 implementation | R9 | yes | B-01 SessionPrompt regression suite remains red; B-02 superseded unbounded `MessageV2.chronology()` remains exported; B-03 Message-prefix optimization lacks behaviorally sensitive verification | independent E/C calculation passes; exact failure count was 111/2 in the audit run | BLOCK | `ses_065f087b2ffe4qXhghx3OEcWve` |
| R10 | R10 | yes | B-01 plan baseline still described already-completed Goal/Snapshot fixes as pending; B-02 ordinary active Goal no-scan path lacked sensitive verification; B-03 verification omitted the complete red Prompt file | fixed benchmark parameters remained non-blocking; stale R9 labels reduced readability | BLOCK | `ses_065df4640ffeXvS03UQ0yGQk4M` |
| R11 | R11 | yes | B-01 remaining work had no executable path below 1200 changed lines; B-02 `worktree` schema exclusion lacked a sensitive Provider-boundary test | Timing mutation sensitivity remained an implementation-audit concern | BLOCK | `ses_06589a974ffe4NwQdeZ3vNDPHK` |
| R12 | R12 | yes | No blocking findings. | N-01 审计模式元数据用词不一致；N-02 Provider-executed Tool 的测试落点应在实施证据中明确核对 | **APPROVE — exact canonical revision R12 only.** | `ses_0657a4bb7ffe0PbNPDCA0gMccy` |
| R13 | R13 | yes | B-01 Provider-executed Tool 的 Snapshot 排除路径缺少行为敏感验证 | N-01 diff 预算把删除 chronology 错算成增加 changed lines | **BLOCK — exact canonical revision R13.** | `ses_065615370ffeg8DDW8XzzeL6hf` |
| R14 | R14 | yes | B-01 Message 增量窗口错误地假设调用方提供的 MessageID 单调递增 | R14 的部分旧 revision 文案；注释墙仍需在实施审计中清零 | **BLOCK — exact canonical revision R14.** | `ses_0655a7530ffeJXrDt17Lq69J44` |
| R15 | R15 | yes | B-01 计划删除用户明确要求的首笔 `tokens=0` 持久化；B-02 未分离公共 `fromMessageID` 与内部 persisted-order cursor 合同 | 当前 revision 文案与实施 evidence 仍需清理 | **BLOCK — exact canonical revision R15.** | `ses_0654e65dbffecL6SNhX2SLWSkz` |
| R16 | R16 | yes | B-01 Message mutation revision 依赖 experimental Workspaces 的 EventSequence/EventTable，默认运行路径不可用；B-02 所有 MCP Tool 被无条件标记为 `ambient`，独立审计认为缺少受信副作用归属 | N-01 §23 保留 superseded implementation evidence；当前不改变 release verdict | **BLOCK — exact canonical revision R16.** | `ses_0653b1fd3ffeBVWFx6yNnq5r70` |
| R17 | R17 | yes | B-01 active Run 公开旧 Part 修改无法使 cache miss；B-02 `MessageV2.latest` 仍按 ID；B-03 Compaction 首次读取仍按 ID cutoff；B-04 auditor 未收到较早的 audit-cap 授权 | N-01 zero-write current-state wording；N-02 diff estimates；N-03 stale §23 evidence | **BLOCK — exact canonical revision R17.** | `ses_0652764fdffeX9QfMtTYCilXtt` |
| R18 | R18 | yes | B-01 plan retained contradictory run-local versus cross-run cache lifetime; B-02 millisecond `time_updated` could collide | N-01 stale §23 evidence | **BLOCK — exact canonical revision R18.** | `ses_06512fd22ffeh6FjULE2Se3guR` |
| R19 | R19 | yes | B-01 Cache lifetime contract remained contradictory between run-local and cross-run ownership; B-02 typed Bus invalidation had no admission-before-subscriber ordering guarantee | none recorded | **BLOCK — exact canonical revision R19.** | `ses_06507d712ffeHNdJJonfHNmtcA` |
| R20 | R20 | yes | B-01 Audit handoff omitted the later user quote removing the first durable `tokens=0` write and therefore treated the superseded two-write description as contracted; B-02 a per-Session entry Map violated the user's one retained cache cardinality | none | **BLOCK — exact canonical revision R20.** | `ses_064f073b0ffeFWgQkCJziVSlnV` |
| R21 | R21 | yes | No blocking findings. | §23 superseded evidence should be replaced after implementation; timing thresholds remain supplemental to literal request-body equivalence | **APPROVE — exact canonical plan revision R21 only.** | `ses_064e752cbffetbpSgyXKckegu3` |
| R22 | R22 | yes | B-01 Revert tail selection, diff range and cleanup retained lexical MessageID order, so a later low-ID Message could remain visible and be replayed by the otherwise correct cache | E/C remains implementation-stage evidence; §23 is superseded history; 12-file count depends on removing the standalone Tool.define test diff | **BLOCK — exact canonical plan revision R22.** | `ses_064d5e535ffekBO2u2gRF5HcTa` |
| R23 | R23 | no | audit was not invoked; revision superseded after the worktree reset | none | NOT AUDITED | n/a |
| R24 | R24 | yes | B-01 已超过计划审计六轮硬上限；B-02 缓存转换块没有覆盖工作历史的非 Plugin 改写 | Audit mode 元数据用词；E/C 与预算实施时复核 | **BLOCK — exact canonical plan revision R24.** | `ses_064a8954fffeoD381UdncWoZZe` |
| R25 | R25 | no | B-02 corrected; B-01 awaits explicit user authorization for a fresh six-round cycle | none | BLOCKED BEFORE AUDIT | pending user decision |
| new cycle 1/6 | R26 | yes | B-01 Tool worktree policy lacks a durable, race-safe ownership path | Budget/comment/benchmark findings are implementation-stage checks | **BLOCK — exact canonical plan revision R26, new audit cycle round 1/6.** | `ses_06490986cffeYL9DMmMExTi0q0` |
| new cycle 2/6 | R27 | yes | B-01 新增 `ToolPart.worktree` 会改变公开 SDK 合同，但计划明确排除了 SDK 生成 | Budget/comment/benchmark findings remain implementation-stage checks | **BLOCK — exact canonical plan revision R27, new audit cycle round 2/6.** | `ses_06489a881ffevD5G1HLJsE80lD` |
| new cycle 3/6 | R28 | yes | No blocking findings. | 无。 | **APPROVE — exact canonical plan revision R28 only.** | `ses_0647a79b5ffeiCIs88oqfCp38L` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

### R24 Independent Verdict (verbatim)

#### Blocking findings

##### B-01 已超过计划审计六轮硬上限

- Violated invariant: 计划审计最多进行 6 轮；达到上限后，未解决事项必须转为用户的显式开放决策，发布结论保持 `BLOCK`。
- Evidence class: contracted
- Producer and execution path: canonical plan 的审计记录累计记录了 R1–R22 的多轮完整计划审计，当前又请求审计 R24；计划没有引用用户对审计轮数上限的明确例外授权。
- Source evidence: `.opencode/policy/first-principles-engineering.md:548-557`
- Canonical-plan evidence: §22，`docs/plans/session-prompt-preflight-latency-lazy-snapshot.md:641-667`
- Responsibility owner: 审计编排与 canonical-plan 状态转换流程
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 仓库政策禁止在超过六轮后继续通过普通修订—审计循环取得计划批准；R24 不能进入 `approved` 或 `Implementation allowed: yes`。
- Why this is not speculative: canonical plan 自身记录了超过六轮的实际审计历史，政策明确规定了硬上限及达到上限后的处理方式。
- Minimal correction direction: 将剩余阻塞项作为用户开放决策处理；只有用户明确授权本任务突破或重置审计轮数限制，并由 canonical plan 原文记录该授权，才可继续寻求批准。

##### B-02 缓存转换块没有覆盖工作历史的非 Plugin 改写

- Violated invariant: 最终发送给 Provider 的 Message 必须包含本轮所有 reminder、排队 Message 包装和 Agent 专用转换；缓存只能复用与最终工作历史语义一致的转换块。
- Evidence class: reachable
- Producer and execution path:
  1. `SessionPrompt.runLoop` 取得 canonical Message 历史。
  2. `insertReminders` 可以修改最新 user Message，并可能持久化新的 Part。
  3. 后续 user Message 会被包装为 `<system-reminder>`。
  4. `decide` Agent 会把 Tool Part 改写成 synthetic text，并截断 Reasoning。
  5. 当前实现完成这些改写后才调用 `toModelMessagesEffect`。
  6. R24 计划改为先生成并复用 canonical conversion chunks，再克隆和装饰工作历史；它只为 Plugin Message Transform 明确规定完整重转换，没有规定 reminder、排队包装或 `sanitizeDecideMessages` 如何使受影响的缓存块失效或重新转换。
- Source evidence: `packages/opencode/src/session/prompt.ts:462-479`, `packages/opencode/src/session/prompt.ts:2504-2524`, `packages/opencode/src/session/prompt.ts:2784-2787`, `packages/opencode/src/session/prompt.ts:2855-2873`, `packages/opencode/src/session/prompt.ts:2891-2893`
- Canonical-plan evidence: §10.3 lines 368-400；§16 slices 6-8
- Responsibility owner: `SessionPrompt` 的最终工作 Message 组装与 `MessageV2` conversion-chunk admission 边界
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: full/prefix cache hit 可以把装饰前的 canonical chunk 直接发送给 Provider，导致缺失 reminder、遗漏排队 user Message 的系统包装，或者让 `decide` Agent 收到未净化的 Tool/Reasoning 历史；最终请求体会与当前正常行为不一致。
- Why this is not speculative: 三类改写都存在于当前可达的 Provider 请求路径中；canonical plan 明确把 conversion chunks 建在装饰前，并只对 Plugin transform 指定完整重转换。
- Minimal correction direction: 在 `SessionPrompt` 的唯一最终转换路径中明确规定，所有会改变工作 Message 的现有转换都必须在 Provider dispatch 前使受影响的 canonical chunks 失效或重建；为 reminder、排队包装和 `decide` 转换分别加入通过最终 Provider 请求体观察的行为敏感测试。

#### Non-blocking findings

- `Audit mode` 元数据写成 `full-scope`，而本次输入指定的是 `plan`。当前上下文足以确定审计类型，不单独影响设计可执行性。
- R24 对 `E=600–900`、`C=90–135` 的估算满足 `ceil(E × 0.15)`，并承诺注释贴近具体决策。实际分布和有效行数仍须在 implementation audit 中重新计算。
- 12 个代码/测试文件、少于 1200 行以及约 600 行以内生产代码的预算在当前文件计划下可行；实际 diff 必须重新核算。

#### Release verdict

**BLOCK — exact canonical plan revision R24.**

R24 存在 B-02 的最终请求体一致性缺口；同时审计历史已经超过六轮硬上限。剩余阻塞项必须作为用户开放决策处理，当前 revision 不得标记为 `approved`，也不得开始实施。

### R26 Independent Verdict (verbatim)

#### Blocking findings

##### B-01 Tool worktree policy lacks a durable, race-safe ownership path

- Violated invariant: `declared` / `ambient` policy must survive the complete Tool lifecycle so the first non-`none` Tool triggers Snapshot and Revert can distinguish declared, ambient, and none attribution.
- Evidence class: reachable
- Producer and execution path:
  1. The local builtin or MCP execute adapter invokes the planned pre-execute operation and marks the Tool Part with server-owned worktree policy.
  2. AI SDK Tool execution can overlap Processor event handling; the plan’s own reproduced race proves execute can start before preceding asynchronous event work completes.
  3. `SessionProcessor` later handles `tool-call` and replaces top-level `ToolPart.metadata` with Provider metadata.
  4. Tool progress replaces `state.metadata`, and terminal completion replaces it again with sanitized result metadata.
  5. Revert later depends on the persisted policy to admit ambient Patch files and distinguish them from none.
- Source evidence:
  - `packages/opencode/src/session/prompt.ts:1169-1183`
  - `packages/opencode/src/session/prompt.ts:1217-1235`
  - `packages/opencode/src/session/prompt.ts:1286-1308`
  - `packages/opencode/src/session/processor.ts:275-294`
  - `packages/opencode/src/session/processor.ts:355-370`
  - `packages/opencode/src/session/processor.ts:490-520`
  - `packages/opencode/src/session/processor.ts:563-597`
  - `packages/opencode/src/session/revert.ts:95-118`
- Canonical-plan evidence: §8 “Execute-boundary race feedback”; §10.2; §13 INV-06; §15 `processor.ts` / `prompt.ts` responsibilities; §16 slices 3 and 5
- Responsibility owner: `SessionProcessor` Tool Part lifecycle and the Prompt local/MCP execute adapters
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: An ambient shell or MCP Tool can successfully mutate the worktree and produce a Patch while its persisted Tool Part loses the ambient marker. A subsequent Revert then treats that Assistant as none/undeclared and omits the Patch files, leaving the Tool’s worktree changes in place. The same overwrite surface can erase declared classification needed by the policy matrix.
- Why this is not speculative: The metadata replacement transitions exist in the current production path, and the plan records observed overlap between asynchronous Processor event handling and actual Tool execution. R26 requires a persisted Tool Part marker but does not assign a canonical storage location or preservation rule to any of these existing replacement transitions.
- Minimal correction direction: Define one Processor-owned persisted location for worktree policy and require that location to survive pending → running → progress → completed/error/cleanup transitions, including concurrent `tool-call` and pre-execute updates. The behavioral tests must use real builtin and MCP metadata updates before checking declared/ambient/none Revert behavior.

#### Non-blocking findings

- The 12-code/test-file plan is internally consistent: 11 production files plus `test/session/prompt.test.ts`.
- The estimated 300–490 production lines and 580–920 total code/test lines are feasible under the user’s approximate 600-production-line preference and hard 1200-line limit.
- The Chinese explanatory-comment estimate commits to the actual `ceil(E × 0.15)` minimum and explicitly rejects concentrated comments and split-line padding. Actual `E`/`C` remains an implementation-audit calculation.
- The standalone database/Snapshot benchmark establishes measured contributor cost. R26 correctly assigns behavior-level call-path verification to focused `SessionPrompt` tests rather than treating that benchmark as proof of removal.
- The audit-cycle reset is explicitly authorized and quoted. R26 is validly treated as round 1 of the new six-round cycle.

#### Release verdict

**BLOCK — exact canonical plan revision R26, new audit cycle round 1/6.**

R26 must define the single durable worktree-policy location and its preservation across the real Processor Tool lifecycle, then undergo another full-scope plan audit.

### R27 Independent Verdict (verbatim)

#### Blocking findings

##### B-01 新增 `ToolPart.worktree` 会改变公开 SDK 合同，但计划明确排除了 SDK 生成

- Violated invariant: 每个生产接口变更都必须覆盖其实际消费者、生成物和验证路径；12 个代码文件及少于 1200 行的硬限制必须基于完整改动面计算。
- Evidence class: contracted
- Producer and execution path:
  1. R27 在 `MessageV2.ToolPart` 上新增公开可序列化字段 `worktree`.
  2. `MessageV2.Part` 是 `part.update` HttpApi 的请求和响应 Schema。
  3. 同一个 `Part` Schema 也进入 Message Part 事件及 Session Message 响应合同。
  4. JavaScript SDK 从这些 HttpApi/OpenAPI Schema 生成 `ToolPart` 类型。
  5. 当前 SDK 已分别生成 v1 和 v2 `ToolPart`：`packages/sdk/js/src/gen/types.gen.ts` 与 `packages/sdk/js/src/v2/gen/types.gen.ts`。
  6. 根级仓库指令要求修改相关 Schema 后运行 `./packages/sdk/js/script/build.ts`。
- Source evidence:
  - `packages/opencode/src/session/message-v2.ts:432-442`
  - `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:609-619`
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:416-430`
  - `packages/sdk/js/src/gen/types.gen.ts:294-404`
  - `packages/sdk/js/src/v2/gen/types.gen.ts:282`
  - `AGENTS.md:1`
- Canonical-plan evidence: §2 lines 80-81；§10.2 lines 362-367；§15 lines 517-535；§18 lines 599-600；§19 lines 606-615
- Responsibility owner: `MessageV2.Part` 的公开 Schema、HttpApi 合同及 JavaScript SDK 生成流程
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 按 R27 实施会让服务端公开 `ToolPart` 与已发布 SDK 的 `ToolPart` 类型发生漂移；执行仓库要求的 SDK 生成又会修改计划未授权的生成代码文件，使“恰好 12 个代码/测试文件、无 generated artifact”的实施合同失效，并可能直接超过用户的 12 文件硬上限。
- Why this is not speculative: `part.update` 明确直接以 `MessageV2.Part` 作为公开 payload 和 success Schema，生成的 SDK 中也已经存在对应 `ToolPart` 类型；这是当前可见的生产接口链，不依赖未来消费者假设。
- Minimal correction direction: 在同一 canonical revision 中明确解决 `ToolPart.worktree` 的公开 Schema/SDK 归属，并把必需生成物纳入文件预算和验证；仍须通过减少其他代码文件或采用不扩张公开生成合同的所属路径，保持最多 12 个代码文件。不得以跳过 SDK 生成来维持文件数。

#### Non-blocking findings

- R27 对首笔 durable Assistant publication、pre-dispatch typed-error finalization 和 preflight Compaction 丢弃未发布尝试的设计，已经覆盖后续澄清，不再保留 durable `tokens=0`。
- `E=600–900`、`C=90–135` 的计划估算承诺实际执行 `C >= ceil(E × 0.15)`，并明确禁止集中注释与拆行填充。实际数值和分布留到 implementation audit 复算，符合阶段要求。
- 独立审计周期授权已逐字记录；R27 可作为新周期第 2/6 轮审计，不受 R1–R24 历史轮次阻断。
- 真实数据库/Snapshot benchmark 只被用作延迟贡献证据，最终行为移除由公开 `SessionPrompt` 测试证明，证据职责划分合理。

#### Release verdict

**BLOCK — exact canonical plan revision R27, new audit cycle round 2/6.**

R27 尚未覆盖 `ToolPart.worktree` 从公开 `MessageV2.Part` Schema 到 JavaScript SDK 的实际生产接口链。当前 revision 不得标记为 `approved`，也不得开始实施。

### R28 Independent Verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

无。

#### Release verdict

**APPROVE — exact canonical plan revision R28 only.**

R28 可以由编排方仅执行行政状态更新，记录本次 full-scope clean verdict，并将 `Status`、`Approved revision` 与 `Implementation allowed` 更新为 R28 对应的批准状态。任何行为、接口、测试、ownership、fallback classification 或文件计划变更都必须递增 revision 并重新进行完整计划审计。

## 23. Implementation Evidence

Implementation was rebuilt from the post-stash source without restoring
`stash@{0}`. Twelve R28 code/test paths currently changed; R29 additionally
plans the existing `revert-compact.test.ts` fixture path. No schema, migration,
generated file, dependency or fallback path changed.

### Actual behavior and paths

- `prompt.ts` removes the constructor-state zero publication, persists estimate
  as the first normal Assistant state, finalizes pre-dispatch failure once,
  admits one Project-scoped raw-proof cache, converts only dirty suffixes and
  loads bounded Goal chronology only from the real Goal Tool adapter.
- `message-v2.ts` owns exact raw Message/Part proof tuples, inclusive suffix
  hydration, per-Message conversion chunks and persisted `(time_created,id)`
  chronology; `compaction-boundary.ts` uses that persisted ordering.
- `processor.ts` moves Snapshot capture to the local non-`none` Tool execution
  barrier, shares one cached capture, serializes Tool Part lifecycle updates and
  preserves the primitive `metadata.worktree` authority across Provider
  metadata replacement. Pure text/read and Provider-executed Tools do not
  capture. Consecutive side-effect steps retain the completed baseline without
  rescanning pure continuation steps.
- `tool.ts`, `registry.ts`, `edit.ts`, `write.ts`, `apply_patch.ts` and `shell.ts`
  carry the server-only policy. The Provider schema/description remains fresh
  and contains no policy field. `revert.ts` combines declared result files with
  same-Assistant ambient Patch files and uses persisted chronology.
- `prompt.test.ts` covers first publication, typed assembly failure, lexical-low
  later Messages, retained-prefix contraction after hidden mutation, 2048-turn
  literal conversion equality/timing and two consecutive ambient Tool steps
  through real Revert.

### Red-green evidence

- Initial pre-change test executions were repeatedly terminated by the OpenCode
  runner as `reason=user_abort` although the user did not cancel. No false red
  verdict is claimed for those attempts.
- After the runner recovered, an exact mutation restored the removed initial
  `updateMessage(msg)`: the public Bus test failed with
  `Expected: > 0 / Received: 0`. Removing that mutation made the same test pass
  (`1 pass`, `2 expect() calls`).
- Adding a new required Handle method produced a real typecheck red in four
  existing Compaction stubs. The implementation was simplified to extend the
  existing `updateToolCall` operation instead of changing a thirteenth file;
  `bun typecheck` then passed.

### Verification

- Complete modified suite: `105 pass / 0 fail`, 459 expectations. Its expected
  retry scenario printed a 503 stack but did not fail.
- Message/pagination/Tool race group: `112 pass / 0 fail`.
- Compaction/Revert/declared ownership group: `93 pass / 0 fail`.
- Processor/token group initially had one overflow assertion fail under three
  groups running concurrently; the focused test passed, and the whole group
  rerun alone passed `31 pass / 0 fail`, so no reproducible implementation
  failure remains.
- `snapshot-tool-race.test.ts`: `1 pass / 0 fail`; ambient two-step Revert:
  `1 pass / 0 fail`; chronology/cache contraction: `2 pass / 0 fail`.
- `bun typecheck` and `git diff --check` pass.

### Original feedback loops

- The 2048-turn public loop passed five independent runs. Cold/warm milliseconds
  were `511.6/105.7`, `515.3/95.5`, `485.4/99.9`, `460.1/92.9` and
  `481.0/97.4`; warm was 4.8–5.3 times faster and always below one second.
- Read-only real DB harness on `ses_1296dfec8ffeF4HyjYjd4NbDUk` (5405 Messages,
  20834 Parts): current Compaction proof domain was 77 Messages/505 Parts;
  raw-proof median was 13.0 ms versus full-history row decode median 88.9 ms.
- Snapshot core `diff-files + ls-files + write-tree` contributor median was
  99.0 ms. The new pure text/read path does not invoke this contributor.

### Diff and comment gates

- Final code/test paths: 13. R34 diff is 1189 changed lines; production changed
  lines are 598. The executable contraction completed before final additions.
- Final gate calculation excludes blank, import-only and comment lines:
  `E=1042`, `C=165`, required `ceil(E*0.15)=157`; excluding the six candidates
  rejected by the first auditor still leaves 159 qualifying comments.
- Representative comments are adjacent to raw proof identity, inclusive
  mismatch hydration, lifecycle permit, Snapshot active-step baseline,
  server-only Tool policy, dirty conversion suffix, failure publication and
  Revert admission. No declaration comment wall was retained.

Post-blocker verification: Prompt `109 pass`; Message/pagination/race `112 pass`;
Compaction/Revert `93 pass`; Processor/token `31 pass`; typecheck and
`git diff --check` pass. The 2048-turn common-prefix/full-hit/eviction test passed
five consecutive isolated runs. Remaining item: independent full-scope R34
implementation audit only.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R28 | yes | B-01 none Tool metadata admitted by Revert; B-02 Snapshot policy matrix missing; B-03 cache invalidation matrix missing | none | BLOCK | `ses_064478ad8ffedh0FK7Xp1QexRF` |
| 2 | R34 | yes | B-01 ambient authority crossed Assistant boundaries; B-02 chunk equivalence lacked Tool error/output, media and Compaction shapes | none | BLOCK | `ses_062d1dfd2ffexZCjNos6qxstxQ` |
| 3 | R34 | yes | none | N-01 pre-existing Goal test flakiness under full-suite load; N-02 single-sample timing assertions; N-03 commit must exclude unrelated worktree paths | APPROVE | `ses_0627920f5ffeXWYts4oAAQzYQw` |

Round-3 verdict recorded verbatim: **APPROVE — exact R34 implementation diff
against approved canonical plan revision R34 only.** The auditor independently
re-ran the §18 commands (`109 pass`, `112 pass`, `93 pass`, `31 pass`,
`bun typecheck` clean, `git diff --check` clean) and recomputed the comment gate
as `E=864`, `C=165`, required `130`, ratio `19.1%`.

R29 identified the thirteenth fixture path. Its plan audit then found that the
loop-entry Session snapshot makes queued control-panel changes stale. R30 added
the correct owner but its audit required sensitive Revert and Permission tests.
R31 kept the same production correction and rewrote existing tests only:
warm cache -> public Revert/cleanup -> Provider body, and initial bash deny ->
queued public allow -> next-step real bash execution.
Its sixth-round audit required one remaining fresh-surface signal. User then
authorized one extra R32 audit. R32 extends the existing warm Plugin fixture so
`tool.definition` returns v1 then v2 description/schema and the second TestLLM
Provider Tool body must contain only v2.
R33 added an executable contraction plan, but its audit showed that cross-runLoop
freshness and append-only timing were insufficient. User authorized R34. R34
moves Tool-definition and MCP state changes into the same queued continuation
runLoop and adds unchanged full-hit versus one-entry eviction/rebuild timing.
B-01 is corrected at `SessionRevert`; B-02 and
B-03 now have sensitive public behavior tests in the approved Prompt suite.
Those tests exposed that four existing Revert regressions still construct
builtin Tool Parts without the new top-level authority. Treating missing as a
Tool-name-derived policy would reopen B-01 and violate the original default-none
contract. R32 adds `revert-compact.test.ts`, updates its shared bash/edit fixtures
to persist `ambient`/`declared`, and changes the queued Prompt test to disable
bash through the public control-panel input before the next Tool continuation.
No production compatibility fallback is introduced.

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

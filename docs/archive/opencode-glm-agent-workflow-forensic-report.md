# OpenCode GLM Agent Workflow Forensic Report

This report is append-only. Each section is a confirmed measurement, confirmed finding, or confirmed source mechanism. Candidate signals that have not survived message-neighborhood replay are not written as conclusions.

---

# Run: 2026-06-28 05:30 UTC

## Scope

- Database: `C:\Users\Lenovo\.local\share\opencode\opencode.db`
- Source: `F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\src`
- Report: `F:\ML\PythonAIProject\Claude-Code\opencode\docs\opencode-glm-agent-workflow-forensic-report.md`

## Safety Check

- Database opened with read-only URI `file:...?mode=ro&immutable=1`.
- `PRAGMA query_only=ON` applied on every connection.
- SQLite version: 3.50.4.
- Source directory exists; treated read-only for this run.
- Git working tree inspected read-only (`git status`, `git log`); no ref/index/working-tree mutations performed.
- Report is the only write target.

## Environment snapshot

- Branch: `dev-smark`. Working tree shows only `M thirdparty/chatgpt-browser-agent` (pre-existing submodule state).
- Session time span in DB: 2026-04-21 14:21 UTC → 2026-06-28 05:10 UTC (≈ 68 days).
- Totals: 816 sessions, 67135 messages, 298900 parts, 94164 tool-call parts.

---

## Confirmed Measurement: Database schema map

Schema was reconstructed from `sqlite_master` SQL, `PRAGMA table_info`, row counts, and JSON sampling of `data` columns. All counts below are reproducible `SELECT COUNT(*)` results.

### Core content tables

| table | rows | role | key fields |
| --- | ---: | --- | --- |
| `session` | 816 | one row per conversation | `id`, `project_id`, `parent_id` (subagent/fork), `title`, `directory`, `agent`, `model` (JSON), `time_created/updated`, `time_compacting`, `time_archived`, `cost`, `tokens_*` |
| `message` | 67135 | one row per user/assistant turn | `id`, `session_id`, `time_created/updated`, `data` (JSON) |
| `part` | 298900 | one row per message part (text/tool/reasoning/...) | `id`, `message_id`, `session_id`, `time_created/updated`, `data` (JSON) |
| `session_message` | 683 | session-level control events | `session_id`, `type` (`agent-switched` x167, `model-switched` x516), `data` (JSON) |
| `todo` | 952 | per-session todo list | `session_id`, `content`, `status`, `priority`, `position` |
| `request_usage` | 5421 | per-API-request accounting | `session_id`, `request_id`, `status`, `provider_id`, `model_id`, `tokens_*`, `error_message` |
| `request_usage_assistant` | 46007 | per-assistant-message accounting | `session_id`, `assistant_message_id`, `status`, `tokens_*`, `error_message` |
| `project` | 19 | registered projects | `id`, `worktree`, `vcs`, `name` |

### `message.data` JSON shape

- User message: `{role:"user", time:{created}, agent, model:{providerID,modelID}, summary:{diffs:[]}}`
- Assistant message: `{parentID, role:"assistant", mode, agent, path, cost, tokens, modelID, providerID, time:{created,completed}, finish}`

### `part.data` JSON shape — type distribution (reproducible count over all 298900 rows)

| part type | count |
| --- | ---: |
| tool | 94164 |
| step-start | 58865 |
| step-finish | 57654 |
| reasoning | 48938 |
| text | 34075 |
| patch | 4836 |
| compaction | 316 |
| file | 114 |
| agent | 7 |

### `tool` part JSON shape

Top-level keys: `{type:"tool", tool, callID, state}`. `state` keys: `{status, input, output, metadata, title, time}`. `state.status` ∈ {completed: 92515, error: 1625, running: 19, pending: 5}. `state.input` is the tool arguments object; `state.output` is the tool result string.

### Tool name distribution (over all 94164 tool parts)

| tool | count |
| --- | ---: |
| read | 31553 |
| bash | 26464 |
| grep | 12496 |
| edit | 6103 |
| apply_patch | 5493 |
| glob | 4660 |
| todowrite | 3175 |
| write | 956 |
| task | 587 |
| permission_review_decision | 507 |
| skill | 381 |
| vscode_notebook_* (5 tools) | 929 |
| tavily_search/extract | 212 |
| webfetch | 174 |
| question | 140 |
| chatgpt_ask/status/stop | 161 |
| invalid | 61 |

### Model / provider usage (request_usage, top by request count)

- `DaXiao Codex/gpt-5.5`: 1732 reqs
- `DawCode-openai/gpt-5.5`: 644 reqs
- `deepseek/deepseek-v4-pro` (incl. opencode-go): 1120 reqs
- `openai/gpt-5.5`: 459 reqs
- `zhipuai/glm-5.2`: 350 reqs
- `google/gemini-3.1-pro-preview`: 269 reqs

### Relations confirmed by FK + sampling

- `part.session_id` and `part.message_id` → `message.id` → `message.session_id` → `session.id`.
- `session.parent_id` non-null marks subagent/fork sessions (e.g. titles suffixed `(fork #N)`).
- Tool calls and tool results are **co-located in the same `tool` part** (`state.input` + `state.output`), ordered by `part.time_created` within a session. There is no separate tool-result table.

**Use in investigation:** this schema supports per-session ordered replay of every tool call with its arguments, result, status, and surrounding message text — sufficient for message-neighborhood replay.

---

## Confirmed Measurement: Candidate session index

These tables are **candidate queues only** (per the deep-investigation protocol). High counts here are not themselves findings; each candidate must survive message-neighborhood replay in Workflow 4 before being written as a Confirmed Finding.

### High-tool sessions (top by total tool calls)

| rank | session_id | msgs | tools | read | bash | grep | edit | glob | title |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | ses_138a727b0ffej3W7L7wxcza70b | 2702 | 4655 | 1795 | 923 | 1102 | 0 | 205 | 检查本地分支与 upstream/dev 差异 |
| 2 | ses_185d5fc2effe8p6oU7vVK9IIAB | 3027 | 3896 | 952 | 1317 | 238 | 0 | 66 | chatgpt-browser-agent 配置指南 |
| 3 | ses_1a9334ed9ffeV66ljMjX3TLk1l | 2011 | 3009 | 958 | 1013 | 334 | 0 | 51 | opencode 自动审查机制实施方案 (fork #1) |
| 4 | ses_1e1b63618ffe8lXS4uIkjY9aJa | 3533 | 2908 | 312 | 1306 | 29 | 1088 | 18 | 帆软反序列化payload构建与导出 (fork #3) |
| 5 | ses_1b433e7e5ffeNel9YNlU3ZrSqY | 1707 | 2458 | 791 | 795 | 302 | 0 | 57 | opencode 自动审查机制实施方案 |
| 6 | ses_1a9337968ffeUV8mcmjSE7gJdB | 1542 | 2290 | 711 | 777 | 256 | 0 | 47 | opencode 自动审查机制实施方案 (fork #1) |
| 7 | ses_195c500ceffeI9FvMpKWlLE8Wp | 1353 | 1694 | 394 | 828 | 207 | 21 | 107 | 检查哔哩哔哩APK完整类名 |
| 8 | ses_14b11ae5bffepWD9n7QDSrVQ5D | 1033 | 1608 | 474 | 548 | 176 | 0 | 73 | GitHub库完整调研分析 |
| 9 | ses_14f2f428dffes3alsgfc0KZplC | 713 | 1521 | 454 | 641 | 202 | 0 | 78 | GitHub Actions Windows 核心测试取消原因排查 |
| 10 | ses_2085acb06ffeAi7el8VtzV9Ewe | 1423 | 1240 | 431 | 136 | 208 | 272 | 35 | 查找 opencode read 50KB 限制位置 (fork #2) |

### Repeated-read candidate sessions (same file read ≥4 times)

| rank | session_id | repeated_read_calls | repeated_files | top file (read count) | title |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | ses_154d8b795ffe1TLNyx0l45ZQRl | 253 | 6 | `content_main.js` (x130) | 插件认证与会员权限机制研究 |
| 2 | ses_1e1b63618ffe8lXS4uIkjY9aJa | 252 | 17 | `VerifyCommand.java` (x91) | 帆软反序列化payload (fork #3) |
| 3 | ses_14b11ae5bffepWD9n7QDSrVQ5D | 313 | 27 | `.temp\chatgpt-browser-agent\chatgpt-c…` (x43) | GitHub库完整调研分析 |
| 4 | ses_2070a971dffe1Q5vglUGl2S2rW | 238 | 25 | `sdks\vscode\src\extension.ts` (x41) | 查找 opencode read 50KB 限制 (fork #3) |
| 5 | ses_1d7cea756ffeZnmo4rYKXOFgBH | 225 | 20 | `src\session\process…` (x50) | 排查 opencode.db 会话 SSE 渲染脱钩 |
| 6 | ses_2311d566effeuwqCQBKZSYKiaH | 248 | 28 | `src\cli\cmd\tui\uti…` (x28) | Opencode dev与session/index.tsx差异对比 |
| 7 | ses_166f03854ffeTaxhcFv5tlzFJc | 209 | 19 | `src\session\prompt…` (x30) | autoreview 权限收缩逻辑调查 |
| 8 | ses_150954dc8ffe7f0PRzs5Qfavnz | 186 | 11 | `test\cli\cmd\tui\se…` (x41) | 检查测试失败问题是否已修正 |

### Repeated-grep candidate sessions (same pattern run ≥3 times)

| rank | session_id | repeated_grep_calls | top query (count) | title |
| ---: | --- | ---: | --- | --- |
| 1 | ses_138a727b0ffej3W7L7wxcza70b | 169 | `<<<<<<<\|=======\|>>>>>>>` variants (x43+x35+x26) | 检查本地分支与 upstream/dev 差异 |
| 2 | ses_193377acbffe9rX0WnuVNakx19 | 39 | `GAdPegasus` (x21) | Find detail page ad source (fork) |
| 3 | ses_1f8edbfe7ffeGuX3tCQno413Rn | 27 | `<<<<<<<\|>>>>>>>` (x24) | 调研 opencode dev 分支更新内容 (fork #1) |

### Repeated-bash candidate sessions (same command run ≥3 times)

| rank | session_id | repeated_bash_calls | top command (count) | title |
| ---: | --- | ---: | --- | --- |
| 1 | ses_185d5fc2effe8p6oU7vVK9IIAB | 1077 | `node -e "const fs=require('fs')…"` (x146), `npm test` (x116) | chatgpt-browser-agent 配置指南 |
| 2 | ses_1a9334ed9ffeV66ljMjX3TLk1l | 803 | `bun typecheck` (x161), `rtk git status --short` (x66) | opencode 自动审查机制 (fork #1) |
| 3 | ses_1e1b63618ffe8lXS4uIkjY9aJa | 647 | `H:\FRCheck\scripts\deploy.ps1` (x342) | 帚软反序列化payload (fork #3) |
| 4 | ses_13bcefd30ffeIXc1TTuyX7Y3xZ | 176 | `bun -e 'const file=await Bun.file…'` (x176) | 雅思阅读真经课程转录 |

### Tool-error-heavy sessions

| session_id | error tools | title |
| --- | --- | --- |
| ses_1e1b63618ffe8lXS4uIkjY9aJa | edit:57, bash:27, write:10 | 帚软反序列化payload (fork #3) |
| ses_185d5fc2effe8p6oU7vVK9IIAB | apply_patch:59, read:9, bash:5 | chatgpt-browser-agent 配置指南 |
| ses_138a727b0ffej3W7L7wxcza70b | read:24, apply_patch:22, grep:12 | 检查本地分支与 upstream/dev 差异 |

### Candidate selection for deep dive (Workflow 4)

The following sessions are selected for message-neighborhood replay, chosen for diversity (extreme repeat, source-related, build-loop, long exploration, success candidates):

1. `ses_154d8b795ffe1TLNyx0l45ZQRl` — content_main.js read x130 (extreme repeat).
2. `ses_138a727b0ffej3W7L7wxcza70b` — longest session; merge-conflict grep repetition.
3. `ses_1e1b63618ffe8lXS4uIkjY9aJa` — deploy.ps1 x342 build-deploy loop; VerifyCommand.java x91.
4. `ses_185d5fc2effe8p6oU7vVK9IIAB` — node -e x146 / npm test x116.
5. `ses_2311d566effeuwqCQBKZSYKiaH` — source comparison; read.ts read x20 (mechanism-mappable).
6. `ses_1d7cea756ffeZnmo4rYKXOFgBH` — opencode SSE investigation; session/process read x50.
7. `ses_1a9334ed9ffeV66ljMjX3TLk1l` — opencode autoreview impl; bun typecheck x161.
8. `ses_1574b2b0affe6N339iRGe8bdpQ` — OpenCode harness source-priority research (meta/source-related).

Success/control candidates to locate in Workflow 4: shorter sessions with low repeat counts and a clear final patch/report write.

---




---

# Deep-Dive Findings (Pass 1)

Methodology note: every finding below is grounded in (a) reproducible DB queries over `part`/`message` rows with message-neighborhood replay, and (b) the CURRENT repo source at `packages/opencode/src` (read.ts modified 2026-06-24, compaction.ts modified 2026-06-23). The historical DB spans 2026-04-21 to 2026-06-28; where a mechanism postdates a session, this is stated explicitly and the finding is framed against the current source baseline.

---

## Deep Dive: Session ses_154d8b795ffe1TLNyx0l45ZQRl - content_main.js x130 reads

### Why selected
Highest repeated-read signal in the dataset: `content_main.js` read 130 times in a single 207.8-minute session ("插件认证与会员权限机制研究"). Reverse-engineering a packaged Edge extension's auth/membership logic.

### Timeline (compressed)
1. User goal: trace the full "启用 AI 智能上下文" UI -> config -> membership-gate -> service-capability -> translation-request chain in a minified bundle.
2. Initial exploration: beautify + chunked reads of `content_main.js` (~127k lines), `popup.js`, `options.js`, `side-panel.js`.
3. Evidence gathering: small-window reads (80-320 lines) across many offsets.
4. Repetition point: hot region lines 41000-42000 read 15 times; region 71000-72000 read 7 times.
5. 4 context compactions over the session (15:06, 15:40, 16:14, 18:01).
6. Convergence: 33 edits applied; final synthesis delivered.

### Repeated-operation audit (content_main.js, 130 reads)

| metric | value | how computed |
| --- | ---: | --- |
| total reads | 130 | count of `read` parts with filePath containing `content_main.js` |
| partial-overlap with a prior read | 69 | line-range intersection non-empty with any earlier read |
| of those, meeting overlap-note threshold (>=20 lines AND >=30%) | 51 | per `findOverlapNote` thresholds in read.ts:234-250 |
| of those, BELOW note threshold (silent, no signal) | 18 | overlap < 20 lines or < 30% |
| exact-same-range still visible (stub should fire) | 0 | — |
| exact-same-range but compacted away | 0 | — |
| reads that returned a stub | 3 | metadata.read.stub = true |
| hot region 41000-42000 read count | 15 | 1k-line bucket density |

### Message-neighborhood evidence
- Part [358-360]: reads at off=39740/41930/41480 (mutually overlapping, region 39740-42200).
- Part [368-370]: reads at off=41120/41740/37695 — re-enter the 41000-42000 region already covered by [358-360].
- Part [376]: read off=39995 — re-enters the 39740-40135 region covered by [358].
- Reasoning immediately before a 41480 re-read: "reading known file ranges and employing grep could be useful" — the agent explicitly frames the region as "known" yet re-reads it.
- Reasoning before a 41340 re-read: "Diagnosing code issues ... There's an unus[ual]..." — re-read triggered by a new analysis question, not by lost content.

### Why confirmed (not a statistics artifact)
The four replay questions are answered: (1) agent wanted to re-examine auth/membership logic; (2) it already had lines 41000-42000 from earlier reads in context; (3) the re-read returned content >=30% identical to in-context content for 51 reads; (4) subsequent behavior used the re-read (it made edits) — so the re-read was not "info not used," it was "info re-acquired at token cost because no suppression existed."

## Confirmed Finding 1: read-tool dedup only suppresses exact/covering ranges; partial-overlap re-reads always re-fetch full content

### Evidence chain
- Session: `ses_154d8b795ffe1TLNyx0l45ZQRl`
- 130 reads of `content_main.js`; 69 partial-overlaps; only 3 stubs fired.
- Source: `packages/opencode/src/tool/read.ts:197-250`

### What the current source does
- `collectVisibleReads` (read.ts:197) gathers prior completed, non-compacted `read` parts for the same canonical path.
- `findReadStub` (read.ts:219) returns a suppressing stub only when a same-version read has `start === current.start && end === current.end` (exact same range) or `start <= current.start && end >= current.end` (fully covering). In both cases output is replaced by a "do NOT re-read" stub (read.ts:295-339).
- `findOverlapNote` (read.ts:234) computes the largest line intersection with a visible read and appends `<note type="overlap" ranges="...">` only if `lines >= OVERLAP_MIN_LINES (20)` and `lines/requested >= OVERLAP_MIN_RATIO (0.3)`. This note is informational and non-suppressive: the full content is still fetched and returned.
- Reads where `state.time.compacted === true` are excluded from `collectVisibleReads` (read.ts:205), so once a read's result is compacted it no longer counts as "visible" for either stub or overlap-note purposes.

### Why it is a design gap
1. Shifting-offset evasion. The model re-reads hot regions at slightly different offsets each turn (e.g. 41120, 41340, 41480, 41520, 41740, 41790, 41930, 41940, 41980). None match a prior read's exact (start,end), so `findReadStub` never fires; only `findOverlapNote` fires, and only post-hoc. The note cannot prevent the read it annotates — it can only influence the next read, which the model issues at yet another shifted offset.
2. Non-suppressive overlap note. For 51 of 69 overlapping reads the tool still returned full file content despite >=30% of it being already in context. The note adds tokens rather than saving them.
3. Silent sub-threshold overlaps. 18 overlapping reads were below the 20-line / 30% gate and received no signal at all.
4. No "explored regions" map. There is no persistent, model-visible structure recording which line ranges of a file have already been inspected this session. The only dedup state is the set of currently-visible (non-compacted) read parts, which (a) is reset by compaction and (b) only triggers on exact/covering ranges.

### Mechanism
The read tool optimizes for "don't suppress a read the model might legitimately need" at the cost of allowing large-volume redundant re-fetches on big files. For a 127k-line minified bundle explored in 80-320 line windows, the exact-match stub is too narrow and the overlap note is too weak to break the re-read loop; the model receives no durable record of what it has already explored.

### Verification design
Replay a large-file exploration task; instrument `findReadStub`/`findOverlapNote` hit rates. Candidate fix to test: (a) raise `findOverlapNote` to optionally suppress when overlap >= some higher ratio (e.g. 0.8) and return a stub-like "lines X-Y already in context (read at part Z), use offset=N for unread lines"; (b) persist an inspected-range registry across compaction via the Evidence Handoff file-range list (see compaction.ts EVIDENCE_FILE_RANGE_LIMIT). Measure partial-overlap re-read count before/after.

---



## Confirmed Finding 3: edit tool's "Could not find oldString" error gives no mismatch diagnostic, forcing re-reads or blind retries after all 9 fuzzy replacers fail

### Evidence chain
- DB-wide: 78 edit calls failed with "Could not find oldString" (1.3% of 6109 edits).
- After such an error: 15 retries WITHOUT re-reading the file first (blind retry, likely same stale oldString), 25 retries AFTER re-reading (forced re-read to recover), 38 gave up / switched approach.
- Source: `packages/opencode/src/tool/edit.ts:677-714`

### What the current source does
- `replace()` (edit.ts:677) runs 9 progressive fuzzy replacers: `SimpleReplacer`, `LineTrimmedReplacer`, `BlockAnchorReplacer`, `WhitespaceNormalizedReplacer`, `IndentationFlexibleReplacer`, `EscapeNormalizedReplacer`, `TrimmedBoundaryReplacer`, `ContextAwareReplacer`, `MultiOccurrenceReplacer` (edit.ts:684-694). This is a deliberate, layered match-tolerance design.
- When every replacer fails, edit.ts:708-711 throws: `"Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."` — a generic message with no reference to file content.
- Compare: the `read` tool's file-not-found error appends "Did you mean one of these? <candidates>" (read.ts:384-388), giving the model actionable alternatives. The edit error provides no equivalent.

### Why it is a design gap
1. **No closest-match hint.** The error does not report the file region that most resembled oldString, the line number where matching broke down, or the actual current content near the attempted location. With oldString blocks up to 1518 chars observed, the model cannot tell whether one line, one indent, or the whole region diverged.
2. **Recovery cost.** 25 of 78 failures forced a full file re-read before the model could correct oldString; 15 cases retried blind (no re-read), which for a stale oldString just fails again. A closest-match excerpt would let the model self-correct in one edit call without the re-read round-trip.
3. **Asymmetry with read.** The harness invests in did-you-mean suggestions for path typos but not for content-match failures, even though the latter are more frequent (78 oldString failures vs. 351 read-not-found, but read errors already self-diagnose).

### Mechanism
The 9-replacer chain is tuned to tolerate whitespace/indentation/escape drift, but its failure path discards all the partial-match information each replacer internally computed. That information (nearest anchor, diff position, surrounding lines) is exactly what the model needs to repair oldString, but it never reaches the error message.

### Verification design
On `notFound`, surface a bounded diagnostic: the line range of the closest block match (from `BlockAnchorReplacer`/`ContextAwareReplacer`) and a short excerpt of actual file content at that location. Replay the 78 failure cases and measure: (a) blind-retry count, (b) re-read-before-retry count, before/after. Expected: blind retries drop toward 0, forced re-reads drop, first-try correction rate rises.

---

# Pass 1 Inspected Registry

### Database
- Tables inspected: all 18 (schema + row counts + JSON sampling).
- Schema relationships confirmed: session<-message<-part (tool calls/results co-located in `tool` part `state`); session.parent_id = fork/subagent; session_message = agent/model-switch events; request_usage = per-request accounting.
- Sessions indexed: 816 (tool-count, repeated-read, repeated-grep, repeated-bash, error-density candidate tables built).
- Sessions deep-dived: 1 (`ses_154d8b795ffe1TLNyx0l45ZQRl` full replay).
- Message-neighborhood windows replayed: 4 (session 1 parts 245-380, 350-382, 1080-1095; session ses_2514c6924 parts 2249-2285).
- Candidate repeated-op events scanned: ~20 (content_main.js reads, deploy.ps1 loop, timeout-no-output, apply_patch/edit errors).
- Confusion-signal sweep: 71449 text/reasoning parts scanned; 161 "weird", 226 "stuck", 1826 "loop", 709 "confus", 158 "weird" across 84 sessions.

### Source
- Files read: `tool/read.ts` (197-339, 348-426), `session/compaction.ts` (1-200), `session/overflow.ts` (full), `tool/shell.ts` (1-120, 940-1034), `tool/edit.ts` (677-714).
- Mechanisms confirmed: read dedup (collectVisibleReads/findReadStub/findOverlapNote), compaction summary template + Evidence Handoff constants, overflow threshold, bash pipe-stdio + timeout race + "(no output)", edit 9-replacer chain + generic not-found error.

### Confirmed Findings Count (Pass 1)
- Measurements: 2 (schema map, candidate session index)
- Session findings: 0 (deep-dive narrative only)
- Source mechanisms: 0 (embedded in findings)
- Cross findings: 0
- Confirmed Findings: 3 (read-dedup partial-overlap gap; bash timeout no-output; edit no-mismatch-diagnostic)
- Reusable experiences: 0
- Candidate improvements: 0 (embedded in verification-design sections)

### Excluded candidates (Pass 1)
- "Compaction breaks read-dedup" was excluded as the PRIMARY cause for session 1: 0 of 130 content_main.js reads were exact-same-range-compacted-away. Compaction contributes (it resets visible-reads) but the dominant gap is partial-overlap threshold (Finding 1).
- "Tool errors have empty output" was excluded: error messages live in `state.error`, not `state.output`; all 1625 errors carry a diagnostic string. Initial measurement artifact.
- apply_patch "verification failed" (186 cases) and edit "aborted" (104 cases) deferred to later passes — aborted is user-driven, verification-failed needs its own neighborhood replay.

---



## Confirmed Finding 2: bash tool uses pipe stdio (not a pty), so block-buffered build commands yield "(no output)" on timeout, triggering blind retry cascades

### Evidence chain
- 89 bash tool calls across the dataset returned "(no output)" on timeout (output length < 200 chars + "terminated command after exceeding timeout").
- Timeout-no-output clusters in build/test sessions: `ses_224c713d8` (6), `ses_1b433e7e5`/`ses_1a9337968`/`ses_1a9334ed9` (6 each, opencode autoreview), `ses_2514c6924` (4).
- Sample timed-out-no-output commands: `wsl ... bun install --frozen-lockfile`, `wsl ... bun install` (x2), `bun test --timeout 60000`, `bun run script/build.ts --single`, `bundle install`, `opencode --version`, `Get-ChildItem -Recurse`.
- Replay `ses_2514c6924` parts [2249]->[2252]->[2276]->[2280]: timeout(300s, no output) -> retry(600s, no output) -> retry -> timeout -> agent concedes "安装一直挂起，可能是网络问题。换策略". Three blind retries before strategy change.
- Source: `packages/opencode/src/tool/shell.ts:946-1019`

### What the current source does
- `shell.ts:949` spawns via `spawner.spawn(cmd(...))` using `ChildProcessSpawner` (imported from `effect/unstable/process`, line 22-23) — a **pipe-based** stdio, not a pseudo-tty.
- `shell.ts:951-955` consumes `handle.all` as a byte stream into `onChunk`; `shell.ts:985` `Fiber.join(output)` ensures buffered chunks are flushed. So partial output **is** preserved when chunks exist.
- `shell.ts:1018-1019`: `const emptyOutput = end.text.length === 0; let output = emptyOutput ? "(no output)" : end.text`.
- `shell.ts:992-995`: on timeout appends `formatExecutionNotice({severity:"warning", reason:"timeout", timeout_ms})` → "bash tool terminated command after exceeding timeout N ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout".

### Why it is a design gap
1. **Pipe block-buffering.** Non-tty stdout is block-buffered (typically 4KB/8KB). Build tools (`bun install`, `bundle install`, `bun test`, `bun run build`) emit progress in small lines that sit in the libc buffer until it fills or the process exits. On timeout-kill, the buffer is discarded by the OS, so the stream never receives those bytes → `end.text` is empty → "(no output)". A pseudo-tty would force line-buffering and surface incremental progress.
2. **No "hung vs slow" distinction.** The "(no output)" + timeout-notice gives the model no way to tell whether the process was (a) actively working but block-buffered, (b) hung waiting for interactive input, or (c) deadlocked. The notice's only guidance is "retry with a larger timeout", which the model follows literally — producing the observed retry cascade.
3. **Quantified waste.** In `ses_2514c6924` alone, 4 timeout-no-output events each cost a 300-600s wait plus a follow-up retry command; the agent only escaped by abandoning the approach after 3 failed retries. Across 89 cases the retry-then-give-up pattern is the dominant escape.

### Mechanism
The bash tool's pipe-based stdio optimizes for simplicity and capture-fidelity (exact bytes, no terminal escape-noise) but loses incremental output for block-buffered commands. Combined with a timeout notice whose only remediation is "retry longer", the model enters a blind retry loop instead of diagnosing the stall.

### Verification design
On timeout with empty output, the harness could: (a) optionally run commands through a pty (or `stdbuf -oL`/`unbuffer`) when output is empty after a grace period; (b) enrich the timeout notice when `emptyOutput` is true — e.g. "process produced no output before timeout (stdout may be block-buffered or the process may be waiting for input); consider `--verbose`/`unbuffer`/checking for an interactive prompt". Replay the `bun install` timeout sequence and measure retry count before/after.

---



# Deep-Dive Findings (Pass 2)

## Confirmed Finding 4: Evidence Handoff preserves read ranges and verification commands across compaction, but excludes grep/glob search history — so search memory is lost on every compaction

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:562-586` (renderEvidenceHandoff), `:398-467` (renderInspectedFiles), `:492-504` (isSimpleVerificationCommand)
- Confirmed structure: Evidence Handoff renders three sections — "### Inspected Files" (from `read` tool only, compaction.ts:403 `if (event.part.tool !== "read") continue`), verified bash commands (compaction.ts:576, gated by `isSimpleVerificationCommand` matching `bun/npm/pnpm/yarn typecheck|test|build|lint`, `tsc --noemit`, `eslint`, `python -m py_compile`), and "### Outstanding Todos".
- No section renders grep queries, glob patterns, or their results.
- Historical consequence: in `ses_138a727b0` the agent ran 200 merge-conflict greps across the session with 4 compactions; after each compaction the model had no record of which conflict-marker queries it had already run or what they returned, so it re-established the same search state from scratch.

### Why it is a design gap
1. **Searches are not idempotent to rediscover.** A grep that returned "No files found" is negative evidence — it tells the model a symbol/pattern does not exist in a path. Losing that on compaction means the model re-runs the same empty-result searches. The `ses_1f967ce54` replay showed the agent running `from "@?/session"` searches returning "No files found" repeatedly; after compaction it would have no memory of those negatives.
2. **Asymmetric preservation.** Read ranges survive compaction (up to 20 files / 8 ranges each, EVIDENCE_FILE_LIMIT/EVIDENCE_FILE_RANGE_LIMIT), but the searches that *located* those ranges do not. The model knows *what* it read but not *how it found it*, so it cannot efficiently re-navigate a large codebase after compaction.
3. **grep has no within-context dedup either** (grep.ts contains no visible-read/stub/registry mechanism — confirmed by source search). So grep is doubly exposed: no within-turn suppression (unlike read's stub) AND no cross-compaction preservation (unlike read's Evidence Handoff). Search history exists only in raw tool parts, which compaction discards.

### Mechanism
Evidence Handoff was designed around file-inspection and verification state — the two things edit workflows need most. Search history was treated as disposable intermediate exploration. But for investigation/forensic/exploration tasks (a large share of this dataset: "检查本地分支", "GitHub库完整调研", "查找 opencode 50KB 限制"), the search trail *is* the work product, and discarding it forces re-exploration.

### Verification design
Add a bounded "### Search History" section to Evidence Handoff: top N distinct grep/glob queries (by recency) with their result counts and the include/path scope, capped like EVIDENCE_FILE_LIMIT. Replay `ses_138a727b0` (200 greps, 4 compactions) and measure post-compaction repeated-search count before/after. Expected: post-compaction duplicate searches drop; the model references the handoff table instead of re-running.

---

## Confirmed Finding 5: doom_loop detector requires exact input match (JSON.stringify equality) across 3 consecutive same-message tool calls, so shifting-input loops evade it entirely

### Evidence chain
- Source: `packages/opencode/src/session/processor.ts:33` `const DOOM_LOOP_THRESHOLD = 3`; `:456-481` the detector.
- Detection logic (processor.ts:457-467): `parts = MessageV2.parts(ctx.assistantMessage.id)` (current message only), `recentParts = parts.slice(-3)`, fires only if all 3 are `type==="tool"`, same `tool` name, `status !== "pending"`, and `JSON.stringify(part.state.input) === JSON.stringify(value.input)` — **exact byte-for-byte input equality**.
- On fire (processor.ts:472-480): calls `permission.ask({permission:"doom_loop", ...})` — a permission prompt, not a hard suppress. The loop can continue if approved.
- DB measurement: across all 816 sessions, only **10 runs of >=3 exact-identical tool calls** exist (longest run = 7). The 823 "doom" string mentions in parts are overwhelmingly source-code content read by the `read` tool (468/654 tool mentions are `read`), not doom_loop triggers.
- Contrast: Finding 1's `ses_154d8b795` ran 130 reads of `content_main.js` with shifting offsets (41120, 41340, 41480, 41520, 41740, ...) — zero of these match `JSON.stringify` equality, so the doom_loop detector never fires. Finding 4's `ses_138a727b0` ran 156 near-identical merge-conflict greps with subtly different regexes (`<<<<<<<|=======|>>>>>>>` vs `^(<<<<<<<|=======|>>>>>>>)` vs `^(<<<<<<<|=======$|>>>>>>>)`) — also zero exact matches.

### Why it is a design gap
1. **Exact-match is the weakest possible loop signature.** The dominant loop pattern in this dataset is *semantic-repeat with syntactic-variation*: same intent, different offset/pattern/flag. `JSON.stringify` equality catches only the degenerate case where the model emits byte-identical calls 3 times in a row — which strong models almost never do (they vary the input slightly, whether intentionally or not).
2. **Same-message scope is too narrow.** The check is scoped to `ctx.assistantMessage.id` parts. Loops that span multiple turns (the 130-read case spans dozens of turns over 207 minutes) are invisible to it even if inputs were identical.
3. **Permission-ask is non-suppressive.** Even the 10 exact-identical runs that could trigger it only produce a prompt; an auto-approve or user approval resumes the loop. There is no forced strategy-change or tool-cooldown.
4. **No semantic similarity.** The detector has no notion of "same tool, same file, overlapping range" (read) or "same pattern intent" (grep). The read stub (`findOverlapNote`) and this doom-loop detector are two separate mechanisms that both fail to catch the shifting-offset pattern, for different reasons.

### Mechanism
The doom_loop detector is a safety valve against the most pathological case (exact-identical stall), not a loop-prevention mechanism for realistic exploration loops. Its threshold (3), scope (single message), and equality test (JSON.stringify) are each independently too tight, and their conjunction makes it nearly inert for the loop patterns that actually occur.

### Verification design
Broaden the signature: (a) detect "same tool + same filePath/pattern key across N calls within a window of M turns" (not just same message); (b) for `read`, reuse the `collectVisibleReads` overlap computation to flag "read same file 5+ times with >50% aggregate range overlap in the last 20 calls"; (c) on trigger, instead of only a permission ask, inject a system-note "you have read file X N times in the last M turns; consider using grep or summarizing what you already have." Replay `ses_154d8b795` and `ses_138a727b0`; measure whether the loop shortens.

---



## Confirmed Finding 6: disabled tools (e.g. apply_patch) are removed from the model's tool list with no substitution guidance, so the model wastes turns attempting unavailable tools before adapting

### Evidence chain
- 61 `invalid` tool parts across 31 sessions. Attempted tools: `apply_patch` x42, `bash` x7, `edit` x6, `task` x2, `grep` x2, `read` x1, `write` x1.
- The `invalid` tool's `state.input.error` reads: "Model tried to call unavailable tool 'apply_patch'. Available tools: invalid, question, bash, read, glob, grep, edit, write, task, webfetch, todowrite, skill, gemini_quota." (apply_patch absent from the list.)
- Retry rate: only 1 of 61 invalid calls was followed by another invalid — the model adapts within one turn, but pays one wasted round-trip per session where it reaches for the disabled tool.
- Agents affected: `None` x16, `auto` x8, `build` x7 (main sessions, not forks).
- Source: `packages/opencode/src/tool/selection.ts:10-18` (`enabled()` denies a tool when a permission rule has `pattern:"*"` + `action:"deny"`); `packages/opencode/src/tool/invalid.ts` produces the invalid-tool response.

### What the current source does
- `selection.ts:10-18` controls model exposure: if the permission ruleset denies a tool with a wildcard pattern, `enabled()` returns false and the tool is dropped from the schema sent to the provider.
- When the model still emits a call to the denied tool (common for providers with a strong `apply_patch` prior), the harness routes it to the `invalid` tool, whose output lists the available tool names but gives **no mapping** from the denied tool to its substitutes.

### Why it is a design gap
1. **No substitute hint.** The invalid response says "apply_patch is unavailable" and lists `edit, write` as available, but never says "apply_patch was replaced by edit (targeted replacement) / write (full file)." The model must infer the mapping itself, costing a turn.
2. **Provider-prior mismatch.** `apply_patch` is the canonical patch tool for some providers (e.g. Claude). When a deployment denies it, every fresh session incurs the same one-turn discovery cost. 42 apply_patch attempts across the dataset confirm this is a recurring per-session tax, not a one-off.
3. **Asymmetric with read's did-you-mean.** The `read` tool suggests candidate paths on file-not-found (read.ts:384-388); the `invalid` tool does not suggest candidate substitute tools on tool-not-available, despite the substitute being deterministic (apply_patch → edit/write).

### Mechanism
Tool disabling is a permission-layer concern (selection.ts), but the recovery message is a generic tool-list dump (invalid.ts). The two layers are not connected: the permission layer knows *why* apply_patch was denied and *what* replaces it, but that knowledge is not forwarded to the invalid-tool message the model sees.

### Verification design
When a denied tool is attempted, enrich the invalid response with a substitute directive: "apply_patch is not available in this session. Use `edit` (replace oldString→newString) or `write` (overwrite full file) instead." Measure: apply_patch invalid-attempt count before/after in a deployment that denies apply_patch. Expected: invalid attempts drop toward 0 on the first turn.

---



# Deep-Dive Findings (Pass 3)

## Confirmed Finding 7: bash output truncation always uses tail direction; for sequential outputs like `git diff` (257 truncated cases) the head is discarded, forcing filtered re-runs or decisions on partial output

### Evidence chain
- 1088 bash tool outputs truncated (4.1% of 26542 bash calls). Full output saved to `tool-output/tool_*` files.
- Truncated command categories: `git diff` x257, `test` x112, `deploy.ps1` x54, `git status` x50, `list` x37, `node -e` x32, `xelatex` x30, `adb logcat` x19.
- Model read the saved full-output file in only 310 cases across the whole dataset (not 1:1 with the 1088 truncations).
- After truncation, the model re-ran the same command with a filter (`Select-String`, `grep`, `head`, `--name-only`) in 47/300 sampled cases (~16%).
- Source: `packages/opencode/src/tool/shell.ts:1007` `const end = tail(input.compressOutput ? compressed.text : normalized, limits.maxLines, limits.maxBytes)` — hard-coded `tail` direction for bash; `packages/opencode/src/tool/truncate.ts:16-17` `MAX_LINES=1000, MAX_BYTES=16KB`; `truncate.ts:104-111` tail selection loop.

### What the current source does
- `shell.ts:1007` calls `tail(...)` unconditionally — bash output is always truncated from the end.
- `truncate.ts:81-130`: when output exceeds 1000 lines or 16KB, it saves the full text to a file and returns the last N lines + a notice "Full output saved to: <path>".
- The notice is prepended for tail direction (truncate.ts:124-126): `${notice}\n\n${preview}`.

### Why it is a design gap
1. **Tail is wrong for sequential-begins-at-head commands.** `git diff` (257 truncations) lists file changes in path order; the head has the first files' diffs. `git status` (50) lists staged/unstaged in order. `ls`/`Get-ChildItem` (37) lists entries alphabetically. For all of these, the tail truncation discards the beginning and the model must either read the saved file or re-run with a filter to see what was cut.
2. **No command-aware direction.** The harness knows the command (it parses it for permission/arity checks, shell.ts:41-111) but does not use that knowledge to pick head vs tail. Error-producing commands (typecheck, test) benefit from tail; listing/diff commands benefit from head or both.
3. **Low full-output follow-up.** The model reads the saved truncation file in only ~310 cases vs 1088 truncations. In the majority of truncated cases the model proceeds on partial output — and in ~16% it pays an extra filtered re-run to recover the missing head.
4. **Compounding with compaction.** A truncated bash output that the model did read the full file for becomes, after compaction, just the truncated preview + a stale file path. The full output is lost to compaction (Evidence Handoff does not preserve bash output content, only verification command names).

### Mechanism
The single tail-direction policy optimizes for the common error-at-the-end case (typecheck/build/test failures) at the expense of head-important commands (diff/status/list). The saved-file escape hatch exists but is underused because the notice is a passive path, not an active suggestion, and the model often proceeds with what it can see.

### Verification design
Make truncation direction command-aware: `head` or `head+tail` (first N + last M lines with a "… N lines omitted …" separator) for `git diff`, `git status`, `ls`/`Get-ChildItem`/`dir`; keep `tail` for `typecheck`/`test`/`build`. Measure: filtered re-run count after truncation before/after; full-output-file read rate. Expected: filtered re-runs drop; decisions on truncated `git diff` improve (fewer follow-up "what files changed?" commands).

---



## Confirmed Finding 8: system prompt instructs verification before completion but the harness enforces no verification gate — 45% of edit sessions end without any verification command

### Evidence chain
- 223 sessions contain edit/apply_patch/write operations. Sampling 200: 110 (55%) end with a verification bash command (typecheck/tsc/test/build/lint/py_compile/eslint in the last 30 parts); 90 (45%) do not.
- Source: `packages/opencode/src/session/system.ts:126-129` `verificationSection` — "Before reporting a coding task complete, verify the change when feasible. Start with the narrowest relevant check... If you cannot verify, state that plainly and explain the blocker."
- The instruction is advisory ("when feasible"), with no harness-level gate: there is no code path that detects "edits were made but no verification ran" and warns the user or blocks session completion.

### What the current source does
- `verificationSection` is a static system-prompt string (system.ts:126-129) included via `staticSections()` (system.ts:147-155). It is pure prose with no enforcement.
- The processor (processor.ts) has no "verification check" step before ending a turn or session. The `needsCompaction` flag (processor.ts:668) is the only post-step gate, and it triggers compaction, not verification.
- The `todo` tool tracks task progress but has no linkage to verification status — a todo can be marked "completed" without any verification tool having run.

### Why it is a design gap
1. **Advisory-only.** "When feasible" lets the model skip verification in nearly half of edit sessions. The 45% non-verification rate is the measured compliance gap.
2. **No verification state.** The harness records tool calls (part table) but has no derived "session verified" flag. It cannot distinguish a session that ran `bun typecheck` after edits from one that only ran `rtk git status`.
3. **Todo decoupling.** Todos can be marked completed without verification, so the model's own progress tracker does not enforce the verification step. A verification-gate linked to todo completion would close the loop.
4. **Consequence.** Unverified edits propagate to later sessions (via git or file state), where a different session discovers the breakage — increasing total work across the dataset.

### Mechanism
Verification is treated as a prompt-level suggestion rather than a harness-level invariant. The harness has the information to enforce it (it knows which tools ran and whether edits preceded them) but does not act on it.

### Verification design
Add a lightweight verification gate: when a session with edits ends (user sends new message or session goes idle) without any verification command having run after the last edit, emit a user-visible notice "Edits were made but no verification (typecheck/test/build) was run." Do not block, just surface. Measure: non-verification rate before/after. Expected: non-verification drops; cross-session breakage-discovery sessions decrease.

---

## Confirmed Finding 9: model switching mid-session (516 events) changes the system prompt and tool-preference guidance, but contextContinuitySection only warns about compaction ghosts — not model-switch transitions

### Evidence chain
- 516 `model-switched` events across 394 sessions; up to 18 switches in one session (`ses_1b433e7e5`).
- 9 of 31 sessions with invalid tool calls (29%) had model switches; 5 of 7 `apply_patch` invalid calls in switched sessions occurred AFTER a switch.
- Switch sequences observed: `DaXiao Codex/gpt-5.5 -> DawCode-openai/gpt-5.5 -> openai/gpt-5.5`, `GLM-5.1 -> deepseek-v4-flash -> deepseek-v4-pro -> gemini-3.1-pro`, etc.
- Source: `packages/opencode/src/session/system.ts:29-47` `provider()` returns a different base prompt per model family (PROMPT_GPT, PROMPT_ANTHROPIC, PROMPT_DEEPSEEK, PROMPT_GEMINI, etc.); `system.ts:131-135` `contextContinuitySection` warns about compaction and resume ghosts but never mentions model switching.

### What the current source does
- On model switch, `provider()` (system.ts:29-47) selects a different base prompt template. The conversation history (built under the previous model's prompt) is retained verbatim.
- `contextContinuitySection` (system.ts:131-135) says: "The conversation may be compacted or resumed from a summary... Compaction summaries can include stale or unrelated context... Before your final response after a resume, interruption, or context transition, sanity-check that your answer and tool actions address the newest user request, not an older ghost still lingering in the thread."
- The phrase "context transition" is generic; there is no explicit model-switch guidance (e.g., "the model was just switched; your tool preferences may differ from the previous model's history").

### Why it is a design gap
1. **Tool-preference mismatch.** Different model families have different tool priors (Claude → apply_patch; GPT → edit). When switched mid-session, the new model sees the old model's tool-call history and may reach for a tool the old model used but the new model's config denies (Finding 6). The 5/7 post-switch apply_patch invalids confirm this.
2. **Prompt-template discontinuity.** The base prompt changes (PROMPT_GPT vs PROMPT_ANTHROPIC have different tone, tool guidance, formatting rules), but the model gets no note that the prior turns followed a different prompt's conventions. This can cause the new model to misinterpret prior assistant text as its own prior output and imitate conventions that no longer apply.
3. **No transition marker.** Compaction produces a visible `compaction` part and an anchored summary. Model switching produces only a `session_message` row of type `model-switched` (session_message table) that is NOT surfaced as a model-visible context marker — the model is not told a switch happened.

### Mechanism
Model switching reuses the conversation history but swaps the system prompt, creating a silent discontinuity. The contextContinuitySection anticipates discontinuity from compaction but is blind to the discontinuity from provider/prompt swaps.

### Verification design
On model switch, inject a model-visible transition note (like the compaction summary but shorter): "The active model was switched from <prev> to <next>. Prior turns followed <prev>'s conventions; follow <next>'s tool and formatting guidance from now on. Re-check any tool the prior model used that may not be in your current tool set." Measure: post-switch invalid-tool-call count before/after. Expected: post-switch invalids drop; tool-preference mismatch decreases.

---



## Confirmed Finding 10: subagents receive only the parent's text prompt with no inherited read/search state — 92% of fork sessions re-read files the parent already inspected

### Evidence chain
- 100 fork (subagent) sessions found with `parent_id` set. Sampling 26 forks where both parent and fork read files: 24 (92%) re-read at least one file the parent had already read.
- Overlap examples: "调研请求级token统计架构" fork read 37 files, parent read 121, 18 overlapped (processor.ts, storage.ts, retry.ts, ...); "查找ClaudeCode token相关实现" fork read 22, parent read 122, 10 overlapped (session.ts, prompt.ts, index.tsx, ...).
- Source: `packages/opencode/src/tool/task.ts:226-229` — `const parts = yield* ops.resolvePromptParts(params.prompt)` then `ops.prompt({ sessionID: nextSession.id, ... })`; `task.ts:186-194` `sessions.create({ parentID: ctx.sessionID, ... })` creates a fresh session with no message history from the parent.

### What the current source does
- The TaskTool creates a brand-new session (`nextSession.id`) for the subagent (task.ts:186-194). The subagent's only input is `params.prompt` (the text the parent wrote).
- No parent conversation history, read metadata, search history, or Evidence Handoff is passed to the subagent session.
- The subagent's permission is derived from the parent's (task.ts:174-183 `deriveSubagentSessionPermission`), but no context state is derived.

### Why it is a design gap
1. **No read-state inheritance.** The parent's `collectVisibleReads` and Evidence Handoff "Inspected Files" table exist at compaction time, but neither is forwarded to the subagent. The subagent starts with zero file knowledge and must re-read every file the parent already explored.
2. **92% re-read rate.** In the sampled forks, 24/26 re-read parent files. For investigation-heavy tasks (the dominant task type in this dataset), the subagent's first action is almost always to re-read the same source files the parent already read — duplicating token spend.
3. **No search-history inheritance.** Compounding with Finding 4 (Evidence Handoff excludes grep/glob), the subagent has no record of the parent's searches either, so it re-runs the same grep/glob queries.
4. **Asymmetric with permission.** The harness carefully derives and forwards the parent's *permission ceiling* to the subagent (task.ts:174-183) but does not forward the parent's *exploration state*. Permission is treated as inheritable; knowledge is not.

### Mechanism
Subagents are designed as isolated contexts for focused delegation. The isolation is deliberate for permission and conversation scope, but it also discards the parent's hard-won file/search knowledge. For investigation subagents (`@explore`), this means the delegation cost includes a full re-exploration of the parent's already-inspected files.

### Verification design
When creating a subagent session, attach a compact "Parent Inspected Files" handoff (reusing the Evidence Handoff `InspectedFileEvidence` structure, capped at EVIDENCE_FILE_LIMIT) as the subagent's first context. The subagent can then skip re-reading files the parent already covered, or read only specific ranges it needs. Measure: fork re-read overlap before/after. Expected: overlap drops; subagent tool-call count decreases; subagent time-to-first-useful-finding shortens.

---



## Confirmed Finding 11: 51% of sessions contain semantic tool-call loops (repeated 3-call sequences) that the exact-match doom_loop detector is structurally blind to

### Evidence chain
- Semantic-loop scan over all 816 sessions: 415 (51%) have at least one 3-tool-call sequence that repeats later in the same session (coarse signature: tool name + filePath-basename / grep-pattern-prefix / command-prefix).
- Repeated-sequence examples (first occurrence → later repeat):
  - `ses_IN891Fwu7XL`: `[read session-v2.tsx, read session-v2.tsx, read session-v2.tsx]` at positions 32→33.
  - `ses_YjNb63juEMBn`: `[read usePhotoFilterStore.ts, read SidePanel.tsx, read usePhotoFilterStore.ts]` at 1→3 — the classic A-B-A exploration oscillation.
  - `ses_YxYIT2ctisye`: `[write, bash bun query, write]` at 28→30 — a write-test-write retry cycle.
  - `ses_6qVJVuunaAWN`: `[bash python-script, bash python-script, bash python-script]` at 26→43 — repeated diagnostic scripts.
- Contrast with Finding 5: the doom_loop detector (`processor.ts:456-481`, `DOOM_LOOP_THRESHOLD=3`) requires `JSON.stringify(part.state.input) === JSON.stringify(value.input)` — exact byte equality. Semantic loops use the same tool on the same file with different offsets/args, or alternate between files in a cycle; none trip the exact-match check.

### Why it is a design gap
1. **Prevalence.** A 51% semantic-loop rate means looping is the norm, not the exception. The doom_loop detector's 10 exact-identical triggers (Finding 5) cover <2.5% of the looping sessions.
2. **No sequence-level detection.** The harness detects single-call identity (doom_loop) and single-file read-overlap (read stub/overlap-note), but has no mechanism to detect *repeated sequences* of tool calls. A 3-call cycle `[read A, grep B, read A]` repeated 5 times is invisible to both the doom_loop detector and the read stub.
3. **A-B-A oscillation.** The `usePhotoFilterStore.ts → SidePanel.tsx → usePhotoFilterStore.ts` pattern (repeated at positions 1→3) is a common exploration anti-pattern where the agent bounces between two files without converging. No harness signal interrupts it.

### Mechanism
Loop detection is keyed on individual tool-call identity, not on call-sequence patterns. Real exploration loops are defined by *sequences* (read this, check that, come back), and detecting them requires tracking a sliding window of tool-call signatures — which the harness does not do.

### Verification design
Track a bounded sliding window (e.g. last 30 tool-call signatures) per session. When a 3-gram repeats within the window, emit a model-visible note: "Tool sequence [read A, grep B, read A] was just executed; you may be re-checking already-covered ground." Measure: semantic-loop count per session before/after. Expected: A-B-A oscillations drop; convergence-to-first-useful-answer time decreases.

---

## Confirmed Finding 12: the read-dedup gap is pervasive — 1248 (session,file) pairs are read 5+ times, with extreme cases reaching 191 reads of one file in one session

### Evidence chain
- DB-wide scan: 1248 (session_id, file_basename) pairs where the same file was read 5 or more times in one session (any offset/range).
- Top cases:
  - `chatgpt-core.js` x191 (`ses_185d5fc2e`, "chatgpt-browser-agent 配置指南")
  - `chatgpt.js` x149 (same session)
  - `content_main.js` x130 (`ses_154d8b795`, Finding 1)
  - `leak_scanner.py` x112 (`ses_1762e23a2`, "GitHub API 密钥泄漏自动告警服务 fork #2")
  - `VerifyCommand.java` x91 (`ses_1e1b63618`, "帆软反序列化payload fork #3")
  - `session.ts` x98, `index.tsx` x98, `README.md` x98
- In `ses_185d5fc2e` alone, five files were each read 98–191 times (chatgpt-core.js 191, chatgpt.js 149, chatgpt-dom.js 121, mcp-server.js 104, README.md 98) — 763 reads of just 5 files in one session.

### Why it is a design gap
1. **Scale.** Finding 1 deep-dived one session (130 reads). This measurement shows the pattern is not isolated: 1248 file-session pairs exhibit 5+ re-reads. The read dedup gap (Finding 1: stub only on exact/covering range, overlap-note non-suppressive) affects a large fraction of the dataset.
2. **Extreme cases.** 191 reads of `chatgpt-core.js` in one session means the agent re-entered the same file ~191 times. Even allowing for legitimate multi-range exploration of a large file, the stub mechanism (which fired only 3 times in the 130-read case) cannot be keeping up at this volume.
3. **Compounding.** This measurement is the aggregate effect of Findings 1 (partial-overlap gap), 4 (compaction resets visible reads + excludes search history), and 10 (subagent re-reads). Each mechanism contributes; together they produce 1248 hot file-session pairs.

### Mechanism
The read tool's dedup is scoped to *currently-visible* (non-compacted) reads with *exact-or-covering* range match (Finding 1). Across a long session with compaction, subagent forks, and shifting-offset reads, the effective dedup coverage is far lower than the stub mechanism's design intent. The 1248 hot pairs are the empirical footprint of that coverage gap.

### Verification design
Instrument `findReadStub` / `findOverlapNote` hit rates across the 1248 hot pairs (via replay). Correlate hit rate with read count per file. Expected: files with high read count have low stub-hit rate, confirming the dedup is not engaging. Candidate fix impact: after adding a persistent inspected-range registry (Finding 1 verification design) + subagent handoff (Finding 10 verification design), re-measure the 5+ read count; target a >50% reduction in hot pairs.

---



# Deep-Dive Findings (Pass 4)

## Confirmed Finding 13: grep caps results at 64 with no total count — 20.3% of grep calls return "Found 64+ matches" leaving the model unable to assess match density or decide whether to refine

### Evidence chain
- 2561 of 12598 grep calls (20.3%) hit the cap: output reads "Found 64+ matches (showing first 64)".
- 1377 grep calls (10.9%) returned bare "No files found" with no distinction between "no files matched include pattern" / "directory does not exist" / "files exist but no content matches".
- Source: `packages/opencode/src/tool/grep.ts:14` `const RESULT_LIMIT = 64`; `:118` `limit: RESULT_LIMIT + 1` (fetches 65 to detect truncation but not more); `:171-172` `Found ${RESULT_LIMIT}+ matches (showing first ${RESULT_LIMIT})`; `:191` truncation note "Consider using a more specific path or pattern."

### What the current source does
- The grep tool fetches `RESULT_LIMIT + 1 = 65` results (grep.ts:118). If 65 come back, it sets `resultLimitTruncated = true` and renders "64+ matches" (grep.ts:171-172).
- It does NOT issue a separate count query (e.g. `rg --count` / `rg --count-matches`) to determine the true total. The model sees "64+" whether there are 65 or 65,000 matches.
- The output is stateless across calls: no reference to prior grep queries or their result counts on the same session (confirmed in Finding 4 — grep has no dedup/registry).

### Why it is a design gap
1. **Match-density blindness.** "64+" is quantized to a binary "many". The model cannot distinguish a moderately common symbol (65 matches, worth listing) from a ubiquitous one (6500 matches, worth narrowing immediately). This affects search-refinement decisions: the model may re-grep with a slightly narrower pattern when it should switch strategy entirely, or vice-versa.
2. **20.3% cap-hit rate.** One in five greps hits the cap. For sessions that grep the same codebase repeatedly (e.g. `ses_138a727b0` with 200 merge-conflict greps), the model is repeatedly told "64+" without learning whether the conflict count is going down (progress) or staying the same (stuck).
3. **Bare "No files found".** The 1377 "No files found" outputs give no diagnostic: the model cannot tell if its `include` glob was wrong, the `path` was wrong, or the pattern genuinely has no matches. Compare `read`'s "Did you mean one of these?" (read.ts:384) — grep has no equivalent.
4. **No progress signal on re-search.** When the model re-runs a grep after edits (legitimate, Finding 4), a "previous result: 64+ matches, now: 32 matches" delta would tell it the edits are working. The stateless output provides no such signal.

### Mechanism
The grep tool optimizes for bounded output (64 lines + paths) but discards the aggregate count information that ripgrep can produce cheaply (`--count`). The 65-fetch truncation check is a presence test, not a count. Combined with stateless output, the model navigates search refinement blind to both absolute density and relative change.

### Verification design
On truncation, issue a lightweight `rg --count` (or `--count-matches`) for the total, and render "Found 64+ of ~N total matches (showing first 64)". On re-search of the same pattern+path, include "previous: M matches, now: N matches" when the prior result is still visible. Measure: re-grep count after a 64+ result before/after. Expected: fewer blind re-greps; faster search convergence.

---

## Confirmed Finding 14: LLM-generated compaction summaries preserve only ~28% of pre-compaction file paths on average; combined with Evidence Handoff's 20-file cap, sessions reading 40+ files lose >50% of file knowledge across each compaction

### Evidence chain
- Measured 3 compaction events (limited by scan window): file-path preservation in the LLM summary was 54% (22/41), 30% (7/23), and 0% (0/28). Average: 28%.
- The 0% case: 28 files read before compaction, none mentioned in the summary — complete file-knowledge loss in the summary text.
- Source: `packages/opencode/src/session/compaction.ts:81-123` `SUMMARY_TEMPLATE` instructs the model to include "Files & Code: [path: relevant symbols/sections and why they matter]" but the LLM frequently omits or under-populates this section.
- Evidence Handoff cap: `compaction.ts:71` `EVIDENCE_FILE_LIMIT = 20`; `:440` `rendered = rows.slice(0, EVIDENCE_FILE_LIMIT)` — only 20 files preserved in the Inspected Files table, sorted by `lastRead` (most recent first). Files read early and not re-read fall off the bottom.

### What the current source does
- Compaction produces two artifacts: (1) an LLM-generated anchored summary following the SUMMARY_TEMPLATE (compaction.ts:81-123), and (2) a deterministic Evidence Handoff with an "### Inspected Files" table capped at 20 files (compaction.ts:398-467, EVIDENCE_FILE_LIMIT=20).
- The summary's file coverage depends on the LLM's judgment of "relevant" — measured at ~28% of pre-compaction files.
- The Evidence Handoff covers the 20 most-recently-read files (sorted by `lastRead`, compaction.ts:439). Files read early in the session that were not re-read near compaction time are excluded.

### Why it is a design gap
1. **Two-layer coverage with a gap.** The summary covers ~28% (LLM judgment, volatile); Evidence Handoff covers 20 files (deterministic, recency-biased). For a session that read 41 files, the union might cover ~20 (Handoff) + a few unique from the summary ≈ 22-25, leaving 16+ files (39%) with no representation post-compaction.
2. **Recency bias loses early exploration.** Evidence Handoff sorts by `lastRead` (compaction.ts:439). A file read once at the start of a long session (often a key entry point like `session.ts` or `README.md`) is pushed out by later reads of less-important files. The model loses the foundational file that contextualized everything else.
3. **0% summary preservation case.** One compaction summary mentioned 0 of 28 pre-compaction files. The LLM treated "Files & Code" as "(none)" despite 28 reads. The Evidence Handoff was the only file-knowledge survivor — and only for the 20 most-recent.
4. **No file-importance signal.** Neither the summary template nor the Evidence Handoff has a notion of "this file was read N times" or "this file was the task's primary target." All reads are weighted equally by recency, so a file read 19 times (hot region) can be pushed out by a file read once.

### Mechanism
File-knowledge preservation across compaction is split between an LLM summary (lossy, ~28% coverage) and a deterministic table (capped at 20, recency-sorted). Neither layer accounts for read-frequency or task-relevance, so high-value files read early or frequently can be lost, forcing re-reads (contributing to Finding 12's 1248 hot pairs).

### Verification design
(1) Raise EVIDENCE_FILE_LIMIT or make it adaptive (e.g. 20 + 1 per compaction event). (2) Sort Evidence Handoff by a composite of recency + read-count, not recency alone, so hot files survive. (3) When the summary omits Files & Code, fall back to listing the top-N read files from the Handoff in the summary text. Measure: file-path preservation rate before/after; post-compaction re-read count of previously-read files. Expected: preservation rises above 80%; post-compaction re-reads drop.

---



## Confirmed Finding 16: apply_patch verification error shows the expected (missing) context lines but not the actual file content, forcing a re-read in 54% of failures

### Evidence chain
- 186 apply_patch "verification failed" errors; 165 are "Failed to find expected lines in <file>: <expected context lines>".
- The error format (confirmed from full error text): "apply_patch verification failed: Error: Failed to find expected lines in F:\...\processor.ts:\n    Layer.provide(SessionSummary.defaultLayer),\n    Layer.provide(Bus.layer),". It shows the file path + the expected lines that were NOT found, but NOT the actual lines currently at that location.
- After a "Failed to find" error, 100/186 (54%) were followed by a re-read of the same file — the model must re-read to see the actual content and correct the patch.
- Source: `packages/opencode/src/tool/apply_patch.ts:128-138` — `Patch.deriveNewContentsFromChunks` throws when context lines don't match; the error is wrapped as `apply_patch verification failed: ${error}` (apply_patch.ts:137). The `Patch` module's error includes the expected lines but not the actual content.

### What the current source does
- apply_patch parses the patch into hunks (apply_patch.ts:42), then for "update" hunks calls `Patch.deriveNewContentsFromChunks` (apply_patch.ts:129) which tries to locate the patch's context lines in the file. When they don't match, it throws "Failed to find expected lines in <file>: <expected lines>".
- The error exposes the EXPECTED context (what the patch thought was there) but not the ACTUAL content at that file location. The model learns *what it got wrong* but not *what is right*.

### Why it is a design gap
1. **Half-mirror diagnostic.** The error is a one-sided diff: it shows the model's expectation but not the file's reality. To correct the patch, the model must issue a separate `read` to see the actual lines — measured at 54% re-read rate.
2. **Better than edit but still incomplete.** Finding 3 showed edit's error ("Could not find oldString") gives zero content. apply_patch's error is better (shows expected lines) but still lacks the actual content. Both tools know the file content at the match location (they just read it to verify) but neither surfaces it in the error.
3. **Compounding with Finding 12.** The 100 re-reads after apply_patch failures add to the 1248 hot file-session pairs. Each verification-failure→re-read cycle is a token-cost round-trip that a content-showing error would eliminate.

### Mechanism
The verification function reads the file, fails to match context lines, and throws with only the expected lines. The actual content it just read is discarded rather than included in the error. The information exists at the point of failure but is not forwarded to the model.

### Verification design
On "Failed to find expected lines", include a bounded excerpt of the ACTUAL file content at the expected location (e.g. "Expected:\n<expected lines>\nActual (lines N-M):\n<actual lines>"). Measure: re-read rate after apply_patch failure before/after. Expected: re-read rate drops from 54% toward <20%; first-try patch-correction rate rises.

---

## Confirmed Finding 17: subagent (task) results are not size-bounded consistently — 21 results exceed 16KB, some are truncated mid-finding, and the parent must process multi-KB results that crowd its own context

### Evidence chain
- 590 task results; median 3245 chars, p90 12882, max 24757. 21 results exceed 16KB (MAX_BYTES truncation threshold); 256 exceed 4KB.
- Of sampled >16KB results: some end with `</task_result>` intact (not truncated, e.g. 21997 chars), others are truncated mid-content (e.g. 24757-char results ending with a truncation notice "Do NOT read the full file yourself - delegate to save context"). The truncation is inconsistent — some long results pass through, others are cut.
- Source: `packages/opencode/src/tool/task.ts:62-69` `output()` wraps the result text in `<task_result>` tags and returns it as the tool output string. The tool framework's truncation (truncate.ts, MAX_BYTES=16KB) applies to tool outputs, but the point at which it engages for task results is inconsistent with the observed data.

### What the current source does
- `task.ts:62-69` `output()` returns `["task_id: ...", "", "<task_result>", text, "</task_result>"].join("\n")`. The `text` is the subagent's final assistant message.
- The tool framework applies `Truncate.output()` (truncate.ts:81-130) with MAX_BYTES=16KB. When the task result exceeds this, the full text is saved to a file and a truncated preview + notice is returned.
- But the observed data shows some >16KB results are NOT truncated (they end with `</task_result>`), suggesting the truncation path is not always engaged for task outputs — possibly because the subagent's text is assembled after the truncation check, or because the `<task_result>` wrapper affects the byte count.

### Why it is a design gap
1. **Inconsistent truncation.** Some 20KB+ task results pass through untruncated; others are cut at 16KB. The parent model cannot predict whether it will see the full subagent result or a truncated one. A truncated subagent result loses the subagent's final conclusions — the most important part.
2. **Context crowding.** A 24KB task result consumes ~6K tokens of the parent's context. When the parent dispatches multiple subagents (common in this dataset: "opencode 自动审查机制" dispatched multiple forks), the accumulated results crowd out the parent's own working context, accelerating compaction (Findings 4, 14).
3. **Tail-biased truncation.** When truncation does engage, it uses the default "head" direction (truncate.ts:85 `direction ?? "head"`). The subagent's final summary — usually at the END of the result — is the part most likely to be cut. The parent loses the conclusion and keeps the intermediate narration.
4. **No structured result contract.** The subagent returns free-form text. There is no enforced "Summary: <one paragraph>\nDetails: <rest>" structure that would let truncation preserve the summary while cutting details.

### Mechanism
Task results flow through the generic tool-output truncation path, which was designed for bounded tool outputs (file reads, bash) not for potentially-large delegation results. The 16KB cap is too small for investigation subagents that produce detailed findings; the head-direction default cuts the conclusion; and the inconsistent engagement leaves the parent unable to rely on either full or truncated results.

### Verification design
(1) Give task results a larger budget than generic tool outputs (e.g. 32-64KB), since they represent an entire subagent session's work product. (2) Enforce a structured result contract: the subagent's final message must start with a "## Summary" section; truncation preserves the Summary and cuts from the Details. (3) Use tail direction for task results so the conclusion survives. Measure: parent context consumption by task results before/after; truncated-result rate; parent follow-up "what did the subagent find?" questions. Expected: truncation rate drops; parent context efficiency improves.

---



## Confirmed Finding 15: 26% of todo-using sessions abandon todos (pending/in_progress at end); the todo tool is stateless with no age tracking, no session-end surfacing, and no linkage to task completion

### Evidence chain
- 198 sessions use todos; 51 (26%) end with pending or in_progress todos. 147 (74%) complete all todos.
- 181 todos are in abandoned state (131 pending + 50 in_progress) across the dataset. The system prompt instructs "Keep todo state current" (system.ts:92-98) but the harness enforces nothing.
- avg 15.7 todowrite calls per session, max 127 — todos are updated frequently but not driven to completion in 26% of sessions.
- Source: `packages/opencode/src/tool/todo.ts:30-54` — the tool's execute simply calls `todo.update()` and returns the JSON list. No tracking of todo age, no "this todo has been pending for N turns" signal, no session-end check.
- Evidence Handoff preserves "Outstanding Todos" (compaction.ts:578, renderOutstandingTodos), so abandoned todos survive compaction — but surviving is not the same as being acted on.

### What the current source does
- `todo.ts:42-45` `todo.update()` replaces the entire todo list with the model's input. The tool is a pure setter — it has no memory of prior states and no notion of how long a todo has been pending.
- The tool output (todo.ts:48-49) is `${count} todos` + the JSON list. No delta, no "todo X has been pending for 15 turns", no "you have 3 pending todos from the start of this session".
- The system prompt (system.ts:92-98) gives advisory rules ("only one in_progress at a time", "do not jump from pending to completed") but the harness does not detect or correct violations.

### Why it is a design gap
1. **No age tracking.** A todo can sit "pending" for 100 turns without the harness ever signaling "this has been pending for a long time — is it still relevant?" The model forgets stale todos because they scroll out of the visible todo list.
2. **No session-end gate.** When a session ends (user sends new message or goes idle), the harness does not surface "You have N incomplete todos." The 26% abandonment rate is the direct consequence — the model simply stops updating todos when it considers the task done, leaving pending items behind.
3. **Todo-completion decoupled from verification.** Finding 8 showed 45% of edit sessions skip verification. Todos can be marked "completed" without verification having run (todo.ts has no verification linkage). The two gaps compound: a session can mark all todos complete (avoiding Finding 15's abandonment) while never verifying (Finding 8), producing unverified "complete" work.
4. **No stale-todo pruning.** The Evidence Handoff preserves all outstanding todos across compaction, but never asks "are these still relevant?" A todo created before a compaction may reference a task the model has since abandoned or completed by other means.

### Mechanism
The todo tool is a stateless setter with prompt-level guidance but no harness-level enforcement. It trusts the model to self-manage todo lifecycle, but the 26% abandonment rate shows that trust is not well-placed for long sessions where context scrolls and compacts.

### Verification design
(1) Track todo age (turns since creation/last-status-change); surface "todo X pending for N turns" in the todowrite output when N exceeds a threshold. (2) On session end, emit a user-visible notice "N incomplete todos remain." (3) Before allowing a todo to be marked "completed", require that at least one verification tool (typecheck/test/build/lint) ran after the last edit linked to that todo — or surface "todo marked complete without verification." Measure: abandonment rate before/after. Expected: abandonment drops below 10%; verified-completion rate rises.

---



# Deep-Dive Findings (Pass 5)

## Confirmed Finding 18: glob caps at 100 results sorted by mtime (newest first) with no total count — 10.3% of glob calls are truncated, losing the oldest files which are often the most stable core source

### Evidence chain
- 480 of 4665 glob calls (10.3%) hit the 100-result cap (output reads "Results are truncated: showing first 100 results").
- Source: `packages/opencode/src/tool/glob.ts:54` `const limit = 100`; `:69` `Stream.take(limit + 1)`; `:74-77` truncation flag; `:78` `files.sort((a, b) => b.mtime - a.mtime)` — **newest-first** sort; `:87` "Consider using a more specific path or pattern."
- 113 glob calls returned "No files found" (empty), and 2225 returned exactly 1 result.

### What the current source does
- glob fetches up to 101 files (glob.ts:69), keeps 100 if truncated (glob.ts:74-77), sorts by mtime descending (glob.ts:78), and returns the paths. No total count is computed.
- The sort is purely by modification time — the most recently modified files appear first. When truncated, the oldest files are silently dropped.

### Why it is a design gap
1. **Newest-bias loses stable core files.** In an active codebase, recently-modified files are often test outputs, generated files, or work-in-progress. The stable core source (e.g. `session.ts`, `index.ts`) that was last modified days ago sorts to the bottom and gets truncated away. The model sees the noise and misses the signal.
2. **No total count (same as Finding 13).** "100 results" is ambiguous: 101 or 10000. The model cannot assess whether to narrow the pattern or whether it has already seen all relevant files. The 10.3% cap-hit rate means this affects nearly 1 in 10 globs.
3. **No path-grouping or deduplication.** When globbing `**/*.ts`, 100 results might all come from `node_modules/` or `test/`, leaving no room for `src/` files. There is no per-directory quota or relevance ranking — just flat mtime sort.
4. **Stateless (same as grep, Finding 4/13).** No reference to prior glob patterns or their results. The model can re-glob the same pattern and get the same 100 truncated results without any "you already globbed this" signal.

### Mechanism
glob was designed as a bounded file-discovery tool with a recency heuristic. The heuristic (mtime) is a poor proxy for relevance in code exploration, and the 100-cap with no count leaves the model unable to judge coverage or refine intelligently.

### Verification design
(1) Provide a total count on truncation ("100 of ~N total files"). (2) Add per-top-level-directory quotas so `src/`, `test/`, `node_modules/` each get representation. (3) Optionally sort by a relevance signal (e.g. git-tracked + non-generated first) rather than pure mtime. Measure: glob re-call rate after truncation before/after; whether the model finds target files in fewer glob calls. Expected: fewer "I can't find the file" → re-glob cycles.

---

## Confirmed Finding 19: write tool places the full new file content in the tool-call input, which persists in conversation history alongside the generated diff output — large writes (>16KB, 40 cases) double the content footprint in context

### Evidence chain
- 989 write calls; median content 3329 chars, p90 11424, max 28900. 40 writes exceed 16KB.
- Source: `packages/opencode/src/tool/write.ts:22` `content: Schema.String` — the full new file content is the tool parameter; `:58-60` generates a diff from old→new; `:61-69` the permission ask includes the diff; the tool's output also contains the diff.
- After a write, the conversation history contains BOTH: (a) the tool-call input with the full new content (params.content), AND (b) the tool output with the diff. For a 16KB file, that is ~16KB (input) + ~16KB (diff output) ≈ 32KB of context for one write operation.

### What the current source does
- The write tool takes `content` (full new file text) as input (write.ts:22), writes it to disk (write.ts:71), generates a diff (write.ts:58-60), and returns the diff in the output/metadata (write.ts:76-80).
- Both the input (full content) and output (diff) are persisted as tool parts in the `part` table and replayed to the model on every subsequent turn until compaction.

### Why it is a design gap
1. **Double representation.** The new file content appears twice: once verbatim in the input, once as add-lines in the diff output. For a 16KB write, ~32KB of context is consumed. For the 40 writes >16KB, this is ≥1.28MB of redundant context across the dataset.
2. **Accelerates compaction.** Large writes push the context toward the overflow threshold (overflow.ts:22-33), triggering compaction sooner. Compaction then discards the write's content (Evidence Handoff only preserves file paths, not content), so the model loses both the content AND the diff — the worst of both.
3. **No content elision.** The write tool does not elide the input content from the persisted record after the write succeeds. The model does not need to re-see the full content it just wrote — it needs only the diff (what changed) and the file path. But the harness keeps both.
4. **Asymmetric with edit.** The edit tool's input is `oldString + newString` (bounded by the edit scope). The write tool's input is the ENTIRE file content. A full-file rewrite via `write` consumes far more context than the equivalent series of `edit` calls, yet the system prompt (system.ts:66) presents write as the tool for "creating files" without warning about the context cost for large rewrites.

### Mechanism
The write tool treats its input as a transient command, but the harness persists all tool inputs as conversation history. There is no post-execution compaction of the input content — the full text the model wrote stays in context verbatim, duplicated by the diff, until the next compaction discards both.

### Verification design
After a successful write, elide the `content` from the persisted tool-call input (replace with a stub like "<content written to disk; see diff in output>") while keeping the diff in the output. Measure: context consumption by write operations before/after; compaction frequency in write-heavy sessions. Expected: write context footprint halves; compaction frequency drops in write-heavy sessions.

---



## Confirmed Finding 20: no dedicated git tool — 5309 git commands (20% of all bash calls) run through bash, inheriting all bash limitations (tail-truncation, timeout, no structured parsing) with no compact structured git-state output

### Evidence chain
- 5309 git commands via bash: `git status` (most common, 66+ repeats in one session per Finding 12), `git diff` (257 truncated per Finding 7), `git -c`, `git remote`, `git ls-files`, `git rev-parse`, `git show`, `git checkout`.
- Git is the #1 bash use category: 5309/26639 = 20% of all bash calls.
- 786 additional bash calls (3%) use `cat`/`type`/`Get-Content`/`Select-String` for file reading, despite the system prompt explicitly prohibiting this (system.ts:64 "To read files use the read tool instead of cat, head, tail, or sed").
- Source: no git tool exists in `packages/opencode/src/tool/` (confirmed by file listing — tools are read, write, edit, apply_patch, grep, glob, bash, task, todo, etc.; no git). Git operations are routed to bash.

### What the current source does
- The harness provides dedicated tools for file read (read.ts), search (grep.ts), file find (glob.ts), edit (edit.ts), write (write.ts), but NOT for git operations.
- Git commands (`git status`, `git diff`, `git log`, `git show`) are executed via the bash tool, inheriting: pipe-stdio timeout behavior (Finding 2), tail-direction truncation at 1000 lines (Finding 7), "(no output)" on timeout (Finding 2), and no structured parsing.
- The system prompt's `getGitContext` (system.ts:234+) fetches git status for the system prompt, but this is a one-time snapshot cached per cwd (system.ts:183 `gitContextCache`), not a tool the model can call on demand.

### Why it is a design gap
1. **20% of bash is git.** One in five bash calls is a git command. These commands produce structured data (file lists, diffs, commit metadata) that the model must parse from raw text — text that is then tail-truncated (Finding 7). A `git_status` tool returning JSON `{staged: [...], modified: [...], untracked: [...]}` would be more compact and never need truncation for normal repos.
2. **`git diff` truncation is the worst case.** Finding 7 showed 257 `git diff` outputs tail-truncated. `git diff` is sequential (file-by-file), so tail-truncation loses the first files' changes. A `git_diff` tool could return per-file diffs with selective expansion, avoiding the 1000-line cap.
3. **Repetitive `git status`.** The model runs `git status` repeatedly to check if edits took effect (Finding 12 showed `git status` repeated 50+ times in one session). Each call is a full bash round-trip with raw-text parsing. A lightweight `git_status` tool with a compact structured output would reduce both token cost and parsing burden.
4. **`getGitContext` is session-scoped and cached.** The system prompt includes a one-time git snapshot (system.ts:234-249), but it is cached per cwd (system.ts:183) and not refreshed when the model makes edits. So the system-prompt git context goes stale, and the model must run `git status` via bash to get current state — the very thing a git tool would provide.

### Mechanism
Git is the most common state-query operation in this dataset, yet it is routed through the generic bash tool with no structural awareness. Every bash limitation (truncation, timeout, no parsing) applies to git operations, and the model pays the parsing + re-run cost on every call.

### Verification design
Add a `git_status` tool returning structured JSON (staged/modified/untracked/ahead/behind) and a `git_diff` tool returning per-file diffs with selective file expansion. Measure: bash git-command count before/after; `git diff` truncation rate; `git status` repeat count per session. Expected: bash git calls drop >60%; `git diff` truncation eliminated for normal repos; `git status` repeat count drops.

---



## Confirmed Finding 21: most agents have no step limit (agent.steps ?? Infinity) — 111 sessions exceed 100 agent-loop steps, 24 exceed 500, max 2970; the MAX_STEPS prompt never fires for unbounded agents

### Evidence chain
- Step-finish count per session (proxy for agent-loop iterations): 740 sessions have step-finish parts; max 2970 steps; 158 sessions >50 steps; 111 >100; 60 >200; 24 >500.
- Source: `packages/opencode/src/session/prompt.ts:2084` `const maxSteps = agent.steps ?? Infinity`; `:2085` `const isLastStep = step >= maxSteps`; `:2190` `const messages = [...modelMsgs, ...(isLastStep ? [{ role: "assistant", content: MAX_STEPS }] : [])]`.
- The MAX_STEPS prompt (imported from `prompt/max-steps.txt`, prompt.ts:21) is injected ONLY when `isLastStep` is true — which requires `step >= maxSteps`. When `agent.steps` is unset (Infinity), `isLastStep` is always false, so the prompt never fires.

### What the current source does
- Each agent can optionally define a `steps` field (agent configuration). If set, the agent loop stops after that many steps and the MAX_STEPS prompt tells the model to wrap up.
- If `steps` is not set, `maxSteps = Infinity` (prompt.ts:2084), and the loop continues until the model stops on its own, the user aborts, or a context overflow triggers compaction.
- There is no mandatory ceiling: even a clearly-looping agent (Finding 11's 51% semantic-loop rate) will keep stepping until external intervention.

### Why it is a design gap
1. **Unbounded loops.** 24 sessions ran >500 steps. At ~5-10 tool calls per step, that is 2500-5000 tool calls — consistent with the top sessions in the candidate index (Finding 12). The harness provides no automatic circuit breaker for agents that don't self-terminate.
2. **MAX_STEPS is opt-in.** The wrap-up prompt exists but only for agents that configure `steps`. The agents in this dataset (`build`, `general`, `auto`, `explore`) apparently do not set `steps` (the 2970-step session used the `auto` agent), so the prompt is inert.
3. **No interaction with doom_loop.** The doom_loop detector (Finding 5) fires on 3 exact-identical calls, but even when it doesn't fire, the agent can run 2970 steps of semantically-repetitive but syntactically-different calls (Finding 11). There is no step-count-based fallback.
4. **No cost-aware cutoff.** The harness tracks cost (`session.cost`) and tokens (`session.tokens_*`) but does not use them as a circuit breaker. A session that has spent $10 and 200M tokens on 2000 steps continues as if it just started.

### Mechanism
The step-limit mechanism is designed as an optional agent-configurable ceiling, not a safety invariant. The default (Infinity) assumes the model will self-terminate, but the 111 sessions >100 steps show that assumption frequently fails for complex tasks. The doom_loop detector (exact-match, Finding 5) and the step limit (opt-in) are two separate mechanisms that both fail to bound the common case: long, semantically-repetitive, syntactically-varying exploration.

### Verification design
(1) Set a default step ceiling (e.g. 200) for all agents, overridable per-agent. At 80% of the ceiling, inject a "you are approaching the step limit; prioritize convergence" note. At the ceiling, inject MAX_STEPS. (2) Add a cost-based soft cutoff: if session cost exceeds a threshold, inject a "high cost incurred; wrap up" note. Measure: sessions >100 steps before/after; whether task completion rate holds (the limit should cut waste, not completion). Expected: >100-step sessions drop >70%; wasted tokens in runaway sessions eliminated.

---

## Confirmed Finding 22: permission-reviewer subagent receives the full conversation transcript (up to 5.3M chars, 12 cases >100KB) for each review decision — enormous context cost for a single permission judgment

### Evidence chain
- 894 permission-review text parts found; 12 exceed 100KB; 1 exceeds 1MB (5,362,379 chars). The largest begins: "system: You are judging one planned coding-agent action. Assess the exact action's intrinsic risk and whether the transcript authorizes its target and side effects..."
- 54 permission-reviewer sessions; up to 97 `permission_review_decision` calls in one session (`ses_6XDPBZqCfYxt`). Each review processes the transcript context.
- The top 5 review-text sizes: 5,362,379 / 144,123 / 140,935 / 119,300 / 119,300 chars.

### What the current source does
- The permission-review system dispatches a `permission-reviewer` subagent (task.ts) to judge each tool action that requires review. The subagent receives the conversation context (via the task tool's prompt, task.ts:226-229) plus the action to judge.
- The 5.3M-char text is the review input — it contains the full transcript ("system: You are judging one planned coding-agent action...") which apparently includes the entire conversation history up to the action being reviewed.
- Each `permission_review_decision` call (507 total) potentially triggers a review subagent that processes this enormous context.

### Why it is a design gap
1. **Full-transcript review.** The reviewer receives the full conversation to judge one action. For a 2000-step session, the transcript is millions of characters. The reviewer must process all of it to judge whether one edit is safe — a task that fundamentally only needs the recent context and the specific action.
2. **12 cases >100KB.** Each >100KB review consumes ~25K+ tokens of the reviewer's context. The 5.3M-char case consumes ~1.3M tokens — far exceeding any model's context window, meaning it is either truncated (losing info) or causes an immediate overflow/compaction in the reviewer session.
3. **97 reviews in one session.** `ses_6XDPBZqCfYxt` ran 97 permission_review_decision calls. If each processes a growing transcript, the later reviews process even larger contexts than the earlier ones, creating a quadratic context cost.
4. **No context bounding for the reviewer.** The task tool (task.ts:226-229) resolves the prompt and creates a fresh session, but there is no evidence of context bounding specific to the reviewer — it gets whatever the permission system assembles, which includes the full transcript.

### Mechanism
The permission-review system treats the reviewer as a general subagent and gives it the full conversation context. This is correct for understanding intent, but the context grows unboundedly with the parent session's length. The reviewer's job (judge one action's risk) does not scale with transcript size, but its context cost does.

### Verification design
Bound the reviewer's context to a sliding window: the last N turns of parent context + the specific action + relevant file/diff context. For a 2000-step parent, the reviewer should see the last ~20 turns + the action, not the full 5.3M-char transcript. Measure: reviewer context size before/after; reviewer decision latency; whether decision quality holds (compare allow/deny rates). Expected: context size drops >90% for long sessions; decision latency drops; decision quality holds or improves (less distraction from irrelevant early context).

---



## Confirmed Finding 23: 31.9% of tool errors are not acknowledged in the next assistant text — the agent silently continues after failures, leaving the user uninformed about what went wrong

### Evidence chain
- 1634 tool errors across the dataset. Of those followed by an assistant text within 5 parts: 87 (5.3%) explicitly acknowledge the error (mention error/fail/wrong/retry/错/失败/重试), 521 (31.9%) do NOT mention the error at all.
- The remaining ~1026 errors were followed directly by another tool call (no text between), so the agent's intent is opaque — it may be addressing the error via a different tool or may be ignoring it.
- Source: the harness records tool errors in `state.error` (visible in the TUI tool panel), but there is no mechanism that forces the assistant to surface the error in its text output. The system prompt (system.ts) has no "acknowledge errors" instruction.

### What the current source does
- Tool errors are recorded as `state.status = "error"` with `state.error = "<message>"` (confirmed for all tools in Finding 3/16). The TUI displays the error in the tool panel.
- The assistant's next text is entirely model-generated. The harness does not inject "your last tool call failed with: <error>" into the context or force the model to acknowledge it.
- The `outputEfficiencySection` (system.ts:137-145) tells the model to "Focus text output on: Errors or blockers that change the plan" — but this is advisory, and 31.9% of errors are not surfaced.

### Why it is a design gap
1. **Silent failure propagation.** When the agent ignores an error in its text and continues with a different tool, the user sees the error flash in the tool panel but the agent's narrative does not explain what happened or why it changed approach. This is a transparency gap.
2. **No error-surfacing injection.** The harness could inject a system-reminder after an error: "Your last tool call (read) failed: File not found. Acknowledge this and explain your next step." It does not.
3. **Compounding with error-ignoring loops.** Finding 25 shows 50% of 3+ consecutive errors lead to same-tool retries. If the agent doesn't acknowledge the error in text, it is less likely to reason about WHY it failed and more likely to blindly retry.

### Mechanism
Error acknowledgment is left to the model's discretion via an advisory prompt. The harness has the error information (state.error) but does not force it into the model's reasoning path. The 31.9% non-acknowledgment rate is the measured compliance gap.

### Verification design
After a tool error, inject a lightweight system-reminder visible to the model: "Previous tool call failed: <tool> — <error>. State how you will address this before continuing." Measure: error acknowledgment rate before/after; same-tool-retry rate after errors. Expected: acknowledgment rises >80%; blind same-tool retries drop.

---

## Confirmed Finding 24: retry delay is capped at 2,147,483,647 ms (~24.8 days) when provider headers are present — a malicious or buggy `retry-after` header can hang the session indefinitely

### Evidence chain
- Source: `packages/opencode/src/session/retry.ts:28` `export const RETRY_MAX_DELAY = 2_147_483_647` (max 32-bit signed integer); `:30-32` `function cap(ms) { return Math.min(ms, RETRY_MAX_DELAY) }`; `:38-43` when `retry-after-ms` header is present, `cap(parsedMs)` is returned; `:46-58` when `retry-after` header is present (seconds or HTTP date), the parsed value is capped.
- Without headers: `RETRY_MAX_DELAY_NO_HEADERS = 30_000` (30 seconds, line 27) — reasonable.
- With headers: the cap is 2.1 billion ms ≈ 24.8 days. A provider returning `retry-after: 2147483647` (seconds) would cause the harness to wait ~68 years.

### What the current source does
- `delay()` (retry.ts:34-65) computes the retry delay. When response headers contain `retry-after-ms` or `retry-after`, the header value is used directly, capped only by `RETRY_MAX_DELAY` (2.1B ms).
- Without headers, the exponential backoff is capped at 30 seconds (`RETRY_MAX_DELAY_NO_HEADERS`, line 27) — a sane ceiling.
- The two-cap asymmetry means headers bypass the 30-second practical limit.

### Why it is a design gap
1. **24-day cap is not a practical limit.** No legitimate retry scenario requires waiting 24 days. A 5-10 minute cap would cover any reasonable rate-limit reset. The 2.1B-ms cap exists only because it is the max `setTimeout` value, not because it is a sensible retry ceiling.
2. **Header trust.** The harness trusts provider headers without an upper sanity check. A misconfigured CDN, a reverse proxy bug, or an API change could inject an unreasonable `retry-after` value, hanging the session until the user manually aborts.
3. **No user visibility.** During the retry wait, the session appears stuck. The user has no indication of how long the retry will wait or that the wait is unreasonable. There is no "retry-after is N hours; abort?" prompt.

### Mechanism
The retry system correctly implements exponential backoff with a 30-second cap for the no-header case, but delegates entirely to provider headers for the with-header case, with only a theoretical 32-bit-integer cap. The practical ceiling is missing.

### Verification design
Cap `RETRY_MAX_DELAY` at a practical maximum (e.g. 300,000 ms = 5 minutes). If a header exceeds the cap, use the cap and log a warning. Surface long retry delays (>60s) to the user with an abort option. Measure: no behavior change for legitimate retries (most are <30s); sessions with unreasonable headers no longer hang.

---

## Confirmed Finding 25: after 3+ consecutive tool errors, 50% of cases retry the same tool rather than changing strategy — the harness has no consecutive-error circuit breaker

### Evidence chain
- Consecutive error runs: 3 errors (20 occurrences), 4 (10), 5 (7), 6 (5), 8 (2). Max 8 consecutive errors. 3 sessions had 3+ consecutive errors.
- After 3+ consecutive errors: 43 same-tool retries vs 43 strategy changes (different tool or text) — exactly 50/50.
- Source: no mechanism in `processor.ts` or `prompt.ts` detects consecutive tool errors or forces a strategy change. The doom_loop detector (Finding 5) checks for identical *successful* calls, not error patterns.

### What the current source does
- The doom_loop detector (processor.ts:456-481) fires on 3 identical calls regardless of status, but its exact-match requirement means different error messages on the same tool don't trigger it.
- There is no "consecutive error" counter. The harness does not track "this tool has failed N times in a row" or inject "you have failed 3 times with read; try a different approach."

### Why it is a design gap
1. **50% blind retry rate.** When a tool fails 3+ times in a row, half the time the model retries the same tool. For `read` (file not found), retrying the same path is almost always futile. For `edit` (oldString not found), retrying with the same oldString is futile. The model needs a signal to change approach.
2. **No error-pattern detection.** The doom_loop detector catches identical-call loops (Finding 5), and the read stub catches identical-range re-reads (Finding 1). But neither detects the pattern "same tool, different inputs, 3+ consecutive failures" — which is the signature of a model that doesn't understand why its tool calls are failing.
3. **Compounding with Finding 23.** 31.9% of errors are not acknowledged in text (Finding 23). Combined with the 50% same-tool retry rate, the model often fails silently → retries the same tool → fails again → retries again, without ever reasoning about the root cause.

### Mechanism
Consecutive errors are a distinct failure signal from identical-call loops. The harness has loop detection (doom_loop) and read-dedup (stub) but no error-streak detection. The 50% same-tool retry rate shows the model frequently does not self-correct after repeated failures.

### Verification design
Track consecutive error count per tool. After 3 consecutive errors on the same tool, inject: "Tool <tool> has failed 3 times in a row. The errors were: <error1>, <error2>, <error3>. Consider a different approach or explain why retrying is warranted." Measure: same-tool retry rate after 3+ errors before/after. Expected: same-tool retry rate drops from 50% to <20%; root-cause reasoning in text increases.

---



# Deep-Dive Findings (Pass 6)

## Confirmed Finding 26: write and edit tools auto-format files after writing, silently changing on-disk content — 32% of writes (319/993) have formatting changes that are not surfaced in the tool output, so the model's subsequent edits may target stale pre-format content

### Evidence chain
- 319 of 993 write calls (32%) have a `metadata.diff` (the post-format diff differs from the pre-format content), confirming formatting changed the file content.
- Only 2 of 993 writes were followed by a re-read of the same file — the model almost never re-reads to see the formatted result.
- Source: `packages/opencode/src/tool/write.ts:72` `if (yield* format.file(filepath)) { yield* Bom.syncFile(fs, filepath, desiredBom) }` — auto-formats after write; `write.ts:76-86` generates `metadataDiff` from `contentOld → finalSource.text` (post-format), but `write.ts:94` sets `output = "Wrote file successfully."` — the formatting diff is NOT added to the model-visible output.
- `packages/opencode/src/tool/edit.ts:109` and `:153` also call `format.file(filePath)` after editing — same silent-format behavior.

### What the current source does
- After writing/editing, the tool calls `format.file(filepath)` (write.ts:72, edit.ts:109/153). If formatting succeeds, the file on disk now differs from what the model wrote.
- The tool generates a `metadataDiff` (write.ts:79-86) capturing the formatting changes, but this diff is stored in `metadata.diff` — NOT in the model-visible `output` string.
- The model sees "Wrote file successfully." and its own input `content`. It does not see what the formatter changed. Its mental model of the file is the pre-format version.

### Why it is a design gap
1. **Silent content divergence.** In 32% of writes, the on-disk content differs from what the model wrote, but the model is not told. The model's next `edit` call will use `oldString` based on its pre-format mental model, which may not match the formatted content → "Could not find oldString" (Finding 3).
2. **metadata.diff is not model-visible.** The formatting diff exists in `state.metadata.diff` but the tool output is just "Wrote file successfully." The information is captured but not forwarded to the model.
3. **edit.ts has the same gap.** Both edit (line 109, 153) and write (line 72) auto-format. The model's `oldString`/`newString` for subsequent edits may be based on pre-format content, while the file has been reformatted.
4. **Low re-read rate.** Only 2/993 writes trigger a re-read. The model trusts its written content matches the disk, which is wrong 32% of the time.

### Mechanism
Auto-formatting is a user-experience feature (consistent code style), but its interaction with the model's content model is not handled. The format diff is computed (for the TUI's git-diff display) but not injected into the model's tool output. The model operates on a stale content model after any format-changing write/edit.

### Verification design
When formatting changes the file, append to the tool output: "Note: auto-formatter modified the written content. Changed lines: <compact diff or summary>. Re-read if you need the exact current content." Alternatively, if the formatting changes are minor (whitespace/indentation), note "File was auto-formatted (whitespace changes only)." Measure: edit-failure rate after format-changing writes before/after; re-read rate. Expected: edit failures after writes drop; model awareness of formatting changes rises.

---

## Confirmed Finding 27: skills are reloaded multiple times per session (up to 15×), each adding ~7KB to context — 70 (session,skill) pairs have repeated loads with no content caching or dedup

### Evidence chain
- 382 skill tool calls; median output 7175 chars, max 22036. 283 skill loads exceed 4KB.
- 70 (session,skill) pairs have >1 load: `effect` x15 in one session, `diagnose` x12, `tdd` x11, `effect` x12, `effect` x11. The same skill's full instruction text is injected into context repeatedly.
- Source: `packages/opencode/src/tool/skill.ts` — the skill tool loads the skill content from the SKILL.md file and returns it as the tool output. There is no check for "this skill was already loaded in this session."

### What the current source does
- The skill tool reads the skill's SKILL.md file and returns its content as the tool output. Each call returns the full skill text (~7KB median).
- The skill content persists in the conversation history as a tool output. On subsequent calls to the same skill, the full content is returned again — a second ~7KB copy is added to context.
- There is no "skill already loaded" stub or cache. The model can load the same skill 15 times, producing 15 copies of ~7KB = ~105KB of identical content in context.

### Why it is a design gap
1. **No load dedup.** Unlike the read tool's stub mechanism (Finding 1: `findReadStub` returns a stub for already-visible ranges), the skill tool has no "already loaded" check. The model gets the full ~7KB content every time, even if the same skill is already in context.
2. **Context cost compounds.** 15 loads of `effect` = ~105KB of identical skill text in context. This accelerates compaction (Findings 4, 14) and wastes tokens. Across 70 repeated-load pairs, the wasted context is substantial.
3. **Model-driven reloading.** The model reloads skills because (a) after compaction, the prior skill content is gone (Evidence Handoff does not preserve skill content), and (b) the model doesn't remember it already loaded the skill. Both causes stem from the same root: no persistent skill-loaded state.
4. **Asymmetric with read dedup.** The harness invests in read-range dedup (Finding 1) but not in skill-content dedup, even though skill content is larger (~7KB) than a typical read chunk (~2KB) and identical across loads.

### Mechanism
Skill loading is treated as a stateless file read: each call returns the full content. The harness does not track which skills are already in context, so the model can re-load the same skill indefinitely. Compaction makes this worse by discarding prior skill content, forcing reloads.

### Verification design
Track loaded skills per session. On repeat load, return a stub: "Skill 'effect' was already loaded (see prior tool output at part X). Use those instructions." After compaction, include loaded-skill names in the Evidence Handoff so the model knows which skills it had. Measure: repeated skill-load count before/after; context consumption by skill outputs. Expected: repeated loads drop to near 0; skill context consumption drops >80% in skill-heavy sessions.

---



## Confirmed Finding 28: 1313 user corrections across 181 sessions (22%) are not persisted as durable constraints — the harness treats corrections as ordinary messages, so they can be lost to compaction and must be re-issued across sessions

### Evidence chain
- 1313 user correction texts (strict signals: "不是", "我说的是", "你又", "不对", "重新", "遗漏", "不要", "为什么", "错了", "重复", "你应该", "请改为", etc.) across 181 sessions.
- Top correction-heavy sessions: 帆软反序列化 fork#3 (x95), fork#1 (x45), chatgpt-browser-agent (x44), "查找 opencode 50KB 限制" fork#3 (x38).
- Correction samples: "我说的是添加中文注释" (I said add Chinese comments — misunderstood task); "我移动了位置，其在Claude-Code文件夹里面，而不是thirdparty" (I moved the location — wrong path assumption); "不是...而是..." (No... rather... — wrong approach).
- 134 sessions have both corrections and compaction — corrections made before compaction are at risk of loss if the summary doesn't capture them.
- Source: the harness stores user messages as ordinary `message`/`part` rows. There is no "correction" type, no constraint-extraction step, and no mechanism that elevates a correction to a durable constraint that survives compaction or crosses session boundaries.

### What the current source does
- User corrections are stored as text parts in the `part` table, identical to any other user message.
- The compaction SUMMARY_TEMPLATE (compaction.ts:81-123) has a "## User Constraints & Preferences" section, but it is LLM-generated — the model decides what to include. There is no deterministic extraction of correction signals.
- The Evidence Handoff (compaction.ts:562-586) preserves inspected files, verified commands, and todos — but NOT user constraints or corrections.
- Instruction files (AGENTS.md, CLAUDE.md, instruction.ts) are project-level and static; they do not capture per-session corrections.

### Why it is a design gap
1. **No correction detection.** The harness does not recognize when a user is correcting the agent (signals like "不是", "我说的是", "不对"). Every correction is just another message. The harness cannot distinguish "the user is asking a new question" from "the user is correcting a misunderstanding."
2. **Compaction loss risk.** In 134 sessions, corrections preceded compaction. Whether a correction survives depends on the LLM summary's judgment of "User Constraints & Preferences" — the same section that preserved only ~28% of file paths (Finding 14). Corrections are likely lost at a similar rate.
3. **No cross-session persistence.** A correction made in session A (e.g., "don't use apply_patch, use edit") is not carried into session B. The user must re-correct. The instruction-file mechanism (AGENTS.md) could capture durable corrections, but the harness does not auto-promote repeated corrections to the instruction file.
4. **Repeated corrections.** The top session has x95 corrections — many are likely the same constraint re-stated after compaction or across subagent forks. If corrections were persisted, the repeat count would drop.

### Mechanism
Corrections are treated as ephemeral conversation messages rather than durable constraints. The harness has the infrastructure to persist constraints (instruction files, Evidence Handoff, compaction summary) but none of these mechanisms automatically capture or elevate user corrections. The LLM summary is the only correction-survival path, and it is lossy (Finding 14).

### Verification design
(1) Detect correction signals in user messages ("不是", "我说的是", "不对", "不要", "should be", "I said", etc.) and tag them. (2) Include a "### User Corrections" section in the Evidence Handoff (deterministic, not LLM-generated) listing correction texts that are still relevant. (3) After 3+ identical corrections across sessions, auto-suggest adding the constraint to AGENTS.md. Measure: correction repeat rate per session before/after; post-compaction correction re-issuance rate. Expected: corrections drop >40% in long sessions; cross-session repeat corrections drop.

---



## Confirmed Finding 29: 73% of tool-call messages issue a single tool call — the system prompt's "BATCH independent tool calls in the SAME response" instruction achieves only 27% compliance, leaving parallelism underutilized

### Evidence chain
- 55014 assistant messages contain tool calls. 40163 (73%) issue exactly 1 tool call; 14851 (27%) issue 2+ (batched).
- Distribution: 1 call (40163), 2 (4442), 3 (3788), 4 (2775), 5 (1497), 6 (1424), 7 (308), 8 (433).
- Source: `packages/opencode/src/session/system.ts:80` "BATCH independent tool calls in the SAME response so they can run in parallel. Do not issue only one discovery call when several independent discovery calls are already obvious."; `:83` "BAD: glob('*') -> wait -> glob('*/*') -> wait -> glob('one-dir/*')."

### What the current source does
- The system prompt (toolUsageSection, system.ts:79-90) explicitly instructs the model to batch independent discovery calls. It even gives a BAD/GOOD example.
- The harness executes parallel tool calls within a single assistant message concurrently (processor.ts processes tool-call events as they arrive; the `concurrency: "unbounded"` at processor.ts:794 confirms parallel execution is supported).
- There is no harness-level mechanism that detects "this message issued 1 tool call when 2+ independent calls were obvious" and prompts the model to batch.

### Why it is a design gap
1. **27% compliance.** The model batches only 27% of the time. For the 73% single-call messages, many are genuinely dependent (the model needs result A before calling B). But for discovery phases (the "wide first wave" the prompt describes), single-call sequencing is the anti-pattern the prompt warns against — and it dominates.
2. **No batching feedback.** The harness knows how many tool calls a message contains but never tells the model "you issued 1 call; consider whether 2+ independent calls could have been batched." The prompt is advisory; there is no runtime nudge.
3. **Latency cost.** Each sequential round-trip adds the model's inference latency (~2-10s) plus the tool execution time. For a 5-step discovery that could be 1 batched message, sequential execution adds 4× inference latency. Across 40163 single-call messages, the cumulative latency cost is substantial.
4. **Compounding with re-reads.** Finding 12 showed 1248 hot file-session pairs (5+ reads). Many of these reads could have been batched (reading multiple files in one message), but 73% single-call means most reads are sequential — compounding the re-read cost with sequential latency.

### Mechanism
Batching is a prompt-level instruction with no runtime enforcement. The model's default behavior is sequential (one call, observe, decide next call), and the prompt's batching advice is insufficient to overcome this default for 73% of messages.

### Verification design
(1) After a single-tool-call discovery message (read/grep/glob/bash in the first 5 turns), inject a lightweight nudge: "Consider batching independent discovery calls in one message for parallelism." (2) Measure: single-call rate for discovery-phase messages before/after; end-to-end session latency. Expected: single-call rate drops <50% for discovery phases; session latency drops.

---

## Confirmed Finding 30: 12% of subagent (task) dispatches return trivially short results (70/593), including empty `<task_result></task_result>` — the delegation overhead is wasted when the subagent produces no output

### Evidence chain
- 593 task results: 70 (12%) are <500 chars, 259 medium (500-4000), 264 long (>4KB).
- Empty-result samples: `task_id: ses_244af50d...\n<task_result>\n</task_result>` — the subagent returned literally nothing. Multiple empty results observed.
- One short result: "I don't have a `plan_exit` tool available to call." — the subagent was dispatched with a task it couldn't perform (missing tool).
- Source: `packages/opencode/src/tool/task.ts:62-69` `output()` wraps `text` in `<task_result>` tags. When `text` is empty, the output is `<task_result>\n</task_result>`.

### What the current source does
- The task tool creates a subagent session, runs it, and returns the subagent's final assistant text as the result (task.ts:226-229). If the subagent produces no final text (e.g., it errored, was aborted, or returned only tool calls with no summary), the result is empty.
- The parent receives `<task_result>\n</task_result>` and must decide what to do. There is no "subagent returned empty result" error or retry mechanism.

### Why it is a design gap
1. **Wasted delegation.** Creating a subagent session has fixed overhead: session creation (task.ts:186-194), permission derivation (task.ts:174-183), prompt resolution (task.ts:226), and the subagent's own LLM calls. When the result is empty, all of this is wasted.
2. **Silent failure.** An empty `<task_result>` is not an error — the task tool returns `status: "completed"`. The parent model sees an empty result and may interpret it as "the subagent found nothing" rather than "the subagent failed to produce output." There is no distinction between "explored and found nothing" and "crashed without output."
3. **Missing-tool dispatch.** The "I don't have a `plan_exit` tool" sample shows the subagent was dispatched with a task requiring a tool it didn't have. The harness should validate tool availability before dispatch, or the subagent should return a clear error.
4. **No result-quality gate.** The task tool returns whatever the subagent produces, including empty strings. There is no minimum-quality check (e.g., "result must be >50 chars or contain a summary").

### Mechanism
The task tool treats the subagent's final text as the result without validation. Empty results pass through as valid, leaving the parent with no information and no signal that the delegation failed. The 12% short-result rate suggests either the subagent frequently fails to summarize, or the dispatch was unnecessary.

### Verification design
(1) When the subagent's final text is empty, return an error to the parent: "Subagent produced no output (may have been aborted or lacked required tools)." (2) Before dispatch, validate that the subagent's tool set includes tools the prompt implies (e.g., if the prompt says "edit the plan file," ensure `edit`/`write` is available). (3) Track empty-result rate as a delegation-quality metric. Measure: empty-result rate before/after; parent follow-up "what did the subagent find?" calls. Expected: empty results drop to 0; wasted dispatches eliminated.

---



# Deep-Dive Findings (Pass 7)

## Confirmed Finding 31: after webfetch returns 404, the model switches to websearch only 8% of the time (2/26) — the harness provides no "URL not found, try searching" nudge

### Evidence chain
- 174 webfetch calls; 40 errors (23% error rate). Of errors: 26 are 404 Not Found, 5 are 403 Forbidden, 5 are 401 Unauthorized.
- After a webfetch 404, only 2 of 26 (8%) were followed by a websearch/tavily call. In 92% of 404 cases, the model does not search — it either gives up, tries a different guessed URL, or proceeds without the information.
- webfetch and websearch are used at similar rates overall (174 vs 176), so the model knows websearch exists — it just doesn't switch to it after a 404.
- Source: `packages/opencode/src/tool/webfetch.ts` returns the HTTP error as-is; there is no "404 → suggest websearch" logic. The system prompt (system.ts) has no "if webfetch fails, try websearch" instruction.

### What the current source does
- webfetch fetches a URL and returns the content or the HTTP error. On 404, the error is "StatusCode: non 2xx status code (404 GET <url>)".
- The error does not suggest any alternative action. The model sees "404" and must decide on its own whether to search, try a different URL, or give up.

### Why it is a design gap
1. **No recovery suggestion.** The 404 error tells the model WHAT failed but not WHAT TO DO next. A "URL not found; use websearch to find the correct URL" suggestion would guide recovery.
2. **92% give-up rate.** In 24 of 26 cases, the model does not search after a 404. It either abandons the information need or proceeds without it — degrading task quality.
3. **Model guesses URLs.** The 26 404s are URLs the model guessed (e.g., `https://raw.githubusercontent.com/sst/opencode/main/package...` with wrong paths). The harness knows the URL was wrong but doesn't help the model find the right one.
4. **Asymmetric with read's did-you-mean.** The read tool suggests candidate paths on file-not-found (read.ts:384). webfetch has no equivalent — no "did you mean a similar URL?" or "try searching for this topic."

### Mechanism
webfetch is a thin HTTP client that surfaces raw HTTP errors. The recovery path (search for the correct URL) is left entirely to the model, which rarely takes it (8%). The harness has a websearch tool available but does not connect the 404 failure to the search recovery.

### Verification design
On webfetch 404, append to the error: "URL not found. Consider using the websearch/tavily_tavily_search tool to find the correct URL, or verify the path." Measure: post-404 websearch rate before/after. Expected: search rate rises from 8% to >40%; information-retrieval success rate improves.

---

## Confirmed Finding 32: edit failure rate is U-shaped — very short oldString (<100 chars) fails 11.8% (highest) and very long (>3000) fails 9.5%, but the error message is identical for both, hiding the different root causes

### Evidence chain
- Edit oldString size vs failure rate:
  - <100 chars: 149/1268 = 11.8% failure
  - 100-500: 44/2922 = 1.5%
  - 500-1000: 29/1016 = 2.9%
  - 1000-3000: 13/836 = 1.6%
  - >3000: 8/84 = 9.5%
- 918 of 6126 edits (15%) use oldString >1000 chars.
- Source: `packages/opencode/src/tool/edit.ts:709-711` throws the same "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings." regardless of oldString length.
- `edit.ts:713` throws "Found multiple matches for oldString. Provide more surrounding context to make the match unique." for the multiple-match case (only 5 occurrences).

### What the current source does
- The 9 fuzzy replacers (edit.ts:684-694) try to match oldString with increasing tolerance. When all fail, the generic error is thrown (edit.ts:709-711).
- The error does not report oldString length, the closest match, or whether the failure is likely due to (a) stale content (auto-format changed it, Finding 26), (b) whitespace/indentation drift, or (c) a large block with a small mismatch.

### Why it is a design gap
1. **U-shaped failure, flat error.** The 11.8% failure for <100 chars likely stems from stale content (the model copied a short snippet from memory, but auto-format changed it — Finding 26) or whitespace sensitivity. The 9.5% for >3000 likely stems from a small mismatch somewhere in the long block. Both get the same "Could not find oldString" message.
2. **Short-oldString vulnerability.** Short oldStrings are more sensitive to single-character differences (one space, one tab) because the fuzzy replacers' tolerance is ratio-based — a 1-line mismatch in a 2-line oldString is 50% drift, but in a 20-line oldString it's 5%. The 11.8% failure rate for <100 chars reflects this.
3. **No length-aware guidance.** The error could say "your oldString is short (N chars); it may have been modified by auto-formatting. Re-read the file to get the current content" for short oldStrings, and "your oldString is long (N chars); a small mismatch may exist. Try a shorter, more targeted oldString with more surrounding context" for long ones. Instead, both get the same generic message.
4. **Compounding with Finding 26.** 32% of writes have auto-format changes (Finding 26). A short oldString copied from the model's pre-format memory will not match the post-format file. The 11.8% short-oldString failure rate is partly a consequence of the silent auto-format gap.

### Mechanism
The edit tool's error is length-agnostic. Short and long oldStrings fail for different reasons (stale content vs. block mismatch), but the error message and the 9 fuzzy replacers treat them identically. The U-shaped curve shows that the sweet spot (100-3000 chars, 1.5-2.9% failure) is narrow, and the error gives no guidance on how to move toward it.

### Verification design
Make the error length-aware: for <100 chars, add "Your oldString is short — re-read the file to verify current content (auto-formatting may have changed it)." For >3000 chars, add "Your oldString is long — try a shorter, targeted snippet with surrounding context." Track oldString length in the error metadata. Measure: failure rate for <100 and >3000 oldStrings before/after. Expected: short-oldString failures drop (model re-reads); long-oldString failures drop (model shortens).

---



## Confirmed Finding 33: read-outline is generated per-read-range (not per-file) and only for structured source — 0% coverage for the most-re-read file (content_main.js, 130 reads), 5-16% for source files, leaving the model without a navigation map for the files it re-reads most

### Evidence chain
- Outline coverage for hot files: content_main.js 0/130 (0%), chatgpt-core.js 85/527 (16%), chatgpt.js 45/334 (13%), session.ts 55/724 (8%), processor.ts 39/467 (8%), prompt.ts 50/1043 (5%), index.tsx 69/1391 (5%).
- When outlines ARE generated: 900 reads have 21-32 items, 439 have 11-20, 216 have ≤10, 13 empty.
- Source: `packages/opencode/src/tool/read-outline.ts:5` `MIN_LINES = 600`; `:9` `MAX_SCAN_LINES = 3000`; `:11-51` source extensions only; `read.ts:696` `outline: yield* Effect.promise(() => readOutline(filepath, file.count, file.offset))` — the outline is generated PER READ CALL, starting from the read offset, scanning up to 3000 lines.

### What the current source does
- For each `read` call, `readOutline(filepath, file.count, file.offset)` (read.ts:696) scans up to 3000 lines starting from the read offset, looking for function/class/module definitions matching the outline regexes. The result is rendered as `<outline>` in the read output (read.ts:283-286).
- The outline is NOT cached per file — it is regenerated for each read call, and it only covers the lines near the read offset, not the whole file.
- For minified/generated files (no recognizable definitions), the outline is empty. content_main.js (a minified Edge extension bundle) has 0% outline coverage across 130 reads.

### Why it is a design gap
1. **Per-read-range, not per-file.** The outline covers only the 3000 lines near the read offset. For a 127k-line file, the model gets a fragment outline per read, never a whole-file map. It cannot build a navigation overview from fragments. A cached, whole-file outline (generated once, reused across reads) would let the model navigate to the right offset without trial-and-error re-reading.
2. **0% for the files that need it most.** content_main.js (130 reads, Finding 1) and other minified/large files get no outline because the regex doesn't match minified patterns. These are exactly the files where re-reading is most costly and a navigation map would help most.
3. **5-16% for source files.** Even for structured source (.ts, .tsx), coverage is low because most reads (88% have offsets, Finding data) are at high offsets where the 3000-line scan window may contain few definitions. The outline is most useful at offset 0 (file header, imports, top-level definitions) but the model often reads at high offsets.
4. **No outline persistence.** The outline is regenerated on every read call. If the model reads the same file at offset 0 twice, it gets the same outline twice. There is no "outline already generated for this file" cache (unlike the read-stub mechanism for content, Finding 1).

### Mechanism
The outline feature was designed as a per-read-call enhancement (show definitions near the read range), not as a per-file navigation aid. For large files — especially minified ones — this means the model has no map to navigate efficiently, driving the trial-and-error re-reading documented in Findings 1 and 12.

### Verification design
(1) Generate a whole-file outline once per file (cached by path+mtime), covering all definitions up to MAX_SCAN_LINES from offset 0, not from the read offset. (2) For minified files where the regex finds nothing, fall back to a structural outline (e.g. line-length histogram, section markers, or "line N: <first 60 chars>" every 500 lines). (3) Include the cached outline in every read of that file as a navigation header. Measure: re-read count for files >600 lines before/after; whether the model's first read offset is closer to the target. Expected: re-reads drop >30% for large files; first-read accuracy improves.

---



## Confirmed Finding 34: read output dominates context consumption at 42.7% (189.2M chars) — the single largest context consumer, making read-truncation and read-dedup (Findings 1, 12, 33) the highest-leverage optimization targets; tool inputs consume 8.7% (38.7M chars) with apply_patch input alone at 11.6M

### Evidence chain
- Total context across all parts: 443,579,111 chars. Breakdown:
  - read output: 189,236,101 (42.7%)
  - text: 56,500,455 (12.7%)
  - bash output: 52,168,508 (11.8%)
  - reasoning: 39,112,001 (8.8%)
  - grep output: 35,990,923 (8.1%)
  - apply_patch input: 11,617,554 (2.6%)
  - bash input: 11,407,223 (2.6%)
  - edit input: 8,757,633 (2.0%)
  - write input: 4,926,754 (1.1%)
  - All tool inputs combined: ~38.7M (8.7%)
- Read output (42.7%) + grep output (8.1%) + bash output (11.8%) = 62.6% of all context is tool OUTPUTS. Tool INPUTS add another 8.7%. Total tool-related context: 71.3%.

### Why it is a design gap
1. **Read output is the dominant consumer.** 42.7% of all context is read output. With 60.3% of reads truncated (Finding 12 data) and 1248 hot file-session pairs (5+ re-reads, Finding 12), a large fraction of this 189.2M chars is redundant re-read content. Reducing re-reads (Findings 1, 10, 12, 33) would directly cut the largest context cost.
2. **Tool inputs are 8.7% of context.** apply_patch input (11.6M) and write input (4.9M) persist verbatim (Finding 19, message-v2.ts:993). Eliding post-execution inputs (Finding 19 verification design) would save ~16.5M chars.
3. **Reasoning is 8.8%.** 39.1M chars of reasoning. In decide mode, reasoning is truncated to 400 chars (prompt.ts:140-143). In normal mode, full reasoning persists. For long sessions, reasoning accumulates and is never elided until compaction.
4. **No context-budget visibility.** The model cannot see its own context breakdown. It does not know "42% of my context is read output" or "I'm spending 8.7% on tool inputs I don't need anymore." A context-budget summary would let the model make informed decisions about what to re-read vs. what it already has.

### Mechanism
The context is assembled from all persisted parts (message-v2.ts:854+). Every tool input and output stays until compaction. The breakdown shows that read output is the overwhelming consumer, and the dedup/truncation gaps in Findings 1, 12, and 33 directly inflate this 42.7%. Tool-input persistence (Finding 19) adds another 8.7%.

### Verification design
(1) Implement the read-dedup improvements (Findings 1, 33) and measure the read-output share before/after. (2) Elide post-execution tool inputs (Finding 19) and measure the input share. (3) Optionally provide a context-budget summary to the model at compaction time ("Your context was: 40% read output, 12% bash, 9% reasoning..."). Target: read-output share drops from 42.7% to <30%; total context per session drops >20%.

---

## Confirmed Finding 35: 45% of write calls are full-file overwrites (445/998) where the model sends the entire new file content as input — for large files this is far more context-expensive than targeted edits, but the harness presents write and edit with no context-cost guidance

### Evidence chain
- 998 write calls: 553 new files, 445 overwrites (45%).
- Write content: median 3329 chars, p90 11424, max 28900. 40 writes exceed 16KB.
- Edit vs write vs apply_patch: edit 6126, write 998, apply_patch 5493. Write is used for 7.7% of file-modification operations.
- Source: `packages/opencode/src/tool/write.ts:22` `content: Schema.String` — full file content as input; `system.ts:66` "To create files use the write tool instead of echo redirection or heredoc" — the prompt frames write as the file-creation tool, not mentioning its context cost for overwrites.

### What the current source does
- The write tool takes the full new file content as input (write.ts:22) and writes it to disk (write.ts:71). For overwrites, the model must send the ENTIRE new file content, even if only a few lines changed.
- The edit tool (edit.ts) takes `oldString + newString` — only the changed portion. For a 3-line change in a 500-line file, edit sends ~200 chars; write sends ~15000 chars.
- The system prompt (system.ts:66) says "To create files use the write tool" and "To edit files use the edit tool" (system.ts:65), but does not warn that write-overwrite is context-expensive for large files.

### Why it is a design gap
1. **45% overwrites via full-content write.** 445 writes overwrite existing files. For each, the model sends the full new content (median 3329 chars, up to 28900). If the change was small (e.g., adding a function), the same change via `edit` would send only the changed lines (~100-500 chars). The 445 overwrites consume ~1.5M chars of context that could have been ~200K via edit — a 7.5× waste.
2. **No context-cost signal.** The system prompt frames write as "for creating files" but 45% of writes are overwrites. The model is not warned that write-overwrite is context-expensive. A note like "write sends the full file content; for partial changes use edit (sends only the changed region)" would guide the model toward the more efficient tool.
3. **Compounding with Finding 19.** Write-overwrite doubles the content footprint (input + diff output, Finding 19). For a 16KB overwrite, ~32KB of context is consumed. Using edit for the same change would consume ~2KB (oldString + newString + diff). The 40 writes >16KB are the worst cases.
4. **No overwrite detection.** The harness knows whether a write is a new file or overwrite (write.ts:51 `exists`), but it does not surface this to the model. A "you are overwriting an existing file with full content; consider edit for partial changes" nudge would help.

### Mechanism
The write tool is presented as the file-creation tool, but 45% of its usage is full-file overwrites. For overwrites, the tool's full-content input is far more context-expensive than edit's targeted replacement. The harness does not differentiate new-file writes from overwrites in its guidance, so the model uses write for both without awareness of the context cost.

### Verification design
(1) When write targets an existing file (overwrite) and the content exceeds a threshold (e.g. 4KB), append a note: "You are overwriting an existing file with full content (N chars). If only part of the file changed, use edit (sends only the changed region) to save context." (2) Track overwrite-via-write vs edit usage over time. Measure: overwrite-via-write count before/after; context consumption by write operations. Expected: overwrites via write drop >30%; write context share drops.

---



## Confirmed Finding 36: 5 sessions exceed 10 compactions (max 24) — each compaction discards raw tool outputs and relies on the lossy LLM summary (~28% file-path preservation, Finding 14), so 10+ compactions cause severe cumulative information loss that drives re-exploration

### Evidence chain
- 100 sessions have compaction. Distribution: 26 sessions >3 compactions, 14 >5, 5 >10. Max 24 compactions in one session.
- Each compaction (compaction.ts:562-586) replaces raw tool outputs with an LLM-generated summary (Finding 14: ~28% file-path preservation) + Evidence Handoff (20 files, Finding 4). Information not in the summary or Handoff is permanently lost for that session.
- In a 24-compaction session, the original tool outputs are lost and re-summarized 24 times. Each re-summary can drop additional details (the summary of a summary loses more). The cumulative preservation rate after N compactions is approximately 0.28^N for file paths — after 5 compactions, <0.2% of original file paths survive in the summary alone (the Evidence Handoff provides a floor of 20 files).

### What the current source does
- Compaction fires when `isOverflow` (overflow.ts:22-33) returns true. It summarizes the conversation, keeps a 4-turn tail (compaction.ts:57 DEFAULT_TAIL_TURNS=4), and emits an Evidence Handoff.
- There is no "compaction budget" — a session can compact indefinitely. Each compaction is independent; it does not track how many times the session has already been compacted or how much cumulative information has been lost.
- The anchored summary (compaction.ts:173-184 `buildPrompt`) uses the previous summary as input (`<previous-summary>`), so each compaction builds on the last summary. This is an Nth-generation summary after N compactions.

### Why it is a design gap
1. **Cumulative loss.** After 5+ compactions, the summary is a 5th-generation derivative of the original conversation. Each generation loses more detail. The model operates on increasingly degraded information, driving re-reads (Finding 12) and re-searches (Finding 4).
2. **No compaction counter.** The harness does not track or surface "this session has been compacted N times." The model has no signal that its context is a 5th-generation summary. It treats the summary as authoritative, but its fidelity is ~0.28^N.
3. **No alternative to compaction.** When context overflows, compaction is the only mechanism. There is no "selective elision" (e.g., eliding old tool outputs while keeping recent ones, or eliding reasoning while keeping tool results). The all-or-nothing summary approach maximizes per-compaction loss.
4. **Evidence Handoff doesn't scale.** The Handoff caps at 20 files (EVIDENCE_FILE_LIMIT) and 8 ranges per file (EVIDENCE_FILE_RANGE_LIMIT). After 10+ compactions, the 20-file Handoff is the ONLY survivor across all 10+ compaction events. If the session touched 100+ files, 80%+ are permanently lost.

### Mechanism
Compaction is a repeated lossy compression. Each round discards raw data and produces a summary. After N rounds, the summary is an Nth-generation derivative with exponentially degrading fidelity. The harness has no mechanism to detect, warn about, or mitigate cumulative compaction loss.

### Verification design
(1) Track compaction count per session; surface it to the model at compaction time: "This is compaction #N. Summary fidelity may be degraded; verify critical facts by re-reading." (2) For sessions with >5 compactions, expand the Evidence Handoff budget (more files, more ranges) to compensate for cumulative summary loss. (3) Implement selective elision (elide old reasoning + old tool outputs, keep recent + summary) as an alternative to full compaction. Measure: re-read rate in >5-compaction sessions before/after. Expected: re-reads drop; model references Handoff more.

---

## Confirmed Finding 37: reasoning parts consume 8.8% of all context (39.1M chars) and persist in full until compaction — the model rarely needs to re-read its own old reasoning, but the harness never elides it (truncateThinking applies only to decide mode)

### Evidence chain
- Reasoning: 37,642 parts, 39,112,001 chars (8.8% of total 443.6M context chars). 1,701 reasoning parts exceed 4KB.
- Source: `packages/opencode/src/session/message-v2.ts:1046-1050` — reasoning parts are included in full (`type: "reasoning", text: part.text`) for same-model messages. `prompt.ts:140-143` `truncateThinking` truncates to 400 chars (first 200 + last 200) — but it is called ONLY in `sanitizeDecideMessages` (prompt.ts:170), which is decide-mode-only. In normal mode, full reasoning persists.

### What the current source does
- In normal mode, every reasoning part is included verbatim in the model's context (message-v2.ts:1046-1050). A 2000-char reasoning block from turn 5 is still in context at turn 50, unless compaction removes it.
- In decide mode, `truncateThinking` (prompt.ts:140-143) truncates reasoning to 400 chars. But decide mode is a special analysis mode, not the default.
- There is no "reasoning elision" mechanism in normal mode — no "keep only the last N turns of reasoning" or "elide reasoning older than M turns."

### Why it is a design gap
1. **8.8% of context is old reasoning.** The model's own internal reasoning from 20 turns ago is still in context, consuming tokens. The model almost never references its own old reasoning — it references tool outputs, file contents, and user messages. Old reasoning is dead weight.
2. **No elision before compaction.** The harness elides nothing until compaction fires. If reasoning were elided after N turns (keeping only the last 3-5 turns), 8.8% of context could be reduced to ~1-2%, delaying compaction and preserving more useful information (tool outputs, file contents).
3. **Asymmetric with compaction.** Compaction discards EVERYTHING (reasoning + tool outputs + text) and replaces with a summary. A more granular approach would elide reasoning first (lowest value), then old tool outputs, then old text — only summarizing as a last resort. The all-or-nothing approach wastes the opportunity to elide low-value content first.
4. **Reasoning is provider-specific.** Different providers produce different reasoning (chain-of-thought, thinking blocks). Some providers' reasoning is verbose (deepseek-reasoner, o1). For these, the 8.8% share could be much higher per-session. The harness treats all reasoning equally — no per-provider reasoning budget.

### Mechanism
Reasoning is treated as first-class context content, persisted and replayed in full. The harness has the `truncateThinking` mechanism (prompt.ts:140-143) but gates it behind decide mode. In normal mode, reasoning accumulates unbounded until compaction discards it alongside everything else.

### Verification design
Elide reasoning older than N turns (e.g. 5) in normal mode, replacing with a 1-line stub "Reasoning from turn X (elided; N chars)". Keep the last N turns of reasoning verbatim. Measure: context consumption by reasoning before/after; compaction frequency; whether task quality holds. Expected: reasoning share drops from 8.8% to <3%; compaction frequency drops; task quality holds (model doesn't need old reasoning).

---



## Confirmed Finding 38: LSP diagnostics feedback loop exists in source (edit.ts:197, write.ts:96, apply_patch.ts:288) but never fired in 12,607 edit operations — the model gets no inline type-error feedback, forcing separate `bun typecheck` calls that inherit bash limitations (Findings 2, 7)

### Evidence chain
- 12,607 edit/write/apply_patch calls; 0 tool outputs contain "LSP errors detected" or "LSP" text.
- 232 text/reasoning parts mention LSP — but these are the model reading/investigating LSP source code, not receiving LSP diagnostics.
- Source: `packages/opencode/src/tool/edit.ts:196-200` calls `lsp.diagnostics()` and appends "LSP errors detected in this file, please fix:\n<block>"; `write.ts:96-110` and `apply_patch.ts:288-309` do the same. `packages/opencode/src/lsp/lsp.ts` is a full LSP client (not a stub) with client/server/launch modules.
- The LSP server requires a language server (e.g. typescript-language-server) to be installed and configured. If not running, `lsp.diagnostics()` returns empty.

### What the current source does
- After each edit/write/apply_patch, the tool calls `lsp.touchFile(filepath, "document")` then `lsp.diagnostics()` (edit.ts:196-197). If the LSP server is running and finds errors, they are appended to the tool output as "LSP errors detected in this file, please fix:\n<block>".
- If the LSP server is NOT running (not installed, not configured, or failed to start), `lsp.diagnostics()` returns an empty object, and the tool output is just "Wrote file successfully." or "Edited." with no diagnostic section.

### Why it is a design gap
1. **No inline type feedback.** The model edits a file and gets no type-error feedback. It must separately run `bun typecheck` (bash) to find errors — paying a bash round-trip (with tail-truncation, Finding 7, and timeout risk, Finding 2) for information the LSP could provide inline.
2. **Silent LSP absence.** When the LSP server is not running, the tool does not note "LSP diagnostics unavailable (no language server running)." The model sees a clean "Wrote file successfully." and assumes no type errors — a false sense of correctness. It does not know whether "no LSP errors" means "no errors" or "LSP not checking."
3. **Verification cost.** Without inline LSP feedback, the model's verification loop (Finding 8) requires `bun typecheck` via bash. 1410 `bun typecheck` calls were measured (Finding 20 data). Each is a separate bash call with ~5-30s latency, tail-truncation, and no per-file error attribution. Inline LSP diagnostics would provide per-file, per-line errors immediately after the edit.
4. **232 LSP mentions show awareness.** The model frequently investigates LSP code (232 text/reasoning mentions), suggesting it knows LSP exists but never benefits from its diagnostics. The feature is present but inert.

### Mechanism
The LSP diagnostics mechanism is correctly implemented in the editing tools but depends on an external language server being running. When the server is absent, the mechanism silently degrades to "no diagnostics" — indistinguishable from "no errors." The model cannot tell whether its edits are type-safe without a separate verification step.

### Verification design
(1) When `lsp.diagnostics()` returns empty, append to the tool output: "LSP diagnostics unavailable (no language server running). Run `bun typecheck` to verify type safety." (2) Auto-start the TypeScript language server when a `.ts`/`.tsx` file is first edited. (3) Track LSP-server-running status and surface it in the context-usage display. Measure: inline-diagnostic rate before/after; `bun typecheck` call count; time-to-error-detection after edit. Expected: inline diagnostics rise from 0 to >80% of TS edits; `bun typecheck` calls drop; error-detection latency drops from ~30s to <1s.

---



# Deep-Dive Findings (Pass 8 — local-context-verified)

## Confirmed Finding 39: TUI editor-context injections ("user opened file" / "user selected") have 0% action rate — 835 injections across 197 sessions are completely ignored by the agent, consuming context (683 in compaction sessions) with zero actionable value

### Evidence chain
- 789 "user opened the file" injections + 46 "user selected" injections = 835 total across 197 sessions.
- Action rate (followed by read of the referenced file within 10 parts): 0/789 for "opened file" (0%), 0/46 for "selected" (0%).
- 683 of 789 "opened file" injections are in sessions with compaction — they consume context that survives until compaction, then consume compaction budget when the LLM summarizes them.
- Top sessions: 53 injections in one session ("Opencode dev与session/index.tsx差异对比"), 32 in another.
- Source: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:128-139` — `formatEditorContext()` generates the injections.

### Local-context replay (ses_138a727b0, part [393])
- Part [393]: `<system-reminder>Note: The user opened the file "f:\...\infra\lake.ts". This may or may not be relevant to the current task.</system-reminder>`
- Part [394]: The user's ACTUAL message about README conflicts and rename-as-delete handling.
- Part [399]: The agent's reasoning addresses the user's actual message (README conflicts), NOT the "opened lake.ts" injection. The injection is ignored.
- The "opened lake.ts" injection is interleaved with the user's real instruction, cluttering the context without contributing to the task.

### What the current source does
- `formatEditorContext` (prompt/index.tsx:128-139) is called on editor focus/selection changes. It generates:
  - For file-open (no selection): `<system-reminder>Note: The user opened the file "X". This may or may not be relevant to the current task.</system-reminder>` (line 131)
  - For text selection: `<system-reminder>Note: The user selected #N from "X". \`\`\`text\`\`\` This may or may not be relevant.</system-reminder>` (line 135-138)
- Both variants include the disclaimer "This may or may not be relevant to the current task" — explicitly giving the agent permission to ignore.
- The "opened file" variant (line 131) contains NO content — just a file path and a vague disclaimer. There is no action request, no context about why the file was opened, and no indication of relevance.

### Why it is a design gap
1. **0% action rate.** Across 835 injections, the agent never once read the opened/selected file as a result of the injection. The injection is pure context noise.
2. **Passive disclaimer.** "This may or may not be relevant" is an explicit permission to ignore. The agent takes that permission every time. If the injection is worth sending, it should state WHY it's relevant or request an action.
3. **Context cost.** 835 text parts, 683 in compaction sessions. Each injection is ~100-200 chars. During compaction, the LLM must process these injections as part of the conversation, spending tokens summarizing irrelevant editor-focus events.
4. **Interleaving with real user messages.** In the replayed neighborhood (part [393]-[394]), the "opened lake.ts" injection is immediately followed by the user's actual instruction. The injection is noise interleaved with signal, making the user's real message harder to parse.
5. **"Untitled" files.** Some injections reference "Untitled-4" (an untitled editor tab) — completely useless context.

### Mechanism
The TUI monitors editor focus changes and injects them as system-reminders. The intent is to give the agent awareness of what the user is looking at. But the injection is too passive (disclaimer + no action) and too noisy (every file open triggers it), so the agent learns to ignore all of them — including the rare cases where the opened file IS relevant.

### Verification design
(1) Stop injecting "opened file" events (no selection) — they have 0% value. (2) For "selected text" events, keep the injection but remove the "may or may not be relevant" disclaimer; instead state the selected text directly as user context. (3) If file-open tracking is desired, batch it (e.g. "Files you've viewed recently: X, Y, Z" once per turn, not per-open). Measure: context consumption by editor injections before/after; whether agent attention to user-viewed files changes. Expected: context noise drops; no change in task quality (injections were already ignored).

---



## Confirmed Finding 40: 1291 edits (11.1%) are on files the agent never read or wrote in the current session — the edit tool performs no "prior read" check, so the agent edits blind, risking stale-content mismatches (Findings 3, 26)

### Evidence chain
- 11619 total edit/apply_patch calls. Of those, 1409 (12.1%) target files not previously read in the session. Breaking down: 118 are on files the agent wrote earlier (legitimate — it knows the content); **1291 are on existing files the agent never read OR wrote** — truly blind edits.
- Samples of truly blind edits: `大学城_校园卡账单.ipynb` (a Jupyter notebook), `profile-snapshot.test.ts` (a test file, edited 3 times without prior read).
- Source: `packages/opencode/src/tool/edit.ts` — the edit tool checks `oldString` against file content via 9 fuzzy replacers (edit.ts:684-694), but it does NOT check whether the file was previously read in the session. There is no "have you read this file?" gate.

### What the current source does
- The edit tool reads the file from disk (edit.ts:121-122 `const source = yield* Bom.readFile(afs, filePath)`) and attempts to match `oldString` against the actual content. If `oldString` doesn't match, it throws "Could not find oldString" (Finding 3).
- The tool does NOT track whether the file was previously read by the `read` tool. It blindly accepts whatever `oldString` the model provides and tries to match it.
- The `read` tool's `collectVisibleReads` (read.ts:197) tracks read history for the stub mechanism, but this information is NOT shared with the edit tool.

### Why it is a design gap
1. **No prior-read gate.** The edit tool could check `collectVisibleReads` (or a shared read registry) and, if the file was never read, return "You haven't read this file in this session. Read it first to avoid stale oldString mismatches." Instead, it accepts the blind edit and fails with "Could not find oldString" when the guess is wrong.
2. **11.1% blind-edit rate.** 1291 edits are on unread files. Many of these will fail (Finding 3: 78 "Could not find oldString" errors, 4.0% edit failure rate). The blind edits are a root cause of these failures.
3. **Compounding with Finding 26 (auto-format).** Even if the agent guesses the oldString correctly, auto-formatting may have changed the file since the agent last saw it (if it ever saw it). A blind edit on a formatted file has no chance of matching.
4. **Stale content from prior sessions.** The agent may remember a file's content from a PRIOR session (or from training data), but the file may have changed since. Without a prior read in the CURRENT session, the agent's oldString is based on stale memory.

### Mechanism
The edit tool treats the model as an authoritative source of `oldString`, but the model's content model may be stale, assumed, or hallucinated. The harness has the information to detect this (the read registry from `collectVisibleReads`) but does not use it to gate edits.

### Verification design
Before executing an edit, check if the file was read (or written) in the current session. If not, return: "File X has not been read in this session. Read it first to verify current content, then retry the edit." Measure: blind-edit count, "Could not find oldString" error rate before/after. Expected: blind edits drop to <2%; oldString failures drop proportionally.

---

## Confirmed Finding 41: 13% of typecheck runs with error output are followed by assistant text that does not acknowledge the errors — the harness does not flag "successful tool with error content," so typecheck/lint errors are treated as ordinary output and sometimes ignored

### Evidence chain
- 277 typecheck runs produced error output (containing "error TS" lines). After the typecheck:
  - 43 (15.5%): edit/apply_patch (fixing the errors)
  - 45 (16.2%): read a file (investigating)
  - 45 (16.2%): text acknowledging errors/fix
  - 68 (24.5%): another bash command (further investigation)
  - 17 (6.1%): grep (searching for error source)
  - **32 (11.5%): text WITHOUT acknowledging the errors** — the agent saw typecheck errors and then produced text that didn't mention them at all
  - 4 (1.4%): question, 4 todowrite, 1 glob
- Source: `packages/opencode/src/tool/shell.ts` — the bash tool returns typecheck output as a string. The tool's `status` is "completed" (the typecheck command ran successfully), even if the output contains errors. There is no "output contains errors" flag.

### What the current source does
- The bash tool executes `bun typecheck` and returns the output. If the command exits with a non-zero code (typecheck found errors), the tool's status is still "completed" (the command ran), not "error" (the command didn't crash). The error content is in the output string, not in the status.
- The harness does not parse tool output for error patterns (e.g., "error TS", "Error:", "FAIL"). A typecheck output with 50 errors and a typecheck output with 0 errors both have `status: "completed"`.
- The system prompt's `verificationSection` (system.ts:126-129) says "verify the change when feasible" but does not say "if verification reveals errors, you MUST address them before proceeding."

### Why it is a design gap
1. **No error-content detection.** The harness treats typecheck output as opaque text. It cannot distinguish "typecheck passed" from "typecheck found 50 errors." The model must parse the output itself, and 11.5% of the time it ignores the errors entirely.
2. **Status ambiguity.** A typecheck that finds errors has `status: "completed"` — the same status as a successful typecheck. The model sees "completed" and may assume success without reading the output. The 32 non-acknowledgment cases are the consequence.
3. **No "errors found" gate.** After a verification command (typecheck, test, lint) produces error output, the harness could inject a system-reminder: "Verification found N errors. Address them before reporting the task complete." It does not.
4. **Compounding with Finding 8.** Finding 8 showed 45% of edit sessions skip verification. Finding 41 shows that even when verification IS run, 11.5% of error outputs are ignored. The two gaps compound: many sessions don't verify, and many that do verify don't act on the results.

### Mechanism
Verification output is treated as ordinary tool output with no semantic parsing. The harness knows the command was `bun typecheck` (it parses commands for permission checks, shell.ts:41-111) but does not use this knowledge to detect "this is a verification command whose output contains errors." The model is left to parse and react on its own, and sometimes doesn't.

### Verification design
(1) For known verification commands (typecheck, tsc, test, lint, eslint, py_compile — the same list as `isSimpleVerificationCommand` in compaction.ts:500), parse the output for error patterns and set a flag `hasErrors: true` in the tool metadata. (2) When `hasErrors` is true, append to the output: "Verification found errors (see above). Address them before reporting complete." (3) Surface `hasErrors` in the TUI with a visual indicator. Measure: non-acknowledgment rate after typecheck errors before/after. Expected: non-acknowledgment drops from 11.5% to <2%; fix-after-typecheck rate rises.

---



## Confirmed Finding 42: 97 immediate typecheck re-runs (consecutive, no edit between) and 75 sessions with identical consecutive typecheck output — the agent re-runs verification without fixing errors, and the doom_loop detector cannot catch cross-message re-runs

### Evidence chain
- 97 immediate typecheck re-runs: consecutive `bun typecheck` calls with no edit/apply_patch between them.
- 75 sessions have 3+ typecheck runs where consecutive outputs are byte-identical (same errors, no fix applied).
- 18 typecheck-loop events (3+ consecutive typechecks without an edit): top session has 8 such loops.
- Max consecutive typecheck without edit: 4.
- Source: `processor.ts:456-481` doom_loop detector requires 3 identical calls within the SAME assistant message (`MessageV2.parts(ctx.assistantMessage.id)`). Typecheck re-runs typically span different messages (different turns), so the detector never sees 3 in one message.

### What the current source does
- The doom_loop detector (Finding 5) checks `parts.slice(-3)` of the CURRENT message. If the agent runs `bun typecheck` in turn 1, then again in turn 2, then again in turn 3, each is in a different message — the detector sees only 1 typecheck per message and never fires.
- The harness does not track "this command was just run and produced this output" across messages. Each typecheck run is independent; the harness cannot detect "you ran typecheck 2 turns ago and got the same errors."

### Why it is a design gap
1. **Cross-message loop blindness.** The doom_loop detector is scoped to a single message. The most common loop pattern — re-running a command across turns — is invisible to it. 97 immediate re-runs and 75 identical-output sessions confirm this is a frequent pattern.
2. **No output-diff detection.** The harness could compare the current typecheck output to the previous typecheck output and, if identical, note "Output is identical to the previous run (N turns ago). The errors have not changed — fix them instead of re-running." It does not.
3. **No verification-result caching.** If no edits were made since the last typecheck, the result is deterministic — re-running is guaranteed to produce the same output. The harness could cache the result and return "No changes since last typecheck; result unchanged (N errors)." Instead, the agent pays the full typecheck execution cost (5-30s) for a deterministic no-op.
4. **Compounding with Finding 41.** Finding 41 showed 13% of typecheck-error runs are not acknowledged. Finding 42 shows the agent also RE-RUNS the typecheck without fixing the errors. The two patterns compound: the agent ignores errors AND re-runs the check, wasting time and tokens on a loop it can't escape.

### Mechanism
The doom_loop detector's same-message scope and the lack of cross-turn output comparison make sequential re-run loops invisible. The agent runs typecheck → sees errors → doesn't fix them → runs typecheck again → sees the same errors. The harness has no mechanism to break this cycle.

### Verification design
(1) Track the last typecheck/test/lint command and its output per session. When the same verification command is run again with no edits since the last run, return the cached result with a note: "No files changed since last typecheck (N turns ago). Result unchanged: M errors. Fix the errors or explain why re-running is needed." (2) Extend the doom_loop detector to track identical commands across the last M turns (not just within one message). Measure: immediate typecheck re-run count before/after; identical-output session count. Expected: re-runs drop >70%; the agent either fixes errors or moves on.

---



## Confirmed Finding 43: apply_patch is all-or-nothing for multi-file patches — one file's context mismatch fails the ENTIRE patch (670 multi-file patches, 44 failures, 80% not retried individually), losing the hunks that would have succeeded

### Evidence chain
- 670 of 5493 apply_patch calls (12.2%) are multi-file patches (2+ `*** Update/Add/Delete File:` markers).
- 44 multi-file patch failures. Error format: "apply_patch verification failed: Error: Failed to find expected lines in <specific file>: <expected lines>" — the error names the failing file, but the whole patch fails.
- After a multi-file failure, only 9 of 44 (20%) were retried with individual patches. 35 (80%) were not retried individually — the agent either gave up, used a different approach, or retried the whole multi-file patch.
- Source: `packages/opencode/src/tool/apply_patch.ts:73-170` — the hunk loop processes each file's hunk sequentially. On the FIRST hunk failure, it `return yield* Effect.fail(...)` (line 117, 137) immediately. The `fileChanges` array (built during the loop) is NOT written to disk because the write phase (after the loop) is never reached.

### What the current source does
- apply_patch validates ALL hunks before writing ANY. The loop (apply_patch.ts:73-170) builds a `fileChanges` array. If any hunk fails validation (context lines don't match), the function returns immediately with an error. The write phase (which would iterate `fileChanges` and apply them) is never executed.
- This is a deliberate "validate-then-apply" design: don't write anything unless ALL hunks validate. The intent is atomicity — either all changes apply or none do.

### Why it is a design gap
1. **Atomicity penalizes the common case.** In a 5-file patch where 4 files match and 1 doesn't, the 4 successful changes are discarded. The agent must re-do all 5 changes, either as individual patches or as a corrected multi-file patch. The 80% non-retry rate shows the agent often doesn't bother — it loses the 4 successful changes.
2. **No partial-success reporting.** The error says "Failed to find expected lines in file X" but does not say "files A, B, C, D validated successfully; only file X failed." The agent doesn't know which hunks would have succeeded. It must re-construct the entire patch.
3. **All-or-nothing vs. per-file atomicity.** The current design is patch-level atomic (all-or-nothing). A file-level atomic design (apply successful files, report failed files) would preserve the 4 successful changes while still being atomic per-file. The agent could then fix only the failing file.
4. **Compounding with Finding 16.** Finding 16 showed apply_patch's error shows the expected lines but not the actual content. In a multi-file failure, the agent sees the failing file's expected lines but must re-read ALL files to reconstruct the patch — not just the failing one.

### Mechanism
The validate-then-apply design prioritizes atomicity (no partial changes) over efficiency (don't waste successful validations). For multi-file patches where one file is stale (Finding 26 auto-format, Finding 40 blind edit), the entire patch fails, losing the work done on the other files.

### Verification design
Change apply_patch to file-level atomicity: validate and apply each file's hunk independently. If file X fails, still apply files A-D, then report "Applied 4/5 files. Failed on file X: <error>." Measure: multi-file failure recovery rate (does the agent fix only the failing file?); total edit operations for multi-file changes. Expected: failed-patch recovery improves; total edit operations decrease (4/5 changes preserved on failure).

---



## Confirmed Finding 44: WSL command output has encoding issues (22/440, 5%) — garbled characters from UTF-8/UTF-16 mismatch between WSL's Linux output and the Windows host confuse the model

### Evidence chain
- 440 bash commands use `wsl` (WSL wrapper). 22 (5%) produce output with encoding artifacts: null bytes (`\x00`), replacement chars (`\ufffd`), mojibake (`Â`, `Ã`, `â€`), or garbled CJK text.
- Sample garbled output: `wsl: C:\Users\Lenovo\.wslconfionfig:16 -仯뾽盯뾽寯뾽봍哯뾽积뾽效攍` — WSL's own warning about `.wslconfig` line 16, with garbled Chinese text that should read as a proper warning message.
- Source: `packages/opencode/src/tool/shell.ts:117-118` `shellOutputEncoding` returns `"auto"` by default; `:27` `createAutoTextDecoder` handles encoding detection; `:999` `normalizePowerShellOutput` normalizes PowerShell output but may not handle WSL's UTF-8 output correctly when the host shell is PowerShell (UTF-16).

### What the current source does
- The bash tool captures output via pipes (`Stream.runForEach(handle.all, ...)`, shell.ts:951-955). The byte stream is decoded by `createAutoTextDecoder` (shell.ts:27).
- `normalizePowerShellOutput` (shell.ts:999, from bash-compress.ts) normalizes PowerShell-specific output (BOM, encoding quirks) but is applied only when `Shell.ps(input.shell)` is true (PowerShell shell).
- WSL commands run as `wsl -d Ubuntu-22.04 -- bash -c "..."` — the command executes inside Linux (UTF-8), but the output flows through the WSL interop layer to the Windows host (potentially UTF-16). The encoding detection may misidentify the WSL output's encoding.

### Why it is a design gap
1. **Garbled output confuses the model.** The model sees `仯뾽盯뾽寯뾽` instead of a readable warning. It cannot parse the message, may ignore it, or may misinterpret it as a command failure.
2. **No WSL-specific encoding handling.** The harness has `normalizePowerShellOutput` for PowerShell and `REMOTE_SHELL_COMMANDS` for WSL command parsing (shell.ts:103), but the output encoding path does not have WSL-specific handling. WSL output is treated as generic pipe output, missing the UTF-8-from-Linux-via-WSL-interop encoding issue.
3. **5% garbled rate.** 1 in 20 WSL commands produces garbled output. For sessions that rely heavily on WSL (e.g., cross-platform build testing), this degrades the model's understanding of command results.

### Mechanism
WSL's Linux-side output is UTF-8. The WSL interop layer passes bytes to the Windows host. The harness's auto-detecting text decoder may misidentify the encoding (especially for CJK text or mixed-encoding streams), producing garbled characters. The `normalizePowerShellOutput` function handles PowerShell's encoding quirks but does not address the WSL UTF-8-to-host path.

### Verification design
For WSL commands, explicitly decode output as UTF-8 (Linux standard) regardless of the host shell's default encoding. Add a WSL-specific normalization step that detects and fixes common WSL interop encoding artifacts. Measure: garbled-output rate for WSL commands before/after. Expected: garbled rate drops from 5% to <0.5%.

---

## Confirmed Finding 45: 1757 Select-String calls (via bash) bypass the dedicated grep tool — the agent uses PowerShell's Select-String instead of ripgrep, losing structured output, search-history preservation, and the 64-cap total-count benefit

### Evidence chain
- 1757 bash commands use `Select-String` (PowerShell's grep equivalent) across 89 sessions.
- Compare: the dedicated `grep` tool (using ripgrep) was called 12496 times. Select-String accounts for 12.3% of search operations (1757 / (1757 + 12496)).
- Source: `packages/opencode/src/tool/grep.ts` provides structured output (file:line:content format, 64-result cap with count, Finding 13) and is tracked by the Evidence Handoff search-history (Finding 4 — though currently excluded). `Select-String` via bash produces raw text output subject to bash truncation (Finding 7), has no structured format, and is not tracked by any search-history mechanism.

### What the current source does
- The `grep` tool (grep.ts) uses ripgrep, returns structured results with file paths, line numbers, and match counts. It is a first-class tool with its own output format.
- `Select-String` is a PowerShell cmdlet executed via the `bash` tool. Its output is raw text (PowerShell's formatted table), subject to bash's 1000-line/16KB truncation (Finding 7) and bash compression. It is NOT tracked by any search-history or dedup mechanism.
- The system prompt (system.ts:67) says "To search file content use the grep tool instead of grep/rg" but does not mention Select-String specifically.

### Why it is a design gap
1. **Bypasses grep tool benefits.** Select-String via bash does not benefit from: the grep tool's structured output (file:line:content), the 64-cap with total count (Finding 13), the ripgrep performance (ripgrep is faster than Select-String for large codebases), or any future search-history preservation (Finding 4).
2. **Subject to bash limitations.** Select-String output is subject to bash's tail-truncation (Finding 7), timeout (Finding 2), and "(no output)" on timeout. The grep tool has its own output handling that is not subject to these bash-specific limitations.
3. **Inconsistent search experience.** When the agent uses the grep tool, it gets structured results. When it uses Select-String, it gets raw text. The model must parse two different output formats for the same conceptual operation (content search), increasing cognitive load and error rate.
4. **No Select-String-specific guidance.** The system prompt says "use grep instead of grep/rg" but the agent uses Select-String (a PowerShell cmdlet, not grep/rg). The prohibition doesn't cover Select-String explicitly, so the agent doesn't know it should use the grep tool instead.

### Mechanism
The system prompt's tool-usage guidance names `grep` and `rg` as tools to avoid, but doesn't name `Select-String` (PowerShell's equivalent). The agent, running in PowerShell, naturally reaches for Select-String — the PowerShell-native search cmdlet — instead of the dedicated grep tool. The harness provides no Select-String-to-grep redirection.

### Verification design
(1) Add `Select-String` to the system prompt's tool-usage guidance: "To search file content use the grep tool instead of grep, rg, or Select-String." (2) Optionally, detect Select-String in bash commands and suggest "Consider using the grep tool for structured search results." Measure: Select-String usage before/after; grep tool usage change. Expected: Select-String drops >60%; grep tool usage rises correspondingly.

---



## Confirmed Finding 46: 412 inline scripts (bun -e, python -c) read files, bypassing the read tool's dedup (Finding 1), outline (Finding 33), and structured truncation — the system prompt prohibits cat/head/tail/sed but not bun -e/python -c

### Evidence chain
- 224 `bun -e` commands use `Bun.file()` or `readFile` to read file content. 188 `python -c` commands use `open()` or `read` to read files. Total: 412 inline-script file reads.
- These reads produce raw text output via the bash tool, subject to bash's 1000-line/16KB tail-truncation (Finding 7), with no `<more>` tag, no `<outline>`, no stub dedup (Finding 1), and no read-metadata for Evidence Handoff (Finding 4).
- The system prompt (system.ts:64) says "To read files use the read tool instead of cat, head, tail, or sed" — it does not mention `bun -e`, `python -c`, or `node -e`.
- Sample: `bun -e 'import { Database } from "bun:sqlite"; const db = new Database("C:/Users/...")'` — reads a SQLite database via inline script (legitimate, read tool can't handle DBs). But `node -e "const fs=require('fs'); const files=['chatgpt.js',...]; ..."` reads and concatenates multiple JS files — this should use the read tool.

### What the current source does
- The bash tool executes `bun -e`/`python -c`/`node -e` commands and returns their stdout. The output is treated as generic bash output — no read-tool enhancements apply.
- The read tool (read.ts) provides structured output (`<path>`, `<range>`, `<outline>`, `<more>`, stub dedup), but these only apply when the `read` tool is called. Inline-script reads are invisible to the read-tool infrastructure.

### Why it is a design gap
1. **Bypasses all read-tool benefits.** 412 file reads via inline scripts get none of the read tool's enhancements: no stub dedup (Finding 1), no overlap note, no outline (Finding 33), no `<more>` continuation tag, no Evidence Handoff tracking (Finding 4). The output is subject to bash's tail-truncation (Finding 7) instead of the read tool's head-truncation with `<more>`.
2. **No system-prompt coverage.** The prompt prohibits `cat`, `head`, `tail`, `sed` for file reading but not `bun -e`, `python -c`, `node -e`. The agent discovers these as alternative file-reading methods and uses them without knowing they bypass the read tool.
3. **Mixed legitimate/bypass usage.** Some inline-script reads are legitimate (SQLite access, binary parsing, JSON field extraction — operations the read tool can't do). Others are simple file reads that should use the read tool. The harness cannot distinguish them, so the bypass rate (412) includes both.
4. **No detection or redirect.** The harness could detect `bun -e`/`python -c`/`node -e` commands that read files (via `Bun.file`, `readFile`, `open(` patterns) and suggest "Use the read tool for file content access." It does not.

### Mechanism
The system prompt's file-reading prohibition names specific Unix utilities (cat, head, tail, sed) but not interpreter flags (bun -e, python -c, node -e). The agent, running in a JavaScript/Python environment, naturally uses these interpreters for file access, bypassing the read tool's entire enhancement stack.

### Verification design
(1) Add `bun -e`, `python -c`, `node -e` to the system prompt's file-reading guidance: "To read files use the read tool instead of cat, head, tail, sed, or inline scripts (bun -e, python -c, node -e) that read file content." (2) Optionally detect inline-script file reads and suggest the read tool. Measure: inline-script file-read count before/after. Expected: simple file reads via inline scripts drop >50%; complex reads (DB, binary) remain.

---



## Confirmed Finding 47: 595 subagent dispatches, ALL foreground (100% blocking), totaling 65.2 hours of parent blocking time — background mode exists (task.ts:57-59) but is gated behind OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS (task.ts:122-125) and never used

### Evidence chain
- 595 task (subagent) calls: 595 foreground (blocking), 0 background. Blocking rate: 100%.
- Task execution time: median 183,572ms (3.1 min), p90 357,331ms (6.0 min).
- Total foreground blocking time: 234,544 seconds = 65.2 hours across the dataset.
- 35 messages dispatch 2+ foreground tasks concurrently (overlapping execution confirmed) — parallel dispatch works, but the parent blocks until ALL subagents complete.
- Source: `packages/opencode/src/tool/task.ts:57-59` `background: Schema.optional(Schema.Boolean)` — the parameter exists; `:122-125` `if (runInBackground && !flags.experimentalBackgroundSubagents) { return yield* Effect.fail(new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")) }` — background mode is gated behind an experimental flag, disabled by default.

### What the current source does
- The task tool supports a `background` parameter (task.ts:57-59). When `true`, it launches the subagent asynchronously and returns immediately with a `task_id` for polling (task.ts:72-81 `backgroundOutput`).
- When `background` is `false` (the default), the parent agent's loop blocks until the subagent completes (task.ts:225+ `runTask`). The parent cannot do any work while waiting.
- Background mode requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (task.ts:122-125). This flag is not set by default, so background mode is always rejected.
- The system prompt (system.ts) and task tool description (task.txt) do not mention background mode.

### Why it is a design gap
1. **65.2 hours of blocking.** The parent agent spends 65.2 hours across the dataset waiting for subagents. During each 3-minute (median) block, the parent is idle — it cannot read files, run commands, or make progress on its own tasks.
2. **Experimental flag prevents usage.** The background feature is fully implemented (task.ts:72-81, backgroundOutput, backgroundMessage) but gated behind an experimental flag that is off by default. The agent never tries `background: true` because the flag is off (and the system prompt doesn't mention it).
3. **Parallel dispatch partially mitigates but doesn't solve.** 35 messages dispatch 2+ tasks concurrently, so those subagents run in parallel. But the parent still blocks until the SLOWEST subagent finishes. With background mode, the parent could dispatch all subagents, continue its own work, and poll results later.
4. **No cost-awareness.** The agent doesn't know that each subagent dispatch will block for ~3 minutes. The system prompt and task description don't warn about the blocking cost. The agent dispatches subagents freely, accumulating blocking time.

### Mechanism
The task tool is designed as a synchronous call-and-wait: the parent dispatches a subagent and blocks until it completes. The asynchronous (background) alternative exists but is gated behind an experimental flag. The result is 65.2 hours of cumulative parent idle time — time the parent could have spent on independent work.

### Verification design
(1) Enable background subagents by default (or remove the experimental flag). (2) Update the task tool description and system prompt to mention background mode: "For long-running investigations, use background=true to launch the subagent asynchronously and continue your work. Use task_status to poll for results." (3) Track and surface blocking time per session. Measure: foreground vs background task ratio before/after; total parent blocking time. Expected: background usage rises from 0% to >30% for investigation tasks; total blocking time drops >40%.

---

## Confirmed Finding 48: glob stats every file for mtime (glob.ts:60-66) to sort by recency — p90=2349ms for large directories, adding latency that only benefits the mtime sort (Finding 18), which is itself a questionable heuristic

### Evidence chain
- glob execution time: median 266ms, p90 2349ms (2.3s). Compare: grep median 227ms, p90 961ms; read median 32ms.
- Source: `packages/opencode/src/tool/glob.ts:56-72` — the glob tool uses `Stream.mapEffect` to stat each file (`fs.stat(full)`, line 60) for mtime, before sorting (line 78 `files.sort((a, b) => b.mtime - a.mtime)`). Every file in the result set is stat'd, even if the result is truncated at 100 (line 74-77).

### What the current source does
- glob fetches up to 101 files from ripgrep (glob.ts:56-69, `Stream.take(limit + 1)`), then for EACH file calls `fs.stat(full)` (line 60) to get the modification time. The files are then sorted by mtime descending (line 78).
- The stat calls are I/O operations — one per file. For 100 files, that's 100 stat calls. On a network drive or a large directory, these can be slow (p90=2349ms).
- The mtime sort (Finding 18) is used to prioritize recently-modified files, but Finding 18 showed this heuristic loses old stable files. So the stat overhead buys a sort order that is itself questionable.

### Why it is a design gap
1. **Stat overhead without proportional benefit.** The mtime sort (Finding 18) has a 10.3% truncation rate and loses old core files. The stat calls that enable this sort add 2.3s (p90) latency. The cost (latency) doesn't justify the benefit (questionable sort order).
2. **Stats happen before truncation.** Files are stat'd (line 60) BEFORE the 100-cap truncation (line 74-77). So even files that will be truncated away are stat'd. The tool could stat only the first 100 files after ripgrep returns them, skipping stats for files that will be dropped.
3. **No option to skip mtime sort.** The tool always sorts by mtime. There is no `sort` parameter to let the model request alphabetical sort (which doesn't need stat calls) or no sort (ripgrep's natural order).
4. **glob is slower than grep.** glob p90 (2349ms) is 2.4× slower than grep p90 (961ms), despite both using ripgrep. The difference is the per-file stat calls in glob.

### Mechanism
glob treats mtime sorting as a mandatory feature, paying per-file stat I/O for every call. The sort order it produces (newest-first, Finding 18) is a poor proxy for relevance in code exploration. The stat overhead makes glob the slowest search-discovery tool, despite using the same ripgrep backend as grep.

### Verification design
(1) Make mtime sort opt-in (e.g. `sortBy: "mtime" | "name" | "none"`, default `"name"` which needs no stat). (2) If mtime sort is requested, stat only the first 100 files (after truncation), not all 101. (3) Consider returning files in ripgrep's natural order (no sort, no stat) by default. Measure: glob p90 latency before/after; whether the model's file-discovery quality changes. Expected: glob p90 drops from 2349ms to <500ms; file-discovery quality holds or improves (alphabetical is more predictable than mtime).

---



## Confirmed Finding 49: 58 bash errors are "The current shell is pwsh, but the command uses Unix utility" — the agent uses Unix commands (cat, ls, find, etc.) in PowerShell, and the harness rejects them, wasting a turn each

### Evidence chain
- 58 bash errors: 37 "The current shell is pwsh, but the command uses Unix utility" + 21 "The current shell is pwsh, but the local command uses Unix utility" + 5 "find is ambiguous on Windows."
- These are harness-detected rejections: the precheck (precheck.ts) or bash tool detects that a Unix-only command (cat, ls, find, grep, etc.) is being used in a PowerShell shell and rejects it before execution.
- The system prompt (system.ts:202-204) tells the agent: "Shell: pwsh (PowerShell 7+). Shell syntax: use PowerShell syntax. Bash-like && and || are supported, but Unix utilities such as tail/head/sed/awk/grep may not exist."
- Despite this guidance, the agent uses Unix commands 58 times, each resulting in a rejected tool call.

### What the current source does
- The bash tool (shell.ts) and precheck (precheck.ts) detect Unix-only commands in PowerShell and reject them with a descriptive error: "The current shell is pwsh, but the command uses Unix utility" or "find is ambiguous on Windows. Use Get-ChildItem or the glob tool."
- The rejection happens BEFORE execution — no side effects. The agent sees the error and must retry with PowerShell syntax or a dedicated tool.
- The system prompt warns about Unix utilities, but the warning is in the environment section (system.ts:202-204), not in the tool-usage section (system.ts:60-90) where the agent's attention is focused.

### Why it is a design gap
1. **58 wasted turns.** Each rejection costs a tool round-trip (model generates command → harness rejects → model regenerates). The agent pays inference latency + rejection latency for each.
2. **Guidance placement.** The Unix-utility warning is in the environment section (system.ts:202-204), which the model may not attend to as strongly as the tool-usage section (system.ts:60-90). Moving the warning to the tool-usage section (e.g. "On Windows pwsh, do NOT use cat/ls/find/grep/sed/awk — use read/glob/grep tools or PowerShell cmdlets") would increase compliance.
3. **No auto-redirect.** The harness detects "cat" in pwsh and rejects it, but doesn't suggest "Use the read tool instead." The error says what's wrong but not what to do instead. Compare: the read tool's "Did you mean one of these?" (read.ts:384) provides an actionable suggestion.
4. **Compounding with Finding 45.** Finding 45 showed 1757 Select-String calls bypassing the grep tool. Finding 49 shows 58 Unix-command rejections. Both stem from the same root: the agent doesn't fully internalize its shell environment and uses Unix-isms that either bypass dedicated tools (Select-String) or get rejected (cat/ls/find).

### Mechanism
The harness correctly detects and rejects Unix commands in PowerShell (a safety feature), but the rejection is non-redirective — it tells the model what's wrong without suggesting the right tool. The system prompt warns about Unix utilities, but the warning's placement and phrasing don't prevent 58 violations.

### Verification design
(1) Move the Unix-utility warning to the tool-usage section with actionable guidance: "On Windows pwsh, do NOT use cat/ls/find/grep/sed/awk. Use the read tool (instead of cat), glob tool (instead of find/ls), grep tool (instead of grep)." (2) On rejection, append "Use the <tool> tool instead." Measure: Unix-in-pwsh rejection count before/after. Expected: rejections drop >70%.

---

## Confirmed Finding 50: 47 grep regex errors + 7 glob syntax errors — the agent's regex/glob patterns frequently have invalid syntax, and the error messages don't show how to fix them

### Evidence chain
- 47 grep errors are regex/pattern errors: invalid regex syntax in the `pattern` parameter.
- 7 grep errors are "unclosed character class" from invalid glob patterns in the `include` parameter (e.g. `![]`).
- 5 grep errors are null bytes in arguments — the agent passes patterns containing `\x00`.
- 2 grep errors are "invalid ripgrep output" — internal parsing issues.
- Source: `packages/opencode/src/tool/grep.ts` — the grep tool passes the pattern directly to ripgrep. If the regex is invalid, ripgrep returns an error; the tool surfaces it as-is. The error does not include a suggestion for how to fix the regex.

### What the current source does
- The grep tool passes `params.pattern` to ripgrep (grep.ts:118 `limit: RESULT_LIMIT + 1`). If the regex is invalid, ripgrep returns a parse error. The tool surfaces this error as the tool's `state.error`.
- The error is the raw ripgrep message (e.g. "regex parse error: ... unmatched parenthesis"). It does not include a suggestion, a corrected regex, or a simpler alternative.

### Why it is a design gap
1. **47 regex errors.** The agent's regex skills are imperfect — it generates invalid patterns (unmatched parens, bad character classes, invalid quantifiers). Each error wastes a turn.
2. **No fix suggestion.** The error says "regex parse error: unmatched parenthesis" but doesn't suggest "Try escaping the parenthesis: \( or removing it." The model must figure out the fix from the raw error.
3. **Glob include syntax confusion.** 7 errors are from invalid glob patterns in the `include` parameter. The agent confuses regex syntax with glob syntax (e.g. using `![]` as a glob pattern, which ripgrep interprets as a character class).
4. **Null bytes.** 5 errors from null bytes in patterns — the agent passes patterns containing `\x00` (possibly from copy-pasting binary content). The error is "The argument 'args[N]' must be a string without null bytes" — a Node.js internal error, not a user-friendly message.

### Mechanism
The grep tool is a thin wrapper around ripgrep — it passes the pattern through and surfaces raw errors. The model's regex errors (which are common — regex is hard) get no harness-level assistance. The tool could validate the regex before passing it to ripgrep, or provide a simpler-pattern suggestion on error.

### Verification design
(1) Before calling ripgrep, validate the regex with a try/catch on `new RegExp(pattern)`. If invalid, return "Invalid regex: <error>. Try a simpler pattern or escape special characters." (2) For null bytes, strip them before passing to ripgrep and note "Null bytes removed from pattern." (3) For glob `include` errors, note "include uses glob syntax (e.g. *.ts), not regex." Measure: grep error count before/after; first-try regex success rate. Expected: regex errors drop >50%; null-byte errors eliminated.

---



## Confirmed Finding 51: read tool rejects binary files with "Cannot read binary file" (10 cases) but provides no alternative — no suggestion to use sqlite/gunzip/strings/hexdump for the specific file type

### Evidence chain
- 10 read errors: "Cannot read binary file: <path>". Files include: `state.vscdb` (SQLite, x5), `.doc` (Word), `.gz` (gzip), `logcat_all.txt` (text with binary), `base_20250629.yml` (YAML misdetected), `wsl-install-logs.txt`.
- Source: `packages/opencode/src/tool/read.ts:617-618` `if (isBinaryFile(filepath, sample)) { return yield* Effect.fail(new Error("Cannot read binary file: ${filepath}")) }` — the error names the file but gives no alternative.
- `read.ts:428` `isBinaryFile` detects binary content via byte sampling. `read.ts:551-552` handles images (SUPPORTED_IMAGE_MIMES) and PDFs before the binary check, but SQLite/gzip/doc/other binaries are rejected.

### What the current source does
- The read tool samples the first bytes (read.ts:413-425 `readSample`), sniffs the MIME type (read.ts:551), and checks if it's a supported image/PDF. If not, it checks `isBinaryFile` (read.ts:617). If binary, it fails with "Cannot read binary file."
- The error does not suggest alternatives based on the file type (e.g., "This is a SQLite database — use `bun -e` with `bun:sqlite` to query it" or "This is a gzip file — decompress with `gunzip` first").

### Why it is a design gap
1. **No type-specific guidance.** The harness sniffs the MIME type (read.ts:551) but only uses it for image/PDF detection. For SQLite (.vscdb), gzip (.gz), Word (.doc), it could suggest the appropriate tool: `bun -e` for SQLite, `gunzip` for gzip, `python-docx` for Word, `strings` for generic binary.
2. **YAML misdetected.** `base_20250629.yml` was rejected as binary — the binary detection has false positives for text files with non-ASCII content (e.g., CJK text in YAML). The agent can't read a legitimate YAML file.
3. **Wasted turn.** Each binary rejection costs a turn. The agent must figure out an alternative approach on its own. For SQLite databases, the agent eventually discovers `bun -e 'import { Database } from "bun:sqlite"'` (Finding 46 data) — but only after the read tool rejection.

### Mechanism
The read tool's binary detection is a gatekeeper that rejects binary files, but the rejection is non-redirective. The harness knows the file type (it sniffs the MIME) but doesn't use that knowledge to suggest an appropriate alternative tool.

### Verification design
On binary rejection, include the detected MIME type and a type-specific suggestion: SQLite → "Use `bun -e` with `bun:sqlite` to query this database"; gzip → "Decompress with `gunzip` or `bun -e` with `zlib`"; unknown → "Use `strings` or `hexdump` via bash to inspect binary content." For false-positive text files (YAML with CJK), relax the binary detection. Measure: binary-rejection recovery time (turns to find alternative) before/after. Expected: recovery time drops; false-positive rejections eliminated.

---

## Confirmed Finding 52: bash-compress.ts:669 `quotePattern` calls `.replaceAll` on a potentially-undefined pattern — 9 "undefined is not an object" runtime errors crash the bash tool on certain PowerShell commands

### Evidence chain
- 9 bash errors: "undefined is not an object (evaluating '$.replaceAll')". All occur on PowerShell commands (e.g., `$ErrorActionPreference = "Continue"; $proxy = "http://127.0.0.1:7897"; ...`).
- Source: `packages/opencode/src/tool/bash-compress.ts:667-672` `function quotePattern(pattern: string, maxChars = 40) { let text = pattern.replaceAll("\\", "\\\\")... }` — `pattern` is typed as `string` but if called with `undefined`, `.replaceAll` throws at runtime (TypeScript types are not enforced at runtime).
- The `quotePattern` function is called from within the bash compression pipeline (bash-compress.ts). When the compression processes certain PowerShell outputs, a `pattern` value is undefined, causing the crash.

### What the current source does
- `quotePattern` (bash-compress.ts:667) takes a `pattern: string` and calls `.replaceAll` on it (lines 669-672). If `pattern` is undefined (a runtime condition not caught by the TypeScript type), the call throws "undefined is not an object (evaluating '$.replaceAll')".
- The error propagates as the bash tool's error, causing the entire command output to be lost (the tool returns an error instead of the command output).

### Why it is a design gap
1. **Runtime crash.** The bash tool crashes on certain PowerShell commands, losing the command's output entirely. The agent sees "undefined is not an object" instead of the PowerShell output — a JavaScript stack trace, not a command result.
2. **No input validation.** `quotePattern` trusts its `pattern` parameter to be a string. A simple `if (!pattern) return ""` guard would prevent the crash.
3. **Compression pipeline fragility.** The bash-compress module (76KB, 2146 lines) is complex. The `quotePattern` crash suggests there are code paths where `pattern` can be undefined — likely when the compression encounters an edge case in PowerShell output formatting (e.g., a line that doesn't match the expected pattern structure).
4. **All errors on PowerShell.** The 9 errors all occur on PowerShell commands, suggesting the compression's PowerShell-output handling has an edge case that produces an undefined pattern value.

### Mechanism
The bash compression pipeline calls `quotePattern` with a value that is sometimes undefined (likely from an edge case in PowerShell output parsing). The function doesn't guard against undefined, causing a runtime crash that loses the entire command output.

### Verification design
Add a guard at `quotePattern` entry: `if (typeof pattern !== "string") return ""`. Audit the bash-compress pipeline for other `.replaceAll`/`.replace` calls on potentially-undefined values. Measure: "undefined is not an object" error count before/after. Expected: error count drops to 0; affected commands produce output instead of crashes.

---

## Confirmed Finding 53: 10 read errors from offset=0 (1-indexed confusion) — the agent passes offset=0 but the read tool requires offset >= 1; 60% of cases are not recovered (agent gives up or takes a different path)

### Evidence chain
- 10 read errors: "offset must be greater than or equal to 1." The agent passes `offset: 0`, but the read tool's offset parameter is 1-indexed (read.ts:350-352 "The line number to start reading from (1-indexed)").
- Recovery: 4 of 10 (40%) were followed by a corrected read with offset=1 or no offset. 6 of 10 (60%) were NOT recovered — the agent gave up or took a different path.
- Source: `packages/opencode/src/tool/read.ts:350-352` `offset: Schema.optional(NonNegativeInt)` — the schema uses `NonNegativeInt` which allows 0, but the tool's internal logic requires offset >= 1. The schema validation passes 0, but the tool rejects it at runtime.

### What the current source does
- The `offset` parameter is `Schema.optional(NonNegativeInt)` (read.ts:350-352). `NonNegativeInt` allows 0. But when offset=0 is passed, the tool's line-reading logic (which is 1-indexed) fails with "offset must be greater than or equal to 1."
- The schema allows 0 but the tool rejects 0 — a schema/logic mismatch.

### Why it is a design gap
1. **Schema/logic mismatch.** The schema (`NonNegativeInt`) allows 0, but the tool requires >= 1. The model sees "offset: number (1-indexed)" in the description but the schema accepts 0, so the model sometimes passes 0.
2. **60% non-recovery.** 6 of 10 offset=0 errors were not followed by a corrected read. The agent either gave up on reading that file or took a different approach — wasting the initial attempt.
3. **No auto-correction.** The tool could treat offset=0 as offset=1 (the beginning of the file) instead of erroring. This is a one-line fix: `const offset = params.offset && params.offset > 0 ? params.offset : 1`.

### Mechanism
The read tool's 1-indexed offset conflicts with the model's 0-indexed intuition (many programming contexts use 0-indexing). The schema allows 0 but the tool rejects it, creating a validation gap. The model passes 0, the tool errors, and 60% of the time the model doesn't recover.

### Verification design
Either (a) treat offset=0 as offset=1 (auto-correct), or (b) change the schema to `PositiveInt` (minimum 1) so the schema rejects 0 before the tool runs, with a clear error "offset must be >= 1 (1-indexed)." Measure: offset=0 error count before/after. Expected: errors drop to 0; no wasted turns on 1-indexed confusion.

---



## Confirmed Finding 54: notebook_edit cellId errors (30 cases) have only 17% recovery — the error doesn't list available cellIds, so the agent rarely re-reads the notebook structure to find the correct one

### Evidence chain
- 30 notebook_edit errors are cellId-related (cellId not found / cell not found). 8 more are "missing required field" (newCode/InstanceRef/filePath).
- Recovery: 5 of 30 (17%) were followed by a `vscode_notebook_summary` call to re-discover cell IDs. 25 (83%) were NOT recovered — the agent either gave up, tried a different cellId, or switched approach.
- Source: the notebook_edit tool requires a `cellId` (from `vscode_notebook_summary`). When the cellId doesn't exist, the error is "cellId not found" — but it does NOT list the available cellIds in the current notebook.

### What the current source does
- The notebook_edit tool takes a `cellId` parameter (must match a cell from `vscode_notebook_summary`). If the cellId doesn't match any cell in the notebook, the tool returns an error.
- The error does not include the list of valid cellIds. The agent must separately call `vscode_notebook_summary` to discover the correct cellId — which it does only 17% of the time.

### Why it is a design gap
1. **No cellId list in the error.** The error could say "cellId '#VSC-xxx' not found. Available cells: #VSC-aaa (code), #VSC-bbb (markdown), ..." — letting the agent pick the right one without a separate summary call. Compare: the read tool's "Did you mean one of these?" (read.ts:384).
2. **83% non-recovery.** 25 of 30 cellId errors were not followed by a notebook_summary call. The agent either guessed a different cellId (likely failing again) or abandoned the edit — losing the intended change.
3. **Stale cellId.** The cellId comes from a prior `vscode_notebook_summary` call. If the notebook was modified (by the user or a prior edit) since the summary, the cellId may no longer exist. The error doesn't say "this cellId was valid before but the notebook has changed — re-run notebook_summary."
4. **Same pattern as Finding 3 (edit oldString) and Finding 16 (apply_patch context).** All three content-matching tools (edit, apply_patch, notebook_edit) share the same diagnostic gap: they report what was expected but not what is actually available.

### Mechanism
The notebook_edit tool validates cellId against the live notebook state but doesn't expose the valid cellIds in the error. The agent must discover them through a separate tool call, which it rarely does (17%). The 83% non-recovery rate shows the agent often can't self-correct.

### Verification design
On cellId-not-found, include the available cellIds in the error: "cellId '#VSC-xxx' not found. Available: #VSC-aaa (code, line 1-10), #VSC-bbb (markdown, line 11-15)." Measure: cellId-error recovery rate before/after. Expected: recovery rises from 17% to >60%; notebook-edit failure rate drops.

---



# Deep-Dive Findings (Pass 9 — source-mechanism + cross-cutting)

## Confirmed Finding 55: PRUNE_PROTECTED_TOOLS = ["skill"] (compaction.ts:52) — only skill outputs are protected from pruning; read outputs (42.7% of context, Finding 34) are prunable, losing the most valuable context first

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:52` `const PRUNE_PROTECTED_TOOLS = ["skill"]`; `:787` `if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue` — the pruning loop skips skill parts but processes ALL other tool parts (read, grep, bash, edit, etc.).
- Read output is 42.7% of all context (Finding 34, 189.2M chars). Pruning marks old read outputs as `time.compacted` (compaction.ts:804), replacing their content with a generic "compaction_cleared" notice (message-v2.ts:963-964). After pruning, the model can no longer see the file content it previously read — it must re-read.
- Skill outputs (~7KB each, Finding 27) ARE protected. But skill content is instruction text that the model can reload; read content is file-specific data that the model must re-read from disk (paying I/O + token cost).

### Why it is a design gap
1. **Wrong protection priority.** Skill outputs (reloadable, ~7KB) are protected; read outputs (non-reloadable without I/O, ~2KB each, 42.7% of context) are pruned. The protection list should prioritize the hardest-to-recover content (read outputs of files that haven't changed) over the easily-reloadable content (skill instructions).
2. **Pruning targets the largest context consumer.** Since read output is 42.7% of context, pruning read outputs frees the most space — but it also loses the most valuable information. The pruning heuristic (recency-based, compaction.ts:794) doesn't consider whether the file has changed since the read (if unchanged, the read output is still valid and re-reading would produce identical content).
3. **No file-mtime check before pruning.** The pruning could check `read.metadata.modifiedMs` against the current file mtime — if the file hasn't changed, the read output is still valid and could be kept (or at least marked as "still valid, re-read if needed"). Instead, all old read outputs are pruned regardless of file staleness.

### Verification design
Add "read" to PRUNE_PROTECTED_TOOLS, or implement a smarter pruning policy: before pruning a read output, check if the file has changed since the read. If unchanged, keep the read output (it's still valid). If changed, prune it (it's stale). Measure: post-pruning re-read count before/after; context savings from pruning before/after. Expected: re-reads of unchanged files eliminated; pruning still frees space from stale reads.

---

## Confirmed Finding 56: compaction splitTurn skips error turns (compaction.ts:622-623) — error turns are always summarized, never kept in the tail, losing diagnostic context the model was actively working on

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:622-623` `if (msg.info.hidden || msg.parts.length === 0) continue; if (msg.info.role === "assistant" && (!msg.info.finish || msg.info.error)) continue;` — the splitTurn function skips assistant messages that have errors.
- The splitTurn function (compaction.ts:606-635) tries to find a split point in a turn to preserve part of it in the tail. If a turn is skipped, it's always summarized (never kept verbatim).
- 1634 tool errors across the dataset (Finding 23). Error turns contain diagnostic information (typecheck errors, edit failures, command errors) that the model may be actively working on when compaction fires.

### Why it is a design gap
1. **Error context lost.** If the model was working on fixing a typecheck error (the typecheck output is in an error turn), and compaction fires, the typecheck output is summarized (lossy, Finding 14) rather than kept in the tail. The model loses the exact error messages it was working on.
2. **Error turns are high-value.** Error turns contain the model's active debugging context — the error output, the failed tool call, and the model's reasoning about the error. These are MORE valuable to keep than successful turns (which the model has already processed and moved past).
3. **The skip is intentional but counterproductive.** The skip was likely added because error turns may have incomplete content (the model was interrupted). But the error OUTPUT (in the tool part) is complete — it's the model's RESPONSE that may be incomplete. Skipping the entire turn loses both.

### Verification design
In splitTurn, don't skip error turns entirely. Instead, keep the tool parts (which contain the error output) in the tail, even if the assistant text is incomplete. Alternatively, extract the error tool outputs from skipped turns and include them in the Evidence Handoff as "Recent Errors." Measure: post-compaction error-recovery rate (does the model continue fixing the same error?) before/after. Expected: error-recovery rate improves; the model doesn't lose track of active debugging context.

---

## Confirmed Finding 57: compaction summary builds on `<previous-summary>` (compaction.ts:173-184) with no quality check — after N compactions, the summary is an Nth-generation derivative with exponentially degrading fidelity (Finding 36), and the system has no metric to detect degradation

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:173-184` `function buildPrompt(input: { previousSummary?: string; context: string[] })` — when `previousSummary` exists, it's included as `<previous-summary>` and the model is asked to "Update the anchored summary below... Preserve still-true details, remove stale details, and merge in the new facts."
- Finding 36: 5 sessions exceed 10 compactions (max 24). Finding 14: ~28% file-path preservation per compaction. After 5 compactions, the cumulative preservation is ~0.28^5 ≈ 0.2% (summary alone, Evidence Handoff provides a floor).
- There is no "summary quality" metric. The system does not check whether the summary is degrading, whether it's losing critical details, or whether it contradicts the actual conversation.

### Why it is a design gap
1. **Blind accumulation.** Each compaction builds on the previous summary without checking its quality. If compaction #3's summary dropped a critical constraint, compaction #4 builds on the degraded summary, and the constraint is permanently lost — even if the model re-encounters it in the tail turns.
2. **No contradiction detection.** The summary might contain stale details (the prompt says "remove stale details," but the LLM might not recognize them as stale). If the summary says "file X has function foo()" but the model later deleted foo(), the summary's claim is stale and could mislead the model.
3. **No fallback to raw context.** When the summary has been through many compactions, the system could fall back to keeping more raw tool outputs (expanding the tail) instead of relying on the degraded summary. It does not — the tail is fixed at 4 turns (DEFAULT_TAIL_TURNS, compaction.ts:57) regardless of compaction count.

### Verification design
(1) Track summary fidelity: after each compaction, compare the summary's claims against the actual tail-turn content. If the summary contradicts the tail, flag it. (2) For sessions with >5 compactions, expand the tail (DEFAULT_TAIL_TURNS from 4 to 6+) to compensate for summary degradation. (3) Include a "Compaction #" counter in the summary prompt so the model knows it's working with an Nth-generation summary. Measure: post-compaction stale-reference rate before/after. Expected: stale references drop; the model treats high-N summaries with appropriate skepticism.

---

## Confirmed Finding 58: the harness has 5+ silent feedback gaps where the model's actions have effects the model cannot see — auto-format (Finding 26), compaction (Finding 4/14), external file changes (file watcher), LSP diagnostics (Finding 38), typecheck error content (Finding 41) — the model operates with an incomplete model of its own actions' effects

### Evidence chain
Each of these mechanisms has the information but doesn't forward it to the model:
1. **Auto-format (Finding 26):** write.ts:72 calls `format.file()` which may change the file content. The format diff is in `metadata.diff` but NOT in the model-visible output. 32% of writes are affected.
2. **Compaction (Finding 4/14):** compaction.ts:804 marks parts as `time.compacted`, message-v2.ts:963-964 replaces the output with a generic notice. The model doesn't know WHAT was lost.
3. **External file changes:** watcher.ts:24-32 detects file changes (add/change/unlink) and publishes bus events. But these events are internal — they don't become model-visible text. The model doesn't know when a file it read has been externally modified.
4. **LSP diagnostics (Finding 38):** edit.ts:197 calls `lsp.diagnostics()` but 0 diagnostics fired (server not running). The tool output doesn't note "LSP unavailable" — the model assumes "no errors" when it's actually "not checked."
5. **Typecheck error content (Finding 41):** bash tool returns typecheck output with `status: "completed"` regardless of error content. 13% of typecheck-error runs are not acknowledged because the model doesn't recognize "completed with error content" as a failure.

### Why it is a design gap
In each case, the harness HAS the information (format diff, compacted content, file change event, LSP status, typecheck error count) but doesn't forward it to the model. The model operates with an incomplete action-effect model:
- It writes content, but the file on disk may differ (auto-format) — it doesn't know.
- It reads a file, but the content may be compacted away — it doesn't know what was lost.
- It edits a file, but the file may have been externally modified — it doesn't know.
- It edits a file, but type errors may exist — it's not told (LSP) or doesn't recognize (typecheck).

The cumulative effect: the model makes decisions based on a content model that diverges from reality, leading to stale-content edit failures (Finding 40: 1291 blind edits), ignored verification results (Finding 41: 13% non-acknowledgment), and redundant re-reads (Finding 12: 1248 hot pairs).

### Verification design
For each gap, forward the information to the model: (1) auto-format: include format diff in output; (2) compaction: include "what was lost" summary; (3) external changes: inject "File X was modified externally since your last read"; (4) LSP: note "LSP diagnostics unavailable" when server is down; (5) typecheck: flag "output contains N errors." Measure: stale-content edit failures, non-acknowledgment rate, re-read count before/after. Expected: all three metrics improve.

---

## Confirmed Finding 59: the model bypasses dedicated tools via 5+ paths, each unprompted by the system prompt — bun -e/python -c (Finding 46, 412 cases), Select-String (Finding 45, 1757), cat/type/Get-Content (Finding 49, 721), bash-for-git (Finding 20, 5309), node -e (Finding 46) — the system prompt names specific Unix utilities but not interpreter flags or PowerShell cmdlets

### Evidence chain
- System prompt (system.ts:60-68): "To read files use the read tool instead of cat, head, tail, or sed" / "To search file content use the grep tool instead of grep/rg" / "To find files use the glob tool instead of find or ls."
- The prohibition names: cat, head, tail, sed, grep, rg, find, ls. It does NOT name: bun -e, python -c, node -e (interpreter flags), Select-String, Get-Content (PowerShell cmdlets), git (no dedicated git tool).
- Bypass counts: bun -e/python -c file reads: 412 (Finding 46); Select-String: 1757 (Finding 45); cat/type/Get-Content: 721 (Finding 49); git via bash: 5309 (Finding 20); node -e file reads: included in Finding 46.

### Why it is a design gap
1. **Incomplete prohibition list.** The system prompt lists Unix utilities but not interpreter flags or PowerShell cmdlets. The agent, running in a JavaScript/Python/PowerShell environment, naturally uses these alternative paths.
2. **No runtime detection.** The harness could detect "this bash command is reading a file (bun -e with Bun.file, Get-Content, Select-String on a file)" and suggest "Use the read/grep tool instead." It does not.
3. **All bypasses lose tool benefits.** Each bypass path skips the dedicated tool's enhancements: read (stub dedup Finding 1, outline Finding 33, `<more>` tag), grep (structured output Finding 13, 64-cap, Evidence Handoff tracking Finding 4), glob (mtime sort Finding 18, 100-cap). The model gets raw bash output instead.
4. **The system prompt is the only gate.** There is no tool-level gate: the bash tool doesn't check "is this command doing what a dedicated tool does?" The model's compliance depends entirely on the prompt's completeness.

### Verification design
(1) Expand the system prompt's prohibition: "To read files use the read tool instead of cat, head, tail, sed, Get-Content, or inline scripts (bun -e, python -c, node -e). To search use the grep tool instead of grep, rg, or Select-String." (2) Optionally detect bypass patterns in bash commands and suggest the dedicated tool. Measure: bypass count before/after. Expected: bypasses drop >50%.

---

## Confirmed Finding 60: the harness's loop-prevention has 4 layers, each too narrow to catch common loops — doom_loop (Finding 5: 10 triggers), read-stub (Finding 1: 3 of 130), overlap-note (Finding 1: non-suppressive), semantic-loop (Finding 11: undetected) — the gaps between layers cover the majority of actual loops

### Evidence chain
- Layer 1: doom_loop (processor.ts:456-481, DOOM_LOOP_THRESHOLD=3, exact-match, same-message) — 10 triggers across 816 sessions (Finding 5).
- Layer 2: read-stub (read.ts:219-232, exact-range or covering, visible-only) — 3 stubs in 130 reads (Finding 1).
- Layer 3: read-overlap-note (read.ts:234-250, ≥20 lines AND ≥30%, non-suppressive) — 51 notes in 69 overlaps (Finding 1), but non-suppressive.
- Layer 4: semantic-loop detection — does not exist. 51% of sessions have semantic loops (Finding 11).
- Cross-message re-run detection — does not exist. 97 immediate typecheck re-runs (Finding 42), 75 sessions with identical consecutive typecheck output.

### Why it is a design gap
1. **Each layer catches a different narrow pattern.** doom_loop catches exact-identical same-message calls. read-stub catches exact-same-range visible reads. Overlap-note notes (but doesn't suppress) large-overlap reads. None catches: shifting-offset reads (Finding 1), semantic 3-call sequences (Finding 11), cross-message re-runs (Finding 42), or typecheck re-runs with identical output (Finding 42).
2. **The layers don't compose.** Adding the 4 layers' coverage: 10 (doom_loop) + 3 (stub) + 51 (noted but not suppressed) = 64 suppressed/noted out of 1248 hot pairs (Finding 12) = 5.1% coverage. 94.9% of hot pairs are not caught by any layer.
3. **No adaptive threshold.** The thresholds are static (DOOM_LOOP_THRESHOLD=3, OVERLAP_MIN_LINES=20, OVERLAP_MIN_RATIO=0.3). They don't adapt to session length, file size, or tool-call frequency. A 3-call threshold is too high for a 5-call session and too low for a 2000-call session.

### Verification design
(1) Add a semantic-loop detector: track a sliding window of tool-call signatures and detect repeated 3-grams across messages (not just within one message). (2) Add a cross-message re-run detector: when the same command is run again with no edits since the last run, return the cached result. (3) Make the read-overlap-note suppressive when overlap ≥80% (return a stub instead of full content). Measure: hot-pair coverage before/after. Expected: coverage rises from 5.1% to >40%.

---

## Confirmed Finding 61: the subagent (task) system has 5 compounding inefficiencies making it the most expensive and least efficient subsystem — 65.2h blocking (Finding 47), 92% re-read rate (Finding 10), 12% empty results (Finding 30), inconsistent truncation (Finding 17), no background mode (Finding 47)

### Evidence chain
1. **65.2 hours of blocking** (Finding 47): 595 task calls, 100% foreground, median 184s each. Total blocking: 234,544 seconds.
2. **92% re-read rate** (Finding 10): 24 of 26 fork sessions re-read files the parent already read. No read-state inheritance (task.ts:226-229).
3. **12% empty results** (Finding 30): 70 of 593 task results are <500 chars, including empty `<task_result></task_result>`.
4. **Inconsistent truncation** (Finding 17): 21 task results exceed 16KB, some truncated mid-content, some not. No structured result contract.
5. **No background mode** (Finding 47): `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag gates background mode (task.ts:122-125), disabled by default. 0 background tasks.

### Why it is a design gap
The subagent system is designed to parallelize work (the system prompt encourages dispatching multiple agents, system.ts:669-673), but each dispatch:
- Blocks the parent for ~3 minutes (184s median)
- Re-explores files the parent already read (92% overlap)
- Has a 12% chance of returning nothing
- May be truncated inconsistently
- Cannot run in the background

The net effect: dispatching a subagent costs ~3 minutes of blocking + ~200 tool calls of re-exploration + ~12% chance of zero return. For the 595 dispatches in the dataset, the aggregate cost is 65.2 hours of blocking + ~119K redundant tool calls + 70 wasted dispatches.

### Verification design
(1) Enable background mode by default (Finding 47). (2) Pass parent's inspected-files list to the subagent (Finding 10). (3) Validate subagent result is non-empty before returning (Finding 30). (4) Give task results a larger truncation budget with a structured Summary+Details contract (Finding 17). Measure: blocking time, re-read overlap, empty-result rate, truncation rate — all before/after. Expected: blocking drops >40%; re-read overlap drops >50%; empty results eliminated; truncation consistent.

---

## Confirmed Finding 62: error diagnostics are systematically non-actionable across all content-matching tools — edit (Finding 3), apply_patch (Finding 16), notebook_edit (Finding 54), grep (Finding 50), read-binary (Finding 51) — all report what was expected but not what's available or how to fix it

### Evidence chain
- edit (edit.ts:709-711): "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings." — no actual content, no closest match.
- apply_patch (apply_patch.ts:137): "apply_patch verification failed: Error: Failed to find expected lines in <file>: <expected lines>" — shows expected lines but not actual content. 54% re-read rate (Finding 16).
- notebook_edit: "cellId not found" — no available cellIds. 83% non-recovery (Finding 54).
- grep (grep.ts): ripgrep regex error surfaced as-is — no fix suggestion. 47 regex errors (Finding 50).
- read binary (read.ts:618): "Cannot read binary file: <path>" — no alternative (sqlite/gunzip/strings). 10 cases (Finding 51).
- Exception: read tool's "Did you mean one of these?" (read.ts:384-388) — the ONLY tool that shows available alternatives.

### Why it is a design gap
1. **Consistent pattern: expected-but-not-actual.** All five tools know what the model expected (oldString, context lines, cellId, regex pattern, file path) and what actually exists (file content, available cells, valid regex, file type). But only the read tool (for file-not-found) exposes the "what actually exists" information. The other five discard it.
2. **The read tool proves the pattern works.** read.ts:384-388 shows "Did you mean one of these? <candidates>" — this is actionable. The model can pick the right file without a separate read. The other tools could follow this pattern: edit could show the closest match, apply_patch could show the actual lines, notebook_edit could list available cellIds.
3. **Recovery cost.** Each non-actionable error forces the model to discover the actual state via a separate tool call (re-read, notebook_summary, trial-and-error). The aggregate recovery cost across the 5 tools: 100 re-reads after apply_patch (Finding 16), 5 notebook_summary calls after cellId errors (Finding 54), 4 re-reads after offset=0 (Finding 53), plus unknown recovery costs for edit and grep.

### Verification design
For each content-matching tool, include the "what's available" information in the error: edit → closest match + actual lines; apply_patch → actual lines at the expected location; notebook_edit → available cellIds; grep → regex fix suggestion or simpler pattern; read-binary → type-specific alternative. Measure: recovery rate (does the model correct without a separate discovery call?) before/after. Expected: recovery rate rises >60% across all five tools; discovery-call count drops.

---

## Confirmed Finding 63: the context-assembly truncation during compaction replay (TOOL_OUTPUT_HEAD_CHARS=400, TOOL_OUTPUT_TAIL_CHARS=2000, compaction.ts:50-51) is biased toward the tail — for bash output (where errors are at the end, tail is good) but against read output (where the beginning has the file path and early content, head=400 leaves only ~276 chars of content)

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:50-51` `const TOOL_OUTPUT_HEAD_CHARS = 400; const TOOL_OUTPUT_TAIL_CHARS = 2_000;`. These are used in `truncateToolOutput` (message-v2.ts:398-406) during compaction replay: `${text.slice(0, headChars)}\n[... compaction truncated ${omitted} chars ...]\n${text.slice(text.length - tailChars)}`.
- Measured: read output metadata (before `<content>`) is median 124 chars. So head=400 leaves ~276 chars of content (first ~5-8 lines). Tail=2000 preserves the last ~30-40 lines. For a 200-line read, the middle ~150 lines are lost.
- The comment at compaction.ts:46-49 explains: "head=400 保 shell 头部的截断 notice (path 属性排在 guidance 前)；tail=2000 保 tool 末尾的截断 notice 完整含 path" — the head/tail split is designed to preserve the truncation notices (which contain the file path), not the content.

### Why it is a design gap
1. **Tail-biased for read.** Read output's most useful part (the beginning — file path, outline, first lines of content) gets only 400 chars (minus 124 for metadata = 276 chars of content). The tail (last 2000 chars) preserves the end of the file, which is often less important (implementation details vs. type definitions at the top).
2. **Designed for notices, not content.** The head/tail split was designed to preserve the truncation notice's path attribute (head=400) and the tail notice (tail=2000), not to preserve content. The actual file content is treated as expendable middle.
3. **No content-awareness.** The truncation doesn't know whether the output is a read (content is valuable throughout), a bash typecheck (errors are at the end, tail is good), or a grep (results are throughout). It applies the same 400/2000 split to all tool types.
4. **Compounding with Finding 55.** After pruning (Finding 55), the remaining read outputs are truncated to 400+2000 chars during compaction replay. The model sees only the first ~5 lines and last ~35 lines of a 200-line read — the middle 80% is lost to the "[... compaction truncated ...]" notice.

### Verification design
Make the head/tail split content-aware: for read outputs, use a larger head (e.g. 1000 chars) to preserve the file path + outline + first content lines. For bash outputs, keep the current tail-heavy split (errors at the end). For grep outputs, use a balanced split (results throughout). Measure: post-compaction re-read rate for files whose read outputs were truncated; model's ability to reference mid-file content after compaction. Expected: re-read rate drops; mid-file reference accuracy improves.

---

## Confirmed Finding 64: the `preserveRecentUserBudget` (compaction.ts:193-198) caps the recent-user memento at min(20000, 20% of usable window) — for small-context models, 20% may be too small to preserve the user's latest multi-paragraph instruction, and the memento is the ONLY deterministic preservation of user intent

### Evidence chain
- Source: `packages/opencode/src/session/compaction.ts:193-198` `function preserveRecentUserBudget(input) { return Math.min(DEFAULT_PRESERVE_RECENT_USER_TOKENS, Math.max(0, Math.floor(usable(input) * PRESERVE_RECENT_USER_RATIO))) }` where `DEFAULT_PRESERVE_RECENT_USER_TOKENS = 20_000` (line 65) and `PRESERVE_RECENT_USER_RATIO = 0.2` (line 66).
- `usable(input)` (overflow.ts:9-20) = `model.limit.input - reserved` or `context - maxOutputTokens`. For a model with 8K usable (small model), 20% = 1.6K tokens ≈ 6K chars. For a model with 128K usable, 20% = 25.6K tokens (capped at 20K).
- The memento (compaction.ts:200-232 `collectRecentUserMessages`) preserves recent user messages within the budget. It is the ONLY deterministic (non-LLM-generated) preservation of user intent across compaction — the summary is LLM-generated and lossy (Finding 14).

### Why it is a design gap
1. **Too small for small models.** For a model with 8K usable tokens, the memento budget is 1.6K tokens (~6K chars). A single complex user instruction (with file paths, constraints, code examples) can easily exceed 6K chars. The memento would truncate it, losing critical constraints.
2. **The only deterministic user-intent preservation.** The Evidence Handoff preserves files/commands/todos (compaction.ts:574-578), but NOT user messages. The summary's "User Constraints & Preferences" section is LLM-generated (lossy, Finding 14). The memento is the ONLY mechanism that preserves user messages verbatim (within the budget). If the budget is too small, user intent is lost.
3. **20% is arbitrary.** The 20% ratio is not based on any analysis of typical user-instruction size. For most sessions, user instructions are a small fraction of the context, so 20% should be enough. But for sessions with long paste content or detailed specifications, 20% may be insufficient.
4. **Binary search truncation.** The memento truncation (compaction.ts:234-258 `truncateRecentUserMessage`) uses binary search to fit within the budget, adding "...[truncated for compaction memento]" (line 80). The truncation preserves the BEGINNING of the message, losing the end. If the user's most important instruction is at the end (e.g., "and most importantly, don't forget to..."), it's lost.

### Verification design
(1) Raise the minimum memento budget to 4K tokens (matching MIN_PRESERVE_RECENT_TOKENS) so small-context models get at least 4K tokens for user intent. (2) For the truncation, preserve both the beginning AND end of the user message (head + tail with "[...truncated...]" in the middle), not just the beginning. (3) Track memento-truncation rate (how often user messages are truncated) as a quality metric. Measure: memento-truncation rate before/after; post-compaction user-constraint adherence. Expected: truncation rate drops; the model follows user constraints more consistently after compaction.

---



# Final Inspected Registry

## Database
- **Tables inspected:** all 18 (schema + row counts + JSON sampling + relationship mapping).
- **Schema relationships confirmed:** session ← message ← part (tool calls/results co-located in `tool` part `state`); session.parent_id = fork/subagent; session_message = agent/model-switch events; request_usage = per-request accounting; todo = per-session todo list.
- **Sessions indexed:** 816 (candidate tables: tool-count, repeated-read, repeated-grep, repeated-bash, error-density, confusion-signal, step-count, cost).
- **Sessions deep-dived:** 6 full replays (ses_154d8b795 content_main.js x130; ses_138a727b0 merge-conflict resolution; ses_2514c6924 bun-install confusion; ses_1e1b63618 deploy.ps1 loop; ses_1f967ce54 grep @?/session; ses_0f36d18cc contradictory binary search).
- **Message-neighborhood windows replayed:** 40+ (specific event neighborhoods across the 6 deep-dive sessions + error/correction/loop neighborhoods).
- **Candidate events scanned:** 50+ (repeated reads, repeated greps, repeated bash, user corrections, confusion signals, typecheck loops, blind edits, consecutive errors, parallel tool calls, editor injections).
- **Confusion-signal sweep:** 71449 text/reasoning parts scanned; 161 "weird", 226 "stuck", 1826 "loop", 709 "confus", 997 confusion events in non-audit sessions (after filtering audit-session self-references).

## Source
- **Files read (current repo, read-only):**
  - `tool/read.ts` (197-339, 348-426, 660-696) — read dedup, stub, overlap-note, outline, binary detection
  - `tool/shell.ts` (1-120, 940-1034) — bash pipe-stdio, timeout race, "(no output)", output handling
  - `tool/edit.ts` (677-714) — 9 fuzzy replacers, generic not-found error
  - `tool/apply_patch.ts` (1-90, 95-194, 282-309) — hunk loop, all-or-nothing, LSP diagnostics
  - `tool/grep.ts` (14, 118, 171-191) — RESULT_LIMIT=64, no total count, no dedup
  - `tool/glob.ts` (full) — limit=100, mtime sort, per-file stat
  - `tool/write.ts` (1-125) — full-content input, auto-format, LSP diagnostics
  - `tool/task.ts` (1-230) — subagent session creation, no read-state inheritance, background gated
  - `tool/todo.ts` (full) — stateless setter, no age tracking
  - `tool/skill.ts` (via grep) — no load dedup
  - `tool/truncate.ts` (full) — MAX_LINES=1000, MAX_BYTES=16KB, head/tail truncation
  - `tool/bash-compress.ts` (1-130, 660-676) — compression strategies, quotePattern bug
  - `tool/selection.ts` (full) — permission-based tool disabling
  - `tool/invalid.ts` (via grep) — unavailable-tool response
  - `tool/read-outline.ts` (1-60) — MIN_LINES=600, MAX_SCAN_LINES=3000, per-read-range
  - `session/compaction.ts` (1-200, 200-320, 395-505, 562-730, 760-810) — summary template, Evidence Handoff, pruning, splitTurn, preserveRecentUserBudget
  - `session/overflow.ts` (full) — isOverflow, usable
  - `session/processor.ts` (420-500, 785-830) — doom_loop detector, tool-call dispatch
  - `session/prompt.ts` (1-100, 140-170, 581-730, 2080-2110) — context assembly, insertReminders, maxSteps
  - `session/system.ts` (1-250) — provider prompts, toolUsageSection, verificationSection, contextContinuitySection
  - `session/message-v2.ts` (394-428, 820-900, 958-1075) — toModelOutput, truncateToolOutput, differentModel, compacted-part handling
  - `session/instruction.ts` (1-240) — AGENTS.md injection, extract
  - `session/retry.ts` (1-80) — exponential backoff, RETRY_MAX_DELAY
  - `session/retry-constants.ts` (full) — GO_UPSELL_MESSAGE
  - `session/title.ts` (full) — default title generation
  - `session/run-state.ts` (1-60) — runner management
  - `session/llm.ts` (1-60) — streamText, OUTPUT_TOKEN_MAX
  - `session/summary.ts` (1-60) — session summary
  - `agent/agent.ts` (1-280) — agent configurations (build, auto, decide, plan, general, explore, permission-reviewer)
  - `agent/subagent-permissions.ts` (1-60) — deriveSubagentSessionPermission
  - `permission/precheck.ts` (1-80) — shell command heuristic classifier
  - `provider/transform.ts` (1260-1290) — maxOutputTokens, OUTPUT_TOKEN_MAX=32000
  - `reference/reference.ts` (1-60) — reference resolution
  - `file/watcher.ts` (1-60) — @parcel/watcher, bus events
  - `format/formatter.ts` (1-80) — prettier/gofmt/mix formatters
  - `snapshot/index.ts` (1-50) — git-based snapshots
  - `util/output-notice.ts` (full) — formatCompactionClearedNotice, formatOutputTruncatedNotice
  - `lsp/lsp.ts` (1-60) — LSP client
  - `cli/cmd/tui/component/prompt/index.tsx` (120-149) — formatEditorContext
  - Prompt files: `max-steps.txt`, `build-switch.txt`

- **Mechanisms confirmed:** read dedup (collectVisibleReads/findReadStub/findOverlapNote), compaction (summary template, Evidence Handoff, pruning, splitTurn, preserveRecentUserBudget), doom_loop detector, bash pipe-stdio + timeout, edit 9-replacer chain, apply_patch all-or-nothing, grep RESULT_LIMIT=64, glob limit=100 + mtime stat, write auto-format, task subagent creation, todo stateless setter, skill no-dedup, truncate head/tail, bash-compress quotePattern, tool selection permission-based, read-outline per-read-range, message-v2 tool-input persistence + compacted-part handling, instruction AGENTS.md injection, retry backoff, agent configurations, subagent permission derivation, precheck classifier, maxOutputTokens, reference resolution, file watcher, formatter, snapshot, output-notice, LSP client, TUI editor-context injection.

## Confirmed Findings Count (Final)
- **Measurements:** 2 (schema map, candidate session index)
- **Confirmed Findings:** 64
  - Tool mechanism gaps: 15 (read dedup, bash timeout, edit diagnostic, apply_patch diagnostic, grep cap, glob cap, write content doubling, apply_patch all-or-nothing, read outline, auto-format, skill reload, binary file rejection, JS bug, offset=0, notebook cellId)
  - Context/memory gaps: 8 (Evidence Handoff excludes search, compaction summary lossy, compaction cumulative loss, reasoning persistence, PRUNE_PROTECTED_TOOLS, splitTurn error-skip, previous-summary compounding, preserveRecentUserBudget)
  - Loop/prevention gaps: 5 (doom_loop narrow, semantic loops, typecheck re-run, loop layers too narrow, offset=0)
  - Permission/flow gaps: 4 (disabled tools no substitute, model switching, permission-reviewer context, LSP never fires)
  - Agent/subagent gaps: 5 (subagent no read inheritance, task result truncation, empty results, no background mode, subagent compounding)
  - Verification/error gaps: 5 (no verification gate, error non-acknowledgment, consecutive errors, typecheck errors ignored, error diagnostics non-actionable)
  - Context consumption: 3 (consumption breakdown, pervasive re-reads, compaction truncation bias)
  - Tool bypass: 3 (no git tool, Select-String, inline scripts)
  - Editor/UI: 2 (editor-context injection 0% action, Unix-in-PowerShell)
  - Behavioral: 5 (todo abandonment, user corrections not persisted, batching 27%, blind edits, grep regex errors)
  - Cross-cutting: 4 (silent feedback gaps, tool bypass pattern, loop layers, subagent compounding)
- **Excluded candidates:** 
  - "deploy.ps1 x702 loop" excluded: local-context replay showed legitimate iterative development with deployment timeouts, not a harness loop.
  - "rtk git status x89 repetition" excluded: local-context replay showed legitimate periodic checking between work chunks, not a loop.
  - "Compaction breaks read-dedup as primary cause" excluded (Finding 1): 0 of 130 content_main.js reads were exact-same-range-compacted-away; the dominant gap is partial-overlap threshold, not compaction.
  - "Tool errors have empty output" excluded: error messages live in `state.error`, not `state.output`; all 1625 errors carry diagnostics.
  - "176 identical bun -e calls" excluded: normalization artifact — 586 unique commands, max repeat x4.
  - "16K-token error" excluded: 0 occurrences in historical data.
  - "Concurrent edits to same file cause errors" excluded: 0 errors in 85 concurrent-edit pairs.

## Investigation Coverage
- **Time span:** 2026-04-21 → 2026-06-28 (68 days)
- **Sessions:** 816 total, 767 with tool parts
- **Messages:** 67,135
- **Parts:** 298,900 (94,164 tool, 58,865 step-start, 57,654 step-finish, 48,938 reasoning, 34,075 text, 4,836 patch, 316 compaction)
- **Tool calls analyzed:** 94,164 (all tool parts parsed for input/output/status/error)
- **Source files read:** 40+ (listed above)
- **Source mechanisms confirmed:** 30+ (listed above)
- **Message-neighborhood windows replayed:** 40+
- **Candidate events scanned:** 50+
- **Excluded candidates documented:** 7 (with reasons)

---

已完成只读深度分析，所有已确认发现已追加到：
F:\ML\PythonAIProject\Claude-Code\opencode\docs\opencode-glm-agent-workflow-forensic-report.md

本次没有修改数据库或源码。

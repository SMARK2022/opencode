# PR #5: minimal-scope hunk audit

Status: keep open; do not merge. This replaces the previous broad recovery plan.
Audit baseline: `8565ca09986c2eea4ad7610dc1fb393b57990bd4`.
Original reviewed head: `7c9edf882`.
Final squash parent: `f37e94dd26d3e179add3b4adadc5cb4d0d70f4ea` (`dev1-smark` at this revision); existing target-branch fixes are preserved.
A second independent review covered all 24 remaining zero-context hunks. No further behavioral changes were needed; only the read budget comment was synchronized.

## User requirements used as evidence

- Q1: “是逻辑或者harness才用修”；“模型的问题不管”；“不需要修的请不要碰”；“不要过度修改请注意着点”。
- Q2: “按理来说 grid 的 timeout 是应该有的呀”；“就比如说它只搜到了六十四条，OK，那就正常把这六十四条做一个列表传到后面不就 OK 了吗？”
- Q3: “就比如说你这种 grip，你的 json 过长，超过 64KB能算长吗？不算长，不应该报错。”
- Q4: “里面应该有发生过 execute 的相关很多错误，结合相关的错误自己去看一看相关的问题。”
- Q5: “然后包括什么这种并行 execute 失败回执啊，巴拉巴拉，什么把成功调用正文交给模型啊，巴拉巴拉。”
- Q6: “你的修改要适当考虑避免把这些什么这种常量去写在硬编码的这个主逻辑里面”。
- Q7: “long module output is saved to a readable file” / “它自己又不会保存” / “用户没让你做的事情不得改”。

Q1/Q4 authorize investigation and actual harness fixes, not arbitrary cleanup. The
read/shell corrections below are implementation-level consequences of that scope,
not claims that the user explicitly dictated those exact lines. Model-generated
invalid JSON is not repaired or automatically retried.

## Final production scope

The original minimal data-path fixes touch three production files (the later authorized JS support is listed separately below):

1. `core/src/ripgrep.ts`: accept a valid record above 64 KiB. Restore all other
   search budgets and preview limits. Removing MAX_RECORD_BYTES removes its
   rejection rule; the number is not embedded elsewhere.
2. `core/src/tool/read-lines.ts`: allow the first complete line despite output
   budget, so read pagination progresses rather than returning empty data.
   This is a deliberate first-line exception, not a strict per-read byte bound;
   subsequent-line and auxiliary-read budgets remain unchanged.
3. `opencode/src/tool/shell.ts`: separate actual process text from display-only
   execution notices in the programmatic content field.

Grep's 64-result cap, default 10-second timeout, maximum 120-second timeout,
5,000-file cap, native 1,000-result default, 100-submatch cap and 2,000-character
preview are restored. The altered grep description is fully restored, including
removal of the new file-storage promise. No claim is made that grep itself writes
that file. No new error is introduced merely because search is partial.

`MAX_VALUE_DEPTH`, `MAX_CONSOLE_DEPTH`, and the existing 64 KiB console log budget
are restored, not replaced by literals. All codemode interpreter, console,
serialization, diagnostics, and error-media changes are withdrawn.

The questioned “77 lines” were aggregate additions in
`packages/codemode/test/codemode.test.ts`, not one necessary test. All additions
in that file are withdrawn because their production changes are withdrawn.
Only tests for the three remaining fixes and a small failure-output regression assertion survive.

## Latest failure-output correction

The user clarified: “它失败了，那就是既有的输出的这个完整的缓冲区的一些内容直接去返回给模型不就 OK 了吗？然后顺带附上一个结果错误的一个 error 消息就 OK 了。” and “本身如果模型没有让它去显示，没有去 display 的东西，应该也不用去 display 啊。”

This supersedes Q5: the automatic completed-child text/path insertion is withdrawn in full. The original session failure implementation is restored. Existing output-buffer/error handling and its storage budget remain unchanged. The parallel recovery test and its budget/abort assertion changes are withdrawn. One existing error-output test now also reads an undisplayed file and verifies that its body is absent while the displayed log and error remain recoverable. This correction itself does not change JS language features; subsequent explicit authorization is recorded below.

## Every original hunk

Rows refer to the original PR diff, not the rollback commit diff. Restored rows
have no net change from the baseline. Test restoration includes snapshot/schema
changes paired with restored production behavior.

| # | Original file and range | Decision and necessity |
|---|---|---|
| 1 | `docs/plans/execute-result-recovery.md` `-0,0 +1,139` | 重写为本逐 hunk 审计；撤回原扩大范围的计划。Q1/Q7。 |
| 2 | `packages/codemode/src/codemode.ts` `-189,12 +189,12` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 3 | `packages/codemode/src/interpreter/runtime.ts` `-56,7 +56,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 4 | `packages/codemode/src/interpreter/runtime.ts` `-2090,7 +2090,8` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 5 | `packages/codemode/src/interpreter/runtime.ts` `-2105,16 +2106,16` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 6 | `packages/codemode/src/interpreter/runtime.ts` `-2126,13 +2127,12` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 7 | `packages/codemode/src/interpreter/runtime.ts` `-2140,7 +2140,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 8 | `packages/codemode/src/interpreter/runtime.ts` `-2149,10 +2149,10` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 9 | `packages/codemode/src/interpreter/runtime.ts` `-2207,7 +2207,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 10 | `packages/codemode/src/interpreter/runtime.ts` `-3187,7 +3187,11` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 11 | `packages/codemode/src/stdlib/console.ts` `-1,4 +1` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 12 | `packages/codemode/src/tool-runtime.ts` `-137,13 +137,6` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 13 | `packages/codemode/src/tool-runtime.ts` `-177,7 +170,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 14 | `packages/codemode/src/tool-runtime.ts` `-192,18 +185,10` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 15 | `packages/codemode/src/tool-runtime.ts` `-252,13 +237,13` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 16 | `packages/codemode/src/tool-runtime.ts` `-296,7 +281,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 17 | `packages/codemode/src/tool-runtime.ts` `-312,7 +297,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 18 | `packages/codemode/test/codemode.test.ts` `-1911,7 +1911,36` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 19 | `packages/codemode/test/codemode.test.ts` `-1919,8 +1948,6` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 20 | `packages/codemode/test/codemode.test.ts` `-2820,3 +2847,50` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 21 | `packages/core/src/ripgrep.ts` `-18,14 +18,6` | 仅删除 MAX_RECORD_BYTES；其他常量恢复。Q3。 |
| 22 | `packages/core/src/ripgrep.ts` `-309,8 +301,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 23 | `packages/core/src/ripgrep.ts` `-347,11 +339,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 24 | `packages/core/src/ripgrep.ts` `-364,13 +353,11` | 删除合法 JSON 记录的 64 KiB 硬拒绝；保留 JSON/schema 校验。Q3。 |
| 25 | `packages/core/src/ripgrep.ts` `-378,7 +365,6` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 26 | `packages/core/src/ripgrep.ts` `-399,10 +385,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 27 | `packages/core/src/tool/grep.ts` `-16,10 +16,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 28 | `packages/core/src/tool/grep.ts` `-36,10 +34,10` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 29 | `packages/core/src/tool/grep.ts` `-55,7 +53,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 30 | `packages/core/src/tool/grep.ts` `-130,17 +128,17` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 31 | `packages/core/src/tool/read-lines.ts` `-146,8 +146,8` | 首行超过预算仍返回完整首行，避免 nextOffset 不前进。Q1/Q4。 |
| 32 | `packages/core/src/tool/read-lines.ts` `-175,7 +175,7` | 同上，字节预算路径。Q1/Q4。 |
| 33 | `packages/core/test/ripgrep.test.ts` `-24,7 +24,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 34 | `packages/core/test/ripgrep.test.ts` `-76,32 +76,32` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 35 | `packages/core/test/ripgrep.test.ts` `-145,6 +145,26` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 36 | `packages/core/test/ripgrep.test.ts` `-176,14 +196,13` | 改成 16 行定向测试：70 KiB 记录前、中、后三个匹配均返回。Q3。 |
| 37 | `packages/core/test/ripgrep.test.ts` `-191,7 +210,9` | 随上述定向测试收缩；不再要求无限子匹配或完整超长预览。Q2/Q3。 |
| 38 | `packages/core/test/ripgrep.test.ts` `-422,8 +443,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 39 | `packages/core/test/tool-read-filesystem.test.ts` `-45,10 +45,10` | 验证超长首行实际返回，而非空结果。Q1/Q4。 |
| 40 | `packages/opencode/src/session/message-v2.ts` `-844,7 +844,16` | 撤回失败父回执的媒体投影扩展；成功正文恢复不需要它。Q1/Q5。 |
| 41 | `packages/opencode/src/session/tools.ts` `-199,6 +199,8` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 42 | `packages/opencode/src/session/tools.ts` `-219,10 +221,12` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 43 | `packages/opencode/src/session/tools.ts` `-352,8 +356,14` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 44 | `packages/opencode/src/tool/code-mode.ts` `-236,7 +236,7` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 45 | `packages/opencode/src/tool/code-mode.ts` `-289,7 +289,8` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 46 | `packages/opencode/src/tool/grep.ts` `-11,14 +11,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 47 | `packages/opencode/src/tool/grep.ts` `-36,10 +30,10` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 48 | `packages/opencode/src/tool/grep.ts` `-69,7 +63,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 49 | `packages/opencode/src/tool/grep.ts` `-107,16 +101,14` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 50 | `packages/opencode/src/tool/grep.ts` `-135,11 +127,10` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 51 | `packages/opencode/src/tool/grep.ts` `-155,7 +146,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 52 | `packages/opencode/src/tool/grep.ts` `-173,42 +164,16` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 53 | `packages/opencode/src/tool/grep.ts` `-217,13 +182,6` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 54 | `packages/opencode/src/tool/grep.ts` `-242,22 +200,21` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 55 | `packages/opencode/src/tool/grep.txt` `-1,11 +1,11` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 56 | `packages/opencode/src/tool/shell.ts` `-810,7 +810,7` | program.value.content 使用 end.text；执行状态提示仅留在展示输出。Q1/Q4。 |
| 57 | `packages/opencode/test/session/execute.test.ts` `-883,6 +883,8` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 58 | `packages/opencode/test/session/execute.test.ts` `-1005,6 +1007,35` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 59 | `packages/opencode/test/session/execute.test.ts` `-1035,7 +1066,8` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 60 | `packages/opencode/test/session/execute.test.ts` `-1073,6 +1105,8` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 61 | `packages/opencode/test/session/execute.test.ts` `-1085,6 +1119,7` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 62 | `packages/opencode/test/session/execute.test.ts` `-1097,6 +1132,73` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 63 | `packages/opencode/test/session/execute.test.ts` `-2269,7 +2371,7` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 64 | `packages/opencode/test/session/execute.test.ts` `-2282,7 +2384,7` | 撤回额外 response/media/无限输出收集及相关测试；超出完成正文恢复。Q1/Q5。 |
| 65 | `packages/opencode/test/session/execute.test.ts` `-2339,7 +2441,9` | 根据用户最新输出/display纠正撤回，恢复基线。原成功child正文恢复要求已被取代；不再注入未显示内容。 |
| 66 | `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` `-154,9 +154,9` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 67 | `packages/opencode/test/tool/code-mode.test.ts` `-715,6 +715,9` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 68 | `packages/opencode/test/tool/code-mode.test.ts` `-1486,6 +1489,20` | 恢复原行为/测试；无当前故障证据支持深度、日志预算或诊断扩展。Q1/Q6。 |
| 69 | `packages/opencode/test/tool/grep.test.ts` `-4,7 +4,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 70 | `packages/opencode/test/tool/grep.test.ts` `-232,10 +232,11` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 71 | `packages/opencode/test/tool/grep.test.ts` `-286,8 +287,9` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 72 | `packages/opencode/test/tool/grep.test.ts` `-309,7 +311,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 73 | `packages/opencode/test/tool/grep.test.ts` `-323,7 +325,8` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 74 | `packages/opencode/test/tool/grep.test.ts` `-353,7 +356,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 75 | `packages/opencode/test/tool/grep.test.ts` `-411,12 +414,11` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 76 | `packages/opencode/test/tool/grep.test.ts` `-427,11 +429,16` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 77 | `packages/opencode/test/tool/grep.test.ts` `-473,7 +480,7` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 78 | `packages/opencode/test/tool/grep.test.ts` `-560,9 +567,10` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 79 | `packages/opencode/test/tool/parameters.test.ts` `-211,11 +211,15` | 恢复原行为/测试；默认 timeout、结果上限及部分结果已有契约不应改变。Q2/Q6/Q7。 |
| 80 | `packages/opencode/test/tool/read.test.ts` `-433,11 +433,11` | 测试先返回完整超长首行、下一页从下一行继续。Q1/Q4。 |
| 81 | `packages/opencode/test/tool/read.test.ts` `-601,28 +601,25` | 同上，撤回旧的空首行/不前进预期。Q1/Q4。 |
| 82 | `packages/opencode/test/tool/shell.test.ts` `-2651,6 +2651,7` | 验证空 shell 输出不会把状态提示作为程序数据。Q1/Q4。 |
| 83 | `packages/opencode/test/tool/shell.test.ts` `-2696,6 +2697,7` | 验证非零退出状态提示不混入程序 content。Q1/Q4。 |

## Subsequently authorized JS support

The user then explicitly requested support instead of unnecessary rejection: “你直接把你自己的东西做支持，做支持好不就 OK 了吗？” and “所以这些东西你都去做吧，OK。” The agreed scope is built-in callbacks, Array construction, and Array.from mapping.

- Reuse the existing restricted callable dispatcher for supported built-in callbacks, including collection, promise, sort and replacement paths. No arbitrary host functions or new tool-call permissions. Sparse-array skip branches yield through the existing Effect scheduler so timeout/cancellation remains effective, without a new size cap.
- Share Array(...) and new Array(...) construction, including sparse numeric-length arrays. Existing array operations skip/preserve holes where JS requires it.
- Run Array.from mappers through that same interpreter callback path, with value/index arguments. No new thisArg binding framework.
- Math fixed-arity methods ignore callback index/array extras and use the existing safe numeric coercion.
- Update the existing supported-syntax statement and remove outdated mapper/arrow-only rejection messages; add no new prompt constraints.
- Three orthogonal tests cover the supported combinations; one small parameterized test verifies existing timeouts still interrupt sparse-array scans; remove the obsolete assertion requiring map(Math.abs) to fail while retaining sleep-property isolation coverage.

These are additional authorized capability changes, not a revival of the withdrawn output/log/depth/grep-budget changes.

## Requested execution limits and CI reconciliation

The user subsequently requested a tool-call limit of 1024 and an appropriate loop-iteration limit. Execute now uses named shared policy constants for 1,024 tool calls and 100,000 total explicit loop-body entries per execution. Nested loops, function calls and async frames share each root budget; a later Execute gets a fresh budget. The library option remains optional, existing concurrent tool admission and timeout ownership remain unchanged, and permission preflight uses the same policy with its own execution counter.

The failed CI run tested merge base `8b6f0f3`. The updated target already fixes the compaction interruption, daemon maintenance fixtures, SSE overflow fixture and message-pagination failures in `9f911f0`. Reapplying this PR to the current target preserves those fixes rather than duplicating them. All 12 previously failing targeted cases pass locally, and the full Cookie-response file passes 63 tests (5 skipped); its earlier extra-request failure did not reproduce, so neither product logic nor assertion semantics were changed speculatively.

### Follow-up CI failures on `33501508`

The user requested investigation and repair of the remaining PR failures. That head completed 28 checks successfully, including typecheck; three platform jobs failed. No Execute budget/callback test failed.

- README: target commit `f37e94dd` intentionally restored the dev README layout, while its existing test still required obsolete alert markers before the screenshot. Update only that test to check the current migration/branch notices before installation, including the database filename and release identity. Do not revert the target README or alter its content.
- Repository-tool contract test: importing through the repository `.opencode` directory allowed unrelated background dependency installation to race with loading Zod. Isolate the fixture's dependency resolution while still executing the real repository tool code and retaining its business-contract assertions.
- Voice Cookie fixture: the process-global endpoint-status monitor continues background origin HEAD probes for its existing active window. A Linux log captured an unrelated loopback origin alongside the two expected transcription requests. Isolate the voice fixture's asynchronous request chain rather than filtering by destination or changing production retry/cache behavior; calls made inside the tested chain must still be recorded regardless of URL.

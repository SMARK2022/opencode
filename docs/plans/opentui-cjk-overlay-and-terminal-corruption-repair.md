# Canonical Implementation Plan: OpenTUI CJK Overlay and Terminal Corruption Repair

> Status: implementation-audit-required
>
> Revision: R16
>
> Approved revision: R16
>
> Audit mode: implementation (full-scope)
>
> Requirement source: 用户要求完整检查 OpenTUI 处理 CJK 字符在半透明遮罩下显示不完整的问题，以及 OpenTUI/终端增量渲染导致缓冲区破碎的问题；研究并实验高质量 PR，保持 OpenTUI 稳定性和鲁棒性，完成相应合入、验证和提交。
>
> Implementation allowed: yes
>
> Last updated: 2026-07-21

本文是本任务唯一 implementation authority。当前只允许按本 revision 进行独立方案审计，禁止在 approval 前修改 production、tests、configuration、generated files 或 release artifacts。

## 1. Verbatim Requirement

> 请完整检查openTUI相关处理CJK字符在半透明遮罩下显示不完全的问题；以及完整检查openTUI内部导致终端缓冲区发生破碎的完整问题以及高质量pr修复，以进行实验与相应的合入（question用户）；保持整体openTUI项目的稳定性与鲁棒性，避免出现新的问题或回归。

## 2. Explicit Non-Goals

- 不把 OpenTUI `thirdparty/opentui` 源码作为正常 OpenCode consumer fallback；consumer 继续只使用 immutable release package family。
- 不把 `0.4.4` 或 `0.4.5` 的无关升级与 overlay 修复混在同一个 repair revision 中。
- 不直接 cherry-pick OpenTUI #791；当前 `0.4.3` 基线与 PR head 已发生 API 和 native renderer 冲突。
- 不合入 OpenTUI #839；它与 #791 表达竞争的 overlay 语义，且原作者收到过维护者的错误路径反馈。
- 不把 xterm.js #6042/#6055/#5997/#5995/#3097 的代码移植进 OpenTUI；这些 PR/issue 的 owner 是 VS Code/xterm.js host terminal。
- 不把每帧 full repaint、关闭 autowrap、Dialog 改成不透明或其他未经 red-capable replay 证明的 workaround 作为生产修复。
- 不修改 `DECAWM` 或引入 full-repaint fallback。renderer restoration 沿同一 wide-glyph primary path修复，并由精确 red/green 行为测试验证。
- 不修改 VS Code 用户设置或外部 terminal 配置作为本任务的代码实现。
- 用户本轮明确要求暂不修复 VS Code integrated-terminal 中的整屏碎块现象：`这个可能属于vscode问题`、`可以先不修这个问题`。本 revision 保留现象、现有 external-owner 证据和后续诊断边界，但不把 host pixel repair 或 host capture 作为 OpenTUI implementation gate。
- 用户本轮允许创建新的 OpenTUI source revision；本 revision 必须让 source/submodule 修复可复现，但不伪造尚不存在的 `.2` package tarballs 或外部 release。
- 用户本轮确认 clipped-edge 语义：只有遮罩完整覆盖整个彩色 emoji span 时使用 `[]`；只覆盖一半的 span 保留原始 span，不能写入 scissor 外 cell。
- 不覆盖、回退或清理工作树中与本任务无关的既有修改。
- 不在没有用户确认 emoji 遮罩策略时，把“保留全亮彩色 emoji”和“宽度稳定 placeholder”两种语义同时实现为竞争路径。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 测试从 package directory 运行；使用 Bun；保留无关 dirty worktree；native 代码需按 OpenTUI 指南构建。 |
| `CONTEXT.md` | 使用 `Project`、`Session`、`Message`、`Goal` 等仓库术语；TUI 位于 `packages/opencode/src/cli/cmd/tui`。 |
| `packages/opencode/AGENTS.md` | OpenCode 使用 Bun/ESM；测试和 typecheck 必须在 package 目录执行；不改变 module shape。 |
| `packages/opencode/test/AGENTS.md` | PTY/TUI readiness 必须使用行为信号，不能使用固定 sleep 猜 mount 完成。 |
| `thirdparty/opentui/AGENTS.md` | native 变更须运行 OpenTUI build/native tests；优先通过真实 renderer seam 验证。 |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；禁止 fallback、竞争成功路径和 speculative production guard。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须完整记录 evidence、reachability、owner、TDD、verification、diff、comment budget 和 audit contract。 |
| `docs/adr/README.md` | 当前 accepted ADR 不约束 TUI compositor 或 terminal rendering。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `package.json:39-41,130-141` 和 `bun.lock:712-722,1619-1640` | OpenCode consumer 固定到 SMARK `0.4.3-smark.1` 的 11 个 release tarball。 | observed |
| `thirdparty/opentui` gitlink `cbe492a538137842961d561c33f55fdb7587b40e` | source provenance 与 `v0.4.3-smark.1` annotated tag 相同。 | observed |
| `packages/opencode/script/verify-opentui-closure.ts` | 当前 closure、package identity、Solid identity、native hash 的 owner。 | observed |
| `packages/opencode/test/script/opentui-provenance.test.ts`、`upgrade-opentui.test.ts` | release tag 与 package family 的行为测试。 | observed |
| question tool decision record, current user confirmation | 用户明确选择 `采用 [] placeholder（推荐）`；本 revision 将其作为 color-emoji overlay 的唯一可见策略。 | contracted |
| 当前活动进程映射的 dylib SHA-256 `5610edd4...cfd2f6` | 证明实际运行 native OpenTUI 是当前 `0.4.3-smark.1`，排除旧 `0.3.4` 二进制。 | observed |
| `packages/opencode/src/cli/cmd/tui/ui/dialog.tsx:40-48` | OpenCode 全屏 `RGBA(0,0,0,150)` overlay producer。 | observed |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig:743-831,921-978` | alpha compositor 只保留 width-1 destination，wide CJK 被空格替换并触发 span cleanup。 | observed |
| `thirdparty/opentui/packages/core/src/zig/renderer.zig:1341-1458` | incremental diff、dirty run、CUP、continuation cell、current buffer sync owner。 | observed |
| `thirdparty/opentui/packages/core/src/zig/renderer-output.zig:342-429` and `renderer_test.zig:810-856,2489-2554` | existing `BufferedBackend` growth, truncated-frame rejection, threaded skip, allocation-failure and next-frame recovery contract; this task must preserve it. | observed |
| isolated Zig `0.15.2` renderer probe against the current source tree | `emoji -> []` frame-2 output had `frame2-len=82`, emitted `[]` directly at the replacement position, and contained no `ESC[1;2H  ` two-cell preclear; the probe failed on that exact assertion. | observed red |
| `thirdparty/opentui/packages/core/src/zig/text-buffer-view.zig` fork diff | 当前 SMARK CJK patch 只处理 Markdown wrap byte/column consumption。 | observed |
| 只读 `bun -e` buffer probe | `A中B` 在半透明 fill 后变成 `A  B`，20/20 deterministic failure。 | observed |
| `bun run script/verify-opentui-closure.ts` | 当前 11 package closure 和 native/solid identity 通过。 | observed |
| `bun test test/script/opentui-provenance.test.ts test/script/upgrade-opentui.test.ts` | 当前两个 provenance/upgrade tests 通过。 | observed |
| OpenTUI #791 | wide grapheme span、emoji placeholder、renderer preclear、Box clipping 和 framebuffer regression 参考实现。 | observed / external |
| OpenTUI #839 | 较小的 continuation redraw 方案，维护者反馈表明其路径不足。 | observed / external |
| OpenTUI #845 | 当前 fork 已携带的 Markdown CJK wrap 修复。 | observed / external |
| OpenTUI #1224 | upstream `v0.4.3` 已携带的 output buffer grow/stale-cell 修复。 | observed / external |
| xterm.js #6042、#6055、VS Code #288682、#322756 | VS Code WebGL shared atlas 的外部 owner、状态和环境匹配证据。 | observed / external |
| VS Code `1.129.0` package metadata | 当前 host 使用 xterm `6.1.0-beta.288` 和 addon-webgl `0.20.0-beta.287`，其 source commit 早于 #6042。 | observed / external |
| `code --status` | 当前 VS Code 全局 WebGL/Metal enabled；同时存在多个 integrated PTY；terminal-specific setting 尚未读取。 | observed |

## 5. Current Behavior

### 5.1 Overlay path

```text
OpenCode Dialog
  -> full-screen Box backgroundColor RGBA(0,0,0,150)
  -> BoxRenderable.drawBox
  -> OptimizedBuffer.fillRect
  -> setCellWithAlphaBlendingCell per cell
  -> blendCells
  -> width-2 CJK fails preserveChar
  -> space overwrites grapheme span
  -> underlying CJK disappears
```

### 5.2 Current OpenTUI CJK scope

The SMARK fork changes `text-buffer-view.zig` to keep UTF-8 byte offsets and display-column offsets aligned during word wrapping. That fixes a narrow Markdown wrap-boundary duplicate. It does not change `buffer.zig` alpha composition, `renderer.zig` terminal output, Box edge clipping, or framebuffer reuse.

### 5.3 Whole-screen corruption path

The current evidence supports two reachable owners and does not yet prove one:

```text
OpenTUI logical buffer / ANSI incremental output
  -> VS Code xterm parser and terminal cell model
  -> VS Code WebGL glyph atlas / GPU texture model
  -> visible terminal pixels
```

The active environment has multiple terminals and global WebGL enabled, which reaches xterm.js shared-atlas invalidation paths. OpenTUI also changes capabilities when `TERM_PROGRAM=vscode`, so the user observation is strong environment evidence but does not prove the first divergence. This host-only symptom is explicitly deferred in the current revision and is not assigned to an OpenTUI owner.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| CJK wide grapheme below translucent space fill | OpenCode Dialog and any OpenTUI Box alpha fill | grapheme tracker records start/continuation cells | Box -> fillRect -> alpha setter | OpenTUI buffer compositor | observed |
| Wide emoji below translucent fill | OpenTUI text/framebuffer content | grapheme bytes and span width are known; terminal foreground tint may not recolor color emoji | same alpha setter and framebuffer paths | OpenTUI compositor policy | reachable |
| Overlay edge intersects wide span | BoxRenderable border/fill | Box geometry and scissor are known | Box render -> native fill/border | OpenTUI Box/buffer owner | reachable |
| Old wide glyph footprint differs from next frame | renderer current/next buffers | diff cell model is authoritative only for intended state | native renderer diff loop | OpenTUI renderer | reachable, requires dedicated red case |
| shared WebGL atlas page merge or clear | multiple VS Code terminals | xterm shared atlas can mutate while sibling model is cached | VS Code/xterm WebGL | external host owner | reachable and externally reported |
| CJK reflow metadata after terminal resize | xterm BufferLine | resize/reflow must preserve combined metadata and `isWrapped` | host terminal resize | external host owner | reachable, resize-specific |
| Same binary normal outside VS Code but corrupt inside VS Code | user external-terminal comparison | application and OpenTUI package are unchanged between hosts | VS Code integrated terminal only | external host compatibility | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing/new test |
| --- | --- | --- | --- |
| INV-01 | A translucent space overlay preserves a covered width-2 CJK grapheme as a complete span and blends its style uniformly. | deterministic `A中B -> A  B` red probe; buffer source | new native buffer behavior test |
| INV-02 | A wide grapheme is updated atomically from its canonical start cell; continuation cells never become independently visible or stale during both placeholder creation and original glyph restoration. | current grapheme encoding and #791 buffer/renderer tests | new buffer and renderer seam tests |
| INV-03 | Color emoji under a translucent fill becomes exactly two width-1 ASCII cells `[` and `]` when the complete span is covered; a clipped half-span preserves the original span because the compositor cannot write outside its scissor. | user decisions and #791 clipped-span behavior | exact native full-span, clipped-edge and restoration tests |
| INV-04 | Direct Box, framebuffer Box, clipped Box and bordered Box use consistent alpha semantics and do not accumulate stale tint after rerender. | #791 scope and reachable Box callers | BoxRenderable regression tests |
| INV-05 | Existing Markdown CJK wrap behavior from #845 remains unchanged while overlay behavior is repaired. | current fork tests and release verifier | existing text-buffer/Markdown tests plus release verifier |
| INV-06 | Wide emoji placeholder creation and restoration preserve the logical and emitted terminal frame through the OpenTUI renderer diff path. | #791 `954659ad` renderer tests and current diff loop | renderer restoration red/green test |
| INV-07 | The new OpenTUI source revision and parent gitlink are reproducible, while the current OpenCode consumer remains on immutable `.1`; a future package-family transition is not part of this revision. | source gitlink plus source-aware closure verifier | source provenance, source-gitlink verification and `.1` package closure tests |
| INV-08 | The VS Code-only whole-screen pixel corruption remains explicitly deferred as a suspected external-host issue; this revision must not claim an OpenTUI fix for it. | user's explicit deferral plus same-binary external-terminal comparison | deferred issue record; no current implementation gate |
| INV-09 | `BufferedBackend` never flushes a truncated ANSI frame; a failed growth frame reports `failed`, emits zero partial bytes, and the next fitting frame recovers in both threaded and unthreaded modes. | current `renderer-output.zig` contract and named renderer tests | existing output-buffer tests rerun as a mandatory preservation gate |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `blendCells` rejects a destination glyph whose encoded width is not 1. | OpenTUI `OptimizedBuffer.blendCells` / alpha buffer interface | `destWidthIsOne` condition and 20/20 probe |
| INV-02/INV-03 | Alpha setter processes a wide span one cell at a time after the preservation decision. | OpenTUI buffer span compositor | current `fillRect` loop and span cleanup |
| INV-04 | Box has no wide-edge-aware clipped perimeter path in current baseline. | OpenTUI `BoxRenderable` and native drawBox path | current `Box.ts`; #791 production diff |
| INV-06 | The OpenTUI internal corruption repair owner is the current/next wide-glyph diff transition: the renderer currently emits the replacement without clearing the old two-cell footprint, and must pre-clear it before emitting the new placeholder or original grapheme. | current `renderer.zig` diff plus isolated Zig `0.15.2` red probe | exact current-baseline renderer test and raw output assertion |
| INV-07 | Source integration currently diverges from the immutable `.1` release by design; the parent gitlink points to the new reproducible source revision, while the source-aware verifier separately proves that package URLs, versions, integrity and native assets remain the unchanged `.1` family. | source-aware closure verifier and source gitlink | split source/release boundary |
| INV-08 | The host pixel owner is intentionally unresolved and deferred; no OpenTUI production change is authorized by this revision for that symptom. | user's explicit deferral and unavailable macOS accessibility capture | deferred external compatibility issue |
| INV-09 | Existing output-buffer failure/recovery contract is already repaired in the current baseline; the planned overlay/renderer/Box changes must not regress it. | `BufferedBackend.endFrame`, `renderer_test.zig` growth/failure/thread tests | preservation gate, not a new fallback |

### Red-Capable Feedback Loops

Overlay loop already executed:

```bash
bun -e '<OptimizedBuffer.drawText("A中B") then fillRect(RGBA.fromInts(0, 0, 0, 150)) probe>'
```

Observed output was `before: "A中B    "`, `after: "A  B    "`; 20/20 repetitions failed to preserve `中`.

OpenTUI internal renderer loop executed in an isolated copy of the current Zig source with the repository-required Zig `0.15.2`:

```bash
zig build test -Dtest-filter="probe wide emoji placeholder transition" --summary all
```

The current baseline failed because frame 2 emitted the replacement `[]` without the required `ESC[1;2H  ` preclear sequence. The temporary probe was outside the repository; no repository test or production file was modified by this diagnostic.

The whole-screen loop is retained as deferred evidence for a future host-focused revision, not as a current release prerequisite:

```text
capture raw PTY ANSI + logical xterm/headless cell frame
compare with VS Code visible frame under one and multiple terminals
repeat with WebGL enabled and terminal GPU acceleration disabled
record resize, text selection and font-change recovery
```

The user has supplied the leading host comparison: the same binary is normal outside VS Code and corrupt inside VS Code. This is retained as evidence only; the current revision does not assign its first divergence or implement a host/emitter repair.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Wide span alpha composition | OpenTUI `OptimizedBuffer` | preserve or explicitly replace a complete cell span | buffer owns grapheme cells and color blend | OpenCode only supplies Box props; it cannot repair native cell bookkeeping |
| Wide Box edge clipping | OpenTUI `BoxRenderable` plus buffer | keep visible border/perimeter geometrically stable | Box owns geometry and clipping policy | terminal host cannot infer Box edge intent |
| Wide-glyph terminal repaint | OpenTUI native renderer | pre-clear the old wide footprint before restoring or replacing a wide span | renderer owns current/next diff and output bytes | the approved renderer transition is the internal OpenTUI repair path |
| Source revision and package provenance | OpenTUI submodule gitlink plus OpenCode closure scripts | source repair is reproducible while the current `.1` consumer closure remains separately verifiable | parent gitlink owns source reproducibility; package manifests own release identity | no package transition is performed in this revision |
| WebGL shared atlas | VS Code/xterm.js | every renderer sharing mutable atlas rebuilds its model | atlas is external host state | OpenTUI cannot access VS Code WebGL texture ownership |
| Host-vs-emitter diagnosis | PTY/headless artifact harness | expose logical frame and raw output independently | harness owns observation and replay | production renderer must not include fallback diagnostics |
| Terminal output-buffer commit/recovery | OpenTUI `BufferedBackend` | never commit truncated ANSI and recover on the next frame after allocation failure | `renderer-output.zig` owns the frame byte lifecycle | overlay/Box code cannot safely recreate this commit contract |

## 10. Single Approved Primary-Path Design

### 10.1 OpenTUI overlay repair

```text
wide grapheme destination
  -> resolve canonical grapheme span
  -> apply one alpha policy to the complete span
  -> write uniform style or explicit width-preserving placeholder
  -> maintain grapheme/link trackers
  -> emit the changed span without stale continuation output
```

Port the five overlay correctness commits of #791 onto the current `0.4.3` source, preserving current #1224 identity-based child ownership and current renderer output-buffer semantics. The selected commits are `dad6aac9`, `4f4bf38e`, `954659ad`, `a6998cb5`, and `ee4bc941`. `954659ad` is the approved OpenTUI internal wide-glyph diff repair: it pre-clears the old wide footprint before emitting a changed placeholder or original grapheme. This is the same wide-glyph primary path, not a fallback. The primary path must serve direct fill, framebuffer composition, clipping, Box border cases and placeholder restoration through one coherent compositor/renderer contract.

The selected commits map to current owner symbols as follows: `dad6aac9` maps to `BlendCursor`, `blendPreservedGraphemeSpan`, and the span-aware alpha path in `zig/buffer.zig`; `4f4bf38e` maps to `classifyWideChar` and `renderPlaceholder`; `954659ad` maps to the current `CliRenderer` diff loop in `zig/renderer.zig`; `a6998cb5` maps to `fillRectClipWideGraphemes` plus its `buffer.ts`/`zig.ts`/`zig/lib.zig` FFI exports; `ee4bc941` maps to `BoxRenderable.renderSelf`, `fillPerimeterTouchesWideGrapheme`, and the clipped perimeter calls. These are the only approved production seams for the #791 port.

The user-approved visible policy is CJK/wide text preservation plus `[]` for color emoji. The implementation must make that policy explicit at the owner seam and test it independently. The authorization is recorded verbatim from the user decision: `采用 [] placeholder（推荐）`.

### 10.2 Deferred VS Code host issue

The same binary being normal outside VS Code and visually corrupted inside VS Code remains documented as an external-host hypothesis. Because macOS Accessibility permission is unavailable in the current account, this revision does not add a host capture runner, does not select `terminal.zig`/`renderer.zig`/xterm as owner, and does not claim a repair. A future revision may reopen the raw ANSI/headless/host matrix only after the user requests it and a host-frame producer is available.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| #791 span-aware compositor | proposed | primary-contract branch over supported grapheme domain | yes | primary | preserve and port |
| #791 emoji placeholder | proposed | primary-contract policy branch by wide grapheme kind | yes | primary | preserve with exact `[`/`]` cell contract and user-approved `[]` policy |
| #791 Box clipped perimeter | proposed | primary-contract geometry branch | yes | primary | preserve and port |
| #791 renderer preclear commit `954659ad` | proposed | same wide-glyph primary path for the OpenTUI internal corruption seam | yes | primary | execute as the approved renderer diff repair |
| current raw width-1 alpha preservation | current | incomplete primary path | yes | existing | replace for wide spans |
| full repaint every frame | rejected diagnostic idea | diagnostic only, not alternate success | no | 0 | reject as production behavior |
| opaque Dialog backdrop | rejected workaround | forbidden caller compensation | yes | 0 | reject |
| xterm/VS Code GPU off | external workaround | external compatibility workaround | yes | 0 | document for diagnosis, do not encode in OpenCode |
| speculative `DECAWM` disable | unproven | speculative production path | yes | 0 | reject until ANSI replay proves owner |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| None confirmed in current OpenCode Dialog | current Dialog directly uses intended translucent backdrop | owner-local OpenTUI compositor repair preserves caller semantics | no current deletion |
| Any future opaque-backdrop workaround | would hide the buffer invariant failure | span compositor repairs the native primary path | do not introduce |
| Any temporary full-repaint debug hook | useful only to classify terminal divergence | diagnostic A/B must remain outside steady-state semantics | remove after diagnosis |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| CJK survives translucent overlay | span-aware alpha compositor | `zig/buffer.zig`, `buffer.ts`, `zig.ts`, `zig/lib.zig` when clipped-fill seam requires it | native `OptimizedBuffer` fill test |
| Emoji has stable overlay output | wide-kind classifier and placeholder policy | `zig/buffer.zig` | emoji/ZWJ/flag/modifier tests |
| Box edge and framebuffer stability | clipped perimeter and reset/reuse path | `renderables/Box.ts`, `Renderable.ts`, `zig/buffer.zig` | `Box.test.ts`, native framebuffer tests |
| Wide placeholder restoration remains stable | wide-glyph renderer primary path | `zig/renderer.zig` preclear repair | renderer restoration test |
| OpenTUI internal wide-glyph corruption is repaired | renderer current/next diff seam | `zig/renderer.zig` #791 `954659ad` adaptation | exact preclear raw-output and logical-cell test |
| Existing #845 wrap remains green | current text buffer path | no semantic rollback; release verifier update only | text-buffer CJK tests and Markdown test |
| Whole-screen corruption is assigned to host compatibility | host disposition path | diagnosis record and existing headless smoke | user external-terminal comparison plus follow-up matrix |
| VS Code-only pixel corruption | deferred external-host hypothesis | no current production change; preserve the observation for a future host-enabled revision | no current implementation test; future host matrix required |
| Truncated terminal frames never reach the host | existing output-buffer contract | `renderer-output.zig` is preserved; no semantic change is approved unless a future red test proves the owner is touched | growth/failure/thread/recovery tests |
| Current consumer closure remains immutable | closure path | preserve current package versions, URLs and lock; update only the source gitlink after source-aware verification proves the `.1` package family remains unchanged | source-gitlink mode plus package provenance tests |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| canonical grapheme span resolution | INV-01/02 | current tracker and deterministic red probe | current cell-local setter erases continuation spans |
| emoji classification | INV-03 | #791 behavior and terminal color emoji limitation | generic width check cannot distinguish tintable text from color emoji |
| clipped Box perimeter | INV-04 | #791 Box regression scope | current `drawBox` fill has no wide-edge-aware perimeter decision |
| clipped-fill native/TypeScript seam | INV-04 | selected #791 `a6998cb5` changes `buffer.ts`, `zig.ts`, `zig/lib.zig` and Box routing | current Box path cannot express the required wide-edge clipped operation |
| placeholder restoration renderer path | INV-02/06 | selected #791 `954659ad` renderer tests and current diff seam | renderer must emit the preclear and restore exact logical wide span |
| host compatibility disposition | INV-06/08 | user external-terminal comparison and xterm/VS Code reports | OpenTUI cannot own VS Code WebGL atlas state |
| Current `0.4.3-smark.1` package family remains intact | INV-07 | current 11-item closure contract | source gitlink is updated independently; package manifests/lock remain `.1` until a future immutable package transition |
| Checked-in source revision authorization manifest | INV-07 | arbitrary clean source commits must not pass the source-aware verifier | `opentui-source-revision.json` is the reviewed source identity, separate from package release identity |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig` | modify | span-aware alpha blending, emoji policy, clipped/atomic wide writes | +250 to +450 |
| `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig` | modify | add tracker-present and tracker-absent/raw-branch tests for `fillRect`, `drawFrameBuffer`, `drawGrayscaleBuffer`, and `drawGrayscaleBufferSupersampled`; assert CJK spans, full-span emoji `[]`, clipped-half preservation and continuation metadata | +350 to +700 |
| `thirdparty/opentui/packages/core/src/buffer.ts`, `zig.ts`, `zig/lib.zig` | modify when #791 clipped-fill seam requires it | preserve the selected native/TypeScript clipped-fill contract; no unrelated public API | +10 to +40 |
| `thirdparty/opentui/packages/core/src/zig/renderer.zig` | modify | apply the approved #791 wide-glyph diff preclear so old placeholder/original spans cannot remain stale | +40 to +80 |
| `thirdparty/opentui/packages/core/src/zig/tests/renderer_test.zig` | modify | add the exact emoji -> `[]` -> emoji renderer owner-local test with logical continuation ownership and captured ANSI preclear assertions | +100 to +220 |
| `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` | preserve; modify only if a new regression proves the owner is touched | retain `BufferedBackend` growth, failed-frame rejection, threaded handoff and next-frame recovery contract | +0 to +30 |
| `thirdparty/opentui/packages/core/src/renderables/Box.ts` | modify | wide-edge-aware clipped perimeter and buffered/direct parity | +150 to +330 |
| `thirdparty/opentui/packages/core/src/Renderable.ts` | modify only if current Box seam requires it | expose existing visible geometry needed by Box path | +10 to +25 |
| `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig` | modify | independent alpha/CJK/emoji/framebuffer regressions | +500 to +1100 |
| `thirdparty/opentui/packages/core/src/renderables/Box.test.ts` | modify | direct/framebuffer/clipped/bordered Box regressions | +500 to +850 |
| `thirdparty/opentui/packages/examples/src/wide-grapheme-overlay-demo.ts` | modify | manual visual coverage for the published semantics | +20 to +50 |
| `thirdparty/opentui` submodule gitlink | modify after source/native tests pass | point the parent repository at the new reproducible OpenTUI source revision; do not change OpenCode package manifests or `bun.lock` until immutable packages exist | metadata delta |
| `packages/opencode/script/verify-opentui-closure.ts`, `packages/opencode/script/opentui-provenance.ts`, `packages/opencode/test/script/opentui-provenance.test.ts`, `packages/opencode/script/opentui-source-revision.json` | modify/add | manifest schema is `{ "schema": 1, "sourceGitlink": "a checked-in 40-character lowercase hexadecimal SHA", "releaseTag": "v0.4.3-smark.1", "releaseCommit": "the checked-in peeled annotated-tag SHA" }`; source-authorized mode checks sourceGitlink against the parent/nested source, checks releaseCommit against the remote annotated `.1` tag, and independently retains all immutable `.1` package URL/version/integrity/Solid/native checks | +130 to +220 |
| `.github/workflows/test.yml`, `.github/workflows/build-opencode.yml` | modify | mandatory CI closure jobs invoke `bun run script/verify-opentui-closure.ts --source-revision-authorized` after the source gitlink transition; no workflow continues calling the release-only default mode for the new source revision | +4 to +8 |
| OpenCode package manifests, `bun.lock`, `upgrade-opentui.test.ts` | preserve in this revision | keep the current `0.4.3-smark.1` consumer closure and package URLs unchanged; defer the package-family release transition | 0 |

No OpenCode Dialog fallback is planned.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `A中B` under alpha fill loses `中` | `destWidthIsOne` rejects width-2 preservation | preserve and uniformly blend complete span | direct CJK overlay |
| 2 | overlay begins at CJK continuation cell | cell-local setter clears or styles only half span | resolve start/end and update whole span | continuation-cell integrity |
| 3 | `buffer - raw alpha path preserves CJK and applies exact full-span emoji placeholder`: exercise `fillRect`, `drawFrameBuffer`, `drawGrayscaleBuffer`, and `drawGrayscaleBufferSupersampled` with no grapheme/link tracker; assert CJK start/continuation cells remain one span, a fully covered color-emoji span is exactly `[`/`]` with width 1 and no grapheme/link metadata, a clipped-half span remains original, and the original span restores on the next frame | current raw callers invoke `setCellWithAlphaBlendingRawCell` cell-by-cell and have no shared wide-span contract | route every raw caller through the same span semantics; preserve the clipped-half original span | emoji semantic, framebuffer/grayscale/raw branch and span integrity |
| 4 | `renderer - wide emoji to placeholder clears old terminal footprint`: create `TestRenderer` at `8x2`, draw `A👨‍👩‍👧‍👦B` at `(0,0)`, render, replace the same row with `A[]B`, render, then restore the original emoji row and render again | current renderer can leave the old wide span after the logical replacement; frame 2 must emit a preclear for the two-cell old footprint before `[`, and frame 3 must emit the original emoji UTF-8 bytes; the current logical row must decode to `A👨‍👩‍👧‍👦B` with its continuation cell owned only by that grapheme | apply #954 preclear in the renderer diff path and keep the exact raw-output and logical-cell assertions green |
| 5 | clipped/bordered Box edge crosses CJK or covers only one cell of a color-emoji span | generic fill path damages perimeter geometry or cannot write the off-scissor continuation cell | CJK keeps one coherent wide span; a half-covered color emoji keeps its original grapheme, while a fully covered emoji uses exact `[` and `]` cells | Box visual integrity and single emoji policy |
| 6 | buffered Box rerender accumulates tint | framebuffer reuse/reset does not share the new span policy | direct and buffered paths converge | reuse and resize |
| 7 | native OpenTUI Box/compositor renders the same wide CJK overlay semantics used by the OpenCode Dialog | current consumer remains on immutable `.1`, so its compiled smoke cannot execute this unreleased source change | verify the OpenTUI source/native seam directly; run the existing OpenCode smoke only as a current-consumer baseline, never as evidence for the unreleased repair | prevents falsely claiming consumer verification |
| 8 | VS Code-only full-screen corruption | current host evidence is insufficient and the user explicitly deferred this suspected VS Code issue | no implementation in this revision; preserve the evidence for a future host-focused plan | prevents accidental OpenTUI workaround |
| 10 | `renderer - grows frame output instead of committing cells whose ANSI was dropped`, `buffered backend reports a failed frame when growth allocation fails`, `threaded buffered backend skips instead of blocking behind output` and their following-frame assertions | output buffer growth, failure, threaded handoff and recovery are reachable terminal corruption contracts | preserve current behavior while applying overlay/Box changes; any failure blocks release | prevents truncated ANSI, stale handoff and recovery regressions |
| 11 | `source-authorized verifier rejects manifest-mismatched clean source`: call exported `verifySourceRevisionAuthorization` with `parentGitlink == nestedHead == unauthorizedCleanSha`, `nestedStatus == ""`, and a manifest whose `sourceGitlink == authorizedRepairSha` and `releaseCommit == releaseTagSha` | the candidate is clean and internally consistent but differs only from the checked-in source authority | the seam fails specifically on the manifest sourceGitlink mismatch; a positive fixture with `authorizedRepairSha` passes and the independent `.1` releaseCommit check remains required | source authorization cannot be bypassed by an arbitrary clean commit |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 1600 to 2800 | include substantive native/TypeScript production and tests; exclude deferred host diagnostics, consumer metadata, imports, formatting, generated metadata and pure moves |
| Required Chinese explanatory comments `C` | 240 to 420 | `ceil(E * 0.15)`; distribute qualifying rationale through changed production and test decision seams |

Qualifying comments must explain the wide-span atomicity invariant, why emoji uses a placeholder, why the Box perimeter is clipped, why framebuffer reuse is reset, and why the release package family must remain immutable. Test comments may explain independent expected values and the specific regression boundary. Comments must be adjacent to the relevant logic and must not restate assignments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run test:native -Dtest-filter="buffer - alpha fill preserves CJK wide grapheme"` | `thirdparty/opentui/packages/core` | exact native compositor red/green behavior; zero matched tests is failure |
| `bun run test:native -Dtest-filter="buffer - raw alpha path preserves CJK and applies exact full-span emoji placeholder"` | `thirdparty/opentui/packages/core` | tracker-present/tracker-absent raw branch, exact `[`/`]` cells, clipped-half preservation and restoration; zero matched tests is failure |
| `bun run test:native -Dtest-filter="renderer - wide emoji to placeholder clears old terminal footprint"` | `thirdparty/opentui/packages/core` | exact renderer preclear red/green behavior and normalized ANSI evidence; zero matched tests is failure |
| `bun run test:native -Dtest-filter="renderer - grows frame output instead of committing cells whose ANSI was dropped"` | `thirdparty/opentui/packages/core` | existing large-frame growth contract in threaded and unthreaded modes |
| `bun run test:native -Dtest-filter="buffered backend reports a failed frame when growth allocation fails"` | `thirdparty/opentui/packages/core` | existing truncated-frame rejection, zero partial writes and next-frame recovery contract |
| `bun run test:native -Dtest-filter="threaded buffered backend skips instead of blocking behind output"` | `thirdparty/opentui/packages/core` | existing threaded handoff and non-blocking recovery contract |
| `bun test src/renderables/Box.test.ts` | `thirdparty/opentui/packages/core` | direct/framebuffer/clipped Box behavior |
| `bun run build` | `thirdparty/opentui` | native and library build |
| Not run: immutable `0.4.3-smark.2` artifacts do not exist and external release publication is deferred | `thirdparty/opentui` | release-family verification is a follow-up gate; current revision must not fabricate package URLs or consumer lock entries |
| `bun test test/script/opentui-provenance.test.ts test/script/upgrade-opentui.test.ts` | `packages/opencode` | consumer version/provenance closure tests |
| `bun run script/verify-opentui-closure.ts` | `packages/opencode` | current `.1` consumer closure baseline before the source-gitlink transition |
| `bun run script/verify-opentui-closure.ts --source-revision-authorized` | `packages/opencode` | final source-aware closure: parent gitlink/submodule must equal manifest `sourceGitlink`; remote `v0.4.3-smark.1` must equal manifest `releaseCommit`; package URLs, versions, integrity, Solid identity and native assets remain immutable `.1` |
| `.github/workflows/test.yml` `opentui-required` and `.github/workflows/build-opencode.yml` `opentui-closure` source-authorized command review | repository root | both mandatory CI consumers use the source-aware verifier after the new gitlink; no no-argument release-only verifier remains on the final source state |
| `git submodule status thirdparty/opentui` and `git diff --submodule=log -- thirdparty/opentui` | repository root | parent repository records the new reproducible OpenTUI source revision after native/source verification |
| `bun run script/smoke-opentui-artifact.ts --binary "$RUNNER_TEMP/opentui-smoke/opencode"` | `packages/opencode` | current immutable `.1` consumer baseline only; not evidence that the unreleased OpenTUI source repair reaches OpenCode |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | TypeScript/native-binding library compilation; `packages/core` exposes no separate typecheck script |
| `bun typecheck` | `packages/opencode` | OpenCode smoke-script and consumer type safety |
| `bun test --timeout 30000 test/script/opentui-provenance.test.ts test/script/upgrade-opentui.test.ts` | `packages/opencode` | exact OpenCode integration/provenance regression set |
| Not run: host-only VS Code matrix deferred by explicit user request and macOS Accessibility permission failure | macOS host | deferred external-host issue record; no owner claim or OpenTUI host repair in this revision |

The raw ANSI/logical/headless/host matrix is explicitly deferred with INV-08. External-terminal normality and the VS Code-only observation remain evidence for a future host-focused revision, not a current OpenTUI release gate.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | the deferred host issue adds no diagnostic harness in this revision |
| Files modified | 9 to 15 plus submodule gitlink metadata | #791 buffer/Box semantic port, required clipped-fill FFI, approved renderer preclear and source-gitlink integration; no OpenCode consumer or host diagnostic changes |
| Files deleted | 0 | no evidence supports deletion |
| Production lines | 400 to 700 | span compositor, exact emoji policy, clipping, clipped-fill FFI and approved renderer preclear |
| Test lines | 1200 to 2200 | #791's independent native/Box regression coverage adapted to current baseline |
| Generated lines | lock/release metadata only | generated consumer closure must be regenerated, not hand-invented |

## 20. Real Risks and Open Decisions

### Real Risks

- #791 is 99 commits behind the `0.4.3` baseline and conflicts with current child identity and renderer code; a mechanical cherry-pick can silently drop current cleanup invariants.
- Emoji placeholder behavior changes visible content under a dimming overlay; the user has selected the `[]` policy for this revision.
- Box perimeter logic touches clipping, borders, framebuffer reuse and native span tracking; a buffer-only patch would leave reachable edge regressions.
- Native package family, gitlink, lock integrity and compiled artifact must move together; a partial release creates an ABI/provenance split.
- The current VS Code host can corrupt pixels after OpenTUI has produced a correct logical frame; a TUI-only test cannot certify the host renderer.

### Open Decisions Requiring the User

- No product decision remains for emoji: the user selected `[]` for color emoji and uniform preservation/tinting for CJK/wide text.
- The original request includes corresponding implementation and merge work; this source-only revision keeps the current `.1` consumer closure unchanged. Immutable package-family transition and external GitHub release publication remain outside this revision and must not be implied by a local commit.
- The user explicitly deferred the VS Code-only pixel issue in the current turn: `可以先不修这个问题，这个可能属于vscode问题`.

### Rejected Speculation

- The active process is not an old `0.3.4` OpenTUI binary; the mapped native hash matches `0.4.3-smark.1`.
- OpenTUI #845 does not repair alpha overlay composition; its scope is Markdown wrapping offsets.
- Upstream `0.4.4`/`0.4.5` release upgrades alone do not provide the overlay repair.
- Linux/Wayland mipmap issue #5987 is not sufficient evidence for the current macOS shared-atlas symptom; #6042/#6055 are the relevant external chain.
- xterm CJK reflow #3097/#5997 cannot own a spontaneous non-resize corruption without a resize/reflow reproduction.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original user requirement.
- Reconstruct the current OpenTUI/OpenCode producer-to-consumer paths from repository evidence.
- Verify the deterministic overlay red signal and ensure its owner is repaired in the plan.
- Audit #791 selection, #839 rejection, #845/#1224 existing coverage and external xterm classification.
- Check that the whole-screen symptom is not silently narrowed to the overlay-only case.
- Check primary-path ownership, no fallback, no speculative emitter change and no external host code leakage.
- Check forward and reverse traceability, TDD seams, release closure, diff budget and Chinese comment budget.
- Verify the user-provided VS Code-only observation and the explicit deferral are retained as evidence; do not require host first-divergence comparison for this source-only revision, and do not claim that OpenTUI repairs the deferred host symptom.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 VS Code-only corruption was classified as external without proving first divergence; B-02 renderer transition required by `[]` policy was excluded without a red test; B-03 selected #791 clipped-fill scope contradicted the file/interface plan; B-04 release verification command lacked required arguments. | #839 stable citation, direct user-decision artifact, broad estimate clarification, zero-test filter clarification | BLOCK | `ses_07ea50589ffecJ2QKzTVybHIeI` |
| 2 | R3 | yes | B-01 the `[]` choice was not present as a verbatim contracted decision in the plan; the renderer red fixture, host-owner matrix, and exact verification commands still lacked executable detail or contained unresolved placeholders; audit metadata was not advanced for the current revision. | none recorded | BLOCK | `ses_07e9ec051ffetXLT8Rfv2bEgxs` |
| 3 | R4 | yes | B-01 OpenTUI-side terminal corruption had no owner-local repair path if raw/headless output diverged; B-02 the required host-frame JSONL had no executable host-frame producer. | compiled binary path and commit-diff evidence still required explicit wording | BLOCK | `ses_07e957985ffe3rIgWZAJ7msMH4` |
| 4 | R5 | yes | B-01 the `[]` policy lacked an auditable user-contract artifact; B-02 the proposed matrix runner had no raw/headless artifact interface; B-03 the matrix required `120x40` while the producer emitted `160x30`. | audit metadata was behind the revision | BLOCK | `ses_07e8f24aeffe1CeRI3704AM02T` |
| 6 | R6 | yes | B-01 `[]` policy and consumer-closure authorization were not auditable from the original requirement; B-02 the existing `renderer-output.zig` output-buffer owner and its failure/recovery contract were not mapped into the plan. | host runner operation details remained non-blocking | BLOCK | `ses_07e86b399ffebADT6An6Zf5rHG` |
| 7 | R7 | yes | B-01 terminal corruption owner remained conditional among three future paths; B-02 the `[]` policy and release closure were not auditable from the original handoff; B-03 immutable `.2` package family did not exist. | host runner details remained non-blocking | BLOCK | `ses_07e80cf50ffeaL5bXf8sY4wTiT` |
| 8 | R8 | yes | B-01 deferred VS Code host capture remained active in section 8 and diff budget; B-02 compiled OpenCode smoke was claimed as verification for unreleased source while `.1` consumer closure was preserved. | none recorded | BLOCK | `ses_07e6ad383ffeg6YVYOxD23zBWC` |
| 9 | R9 | yes | B-01 OpenTUI internal corruption had only preservation tests and no owner-local conclusion; B-02 `[]` policy lacked exact `[`/`]` cell, tracker and restoration contract. | none recorded | BLOCK | `ses_07e6591b5ffeQaqZxWWTSMxgf5` |
| 10 | R10 | yes | B-01 source repair could not be delivered while preserving the `.1` gitlink/closure contract; B-02 clipped-edge emoji behavior was not defined consistently with the `[]` policy. | none recorded | BLOCK | `ses_07e6108faffeZ14AiNL5Gzv8zX` |
| 11 | R11 | yes | B-01 new source gitlink transition contradicted the old `.1` release-tag closure verifier; B-02 clipped-edge emoji behavior was not defined consistently with the selected full-span `[]` policy. | none recorded | BLOCK | `ses_07e59f6b2ffekzgeRfD9SCcQCl` |
| 12 | R12 | yes | B-01 source-gitlink verification had no authoritative authorization contract; B-02 renderer owner-local test file was omitted from the exact file plan. | none recorded | BLOCK | `ses_07e56cd79ffexk2lGUoA81UC49` |
| 13 | R13 | yes | B-01 source-gitlink authorization negative test was not mapped to a concrete executable provenance test; B-02 renderer owner-local red evidence was not established; B-03 `fillRect` raw alpha branch was not mapped into the span contract. | none recorded | BLOCK | `ses_07e524d64ffeKlfO4tud4053qY` |
| 14 | R14 | yes | B-01 source-gitlink verification had no authoritative manifest/release identity contract; B-02 renderer red evidence and B-03 raw alpha mapping were not fully actionable. | CI and exact source authorization details remained incomplete | BLOCK | `ses_07e441ea1ffejgtTVis0eBndT3` |
| 15 | R15 | yes | B-01 raw alpha caller set was incomplete: `drawFrameBuffer` and grayscale raw callers were not mapped to the same span contract. | none recorded | BLOCK | `ses_07e3eafd6ffea53SONawrxKF6t` |
| 16 | R16 | yes | none | none | APPROVE | `ses_07e3abbb7ffewGGjYVGnQHyaq5` |

## 23. Implementation Evidence

Complete only after implementation and only for the approved revision.

### Actual Files and Diff

- OpenTUI source revision `0ac61b0f3b5d0350793e982320911daac4d7cfb8` contains the approved wide-span compositor, renderer footprint preclear, Box clipped-perimeter seam, native export, FFI symbol, TypeScript buffer method, and focused native/Box tests.
- Parent changes are limited for this task to `packages/opencode/script/opentui-provenance.ts`, `packages/opencode/script/verify-opentui-closure.ts`, `packages/opencode/test/script/opentui-provenance.test.ts`, `.github/workflows/test.yml`, `.github/workflows/build-opencode.yml`, and `packages/opencode/script/opentui-source-revision.json`; the parent gitlink is staged at the same source revision.
- Consumer package identity remains `0.4.3-smark.1` and release tag `v0.4.3-smark.1`; no `.2` package or host fallback was introduced.

### Red-Green Test Evidence

- Zig `0.15.2` probe and focused renderer test were red before the wide-footprint preclear; the renderer test then passed after the primary diff-path repair.
- Raw-alpha wide CJK behavior was red before routing raw callers through the shared span-aware setter; the focused raw-alpha test then passed.
- The new clipped-wide native seam test passed after adding the Box-owned perimeter path.
- Box regression tests passed after test doubles implemented the mandatory clipped-fill seam.

### Verification Commands and Results

- `PATH="/opt/homebrew/opt/zig@0.15/bin:$PATH" bun run test:native` from `thirdparty/opentui/packages/core`: `1688 passed, 2 skipped`.
- `bun test src/renderables/Box.test.ts` from `thirdparty/opentui/packages/core`: `29 passed, 0 failed`.
- `bun run build:lib` from `thirdparty/opentui/packages/core`: passed.
- `bun test test/script/opentui-provenance.test.ts test/script/upgrade-opentui.test.ts` from `packages/opencode`: `3 passed, 0 failed`.
- `bun typecheck` from `packages/opencode` in the isolated clean verification tree: passed; the shared worktree's unrelated `edit` tool changes were not modified.
- `bun run script/verify-opentui-closure.ts --source-revision-authorized` from `packages/opencode`: passed with source revision `0ac61b0f3b5d0350793e982320911daac4d7cfb8` and consumer version `0.4.3-smark.1`.

### Original Feedback-Loop Result

- The reproduced native renderer loop now emits the required absolute-position preclear before replacing a wide emoji with `[]`, and the next frame restores the original grapheme. The OpenCode host pixel-fragment symptom remains explicitly deferred as VS Code-owned.

### Actual Secondary and Replacement Path Inventory

- No full-repaint fallback, `DECAWM` change, opaque Dialog workaround, GPU workaround, or failure-triggered alternate renderer path was added.
- Ordinary `fillRect` remains the canonical interior fill path; `fillRectClipWideGraphemes` is only the Box perimeter seam and delegates scissor/span ownership to native code.
- `BufferedBackend` failed-frame and next-frame recovery remains unchanged and is covered by the existing threaded/unthreaded tests.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 384 | Excludes blank, import-only, generated, pure-move, and comment-only lines across the parent task diff and finalized OpenTUI source diff. |
| Qualifying Chinese comment lines `C` | 64 | Colocated rationale comments explain span ownership, clipped-edge boundaries, FFI lifetime, provenance authority, and behavior-sensitive test intent. |
| Ratio `C / E` | 16.7% | `64 / 384`; independent audit must recompute this count. |
| Required minimum `C` | 58 | `ceil(384 * 0.15) = 58`; the implementation is above the hard gate. |

### Remaining Unverified Items

- Independent implementation audit must verify the exact R16 diff, recompute the comment gate, and confirm no unrelated parent worktree changes enter the final commit.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes | pending | pending | pending |  |

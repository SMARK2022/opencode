# Canonical Implementation Plan: edit 逐条 identical(no-op)容忍 + output 变化说明与 warning

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 用户会话原文（2026-08-13，GOAL 原始需求）
>
> Implementation allowed: no further changes without revision
>
> Last updated: 2026-08-13

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户需求原文（GOAL 参数，未作任何改写）：

> 因此请你检查一下并且构建完整的方案,来进行逐条 identical,也就是逐条无操作的优化。也就是只要有相应的变化项,就要在相应工具output里面将这个工具的变化给它说明。然后同时如果真的存在部分条是identical的,那么我们在最终再加一条,加一个warning,blablabla的一个内容,这样的话会让我们整体内容更好。但同时请你也注意相应的TUI部分。理论来说TUI部分不需要进行相应的展示这些内容。所以你的output请你也仔细斟酌这个格式到底放在哪里。同时apply patch部分的未变化hunk确实可以跳过,但如果麻烦的话,你可以不跳过。你可以让相应的apply patch部分和PI也是保持类似即可。整体保持克制修改,修改文件数不超过四个文件,同时生产代码修改行数不超过600行。整体保持克制,不需要触碰其他额外的内容部分,不要引入新的风险,但是既有风险你可以不进行与当前需求无关的修改。

需求分解（R 编号）：

- R-01：batch 中只要有实际变化项，edit 工具 output 必须说明本次变化（模型可见通道为 Tool result 的 output 文本）。
- R-02：batch 中确实存在逐条 identical（oldString === newString，no-op）的条目时，output 末尾追加一条 warning。
- R-03：TUI 不需要为此新增任何展示；output 格式位置需斟酌（保持 model-facing 文本，不引入 TUI 改动）。
- R-04：apply_patch 未变化 hunk 可以跳过，也可以不跳过（麻烦时）；保持与 Pi 类似即可 = 现状已容忍 no-op hunk，不强制改动。
- R-05：修改文件数 ≤ 4，生产代码修改行数 ≤ 600。
- R-06：不触碰与当前需求无关的内容，不引入新风险。

## 2. Explicit Non-Goals

- **不修改 apply_patch 任何生产代码**（R-04 授权现状）。不修改 write 工具。
- **不新增 TUI 渲染**：TUI Edit 视图只渲染 `metadata.diff` 与 diagnostics，不渲染 output（index.tsx:3280-3351）。
- **不修改工具参数 Schema、description（edit.txt）、prepareEditArguments**。
- **不修改 create/overwrite 语义**：单条 create（oldString==""）且 newString=="" 仍报 identical 错误（既有预检+测试）。
- **不修改批级 no-op 错误**（edit-apply.ts 批级内容等值门），不修改 applyEdits 的匹配/跳写/syncEdits 语义（R2/R3 已批准并验证）。
- **不修改 processor/message-v2/TUI 生产代码**（pass-through 消费面）；不修改 `truncate.ts` 与 tool wrapper 的统一截断（通用层，所有工具共享）。
- **禁止增加第二数据源或并行 truth**：output 变化说明与 metadata.diff 必须同源于最终落盘状态（post-formatter）的统一 diff 计算。
- **禁止手工逐条截断（R4 修订）**：R3 的 per-block Changed 列表被废弃，其"展示 formatter 前数据"与"长度不可控"两个缺陷分别由 B-03/B-02 捕获；变化说明改为最终 diff 形态 + 预算保护（§10 决策6/7）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Tool 概念：output 是回喂模型文本；Message 投影只带 input+output。 |
| `AGENTS.md`（仓库根、packages/opencode、test） | 测试/typecheck 从 package 目录运行；`testEffect`/`Layer.mock` 风格（test/AGENTS.md 推荐 Layer.mock 做局部桩）。 |
| `.opencode/policy/first-principles-engineering.md` | 主路径唯一、no fallback、责任归属、克制预算。 |
| `docs/adr/` | 无相关 ADR。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/edit.ts`（当前树 452 行） | 变更主文件：create 分支（186-230，diff 预计算 192-199、commit 内 formatter 后 contentNew 同步 214-218、syncInput 219-222）；non-create 分支 commit 后 diff 重算（305-312）、syncEditsDisplay 提升（317-329）；output 组装（355-399）；LSP 段（363-377） | observed |
| `packages/opencode/src/tool/edit-apply.ts`（当前树 531 行） | 本修订**零改动**：identical 跳写（469-480）、syncEdits 提交形态分发（483-492）、批级门（513-519）均为 R2/R3 已验证成果 | observed |
| `packages/opencode/src/tool/truncate.ts`（全文 148 行） | B-02 相关：`output` 统一 head 截断（81-130）、`limits()`（71-79，可注入 Service）；edit 侧预算保护须与它同源（maxLines/maxBytes/direction） | observed |
| `packages/opencode/src/tool/tool.ts`（159-172） | wrapper 对全部工具统一 `truncate.output(result.output, {}, agent)`；edit 侧保证 output ≤ limits 即可避免触发 | observed |
| `packages/opencode/src/format/index.ts`（76-122, 194-197） | B-03 相关：`format.file` 真实运行外部 formatter 并改写磁盘；commit 内 `Bom.syncFile` 重读最终内容 | observed |
| `packages/opencode/src/session/message-v2.ts`（1229-1266） | 模型 Tool result 只投影 `input`+`output`（含截断后文本）；`metadata.diff` 不透传 | observed |
| `packages/opencode/src/session/processor.ts`（55-72） | `resolveCompletedToolInput` 整表替换 state.input（pass-through 消费面，零改动） | observed |
| `packages/opencode/test/tool/edit.test.ts`（当前树 1587 行，73 用例） | 测试 seam：`run`/`fail` harness、`mockFormatLayer`（47-68，追加换行的确定性 formatter）、`itFormatted`；R3 的 slice 1-8 已在 | observed |
| `.temp/thirdparty/pi/.../edit-diff.ts`、`edit.ts` | 对照：Pi 无变化说明/无 warning/无截断保护，其 output 为块数（对照而非基准） | observed（对照） |
| 仓库 grep：`Truncate.Service` 在 tool 层的取用方式 | 确认 edit 可注入 `Truncate.Service`（test layer 已有 defaultLayer）；其他工具（如 shell）已用 limits 先例可循 | observed |

## 5. Current Behavior

```text
edits[] -> Schema decode -> execute 预检 -> blind-edit 门 -> Mutation.read
-> applyEdits（identical 跳写 + 批级门） -> permission
-> commit（formatter 后 contentNew 同步重读）
-> non-create: diff 重算（formatter 后）；create: diff 仍为 formatter 前预计算
-> output 组装: 成功头 + [per-block Changed 列表(仅非 create, formatter 前数据)] + LSP 段 + [warning(末尾)]
-> tool wrapper: truncate.output（默认 head，>16KiB 丢尾部）
-> message-v2 投影 input+output 给模型
```

当前仍存在的缺口（R4 待修，由两轮全新审计于 2026-08-13 判定 BLOCK）：

1. **B-01（create/overwrite 无变化说明）**：`syncEditsDisplay` 只在 non-create 分支赋值，create/overwrite 分支 `changedBlocks` 恒空 → create/overwrite 成功 output 无任何变化说明，违反 R-01（该路径确有实际变化）。现有证据：edit.ts:186-230、321-329、355-372。既有测试覆盖 create 成功路径 but 只断言 diff metadata（251-300），不涉及 output。
2. **B-02a（Changed 列表基于 formatter 前数据）**：per-block 列表来自 `applied.syncEdits`（applyEdits 的 proposal 时刻数据）；commit 内 formatter 改写文件后，output 展示的 old/new 与模型随后的磁盘状态不一致（edit.ts:293-315 vs 317-329 vs 362-371）。formatter 是正式可配置生产接口（format/index.ts:76-122），test 已有确定性 mockFormatLayer 证明该 seam 可执行。
3. **B-02b（统一 head 截断可丢失末尾 warning）**：output 超 `limits`（默认 16KiB/1000 行）时 wrapper 以 head 方向截断（truncate.ts:97-103），只保留前缀 + notice；末尾 warning 被丢弃；message-v2 投影的是截断后文本。old/new 无长度上限，R-01 的变化说明使超限直接可达。

R1-R3 已正确实现并验证的部分：逐条硬错删除、identical 校验后跳写（零字节写入）、批级内容等值门、warning 末尾追加、syncEdits 提交形态分发（历史一致）、TUI/apply_patch/write 零改动。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| create/overwrite（oldString==""）成功 | 模型（Schema 支持、既有测试 251-300 执行此路径） | 无 | execute create 分支 → 写盘 → output 无变化说明 | edit tool | observed |
| Project 启用 formatter 且 edit 命中格式化文件 | opencode 配置（format/index.ts 正式接口） | 无 | commit 内 format.file → 磁盘内容 ≠ applyEdits 输出 | edit tool | observed（mockFormatLayer 证明 seam）+ reachable |
| 大修改 batch（output 超 limits）且含 identical 条目 | 模型（old/new 无长度上限） | 无 | output 组装 → wrapper head 截断 → warning 丢失 | edit tool / 截断交互 | reachable |
| 非 create batch 混入 identical（exact/normalized 命中） | 模型 | Schema 无等值约束 | 跳写 + warning（R2/R3 已验证） | edit tool | observed |
| 全部 no-op / locate 失败 / 唯一性失败 | 模型 | 无 | 批级门/既有错误（保持） | edit tool | observed |
| apply_patch keep-only hunk | 模型 | R-04 授权现状 | 不改 | apply_patch | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 全 no-op（含漂移角）必须失败 | 跳写 → 批级门（保持） | slice 3/4（既有） |
| INV-02 | 每条 edit（含 identical）都必须通过 locate + 唯一性校验 | applyEdits 顺序（保持） | slice 2（既有） |
| INV-03/04 | 空 oldString / create+空 newString 拒绝（保持） | 既有门 | 既有测试 |
| INV-05/06 | identical 容忍、零字节写入、warning 事实为真（保持） | 跳写 + 分发（保持） | slice 1/5/7（既有） |
| INV-08 | 持久化历史（_syncInput→state.input）保持提交形态（保持） | syncEdits 分发 + processor pass-through | slice 7（既有） |
| INV-09 | **成功 output 依实际落盘结果（post-formatter）说明变化，create/overwrite 同样覆盖**（R4 强化） | 出口统一 diff 重算（§10 决策6） | 新增 slice 9（create）、slice 10（formatter） |
| INV-10 | **output 不超过 truncation limits，末尾 warning 在模型可见结果中恒存在；支持域 = 默认 limits（16KiB/1000 行）及可容纳 header+warning 的配置，极端自定义极限声明为尽力保留**（R4 新增，R5 修正边界） | 组装预算保护与 limits 同源，clamp 负预算（§10 决策7） | 新增 slice 11 |
| INV-07 | TUI 零改动（保持） | 结构性 | 无 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-09（create 覆盖） | `edit.ts` create 分支无 syncEditsDisplay / changedBlocks 恒空 | edit tool execute（output 组装） | R-01 无 create 例外；create 成功路径确有字节变化 |
| INV-09（formatter 真值） | per-block 数据源 `applied.syncEdits` 在 commit/formatter 前生成，而磁盘最终状态在 commit 后 | edit tool execute（output 组装） | format.file 改写磁盘（format/index.ts）+ syncFile 重读（edit.ts:296-298）；R2/R3 的 `_syncInput` create 分支已采用"最终文本"原则（219-222），output 未同步该原则 |
| INV-10（warning 可见） | 统一 head 截断发生在 output 组装之后（truncate.ts:97-103），warning 位于文本尾部必被丢弃 | 截断交互（tool wrapper）——修复必须发生在 edit output 组装（edit 是唯一知道各段语义的模块） | message-v2 投影截断后文本（1232-1263）；per-block 列表无长度上限 |
| B-01/B-02 根源 | 变化说明的数据源与产生时机错误（formatter 前、且非 create 独享），且无"output 有物理上限"的组装纪律 | edit tool execute | 见上三行 |

根因统一表述：R3 的变化说明（per-block Changed 列表）选错了权威真值（formatter 前的 applyEdits 快照）、漏了 create 分支、且不承担 output 的物理上限责任。修复 = 变化说明改用"post-formatter 最终落盘状态 vs proposal 原文"的统一 diff（该 diff 变量本就存在并为 TUI/权限服务），在共享出口统一重算（两分支），并以 limits 同源的预算保护组装 output（保证 warning 恒可见，不触发通用截断、不修改通用层）。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 匹配/跳写/批级门/syncEdits | `applyEdits`（R2/R3 已验证，零改动） | 既有 | — | — |
| 变化说明的真值源（post-formatter 最终 diff） | `EditTool.execute`（两分支共享出口） | output 与 metadata.diff 同源 | execute 拥有 commit/formatter 后的 contentOld/contentNew | applyEdits 不知 formatter；processor/message-v2 是 pass-through |
| output 预算保护（warning 恒可见） | `EditTool.execute`（组装段） | output ≤ truncation limits | 只有 edit 知道各段语义（变化说明可裁剪、warning 不可） | truncate.ts 是通用层（所有工具共享的语义无关裁剪）；wire 层改它引入全工具风险 |
| warning 文案 / unchanged 计数 | `EditTool.execute` | R-02 | output 组装所有者 | 不变 |

## 10. Single Approved Primary-Path Design

```text
edits[] -> execute 预检 -> blind-edit 门 -> Mutation.read
-> applyEdits（identical 跳写 + 批级门，R2/R3 不动）
-> permission -> commit（formatter 后 contentNew 同步）
-> 共享出口（R4）：
   统一重算 diff = createTwoFilesPatch(contentOld, contentNew 最终值)
   统一重算 additions/deletions
-> output 组装（R4）：
   成功头 + [diff 段（预算保护）] + [LSP 段（预算保护）] + [warning（恒保留）]
-> _syncInput（恢复 R2 内联形态，真值不变）
-> wrapper 截断不触发（output ≤ limits） -> message-v2 投影
```

设计决策：

1. **（R2/R3 保持）identiy 校验后跳写、批级门、syncEdits 提交形态分发**：edit-apply.ts 零改动。
2. **（R4 决策6，B-01/B-02a 修复）变化说明 = 最终落盘（post-formatter）diff**：
   - **出口统一重算（保留权限前预计算）**：create 分支 `ctx.ask` 之前的 diff 预计算（192-199）与 non-create 分支权限预计算（275-282）**保留**——权限请求的 `metadata.diff` 必须继续携带内容预览（consumers：permission.tsx:40,53-80、run/tool.ts:387,550、scrollback.writer.tsx:195-198；R5 修订 B-01）。两分支之后、metadata/output 之前增加**出口统一重算**：
     `diff = trimDiff(createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)))`，并统一统计 additions/deletions（上移 non-create 分支 305-312 的重算与共享 327-340 的统计）。contentOld/contentNew 在出口时点均已含 commit 后 formatter 结果（create 215 既有同步、non-create 296-298 既有同步）→ 出口 diff = post-formatter 真值（B-02a ✓），且不触碰任何权限面（B-01 ✓）。
   - **output 变化说明 = 最终 diff 文本**（替换 R3 的 per-block 列表）：`\n\nChanged:\n<diff 行>`。diff 行的 `-`/`+` 本身就是"逐条变化的说明"（R-01 ✓，含实际 old 文本即归一化差异信息），且覆盖 create（全加行，B-01 ✓）。删除 syncEditsDisplay 变量与 per-block 列表循环，syncInput 恢复 R2 内联 map 形态（真值机制不变）。
   - 单一真值：output 的 Changed 段与 metadata.diff 在出口后为同一字符串，杜绝双源漂移。
3. **（R4 决策7，B-02b 修复）output 预算保护（warning 恒可见）**：在组装段注入 `Truncate.Service.limits()`（maxLines/maxBytes，与 wrapper 截断同源），组装纪律：
   - 顺序：成功头 → Changed(diff 段) → LSP 段 → warning。
   - **diff 段**：逐行累计（字节 + 行数），预算 = `max(0, maxBytes − 保留预算)（≈2 KiB 保留：LSP 摘要 + warning + header + notice）`与 `max(0, maxLines − 保留行数)（≈10）`双限；超预算即停止，追加 `\n… (M more lines omitted)`（纯事实句，**不指向 metadata.diff**——该通道模型不可见，N-02 修正）。
   - **LSP 段**：追加前按剩余预算检查（N-1 精确化）：`remaining = maxBytes − (header + Changed 段 + marker + warning 预留)；LSP 块若使 consumed > remaining 则替换为 `\n\n(Diagnostics omitted: output size limit)`，永不消耗 warning 预算`。行数维度同规则（maxLines 留 warning/marker 行数）。
   - **warning 段**：恒追加（长度 < 保留预算）。最终 output ≤ limits → wrapper 不触发 head 截断 → warning 在模型可见文本中恒存在（INV-10 ✓），且仍在 output 最末尾（R-02 ✓）。
   - **支持域（INV-10 边界，N-01 修正）**：默认 limits（16KiB/1000 行）下恒成立；对自定义极限（maxBytes < 1KiB 或 maxLines < 6 这类物理无法容纳 header+warning 的配置）声明行为为"尽力保留"——warning 仍最后拼接，diff/LSP 段按 clamp 后余量裁剪至 0，超限场景由既有通用截断接管，不承诺不可能之事（配置侧自身极端值，非本需求可达域）。
   - 不改 truncate.ts / tool.ts / message-v2（通用层零风险原则）。
4. **（R2/R3 保持）warning 文案、unchanged 计数（提交形态 LF 谓词）、create 空串拒绝**。
5. **与 Pi 分歧记录（保持）**：逐条容忍 + 零写入 + warning + 变化说明均为需求语义的实现；Pi 无对应物。

本路线唯一改动文件为 edit.ts 与 edit.test.ts（edit-apply.ts 保持 R3 已验证内容），无新成功路径、无 fallback、无通用层改动。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Disposition |
| --- | --- | --- | --- | --- |
| 批级内容等值门 | 现状 | primary-contract branch（唯一 no-op 门） | no | preserve |
| identical 跳写 + syncEdits 提交形态分发 | 现状（R2/R3 已验证） | primary-contract 分支 | 否（只少写入） | preserve |
| per-block Changed 列表（formatter 前数据） | R3 | 错误的数据源/时机 + 遗漏 create | 否 | **remove（R4 决策6 废弃）** |
| 统一出口 diff 重算 + Changed=diff 文本 | 提出 | 主路径真值统一（R-01 实现） | 否（成功已定，只增说明） | 新增（INV-09） |
| output 预算保护（diff/LSP 裁剪、warning 恒留） | 提出 | 主路径组装纪律（INV-10） | 否 | 新增（与 limits 同源，无第二套输出） |
| closest 失败诊断 | 现状 | diagnostic path | no | preserve |
| apply_patch no-op 容忍 / create 空串拒绝 / TUI | 现状 | 不变 | — | preserve |

决策面比例：无新增成功路径；新增统一 diff 重算（收敛重复计算，净删除）与预算保护（约 15 判定行）；诊断面零新增。变更决策面估约 40 行。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| per-block Changed 列表 + syncEditsDisplay 提升 | R3 用于 R-01 的最小实现 | 数据源错误（formatter 前）、遗漏 create、长度不可控；被最终 diff 形态取代 | edit.ts output 组装、syncInput 恢复内联 |
| non-create 分支 commit 后 diff 重算（305-312）与共享统计（327-340）重复 | 历史演进 | 出口统一重算合并为一处，create 分支获得 formatter 后真值；**两分支权限预计算（192-199、275-282）保留**（权限请求 metadata.diff 供给不变，R5 修正 R4 的 B-01） | edit.ts 出口（commit 后、metadata 前）集成为唯一 post-commit 计算点 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R-01（含 create/overwrite） | 出口统一 diff → output Changed 段 | `edit.ts` | slice 8（更新为 diff 形态）、slice 9（新增 create） |
| R-01 + R-06（formatter 后真值 + 权限面不变） | 出口在 commit/formatter 之后重算；两分支权限前预计算保留 | `edit.ts` | slice 10（新增，mockFormatLayer）、slice 9（新增权限 diff 断言） |
| R-02 + INV-10（warning 恒可见） | 预算保护组装 | `edit.ts` | slice 11（新增，小 limits mock） |
| R-03 | output 文本（TUI 不可见） | 无 TUI 文件 | 结构性 |
| R-04 | 零改动 | 无 | — |
| R-05 | 2 生产文件（edit-apply 零改动） | edit.ts、edit.test.ts | 预算表 §19 |
| INV-01..08（保持） | edit-apply R2/R3 成果不动 | 无 | 既有 slice 1-7 |
| INV-09 / INV-10 | 见上 | `edit.ts` | slice 8/9/10/11 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 出口统一 diff 重算（create 也覆盖） | R-01 / INV-09 / B-01 | create 分支 diff 为 formatter 前预计算（192-199）；non-create 在 305-312 重算；共享 327-340 统计——三处分散，create 缺 formatter 真值 | 无现有位置同时覆盖两分支的 post-formatter 真值；收敛到出口是消除重复与补齐 create 的最小点 |
| Changed = 最终 diff 文本（取代 per-block） | R-01 / INV-09 / B-02a | diff 变量经 commit 后重算即为 formatter 真值；per-block syncEdits 为 formatter 前 | per-block 无法后验反映 formatter 改写（formatter 可改任意位置）；diff 是唯一可复用真值 |
| output 预算保护（limits 同源） | R-02 / INV-10 / B-02b | truncate.ts:97-103 head 截断丢尾部；tool.ts:164 统一调用；message-v2 投影截断后文本 | 通用层（truncate/tool wrapper）不知道 edit 各段语义，改之影响所有工具（新风险，违背 R-06）；edit 组装段是唯一知道"warning 不可裁剪"的模块 |
| syncInput 恢复内联 | INV-08 | syncEditsDisplay 仅服务 per-block（被废弃）；syncInput 真值取自 syncEdits 不变 | 内联即可承载真值，无需变量 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/edit.ts` | modify | 出口统一 diff 重算（合并三处）；删除 syncEditsDisplay/per-block；output 组装：Changed=diff 段（预算保护）+ LSP 预算保护 + warning 恒留；注入 Truncate.Service.limits | 净 +~35（含注释） |
| `packages/opencode/test/tool/edit.test.ts` | modify | slice 8 断言改为 diff 形态；新增 slice 9（create 变化说明）、slice 10（formatter 后一致性）、slice 11（截断保护，Layer.mock 小 limits） | +~95 测试行 |
| `packages/opencode/src/tool/edit-apply.ts` | 不动 | R2/R3 已验证内容保持 | 0 |
| `docs/plans/edit-identical-noop-tolerance.md` | modify（本文件） | 0（生产外） | 0 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1-7 | （R2/R3 已实现并绿） | — | — | INV-01..08（保持） |
| 8（更新） | 文件 "a\nb\nc"；edits [{a→x},{b→y},{c→c}] → output 含 `Changed:`、diff 行 `-a`/`+x`/`-b`/`+y`，且不含 `-c`/`+c`；归一化用例（"foo - bar"→"foo - bat" on "foo – bar"）output 含 `-foo – bar`/`+foo - bat` | per-block 形态将被替换；新断言在 R3 代码下红（无 diff 行） | Changed = trimDiff 后的 diff 文本 | INV-09 / R-01 |
| 9（新增，create） | 文件不存在；create {oldString:"",newString:"line1\nline2\n"} → output 含 `Changed:` 与 `+line1`；**且权限请求 metadata.diff 非空含 `+line1`**（用捕获 ask 的 ctx 变体断言） | R3 create output 无任何变化说明（B-01）；R4 若删 192-199 则权限 diff 变空（R5 修正） | 出口统一 diff：create 的 Changed 段列出全加行；权限预计算保留 | INV-09 / B-01 / 权限面回归锁 |
| 10（新增，formatter） | mockFormatLayer 下（itFormatted）：文件 "a\nb"；edits [{oldString:"a",newString:"d"}] → output 的 Changed 段反映最终磁盘（含 formatter 追加的尾行差异） | per-block 展示 formatter 前数据（B-02a）；R3 下断言最终态行会红 | 出口在 commit/formatter 后重算 diff | INV-09 / B-02a |
| 11（新增，截断） | Layer.mock(Truncate.Service, limits 1024B/20 行 + output pass-through) 下：文件含 2KB 长行 + "b"；edits [{长行→长行变体},{c→c}] → output 含 "Warning: 1 of 2" 且总字节 ≤ 1024 | R3 per-block 行 >1024B → wrapper head 截断 → warning 丢失（B-02b） | 预算保护：diff 段裁剪 + warning 恒留；output ≤ limits 使 wrapper 不截断 | INV-10 / B-02b |

测试 seam：`run`/`fail` harness（`run(args, next?)` 支持覆盖 ctx —— slice 9 用捕获 `ask` 请求的 ctx 变体断言权限 metadata.diff）；slice 10 用既有 `itFormatted`（mockFormatLayer）；slice 11 用新的 `Layer.mock(Truncate.Service, { output, limits })` 实例（损坏其他方法会抛错的设计正好保证不触碰 wrapper 依赖面）；断言用子串（diff 行、warning）与字节/行上限，期望值独立。

## 16b. 审计放行记录

### R5 plan 独立审计（adversarial-auditor，invocation ses_0063168dcffeeqmnsaNEqQ22Gm，2026-08-13，全新会话）

**Release verdict: APPROVE — 仅针对已审计的 plan revision R5（plan audit，full-scope）。**

Blocking findings: 无。R4 的 B-01（权限预计算删除）已通过保留两分支 pre-ask diff 预计算解决（permission.tsx:40,53-84、session-cache.ts:56-71 请求侧消费保持）；出口重算仅覆盖 metadata/output 通道；B-02a（post-formatter 真值）经两分支 commit 内 syncFile 后统一出口重算成立；B-02b（预算保护）与 truncate.ts/tool.ts:164 行为同源，默认 limits 下最坏 ≈14.6KiB ≤ 16KiB；无 fallback、无第二数据源、无通用层改动；slice 8-11 均 red-capable（含 slice 9 的 ask-捕获 seam 与 slice 11 的 Layer.mock）；克制预算成立（累计 3 文件、生产 +56/−22 + R5 ≈+35）。

Non-blocking findings（原样记录，不触发重审）：

- **N-1**：LSP 段阈值应钉精确为"剩余预算 − (warning + marker)"的公式（已按此修正 §10 决策7 表述），否则 1.86-1.95KiB 级真实 LSP 块 + warning 可能越过默认 16KiB。
- **N-2（引用漂移）**：non-create 重算实际 308-315、LSP 段 373-393、create format 同步 216；run/tool.ts、scrollback.writer.tsx 是结果侧 metadata 消费而非权限请求消费（请求侧为 permission.tsx、session-cache.ts）。无行为后果。
- **N-3（措辞精度）**：compaction 路径始终传 `{ head: 400, tail: 2000 }` 且保留尾部，末尾 warning 在压缩投影中反而安全；plan §20 的"默认未配置"措辞不精确。

Verdict 记录后按 policy 仅进行管理性字段更新：Status → approved、Approved revision → R5、Implementation allowed → yes；§10 决策7 的 LSP 阈值公式按 N-1 做记录修正（非实质性设计变化）。

## 16c. Implementation Evidence（2026-08-13，R5）

### 实际改动（相对仓库基线，含 R2-R5 全流程）

| File | diff | R5 责任 |
| --- | --- | --- |
| `src/tool/edit.ts` | +94/-部分 | 出口统一 diff 重算（两分支后、metadata 前）；删除 non-create 分支重复重算与 per-block syncEditsDisplay；syncInput 恢复内联；output 组装改为预算纪律（Changed=post-formatter diff 段 + LSP 段剩余预算检查 + warning 恒留）；注入 Truncate.Service.limits |
| `src/tool/edit-apply.ts` | +32（R2/R3 内容，本修订零改动） | — |
| `test/tool/edit.test.ts` | +239 | slice 8 更新为 diff 行断言；新增 slice 9（create 变化说明 + 权限 diff 断言）、slice 10（formatter 后真值，itFormatted）、slice 11（预算保护，itTruncated Layer.mock） |

### Red-Green 与验证

- slice 8 两用例 + slice 9/10/11 在 R3 生产代码下全红（5/5），R5 实施后全绿。
- `bun test test/tool/edit.test.ts`：**76 pass / 0 fail / 4045 expect**。
- 邻近套件：apply_patch 50 + write 24 = 74 pass / 0 fail。
- `bun typecheck`：唯一错误为并发 worktree 的 test/cli/cmd/tui/sync.test.tsx:255（非本 diff 文件，R3 前已存在）。
- 预算：3 文件、生产净 +~64 行 ≤ 600（R-05 ✓）。

### E/C（R5 口径）

- R5 delta E ≈ 60（edit.ts ~35 + 测试 ~95 扣除移动/import/空行；审计将以实际 diff 重算）。
- C：新增注释约 19 条（出口重算理由、预算三要素、warning 恒留、LSP 宁断示标、slice 11 mock 意图等）。ratio ≈ 0.19 ≥ 0.15。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ≈140（edit.ts ~45 + 测试 ~95，剔除移动/import/格式） | 见 §15 |
| Required Chinese explanatory comments `C` | `C >= max(1, ceil(140*0.15)) = 21` | 计划 ≥ 22 |

计划注释点：出口重算理由（formatter 后真值、create 覆盖）；Changed 段与 metadata.diff 同源（防双源漂移）；预算保护三要素（limits 同源、diff 可裁、warning 不可裁——B-02b 教训）；LSP 段宁断示标不丢 warning；slice 11 的 mock 意图（wrapper 只依赖 output/limits）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts` | packages/opencode | slice 1-11 全绿（预计 76 用例：73 既有 + slice 9/10/11 新增） |
| `bun test test/tool`（尽力） | packages/opencode | 邻近套件回归；环境失败如实归类 |
| `bun typecheck` | packages/opencode | 无本 diff 错误（并发 sync.test.tsx 既有错误除外） |
| `git diff --stat` | 仓库根 | ≤4 文件、生产 ≤600 行 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files modified | 2 生产（edit.ts；edit-apply.ts 零改动）+ 1 测试 | ≤4（R-05） |
| Production lines | 净 +~35 | ≤600 |
| Test lines | +~95 / 更新既有 | — |

## 20. Real Risks and Open Decisions

### 真实风险（observed / reachable）

1. diff 段裁剪后部分变化行不在 output（模型看不到完整 diff 行）——受 limits 物理约束；裁剪标记（纯事实句）与 metadata.diff（TUI/权限可见通道）兜底；比 head 截断全丢（没有任何 warning）严格更强。记录为设计取舍。
2. 预算保留值（2KiB/10 行）为保守常数：LSP 段超长时走"宁断示标"分支，warning 恒留；自定义极端 limits（N-01 支持域之外）声明为"尽力保留"。
3. create+format 场景：出口 diff 反映最终内容（与 `_syncInput` create 分支 219-222 的最终文本原则一致）；create/overwrite 权限请求的 diff 预计算保留（可见预览不回归）。
4. 环境验证限制（并发 worktree typecheck/tool 全量不稳定）如实记录，双审计复核。

### Non-blocking notes（speculative）

- message-v2 投影层的二次截断（truncateToolOutput head/tail options）默认未配置；若将来配置启用，同预算纪律仍保证 output ≤ 默认 limits，投影 options 需另有专责（记录不修）。

### Open Decisions Requiring the User

无。

## Audit Contract

- 审计材料：本文件 R5、仓库根。
- 历史：R1→R2→R3 流程见前记录；R4 全新 plan 审计（ses_0063f5e4dffeKnSMchuS2hbPFu，2026-08-13）返回 BLOCK：B-01（R4 删 192-199 清空 create/overwrite 权限请求 metadata.diff，审批预览退化，违反 R-06）+ N-01（预算支持域/clamp）、N-02（截断标记勿指向模型不可见的 metadata 通道）、N-03（收敛表述精度）、N-04（用例数 79→76）。本修订（R5）逐项解决：权限预计算保留、出口仅覆盖 commit 后真值、slice 9 增权限 diff 断言、支持域声明 + clamp、纯事实句截断标记、表述与计数修正。
- 本次 plan 审计须以全新 task 启动；blocker 后修订须再以全新 task 全量重审。
- R5 实施后须以全新 task 启动 implementation audit（用户约定：每次审计均为全新会话）。

## Implementation Audit Record（2026-08-13，R5，全新会话）

### 独立实现审计（adversarial-auditor，invocation ses_00619499dffeQ3R1KuKcRQZ3lP）

**Release verdict: APPROVE — 当前 R5 修订与工作树实现 diff 一致，无阻塞缺陷；仅适用于本次审计的精确修订与 diff 范围（edit.ts、edit-apply.ts、edit.test.ts），full-scope。**

Blocking findings: 无。

Non-blocking findings（原样记录，不触发重审）：

- **N-1（省略计数可能 +1 膨胀）**：edit.ts:377 diff.split("\n") 在 diff 以换行结尾时含尾部空串元素，计入 omitted；纯文案精度，无行为后果。
- **N-2（账务保守偏移）**：edit.ts:375-376 对 "\n\nChanged:" 计 11 字节/3 行，实际 10 字节/2 行，方向保守，不影响 INV-10。
- **N-3（LSP 超限非 block 分支静默丢弃）**：极端自定义 limits 域才可见，plan §10 决策7 已声明"尽力保留"，不阻塞。
- **N-4（记录级引用漂移）**：plan §4/§5 行号为早期树编号（实际 edit-apply.ts:472-493、513-519）；§16c E≈60 只计 R5 增量而实际累计 E≈261。无行为后果。

Auditor 独立复核要点（原样记录）：76+74 测试全绿与 typecheck 唯一并发错误复现；出口统一 diff 与 metadata.diff 同一字符串（单一真值）；两分支 pre-ask 权限预计算保留 + slice 9 断言锁死 R4 回归；预算保护与 truncate.limits 同源、缺省域最坏 ≤ ~14.3KiB < 16KiB；E≈261、C≈40、ratio≈0.153 ≥ 0.15；无 fallback、无第二数据源、通用层/TUI/apply_patch/write/processor 零改动；red 能力对 HEAD 全部成立。

Verdict 记录后按 policy 仅进行管理性字段更新：Status → verified、Approved revision → R5、Implementation allowed → no further changes without revision；无任何实质性设计修改。
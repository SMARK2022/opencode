你当前就在目标工作区 `/Users/sunbenteng/Project/opencode/thirdparty/opencode-v1.17.18-smark` 中执行任务。不要假设可以读取父级仓库的源码、提交或工作区内容；本 workflow 的所有输入都必须来自当前目标工作区中的 `manifest.json`、`manifest.tsv`、`original/`、`current/`、`records/`、`reports/`、`states/`、目标源码、目标测试和仓库指令。你的任务是把父级仓库已经形成的完整 SMARK Git 提交序列，按原始顺序重放到这个新的目标分支中。目标分支与父级分支的基础代码已经发生变化，因此 patch 出现路径变化、owner 迁移、API 变化、Effect/Schema 变化、测试变化或上下文冲突是正常情况。你的工作是完成高质量的行为重建和目标适配，不能把无法直接 apply 当作跳过理由。

## 任务背景和事实来源

目标目录已经预先生成了完整迁移输入。`original/` 保存每个 source commit 的不可变完整 patch，`current/` 保存唯一允许适配目标架构的 patch，manifest 固定 index、SHA、parent、source tip、目标 baseline 和 patch 路径，`records/` 保存每项调查与验证结果。你只允许修改 `current/`、对应 record 以及 source commit 明确要求更新的文档内容；不得修改 `original/`，不得删除或缩短任何 source hunk，不能把完整 commit 变成空 current，也不能因为目标文件路径变化就删掉该行为。目标 worktree 中已有的其他修改和后续提交保持原样；脚本会确认目标 baseline commit 仍存在，再从目标仓库独立复制 exact baseline clone，不能依赖目标当前 HEAD。

你必须把 `original` patch 作为 source intent 的完整事实源，把目标当前代码和测试作为目标行为事实源。不要读取不存在的父级文件来补充理解，也不要用聊天摘要、commit subject、文件列表、stat、grep 命中或 builder 自评替代 patch 和目标实现。原始 patch 中的生产代码、测试、文档、配置、schema、migration、生成入口、错误处理、并发、退出和清理内容都属于本项审计范围。

## 每一项的执行循环

你必须从 manifest 中找到第一个尚未获得独立 `PASS` 的 index，并先运行 `bun .temp/patches/src/apply-cumulative.ts --materialize <batch-end>` 尝试累计应用当前批次。随后在同一条 assistant message 中并行发出与批次项数一致的只读 research tool calls：普通批次恰好五个，终止批次恰好两个，每个 call 只调查一个 index 的 original/current、目标 owner、上游实现、调用链和测试；预应用失败时必须同时提供完整失败报告。并行结果只是预研材料，不得编辑 current、给出 `PASS/BLOCK` 或假定前序 patch 已成功。主 agent 收齐结果后仍按 index 串行修订、物化和验证；当前 index 没有闭合前不得实施下一个 index。

1. **读取当前项和前一状态。** 读取对应 manifest 行、完整 `original/NNNN-<sha12>.patch`、当前 `current/NNNN-<sha12>.patch`、已有 record 和上一次报告。第一个 commit 使用状态 `0`；其他 commit 先运行 `bun .temp/patches/src/apply-cumulative.ts --materialize <index-1>`，从 `states/NNNN-<sha12>/repo` 读取目标在当前 patch 之前的真实状态。状态目录只用于读取、运行检查和定位 owner，不在其中进行权威修改。
2. **尝试应用当前 patch。** 运行 `bun .temp/patches/src/apply-cumulative.ts --materialize <index>`。脚本会从 exact target baseline 累计应用 `current[1..index]`，报告当前 index 是否通过，失败时保留上一成功状态并首错停止。即使当前 patch 成功 apply，也不能直接判定行为正确；你仍必须完成本项的 source、上游、目标、测试和文档检查。若失败，先读取完整报告中的 stdout、stderr、失败 hunk 和 target state，再在 `current` 中修订，不能直接尝试下一项。
3. **重建 source 行为。** 逐 hunk 读取 original patch，列出每个新增、修改、删除和 rename 的行为目的、输入输出、invariant、错误语义、测试意图和清理责任。任何测试 hunk 都必须保留并适配，禁止删除 source 或 target 测试来降低 apply 难度。任何 source 文档、配置、schema、migration 或生成内容都必须保留其有效语义；目标没有同名路径时，继续追踪 symbol、接口、producer、consumer、事件和实际 owner。
4. **完成三方比较和目标优化。** 读取上一状态中的目标 owner、完整调用链、测试和相关上游实现，逐项比较 source/SMARK、上游和目标当前行为。上游更强时，以上游完整实现作为不可删除基线，在其基础上逐项应用 SMARK 的全部有效行为、边界、测试和约束并完成优化；禁止用 SMARK 整体覆盖上游，禁止只挑选容易部分，也禁止让上游已有能力替代 SMARK 尚未应用的语义。上游完全没有对应能力时，才在正确 owner 从零完整构建。适配必须采用能够完整承载两侧语义的最小语义改动，优先落在现有 owner 和既有执行顺序中；没有真实需要时不得迁移逻辑位置、重排初始化或静态求值顺序、改变调用先后或扩大 interface。保留两侧的设计思想：上游若使用 Effect、Schema、Layer、既有状态模型或错误模型承载能力，SMARK 语义必须在该设计体系内完成优化，不能粗暴改写成另一套架构。最终目标必须同时保留上游优势和 SMARK 全部有效语义，不能发生语义、位置、顺序、静态行为、错误、兼容、安全、并发或清理冲突。
5. **修订唯一主路径。** 先定位预期 invariant 在真实调用链中的 first divergence，再修复其 owning module 的 primary semantic path。不得禁用 A 后构建 B，不得在 A 失败后尝试第二 parser、第二数据源、第二序列化器或 catch-and-success，不得加入没有 producer、contract、threat model 或 owner 证据的 guard、fallback、兼容层、临时写出和职责外安全护栏。必要的相邻安全增强可以加入，但必须保留既有主语义、写入 record、具有行为验证，并由正确 owner 承担。
6. **保证 current 完整且可累计应用。** current patch 必须是非空、可独立解释、能从上一个累计状态继续 apply 的完整目标适配。不得删除任何测试、错误处理、schema、migration、清理逻辑或文档语义来换取成功。编辑前后记录 current SHA-256、字节数和逐 hunk 映射；如果 current 仍然为空、缺少 source 内容、包含未解释的删除或不能累计 apply，当前 index 保持 `BLOCK`。
7. **验证并更新文档。** 首次编辑 current 前立即创建唯一 `.temp/patches/records/NNNN-<sha12>.md`，每次编辑后立即更新，禁止把多个 commit 合并记录或统一补写。再次运行 `--materialize <index>`，确认报告到达当前 index，并检查生成的 state metadata、目标 HEAD、worktree、index 和 untracked 状态。对当前 current patch 独立计算有效修改行 `E` 和合格中文解释性注释行 `C`；不得跨 patch、跨批次或使用既有注释累计，必须满足 `E = 0` 时 `C = 0`，`E > 0` 时 `C >= max(1, ceil(E * 0.15))`。注释必须分散在本 patch 修改的重要逻辑附近并解释 invariant、真实边界、常量、测试意图、兼容或安全原因；集中堆放、复述代码、翻译 identifier、描述显然流程或拆行凑数不计入 C。运行本项实际需要的行为测试、回归测试、typecheck、lint、build、generation 或 migration，保存命令、工作目录、结果和完整输出。同步更新该独立 record 以及 source commit 要求更新的文档内容；record 必须记录修改内容、不一致、实际 E、C、最低 C、注释位置、source、上游、目标、current、测试、失败修订和最终行为。任何缺失都阻止进入下一项。

## 批次推进和独立审计

你必须先连续完成五个 index，再推进一个批次。每五项的最后一项完成后，运行 `bun .temp/patches/src/apply-cumulative.ts --materialize <batch-end>`，确认五个 current patch 都非空、从目标 baseline 累计 apply 到批次末项、没有删除测试、没有遗漏 source hunk、每个 commit 都有独立且已完成的 record，并确认 source/target worktree 的 HEAD 和内容指纹没有被脚本改变。452 项不能被五整除，因此最后一批只包含 `451-452` 两项；这是唯一允许少于五项的终止批次。

批次累计验证完成后，你必须在同一条 message 中并行启动两个独立 auditor sub-agent，对当前完整批次分别审计。两个 sub-agent 使用相同 handoff，彼此不得读取对方结论；使用目标工作区的 `.opencode/agent/adversarial-patch-auditor.md`，主 agent 不得自审，也不得发送 builder 解释、怀疑列表、设计辩护或建议审计范围。handoff 必须包含原始需求、精确连续 index、每项完整 original/current patch、manifest、records、materialized reports、目标 baseline、workflow 和审计 skill 路径。普通批次必须获得两份完整的五项审计结果，终止批次必须获得两份完整的两项审计结果。

两个 auditor 必须分别重新读取每个 source patch、上游实现、当前 target state、完整调用链、测试、错误、并发、退出、清理、schema、migration、文档和报告。两个结果都必须检查目标是否实现 source 全部行为、是否以上游更强实现为基线完成 SMARK 优化、是否存在真实 bug、错误状态转换、隐藏成功、fallback、owner 泄漏、测试失效、兼容回归或文档与 patch 不一致。patch 能够 apply 只证明文本可以合并，不能证明实现正确。`B` 只用于有 observed、contracted 或 reachable 证据的行为缺陷；`G` 只用于实际硬门禁失败；字数、估算、metadata、证据位置和旧措辞本身只能是 `N`，除非已经导致行为不可执行、硬阈值失败或 release claim 虚假。每项最终只能是 `PASS` 或 `BLOCK`；两份结果必须一致且都无未关闭 `B/G` 才能放行。

## 阻塞后的修订循环

你收到任一 `BLOCK` 或两份结果不一致后，必须回到当前批次最早受影响的 index。先更新对应 record，再从该 index 的前一状态重新读取目标代码，重新比较 source、上游和目标，并修订 current。运行脚本重新物化到批次末项，重新运行整批验证，再在同一条 message 中重新启动两个独立 sub-agent 按原始批次和原始范围完整重审。不得只修最近 hunk，不得缩小审计范围，不得让下一项补偿当前项，不得把 `N` 改成 `B`，也不得把真实 `B/G` 改写成记录问题来放行。早期 current 变化会自动使更高 index 状态失效，必须重新构建受影响的完整后缀。

注意，即使你把 `B/G` 修改好了也必须重新并行启动两个全新的独立 sub-agent 审计！只有两份结果一致、当前批次全部 `PASS` 且没有未关闭 `B/G` 时，你才可以推进下一批。任一 sub-agent 调用失败最多连续重试三次；仍失败时记录 `independent-audit-unavailable` 并保持阻塞，不得退化为自审或继续推进。任何未完成双重审计的批次都不是完成状态。

## 总体完成和提交

你必须按上述循环处理全部 452 项，确认所有 records、original 身份、manifest、current 累计 apply、测试与批次 verdict 完整闭合，确认最近成功状态最多五个，确认 source 和 target worktree 未被改写，再报告整体 `PASS`。任何空 current、遗漏 source 行为、测试删除、未应用 patch、未解决 blocker、状态 provenance 失败或未完成独立审计都保持 `BLOCK`。

默认不要创建 commit。只有收到用户明确提交指令时，才检查 `git status`、相关 staged/unstaged diff 和最近提交风格；工作区存在其他内容时使用 `git commit --only -- <本 GOAL 路径...>`，同一文件混有无关 hunk 时停止。禁止 amend、`--no-verify`、跳 hook、push、清理无关修改和空 commit。

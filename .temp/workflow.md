# SMARK Patch Migration Workflow

先固定 source、target、manifest 和当前批次。随后逐项调查、适配、累计物化并记录，五项完成后启动独立审计；批次通过才推进下一批。不要相信聊天摘要、builder 自评、旧结论或临时解释。

## 1. Initialize Once

迁移开始时固定 source repository `/Users/sunbenteng/Project/opencode`、分支标签 `dev-smark`、不可变 source tip `d0ceb469011412b4ac5058a12d5fe4f247bdac79`、首个 `SMARK|SMARK2022` commit、fork base、target baseline 和 manifest。分支可以继续前进，已固定的 source tip 不能随之移动。当前范围是从 `9f117055c5a8a09f5cc7080786accf853bdb25fe` 到该 tip 的第一父线非 merge commit，共 452 项。使用 `manifest.json`、`manifest.tsv` 和针对固定 tip 的独立 `git rev-list --first-parent --reverse --no-merges` 结果交叉确认全部 index、SHA、真实第一父 parent 和 patch 路径；数量、顺序、baseline 或 manifest hash 发生变化时立即停止。

主仓库只读。目标 worktree 可以保留其他人的修改，脚本只记录并验证运行前后 HEAD 与状态指纹不变。只编辑 `current/` 和对应 `records/`；`original/` 永久不可修改。每个 source commit 都必须拥有完整、非空的 current patch；空 current、被截断的 hunk、被删除的测试或只保留摘要的 patch 都是 `BLOCK`。reports、states 和 staging 只是生成物，不能反向成为 source 或设计依据。

## 2. Enter One Batch

从第一个没有独立 `PASS` 的 manifest index 开始。进入新批次前，确认所有此前 index 都有完整记录、累计 apply 已到达前一项、此前每个审计边界均已通过，且没有未关闭 `BLOCK`。正常批次取连续五项。452 不能被五整除，因此最后一批固定为连续的 451-452 两项；这只是终止批次的明确输入例外，逐项证据和审计标准完全不变。

任何跳过、重排、重复、提前准备下一批或用后续 patch 补前一项的行为都立即停止。当前批次的每个输入必须包含准确的 manifest index、SHA、parent、完整 source diff、非空 original/current patch、完整 record 和目标基线；只给范围、汇总 diff、文件列表或口头说明不满足进入条件。

## 3. Process One Commit

批次内部严格重复以下单项循环。主 agent 一次只处理一个 index，当前项没有形成完整记录和成功验证前，不读取、编辑或应用下一项。

1. **Admit the entry.** 读取该项的完整 manifest 记录，确认 index、SHA、parent、original/current 路径和前一成功状态。第 1 项先物化 baseline `0`；其他项先执行 `bun .temp/patches/src/apply-cumulative.ts --materialize <index-1>`，再从该状态读取目标真实代码。
2. **Reconstruct the behavior.** 完整读取 `git show --format=fuller --no-ext-diff --binary --find-renames <sha>` 和不可变 original patch。记录每个 hunk 的行为意图、invariant、测试、配置、schema、migration、生成、错误、并发、退出和清理路径。路径不存在时追踪 symbol、producer、consumer 和真实 owner，禁止以文件缺失结论跳过行为。
3. **Compare before editing.** 读取目标状态的完整 owner、调用链和测试，并逐项比较上游与 SMARK。上游更强时，以它的完整实现作为不可删除基线，在其基础上逐项应用 SMARK 的优秀全部有效行为、边界、测试和约束并完成优化；禁止用 SMARK 整体覆盖上游，也禁止只挑选容易部分。上游完全没有对应能力时，才在正确 owner 从零完整构建；两种路径都必须保留 SMARK 的全部语义，最终目标同时包含上游优势与 SMARK 有效内容。先定位 first divergence，再修复唯一 primary semantic path。A 失败后切 B、第二 parser、第二数据源、catch-and-success、无证据 guard 或职责泄漏均为 `BLOCK`。
4. **Edit only current.** 记录编辑前 current 的 SHA-256 和字节数，只修改 current patch 与本项 record。current 必须保留 source 的完整行为内容并能够在累计状态中 apply；禁止把 commit 改成空 patch，禁止删除任何 source 或 target 测试，禁止删除错误、schema、migration 或清理语义来换取 apply。新增安全处理必须有真实 reachability、threat model、仓库规则或 confirmed invariant，并属于正确 owner。
5. **Materialize and verify.** 执行 `bun .temp/patches/src/apply-cumulative.ts --materialize <index>`。脚本从 exact target baseline 累计应用 `current[1..index]`，成功后发布 `states/NNNN-<sha12>/repo`，失败首错停止并回收 staging。状态只用于读取和验证，权威修改仍在 current；同一 index 只有一个状态，全局只保留最近成功发布的五个状态，按发布时间回收，绝不按 index 大小保留。
6. **Close the record.** 运行该项实际需要的行为测试、回归测试、typecheck、lint、build、generation 或 migration，保存命令、目录、结果、完整 stdout/stderr 和状态路径。记录必须逐 hunk 说明 source、upstream、target、patch、测试和最终行为一致性，确认没有测试删除、空 patch、遗漏文件或未解释的上游行为变化；任一缺口使当前项保持 `BLOCK`。

## 4. Prepare and Submit the Batch Audit

五项批次或最终两项批次的每个 record 完成后，主 agent 必须重新执行累计物化到批次末 index。主 agent 必须确认 simulation clone 从 exact target baseline 开始，初始 worktree、index 和 untracked 状态为空，最终结果只来自有序、非空 current 前缀；主 agent 必须确认 source/target HEAD 与状态指纹未改变，manifest、original hash、状态 metadata 和 records 互相一致。累计 apply 未到达批次末项、任一 current 为空或任一测试被删除时，主 agent 不得提交 handoff。

主 agent 必须启动 `.opencode/agent/adversarial-patch-auditor.md` 对当前完整批次进行独立审计。handoff 只提供原始用户需求、目标根目录、批次精确 index/SHA/parent、source diff、original/current patch、逐项 record、物化报告、workflow 和审计 skill 路径。不要提供 builder 解释、设计辩护、怀疑列表、建议重点、已检查声明或缩小后的审计范围。

## 5. Independent Batch Audit

被启动的独立 auditor sub-agent 必须先读取自己的 Trust Model、workflow、policy 和审计 skill，再从仓库重建事实。它必须逐项读取 source、上游、目标状态、调用链、测试和报告，比较上游与 SMARK 哪一方更强，以更强的实现为基线完成优化，检查最终实现是否存在 bug、错误状态转换、隐藏成功、错误吞没、并发/清理漏洞、schema 漂移、权限回归或测试无法捕获真实行为，并核对 patch、record、目标结果和文档是否一致。patch 能 apply 只证明文本可合并，不能证明行为正确。

finding 分为三类。`B` 只用于有 observed、contracted 或 reachable 证据的行为、兼容、安全、并发、清理、owner 或测试可信度缺陷。`G` 只用于实际违反已适用的硬门禁，例如实现后的 15% 中文解释性注释不足、实际 diagnostic decision surface 超过 10%、approved revision 漂移或明确要求的验证未完成。估算、字数、metadata、表格位置、证据搬运和旧措辞本身是 `N`，除非它们已经造成行为不可实施、硬阈值可证明失败或 release claim 虚假。无法证明 producer、owner、契约或可达性的意见是 `Rejected speculation`。

主 agent 必须收到正常批次的五项独立结果或终止批次的两项独立结果。每项只能是 `PASS` 或 `BLOCK`，任何 `B/G` 都阻止整批放行。auditor 不得因格式问题伪造 behavior consequence，也不得因模型认为“整体差不多”降低真实 blocker。

## 6. Repair or Advance

主 agent 发现 `BLOCK` 时必须回到该批次最早受影响的 index。主 agent 修订 current 前必须更新对应 record；早期 patch 变化会使所有后续状态自动失效，必须从该 index 重新物化到批次末项，并重新运行整批验证和完整审计。不得只复核最近 hunk，不得使用下一项补偿当前项，不得把 `N` 改写成 `B`，也不得把 `B/G` 改写成记录问题来放行。

主 agent 只有在整批全部 `PASS` 且无未关闭 `B/G` 后，才可以把批次写为 released，并回到第 2 步计算下一批。auditor 调用失败最多连续重试三次；仍失败时主 agent 必须记录 `independent-audit-unavailable` 并保持 `BLOCK`，不得自审或继续推进。

## 7. Complete and Explicit Git Actions

第 452 项通过最终两项批次后，复核 452 项记录、所有批次 verdict、manifest 独立重建、original 不变、current 累计可应用、最近状态不超过五个、source/target 未被改写以及所有真实验证证据，才可报告整体 `PASS`。任何未验证项、未解决 `B/G`、审计轮次用尽或状态 provenance 失败都保持 `BLOCK`。

迁移默认不创建 commit。只有用户明确要求提交时，才检查 `git status`、相关 staged/unstaged diff 和最近提交风格；工作区含有其他内容时使用 `git commit --only -- <本 GOAL 路径...>`，同一文件混有无关 hunk 时停止。禁止 amend、`--no-verify`、跳 hook、push、清理无关修改和空 commit。

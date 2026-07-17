# SMARK Patch Replay

该目录保存从 `dev-smark` 第一父线生成的逐提交 patch，并提供只修改临时 clone 的累积 dry-run。

## 范围

- 首个 SMARK 提交由作者名 `SMARK` 或 `SMARK2022` 识别。
- 当前首个识别结果是 `9f117055c5a8a09f5cc7080786accf853bdb25fe`。
- 其父提交记录为 fork 基线。
- 生成时先把移动中的 `dev-smark` 固定为 `sourceTip`，集合只包含首个 SMARK 提交到该 tip 的第一父线非 merge 提交。
- 通过 merge 提交带入的上游侧历史不会生成 patch。

## 文件约定

- `original/` 是从源 commit 直接生成的不可改原始 patch。
- `current/` 是实际 dry-run 使用的副本，修复路径或冲突时只编辑这里。
- `manifest.json` 保存完整 SHA、父提交、作者、主题、源路径和目标基线。
- `manifest.tsv` 供人工审计和外部 agent 使用。
- `reports/` 保存每次运行的 JSON 和 Markdown 成功/失败报告。
- `states/` 保存按 index 物化的累计目标状态，同一 index 唯一且最多保留最近成功发布的五个。
- `src/generate.ts` 重新识别首个 SMARK 提交并生成 patch 集合。
- `src/apply-cumulative.ts` 在临时 clone 中按序累积应用 patch，首个错误即停止。

## 生成

从目标 worktree 根目录执行：

```bash
bun .temp/patches/src/generate.ts
```

生成器拒绝覆盖非空的 `original/` 或 `current/`，避免无意丢失已修订 patch。

## Dry-run

```bash
bun .temp/patches/src/apply-cumulative.ts --keep-failure
```

脚本会：

1. 检查 manifest baseline commit 仍存在于目标仓库，并记录目标 worktree 的完整前后指纹；目标 HEAD 可以已经前进，已有无关修改不进入 clone，也不会被清理。
2. 从源仓库创建隔离临时 clone。
3. 对每个 `current` patch 先执行 `git apply --check`，再执行实际应用。
4. 每一步保存累计状态，失败时恢复到上一个成功状态。
5. 将文件不存在、路径不匹配、冲突、二进制不匹配和未知错误分别记录。
6. 第一个失败后停止，不尝试后续 patch。

dry-run 不在目标仓库执行 `git apply`、`git am`、`git cherry-pick` 或 `git commit`，也不修改目标 refs。

## Materialize

```bash
bun .temp/patches/src/apply-cumulative.ts --materialize <index>
```

`index=0` 物化 exact target baseline；`1..452` 从 baseline 累计应用 `current[1..index]`。成功状态发布到 `states/NNNN-<sha12>/repo`，失败构建不会替换同 index 的旧成功状态。脚本会清理中断 staging、恢复未完成发布事务、删除 provenance 失效状态，并按成功发布时间保留最近五个状态，绝不按 index 大小保留。

## Per-Commit Records

在首次编辑每个 current patch 前创建 `.temp/patches/records/NNNN-<sha12>.md`，并在每次编辑、materialize、测试和审计结果后立即更新。每个 manifest commit 只能有一份独立完整 record，禁止合并多个 commit、延迟创建或在批次结束时统一补写。Record 必须说明 source 行为、上游与目标的不一致、实际适配、保留和修订的行为、验证证据以及最终审计 verdict。

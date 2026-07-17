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
- `states/.source-proof.json` 缓存一次完整的 452 项 source 身份证明。
- `states/.test-workspace/` 保存唯一可安装测试环境，不向审计 state 复制依赖。
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
2. 初次使用 local Git objects 建立 exact baseline；后续从最大有效 materialized prefix 做 APFS COW 复制。
3. 对每个 `current` patch 先执行 `git apply --check`，再执行实际应用。
4. 每一步保存累计状态，失败时恢复到上一个成功状态。
5. 将文件不存在、路径不匹配、冲突、二进制不匹配和未知错误分别记录。
6. 第一个失败后停止，不尝试后续 patch。

dry-run 不在目标仓库执行 `git apply`、`git am`、`git cherry-pick` 或 `git commit`，也不修改目标 refs。

## Materialize

```bash
bun .temp/patches/src/apply-cumulative.ts --materialize <index>
```

`index=0` 物化 exact target baseline；`1..452` 复用最大有效前缀并只应用新增 current。exact state 已存在时直接复用。成功状态发布到 `states/NNNN-<sha12>/repo`，失败构建不会替换旧成功状态。脚本会清理中断 staging、恢复未完成发布事务、删除 provenance 失效状态，并按成功发布时间保留最近五个状态，绝不按 index 大小保留。

旧版本使用 full-object clone 生成的状态可用显式 maintenance 命令重建：

```bash
bun .temp/patches/src/apply-cumulative.ts --materialize <index> --rebuild
```

`--rebuild` 只跳过 exact-state 复用，并从最近更小的有效前缀重建目标状态；它不会改变 current patch、source 顺序或审计语义。

## Source Proof

```bash
bun .temp/patches/src/apply-cumulative.ts --verify-source
```

该命令强制重新枚举 452 个 source commit、校验 parent、生成 fresh format-patch 并更新 `states/.source-proof.json`。普通 materialize 仍逐项验证 original 文件哈希、manifest 和 TSV，但复用已通过的 source proof，避免每次重做相同的 452 项 Git 证明。

## Automatic Install and Typecheck

```bash
bun .temp/patches/src/apply-cumulative.ts --typecheck <index>
```

该命令先执行同一增量 materialize 主路径，再把权威 staged diff 同步到 `states/.test-workspace/repo`。脚本计算全部 package manifests、Bun lockfiles、bunfig、patched dependencies 和 Bun 版本的安装指纹；指纹变化时自动运行 `bun install --frozen-lockfile --backend=clonefile`，未变化时复用现有依赖。具有独立 `bun.lock` 的受影响 workspace 会在自己的依赖边界执行同一 frozen install。随后仅在实际受影响且声明 `typecheck` script 的 workspace 中执行 `bun typecheck`，首个失败即停止并写入 JSON/Markdown report。Materialized states 不包含 `node_modules`。

## Per-Commit Records

在首次编辑每个 current patch 前创建 `.temp/patches/records/NNNN-<sha12>.md`，并在每次编辑、materialize、测试和审计结果后立即更新。每个 manifest commit 只能有一份独立完整 record，禁止合并多个 commit、延迟创建或在批次结束时统一补写。Record 必须说明 source 行为、上游与目标的不一致、实际适配、保留和修订的行为、验证证据以及最终审计 verdict。

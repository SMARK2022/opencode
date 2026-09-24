# SMARK Patch Replay

该目录保存 `dev-smark` 的逐提交 patch，并提供只修改临时 clone 的累积 dry-run。1–452 固定保留，新增提交按祖先优先顺序接在其后。

## v1.18.32 迁移起点

当前分支 `smark-port-11832` 的产品源码以官方 `545f51d26cc39a907d2867492d498d9607ea5fa4` 为基线，原目录名保持不变。旧分支已推送至 `origin/smark-port-11720`，归档提交为 `b64e18184`。

当前分支已线性 rebase：官方 `v1.18.32` release 后接原有 21 个迁移提交及后续调整，迁移历史中不保留旧 release 的合并节点。正式脚本的 `--verify-source` 已核验全部 644 项，`--materialize 0` 已生成 HEAD 为该 release 的实际起始状态。

本轮脚本将所有新状态和报告分别限定在 `states/v1.18.32/`、`reports/v1.18.32/`；下文同名路径均以这两个子目录为根。原有 states、reports 及其 ignored 内容保持原位，不参与新基线的复用、清理或安装。

active manifest 共 644 项。1–452 的编号、顺序与 current/original 内容保持不变；新增 192 项统一编号 453–644，两侧文件均直接位于 original/current 根目录，命名为 `NNNN-<sha12>.patch`。453–488 对应此前补出的 36 项历史提交，489–644 对应原来的 453–608。此前 PASS 属于旧基线，新基线按完整序列重新验证。

## 范围

- 首个 SMARK 提交由作者名 `SMARK` 或 `SMARK2022` 识别。
- 当前首个识别结果是 `9f117055c5a8a09f5cc7080786accf853bdb25fe`。
- 其父提交记录为 fork 基线。
- `sourceTip` 固定完整范围；前 452 项沿用既有第一父线，剩余可达 SMARK 非 merge 提交按逆拓扑遍历的祖先优先顺序追加。
- merge 提交本身排除，merge 带入的 SMARK 普通提交包含在序列内；纯上游侧提交不作为新增 SMARK patch。

## 文件约定

- `original/` 是从源 commit 直接生成的不可改原始 patch。
- `current/` 是实际 dry-run 使用的副本，修复路径或冲突时只编辑这里。
- `manifest.json` 保存完整 SHA、父提交、作者、主题、源路径和目标基线。
- `manifest.tsv` 供人工审计和外部 agent 使用。
- `reports/` 保存每次运行的 JSON 和 Markdown 成功/失败报告。
- `states/` 保存按 index 物化的累计目标状态，同一 index 唯一且最多保留最近成功发布的五个。
- `states/.source-proof.json` 缓存一次完整的 manifest source 身份证明。
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

`index=0` 物化 exact target baseline；`1..644` 复用最大有效前缀并只应用新增 current。exact state 已存在时直接复用。成功状态发布到 `states/NNNN-<sha12>/repo`，失败构建不会替换旧成功状态。脚本会清理中断 staging、恢复未完成发布事务、删除 provenance 失效状态，并按成功发布时间保留最近五个状态，绝不按 index 大小保留。

旧版本使用 full-object clone 生成的状态可用显式 maintenance 命令重建：

```bash
bun .temp/patches/src/apply-cumulative.ts --materialize <index> --rebuild
```

`--rebuild` 只跳过 exact-state 复用，并从最近更小的有效前缀重建目标状态；它不会改变 current patch、source 顺序或审计语义。

维护过程自动串行，缓存内的 SQLite 互斥锁随进程退出释放，与应用数据库隔离。污染、缺失或指纹失效的 state 会被排除并回收，从健康前缀继续构建；追加 manifest 尾项保持旧前缀可复用。删除遇到临时占用时记录延期清理，失效目录仍不会进入复用候选。发布使用完整目录 rename，失败恢复备份，不递归覆盖旧状态。

构建以本次读取的 patch 内容为准，应用前和发布前复核输入；发现并行编辑或复制期间状态变化时最多自动恢复两次。所有临时构建均位于 states 内，异常退出后的残留由下一次维护清理。Git 命令上限两分钟，Bun 安装与类型检查上限五分钟；原始 patch 身份校验每批十六项，单个 Git 子进程上限一分钟。

## Source Proof

```bash
bun .temp/patches/src/apply-cumulative.ts --verify-source
```

该命令强制重新枚举 manifest 的全部 source commit、校验 parent、生成 fresh format-patch 并更新 `states/.source-proof.json`。普通 materialize 仍逐项验证 original 文件哈希、规范编号路径、manifest 和 TSV，但复用已通过的 source proof，避免每次重做相同的 Git 证明。

## Automatic Install and Typecheck

```bash
bun .temp/patches/src/apply-cumulative.ts --typecheck <index>
```

该命令先执行同一增量 materialize 主路径，再把权威 staged diff 同步到 `states/.test-workspace/repo`。脚本计算全部 package manifests、Bun lockfiles、bunfig、patched dependencies 和 Bun 版本的安装指纹；指纹变化或依赖目录缺失时自动运行 frozen install，macOS 使用 clonefile、Windows/Linux 使用 hardlink；输入未变化且依赖目录存在时复用现有依赖。安装保持完整的 package/lockfile 内容，不临时删改指定依赖。具有独立 `bun.lock` 的受影响 workspace 会在自己的依赖边界执行同一 frozen install。随后仅在实际受影响且声明 `typecheck` script 的 workspace 中执行 `bun typecheck`，首个失败即停止并写入 JSON/Markdown report。Materialized states 不包含 `node_modules`。

## Per-Commit Records

在首次编辑每个 current patch 前创建 `.temp/patches/records/NNNN-<sha12>.md`，并在每次编辑、materialize、测试和审计结果后立即更新。每个 manifest commit 只能有一份独立完整 record，禁止合并多个 commit、延迟创建或在批次结束时统一补写。Record 必须说明 source 行为、上游与目标的不一致、实际适配、保留和修订的行为、验证证据以及最终审计 verdict。

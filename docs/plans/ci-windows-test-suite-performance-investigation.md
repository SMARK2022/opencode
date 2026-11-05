# CI Windows 测试与构建套件耗时调查（只读调研）

> Status: investigation-only（用户明确：本阶段不实施任何修改）
>
> 触发事件：2026-09-08 `test` workflow run 34270727000（commit 4572b1f7）中
> `必过核心测试 / packages/opencode / Windows` 运行 60m19s 被 job timeout 强杀，
> 日志中 sdk:build 结束后 48 分钟零输出，表象疑似卡死。
> 同一 commit 重跑（attempt 2）同一 runner 镜像上 **37m27s 全绿通过**。

## 1. 事件复盘：不是卡死，是「runner 降级 + turbo 缓冲 + 超时余量耗尽」

### 1.1 时间线对比（同一 job，同一 commit）

| | 被取消的 attempt 1 | 通过的 attempt 2 | 历史典型值 |
| --- | --- | --- | --- |
| Setup Bun（install） | **666s** | 320s | 288–299s |
| 测试步骤 | 2917s 时被杀（未完成） | 1905s | 1845s |
| runner 镜像 | windows-2025-vs2026 20260824.214.3 | 同左 | — |

被取消那次**所有步骤均匀变慢约 2 倍**（install 666s vs 299s，测试同比），是
GitHub hosted runner 的邻居噪声/降级机器特征，不是某个测试 hang。
同一 commit 原样重跑即通过，排除了 .11 代码引入 hang 的可能。

### 1.2 为什么看起来像卡死：turbo 输出缓冲

`bun turbo test:ci --filter=opencode` 在 CI（非 TTY）下默认
`--log-order=auto → grouped`：**任务的全部输出被缓冲到任务结束才一次性 flush**。
成功运行的日志证明这一点：全部 3707 条 `(pass)` 行的时间戳都是同一秒
（18:58:38.95x），即测试跑完才落盘。所以「sdk:build 后 48 分钟无输出」
其实是测试在正常运行，只是 turbo 没把中间输出放出来。

**结论：现有日志结构无法区分「慢」和「死」，这是诊断成本最高的缺口。**

### 1.3 超时余量已经在收窄

`core-required` job `timeout-minutes: 60`，Windows opencode job 历史耗时：

```
8/30  1959s
8/30  2128s
9/03  2320s
9/06  2225s
9/08  2171s (成功) / 3619s (被杀)
```

随测试增长约每两周 +5–8%，正常耗时已 36–39 分钟，余量只剩 ~21 分钟；
一旦分配到降级 runner（ slowdown ≥1.6x）必然越线。本次事件就是这个组合。

## 2. Windows 测试套件为什么慢：实测分解

数据源：run 34270727000 attempt 2 的 JUnit 工件（`junit-core.xml` / `junit-tui.xml`）
与 Linux 同 run 工件逐项对比。

### 2.1 总量

| shard | Windows | Linux | 倍率 |
| --- | --- | --- | --- |
| core（429 文件 / 3707 用例） | 1546s | 394s | **3.9x** |
| tui（72 文件） | 324s | 167s | 1.9x |
| install（Setup Bun） | ~300–320s | ~90s（有缓存） | 3.4x |

### 2.2 core shard 头部套件（Windows 耗时 / Linux 耗时 / 倍率）

| suite | Win | Linux | ratio | 特征 |
| --- | --- | --- | --- | --- |
| test/session/prompt.test.ts | 197s | 56s | 3.5x | 87 个 instance 测试 |
| database maintenance CLI | 184s | 62s | 3.0x | 每个用例 runPty 起真实 CLI 进程 |
| test/snapshot/snapshot.test.ts | 145s | 5s | **27.9x** | ~192 次 git 子进程调用 |
| test/session/processor-effect.test.ts | 61s | 31s | 2.0x | |
| MessageV2.page | 48s | 27s | 1.8x | |
| test/session/goal.test.ts | 44s | 3s | 14.7x | |
| plugin.install.concurrent | 40s | 16s | 2.5x | |
| tool.shell permissions | 40s | 0.4s | **111x** | 真实 shell 子进程 |
| HttpApi SDK | 37s | 8s | 4.5x | |
| test/permission/next.test.ts | 28s | 2s | 13.1x | |
| session.compaction.process | 28s | 2s | 11.9x | |
| revert + compact workflow | 25s | 2s | 11.8x | |

tui shard 单点：`daemon.test.ts` 的 `daemon lifecycle` 一个 describe 就占
**278s / 324s（86%）**（45 个用例，每个都真实 spawn/停止 daemon 进程；
Linux 同套件 135s，2.05x）。

### 2.3 根因归纳

倍率分布说明一切：**纯计算套件 1.8–3.5x，spawn 密集型套件 12–28x**。
Windows 上进程创建（无 fork，CreateProcess + Defender 实时扫描 + NTFS 元数据开销）
比 Linux 贵一个数量级。测试套件的 Windows 慢主要是三件事叠加：

1. **子进程 spawn 密集**：git、shell、pty、daemon、CLI 自举，每用例一次或多次。
2. **Defender 实时扫描**：runner 默认开启，对工作区/临时目录的每个新文件
   （bun install 的 2336 包、测试临时 git repo、node_modules 写入）逐个扫描。
3. **install 无缓存**：`.github/actions/setup-bun/action.yml:31-35` 的注释记录了
   当时的测量结论——tar+zstd 恢复 634MB 缓存要 209s+43s save，比冷装 224s 慢，
   故 Windows 跳过缓存。但**现在冷装已涨到 ~300–320s**（包数增长），
   当时的天平可能已经反转，需要重新测量。

## 3. Build 套件（build-opencode.yml）耗时分解

run 34270727016（同 commit，全绿）：

| job | 总时长 | install | 实际工作 |
| --- | --- | --- | --- |
| build-linux | 166s | 92s | build 15s + package 38s |
| build-macos | 399s | **304s** | build 37s + sign/package 29s |
| build-windows | 370s | **313s** | build 18s + package 4s |
| smoke-windows | 370s | **323s** | smoke 28s |
| smoke-macos ×2 | 345s / 258s | ~240s | smoke <60s |
| smoke-linux ×2 | 115s / 99s | ~80s | |
| opentui-closure | 78s | — | |
| checksums | 49s | — | |

**结构性浪费：4 个 smoke job 各花 ~5 分钟装 2336 个包，只为跑 28 秒的 smoke 脚本。**
smoke 脚本（`packages/opencode/script/smoke-opentui-artifact.ts`）import 了
`../src/pty/pty.bun` 和 `test/cli/cmd/tui/sync-fixture`，拖入整个 workspace 依赖图，
这是它需要完整 install 的原因。

（另注：子仓 OpenTUI 的 release 工作流也存在重复构建——release.yml 对同一 sha
重新跑一遍 build-native 的 514s 交叉编译，不复用 smark-ci 已产出的 artifact。
属子仓 workflow 问题，与父仓无关，记录备查。）

## 4. 方案清单（按性价比排序，均未实施）

### P0 — 可观测性（让下次不再靠猜）

1. **`--log-order=stream`**：给 test.yml 的 turbo 调用加流式日志
   （turbo 2.8.13 已支持）。一行改动，测试输出实时可见，
   「慢」与「死」立即可分。或对单包 job 直接 `bun run --cwd packages/opencode test:ci`
   绕过 turbo（test-ci.ts 本身逐 shard 打印）。
2. **步骤级 timeout + 心跳**：给 `Run required package tests` 步骤加
   `timeout-minutes: 45`，并在 test-ci.ts 的 shard 启动处打印文件计数与时间戳
  （脚本已有 "Running X shard (N files)"，确认其经 stream 模式透出即可）。

### P1 — 一行级止血

3. **`timeout-minutes: 60 → 75`**（对齐 `upstream-unit-warning` 的 75）：
   恢复余量，消除降级 runner 误杀。与 P0 一起做掉即可让本次事件归零复发。

### P2 — Windows 加速主杠杆（需 A/B 测量）

4. **Defender 排除**：job 起始加一步
   `Add-MpPreference -ExclusionPath $env:GITHUB_WORKSPACE, $env:RUNNER_TEMP, <bun cache dir>`。
   对文件/进程密集型负载在 GitHub Windows runner 上公开报告有 30–50% 收益，
   直接命中 2.2/2.3 的根因。需要两次对比运行实测验证。
5. **重测 bun 缓存天平**：setup-bun 注释里的结论基于 224s 冷装；
   现在冷装 ~320s。重新测量 restore-only（不 save）路径——
   `actions/cache/restore` + `restore-keys` 前缀命中，Windows 只读不写，
   避免当时观察到的 save 竞争。若 restore < 250s 即为净收益。

### P3 — 结构性拆分（若 P2 收益不足）

6. **core shard 二分**：test-ci.ts 已有 shard 分区设施
   （`partitionTestFiles`），扩展为 `core-a` / `core-b` 两个并行 matrix job。
   用本次 JUnit 的 per-file 权重做贪心装箱，目标两半各 ~780s。
   效果：37.5 min → ~19–20 min（每 job 多付一次 320s install，但并行不占墙钟）。
   不建议三分以上：install 固定成本随 job 数线性放大。
   tui shard（324s）保持单 job，与 core-a/b 并行后不再是瓶颈。
7. **warning job 去重**：`警告 上游单元兼容性 / Windows`（2151s）串行重跑了
   包括 opencode 在内的全部套件，其中 opencode 部分与必过 job 完全重复
   （workflow 注释自证：「预期 ~30m = opencode 24m + 其余 <2m + 安装 4m」）。
   给该 job 加 `--filter=!opencode`（core/http-recorder 同理）可省 ~24 min
   Windows runner 时间。注意这是「警告」性质 job 的覆盖语义决策，需确认
   fork 需要的 upstream 兼容信号不依赖在 warning job 里再跑一遍 fork 自有测试。

### P4 — Build 套件（可选，收益独立于测试）

8. **smoke job 免 install**：把 smoke 脚本在 build job 里用 `bun build --target=bun`
   打成单文件 artifact，4 个 smoke job 下载即用，各省 ~300s。
   需先验证 `pty.bun`（原生模块）与 sync-fixture 的可打包性——标为待验证项。
9. **build/smoke 的 install 瘦身**：评估 `--production`（跳过 devDependencies）
   对 build-windows/build-macos 是否可行（build.ts --skip-embed-web-ui 路径的
   依赖闭包需实测）。

### 不建议的方向

- **拆分单套件内部（如 daemon lifecycle 45 用例共享 daemon）**：改动测试隔离语义，
  风险高于收益，仅当 P2/P3 后仍超预算再考虑。
- **更大规格 runner**：付费项，且问题根源是套件结构而非机器规格。
- **跳过 Windows 或改为非 blocking**：Windows 是主用户平台，覆盖不能降。

## 5. 建议落地顺序与验证方式

```
P0(1+2) + P1(3)   → 一次 commit；重跑 test.yml 确认日志流式、余量恢复
P2(4)             → 单独 PR，同一 commit 跑两次对比 install/test 耗时
P2(5)             → 与 4 合并测量或紧随其后
P3(6)             → 需要 JUnit 权重装箱；落地后验证两半耗时差 <15%
P3(7)             → 独立小改动，确认 warning job 信号语义后执行
P4(8/9)           → 按需
```

预期终态：Windows 必过 job 墙钟 ≤25 min，60 min timeout 下余量 ≥2x；
任何 slowdown 在日志中实时可见，不再出现「48 分钟静默后被杀」的诊断盲区。

## 附：本调查的数据工件

- JUnit：`D:\Temp\opencode\junit-win3\`（Windows）、`D:\Temp\opencode\junit-linux\`（Linux），
  来自 run 34270727000 attempt 2（全绿）。
- 历史耗时：gh api jobs timing（runs 33292110169/33325048576/33712325402/34040610798/34262658247/34270727000）。
- build 分解：run 34270727016 各 job step timing。

# script/guard：机械门禁

规则写在代码里，由 hook、插件和 CI 执行，不靠 Agent 自觉。Agent 看得到报告，但改不了规则：受保护路径的编辑会被插件直接拒绝，PR 里改规则也不会放宽对这个 PR 自己的检查（CI 用目标分支上的规则）。

## 文件一览

| 文件 | 作用 |
|---|---|
| `rules.ts` | 全部规则：包依赖矩阵、core 入口白名单、边界规则 B0–B7/F1、棘轮、形状规则、改动规模阈值、受保护路径、平台敏感路径 |
| `check.ts` | 静态检查。可检查工作区、暂存区（`--staged`）、某个提交（`--commit`）或指定文件（`--files`）；输出终端文本、JSON、Markdown 和 `::error` 注释 |
| `size.ts` | 改动规模：单个提交的净增、大文件的单次增长、只有一个导入方的小新文件（不读基线） |
| `baseline.json` | 存量基线，**由你生成**，只降不升（C2） |
| `gate.ts` | 分层入口：`commit` / `stop` / `push` / `contracts` |
| `ui.ts` | 门禁的终端输出：每步一行，终端里实时显示转圈和测试进度条 |
| `select-tests.ts`、`affected.ts`、`affected-rules.ts` | 选测试：优先用覆盖率图，没有图就退回静态 import 图 |
| `preflight.ts` | 跨平台预检：把 HEAD 这个 SHA 交给 GitHub 在 macOS/Linux（可选 Windows）上跑 |
| `bench/` | 端到端 A/B 基准：harness、预算、OpenCode 场景（list / open / stream / abort） |
| `report.ts` | 结果页：job summary、PR 置顶评论、看板数据合并 |
| `dashboard/index.html` | 看板单页，不依赖任何 CDN（内置 SVG 折线图），亮色/暗色自适应 |
| `ci.ts`、`site.sh` | 只给 workflow 用的小工具 |
| `unneeded-guards.ts`、`shape.ts`、`leak-preload.ts`、`budget.ts` | 多余防御检查、形状度量、测试泄漏检测、测试级预算 |
| `test/guard.test.ts` | 规则自身的测试（33 个） |

另外两处：`.opencode/plugins/guard.ts`（Agent 侧插件），以及 `.github/workflows/` 下的 `guard.yml`、`guard-nightly.yml`、`guard-bench-commits.yml`。

## 首次接入

### 1. 生成基线

```sh
bun install
bun script/guard/check.ts --write-baseline
bun test script/guard/test
git add script/guard .opencode/plugins/guard.ts .github/workflows/guard*.yml
git commit -m "chore(guard): 引入机械门禁与基线"
```

基线生成后，现有代码就是 0 错误；以后只有新增问题会被拦下。**Guard 要先于其他改动单独提交**：commit-msg 检查的是暂存区快照，基线不在暂存区时，所有存量都会被当成新增。

旧版（带 `upstream-growth` 的那一版）生成过基线的，请重新运行一次 `--write-baseline`。

### 2. 接 git hook

新建 `.husky/commit-msg`（如果之前在 pre-commit 里加过 `gate.ts commit`，删掉那一行）：

```sh
#!/bin/sh
# guard：暂存区的规则检查 + 改动规模。放在 commit-msg 是因为要读提交信息里的放行标记
bun script/guard/gate.ts commit --message "$1"
```

`.husky/pre-push` 在子模块校验之前（也就是最后的 `exit` 之前）加上：

```sh
# guard：待推送提交的规则检查（逐个提交判定改动规模）+ 选中测试 + 契约测试；平台敏感改动会启动跨平台 preflight
bun script/guard/gate.ts push
```

### 3. 插件与权限

`.opencode/plugins/guard.ts` 放好即可，OpenCode 会自动加载 `.opencode/plugins/*.ts`。它从不修改、还原或删除任何文件：

- 工具执行前：拒绝编辑受保护路径；拒绝没有正当用途的绕过手段：`commit -n`（提示改用 `--no-verify`，后者会走确认）、`HUSKY=0 git …`、`$env:HUSKY`、改 `core.hooksPath`、`update-ref`/`commit-tree` 这类直接改引用的命令，以及在命令里设置 `GUARD_*` 开关。
- 工具执行后：刚改过的 TS 文件立刻跑一次规则检查，违规追加到工具输出里；受保护路径如果被 shell 命令改了，只报告。
- 回合结束（`session.idle`）：对本会话改过的文件跑 `gate.ts stop`，失败就把报告作为新消息发回，最多 5 轮。改动规模在这里只提示，因为它要到提交时才能决定拆分还是放行。

需要人来决定的操作交给 OpenCode 自己的权限确认。在 `.opencode/opencode.jsonc` 的 `permission` 里加上（这个文件是受保护路径，需要你自己改）：

```jsonc
"permission": {
  "bash": {
    "git commit *Guard-Allow-Large*": "ask",
    "git commit *-F*": "ask",
    "git commit *--file*": "ask",
    "git commit *--no-verify*": "ask",
    "git push *--force*": "ask"
  }
}
```

`-F`/`--file` 那两条是为了不让提交信息绕开确认（写进文件再提交时，命令里看不到放行标记）。

**Auto 模式下**，ask 会先交给你们的审批 reviewer 模型，由它根据对话判断你是否授权过，比如你说过“这个功能可以大提交”。如果希望只由你本人确认，把 `approvals_reviewer` 设为 `"user"`，不过这是全局设置，所有权限请求都会改成由你确认。

启动 OpenCode 时可设的环境变量（Agent 在命令里改不了）：

| 变量 | 取值 |
|---|---|
| `GUARD_UNLOCK=1` | 允许本次会话改受保护路径（你自己维护规则时用） |
| `GUARD_IDLE` | `full`（默认，静态 + 受影响测试）/ `static` / `off` |

### 4. GitHub 设置

1. **CODEOWNERS**（`.github/CODEOWNERS`，它本身也是受保护路径）：

   ```
   /script/guard/                @SMARK2022
   /.opencode/plugins/guard.ts   @SMARK2022
   /.opencode/policy/            @SMARK2022
   /.github/workflows/           @SMARK2022
   /.github/CODEOWNERS           @SMARK2022
   /.husky/                      @SMARK2022
   ```

2. **标签**：建一个 `guard-change`。PR 改到受保护路径时，没有这个标签 CI 直接失败。

3. **Ruleset**（Settings → Rules → Rulesets → New branch ruleset，目标 `dev1-smark`）：
   - Require a pull request before merging，勾选 Require review from Code Owners
   - Require status checks to pass：`规则与契约`、`性能基准`，以及 test.yml 里你要求必过的任务。基准任务在没有运行时改动时会被跳过，跳过算通过。
   - PR 里的提交超出改动规模时，`规则与契约` 会失败。CI 不认 PR 提交信息里的放行标记（第三方 Agent 可以随便写）；你审过后 approve，再在 checks 里点 Re-run failed jobs 即可通过。
   - Block force pushes
   - Bypass list：Repository admin，模式选 Always。这样你本地直接 push 不受影响（本地 hook 是权威），PR 走 CI。
   - **注意**：第三方 Agent 如果用你本人的 token，它也是 admin，也会绕过。给 Agent 用单独的机器人账号或 GitHub App（非 admin、只有写权限）。

4. **看板**：先手动跑一次 `guard-nightly`（Actions → guard-nightly → Run workflow），它会创建 `bench-data` 分支。然后 Settings → Pages → Deploy from a branch → `bench-data` / `(root)`。地址是 `https://smark2022.github.io/opencode/`。私有仓库的 Pages 需要付费计划；没有的话，可以把 `bench-data` 拉到本地，用任意静态服务器打开。

5. **覆盖率图**：同样由 `guard-nightly` 建好并发布到 release `guard-coverage-map`。本地 `gate.ts push` 会在图缺失或超过一天时用 `gh release download` 自动取，取不到就退回静态 import 图。

## 日常怎么走

### 本地直推（你和本地 Agent）

| 时机 | 检查什么 | 大约耗时 |
|---|---|---|
| Agent 每次编辑后 | 刚改的文件，规则检查 | 亚秒级 |
| Agent 回合结束 | 本会话改过的文件：规则 + 小模块 + 多余防御提示 + 受影响测试；改动规模只提示 | 取决于测试 |
| `git commit`（commit-msg） | 暂存区快照的规则检查 + 改动规模（不碰其他 Agent 未暂存的改动） | 约 0.5 秒 |
| `git push` | `origin/dev1-smark..HEAD`：规则 + 逐个提交的改动规模 + 选中测试 + 契约；平台敏感时加 preflight | 取决于测试 |

### 改动规模与放行

| 规则 | 管什么 | 超出时 |
|---|---|---|
| `change-size` | 单个提交里 `packages/*/src` 非测试代码净增 ≤ 300 行，新文件同样计入 | 拆小，或写放行标记 |
| `file-lines` | 超过 2000 行的文件，单个提交里最多净增 100 行 | 抽模块，或写放行标记 |
| `tiny-module` | 新文件少于 40 行有效代码且只有一个导入方 | 合并回调用方（不能放行） |

这几条只看“这一次改了什么”，不读基线，也不和上游比较。阈值来自本 fork 的历史：src 非测试代码单个提交净增的 p90 约 290 行；超过 2000 行的文件，上游只有 8 个。按 fork 自己的 511 个改到 src 的提交回测，大约 10% 会触发 `change-size`。

`tiny-module` 不算拆碎的情况：唯一导入方只是转出它（`export * from`）；导入方是生成的注册表（如迁移清单）；导入方是按目录登记同类模块的聚合文件（`handlers.ts` ↔ `handlers/*`，或目录自己的 `index.ts`）；文件登记在 `package.json` 的 exports 里。`file-lines` 和 `tiny-module` 是互相牵制的：大文件不能无限往里堆，新拆出来的模块又必须有一定分量。

**放行**：确属一个整体的大改动，在提交信息里写一行

```
Guard-Allow-Large: 理由
```

Agent 也可以这样写，但带这行的 `git commit` 会触发 OpenCode 的权限确认，由你决定。放行记录留在提交历史里，pre-push 和 CI 的报告会列出来。

**本地不跑全量测试。** 选测试的结果是全量时（比如改了 `package.json`、`bun.lock`，或者静态依赖图选不准），本地跳过这个包，把同一个 SHA 交给 preflight 在线上跑，默认只跑 Linux（`GUARD_PREFLIGHT_FULL_PLATFORMS`）。确实想在本地跑全量时，设置 `GUARD_TESTS=full`。

终端里每个步骤一行，运行中原地刷新；测试步骤会显示进度条（用例数按测试文件里的 `test()`/`it()` 估算）和失败数：

```
[gate] ✓ 规则检查  origin/dev1-smark..527643cb · 31 个文件  17.3s
[gate] ✓ 选测试  静态依赖图 · 31 个文件  6.3s
[gate] ⠹ 测试  packages/core · 12 个文件 · 静态依赖图  ━━━━━━━━━━──────── 41/~90  ✗1  41.2s
[gate] – 测试  packages/opencode · 全量  本地不跑全量，转交 preflight
[gate] ◷ preflight  527643cb · linux · 全量测试（packages/opencode）  2.0s
       ↳ 已启动：分支 preflight/527643cb2a1f · 平台 linux
[gate] ◷ 等待 preflight  通过后再 push 一次即可，本地不用等
```

失败的步骤会在最后列出输出的末尾部分，完整日志保存在 `.git/guard/logs/`。不在终端里运行时（CI、插件、重定向），只打印开始和结束，测试进度每 30 秒打印一次。

**preflight 是异步的。** 第一次 push 平台敏感的改动（或需要全量测试的改动）时，`gate.ts push` 会把这个 SHA 推到临时分支 `preflight/<sha>`，触发 `guard.yml`，然后拒绝这次 push 并告诉你去忙别的。等它变绿后再 push 一次就会放行（同一个 SHA 不会重复跑）。临时分支在运行结束后自动删除。

```sh
bun script/guard/preflight.ts status          # 看当前 HEAD 的 preflight 状态
bun script/guard/preflight.ts wait            # 想等就等
bun script/guard/preflight.ts start --platforms linux,macos,windows   # 手动指定平台
```

push 到 `dev1-smark` 之后，`guard.yml` 会再跑一次规则与契约，作为事后告警（同一 SHA 已有成功运行就跳过）；三平台全量测试仍由现有的 `test.yml` 负责。

### 第三方 Agent 的 PR

这些 PR 不经过本地 hook，所以 PR 上的 CI 就是它们的 preflight：

- **规则与契约**：用目标分支上的规则、基线和脚本检查 PR，违规以注释标在 diff 上。
- **性能基准**：PR 改到运行时代码（`packages/{core,opencode,tui,server,cli,llm,plugin,sdk/js}/src/`）时，head 与 merge-base 交替跑 A/B。基准脚本同样来自目标分支，PR 改不了自己的考卷。
- **PR 评论**：上面两项汇总成一条置顶评论，每次更新同一条。
- 单元测试仍由 `test.yml` 负责，这里不重复跑。

## 结果在哪里看

| 位置 | 内容 |
|---|---|
| 运行页的 Summary | 违规表、修复方向、存量计数；基准概览表与全部指标 |
| PR 的 Files changed | `::error` 注释，直接标在出问题的行上 |
| PR 置顶评论 | 规则 + 基准的汇总 |
| 看板（Pages） | 性能趋势（可选场景和指标，红点是 A/B 判定的退化）、存量趋势、每个提交的结果 |

## 对任意提交跑基准

**在 CI 上（结果进看板）**：Actions → guard-bench-commits → Run workflow，或者：

```sh
gh workflow run guard-bench-commits.yml -f commits="v1.19.6..dev1-smark"      # 按第一父链展开，最多 20 个
gh workflow run guard-bench-commits.yml -f commits="5c3a359f e93b66fd" -f scenarios=list,stream -f rounds=7
gh workflow run guard-bench-commits.yml -f commits="a1b2c3d4 e5f6a7b8" -f base=v1.19.6   # 全部与同一个提交比较
```

每个提交默认与它的第一父提交比较，同时按**当前**规则记录该提交的存量，所以看板上的存量曲线用的是同一把尺子。基准脚本和预算也都用 `dev1-smark` 上的当前版本。早于某个场景所需接口的旧提交会记为“未完成”，不影响其他提交。

**在本地**：

```sh
bun script/guard/bench/opencode.ts                                 # 工作区 对 merge-base
bun script/guard/bench/opencode.ts --head <sha> --base <sha> --only list,stream --rounds 5
```

两个提交各自建一个缓存 worktree（`$TMPDIR/opencode-bench-<sha12>`）并安装依赖，第二次起会快很多。

### 基准测什么

| 指标 | 含义 |
|---|---|
| 启动到就绪 | 进程启动到健康检查通过 |
| 场景耗时、CPU 时间 | 场景本身的墙钟时间和进程 CPU 时间 |
| 最长阻塞 | 场景进行中，健康检查探针最长一次无响应的时间 |
| 探针 p50/p95/p99 | 场景进行中健康检查的延迟分布（每 50 ms 一次） |
| 探针失败率、最长掉线 | 探针失败的比例和最长连续失败时长；失败会被计数，不会被吞掉 |
| 峰值内存、内存增量 | RSS 峰值和场景前后的增长 |
| 崩溃 | head 任何一次崩溃直接判为退化 |

判定退化需要同时满足：中位数变差超过预算比例、超过绝对噪声下限，且单侧 Mann-Whitney 检验 p < 0.05。预算在 `bench/budgets.ts`，它本身是受保护路径。

## 环境变量速查

| 变量 | 作用 |
|---|---|
| `GUARD_TESTS` | `off` 跳过所有测试；`full` 在本地也跑全量（默认全量转交 preflight） |
| `GUARD_PREFLIGHT` | `auto`（默认，gh 不可用时只提示）/ `required`（gh 不可用就阻断）/ `off` |
| `GUARD_PREFLIGHT_PLATFORMS` | 平台敏感改动的 preflight 平台，默认 `macos,linux` |
| `GUARD_PREFLIGHT_FULL_PLATFORMS` | 只因全量测试触发的 preflight 平台，默认 `linux` |
| `GUARD_UNNEEDED=error` | 多余防御检查从提示改为阻断 |
| `GUARD_MAP_SYNC=off` | 不自动下载覆盖率图 |
| `GUARD_TYPESCRIPT` | typescript 模块路径（默认从 node_modules 解析） |
| `GUARD_UNLOCK`、`GUARD_IDLE` | 见插件一节 |

这些变量都由人在自己的终端里设置，插件会拒绝 Agent 在命令里修改它们。

退出码：`check.ts` 和 `gate.ts` 返回 0 表示通过（只有提示也算通过），1 表示有错误或在等待 preflight，2 表示执行异常；`preflight.ts` 返回 3 表示 gh 不可用，10 表示在等待（已启动或运行中）；`bench/opencode.ts` 返回 1 表示有退化，2 表示没能跑完。

## 修改规则

1. 用 `GUARD_UNLOCK=1` 启动 OpenCode，或者直接手改。
2. 改 `rules.ts`，并在 `test/guard.test.ts` 里补用例，然后跑 `bun test script/guard/test`。
3. 放宽规则或提高基线时，单独开 PR，加 `guard-change` 标签。CI 用目标分支的基线检查，基线只能下降（C2）。

## 已知局限

- `bench/opencode.ts` 的场景没有在真实 OpenCode 上跑过（打包环境里装不了依赖），harness 本身用玩具服务器验证过正常、阻塞、崩溃、泄漏四种情况。第一次用之前，先在本地跑一次 `--only list --rounds 3`，接口路径或种子数据不对的话按报错调整。
- 三个 workflow 只做过 YAML 解析和本地模拟（plan、规则检查、看板写入与推送），没有在 GitHub 上实际运行。第一次运行时请留意权限与 runner 差异。
- 覆盖率图按测试文件逐个跑覆盖率，耗时随测试数量增长，nightly 的上限设为 180 分钟。Bun 的覆盖率是行级的，所以选测试也是行级精度。
- 看板上不同 runner 之间的绝对值只能作参考，退化以同机 A/B 的判定为准。

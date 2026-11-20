# script/guard：机械门禁

规则写在代码里，由 hook、插件和 CI 执行，不靠 Agent 自觉。本地 Agent 可以编辑规则；PR 里改规则不会放宽对这个 PR 自己的检查（CI 用目标分支上的规则）。

## 文件一览

| 文件                                                             | 作用                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules.ts`                                                       | 全部规则：包依赖矩阵、core 入口白名单、边界规则 B0–B10/F1、棘轮、形状规则、改动规模阈值、受保护路径、平台敏感路径                           |
| `check.ts`                                                       | 静态检查。可检查工作区、暂存区（`--staged`）、某个提交（`--commit`）或指定文件（`--files`）；输出终端文本、JSON、Markdown 和 `::error` 注释 |
| `graph.ts`、`syntax.ts`                                          | 按 tsconfig/exports 解析依赖，区分类型与运行时导入，按 AST 绑定识别受限能力                                                                 |
| `size.ts`                                                        | 改动规模：单个提交的净增、大文件的单次增长、只有一个导入方的小新文件（不读基线）                                                            |
| `baseline.json`                                                  | 存量基线，**由你生成**，只降不升（C2）                                                                                                      |
| `gate.ts`                                                        | 分层入口：`commit` / `stop` / `push` / `contracts`                                                                                          |
| `ui.ts`                                                          | 门禁的终端输出：每步一行，终端里实时显示转圈和测试进度条                                                                                    |
| `select-tests.ts`、`affected.ts`、`affected-rules.ts`            | 选测试：静态依赖确定必跑集合，覆盖率图补充；多套执行入口分别运行                                                                            |
| `preflight.ts`                                                   | 跨平台预检：固定待推送提交与比较 base，逐项核对请求平台的实际任务结果                                                                       |
| `bench/`                                                         | 端到端 A/B 基准：harness、预算、OpenCode 场景（list / open / stream / abort）                                                               |
| `report.ts`                                                      | 结果页：job summary、PR 置顶评论、看板数据合并                                                                                              |
| `dashboard/index.html`                                           | 看板单页，不依赖任何 CDN（内置 SVG 折线图），亮色/暗色自适应                                                                                |
| `ci.ts`、`site.sh`                                               | 只给 workflow 用的小工具                                                                                                                    |
| `unneeded-guards.ts`、`shape.ts`、`leak-preload.ts`、`budget.ts` | 多余防御检查、形状度量、测试泄漏检测、测试级预算                                                                                            |
| `test/`、`tsconfig.json`                                         | 规则、测试选择、执行链、基准、实际工作流判定的反例测试，以及 guard 自身类型检查                                                             |

另外两处：`.opencode/plugins/guard.ts`（Agent 侧插件），以及 `.github/workflows/` 下的 `guard.yml`、`guard-nightly.yml`、`guard-bench-commits.yml`。

## 已执行的设计约束

| 约束               | 机械判定与失败条件                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 的旧 SDK 引用 | B8 只允许类型导入/导出；运行时引用直接失败                                                                                                                                |
| 依赖环             | B10 冻结已有静态运行时成环边；新增环边或替换例外位置失败，类型引用不计入运行时环。需要完整依赖图，只在 push、CI 和全量扫描时检查                                         |
| 兼容入口           | F1 固定纯转发结构及目标；混入实现、重定向到其他目标或移除锁定都会失败                                                                                                     |
| 受限 API           | 计时器、ManagedRuntime、Effect 执行/吞错、Schema.Any、Solid 异步 effect 和测试固定等待按 AST 绑定识别，覆盖别名、解构、本地转发和文字属性访问；字符串与说明文字不作为调用 |
| 快照完整性         | 暂存检查导出完整 index；只解析改动文件的导入，改到 package.json、tsconfig、bunfig 时改为完整依赖图。无效引用、语法错误、冲突 index、无效基线返回执行失败                 |
| 测试执行入口       | 新测试文件必须登记可达运行器；纯 echo、仅编译、脚本循环、漏掉发现文件的入口失败。按各包自己的 test 脚本参数执行（如 `--timeout 30000`）                                 |
| 资源泄漏           | 整轮测试结束时（所有 afterAll 执行完）仍在运行、会阻止进程退出的计时器和子进程判为泄漏，报告仓库内的创建位置；`unref()` 过的计时器不算                                    |
| 基准与预算         | 场景错误、空/非法样本、缺失指标、无效参数返回失败；取消必须发生在主模型流启动后。SQL 预算覆盖迭代消费并隔离并发/嵌套测量                                                  |

写法和规模检查聚焦本次改动。存量允许项按规则和文件/依赖边登记，新增代码的默认允许数为零。

选测试：静态依赖图沿反向 import 闭包选出测试；覆盖率图可用时以它为准（静态图经测试夹具几乎连到全部测试，单靠它常升级为全量）。全局输入（根目录 `bun.lock`、`package.json` 等）升级全部包，包内全局输入或依赖图之外的文件只升级所属包。Playwright 端到端和性能套件不进门禁。覆盖率建图失败、缺少 LCOV 或地图版本失效时不会发布/复用残缺结果。Guard 自身变化只触发其自测和固定契约。

## 首次接入

### 1. 生成基线

```sh
bun install
bun script/guard/check.ts --write-baseline
bun run --cwd script/guard test
git add script/guard .opencode/plugins/guard.ts .github/workflows/guard*.yml
git commit -m "chore(guard): 引入机械门禁与基线"
```

基线生成后，现有代码就是 0 错误；以后只有新增问题会被拦下。**Guard 要先于其他改动单独提交**：commit-msg 检查的是暂存区快照，基线不在暂存区时，所有存量都会被当成新增。

v3 基线将 AST 能力计数和成环边写入 `structured`，将兼容入口的目标写入 `forwarderTargets`。本次迁移只登记引入规则时已有的代码；后续 C2 同时限制普通计数、结构化计数和转发目标，禁止提高数量、迁移例外位置、移除转发锁或降低版本。规则升级需要独立 PR；日常业务 PR 不重新生成基线。

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

- 工具执行前：拒绝没有正当用途的绕过手段：`commit -n`（提示改用 `--no-verify`，后者会走确认）、`HUSKY=0 git …`、`$env:HUSKY`、改 `core.hooksPath`、`update-ref`/`commit-tree` 这类直接改引用的命令，以及在命令里设置 `GUARD_*` 开关。
- 工具执行后：刚改过的源码文件立刻跑一次规则检查，违规追加到工具输出里；改到受保护路径时，在工具输出末尾附一句提醒（不拦截）。
- 回合结束（`session.idle`）：对本会话编辑工具碰过的文件跑 `gate.ts stop`。未通过时把报告写进会话记录并弹出提示，**不触发回复**；需要 Agent 修复时由你回复。写入的记录沿用这个会话最后一次的 Agent 和模型。改动规模在这里只提示，因为它要到提交时才能决定拆分还是放行。

本会话的改动只认编辑工具（edit、write、apply_patch 等）的参数，不看 bash，也不判断其他会话。多个会话改同一个文件时，检查的是文件当前内容。

需要人来决定的操作交给 OpenCode 自己的权限确认。在 `.opencode/opencode.jsonc` 的 `permission` 里加上：

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

| 变量             | 取值                                                |
| ---------------- | --------------------------------------------------- |
| `GUARD_IDLE`     | `full`（默认，静态 + 受影响测试）/ `static` / `off` |

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

2. **Ruleset**（Settings → Rules → Rulesets → New branch ruleset，目标 `dev1-smark`）：
   - Require a pull request before merging，勾选 Require review from Code Owners
   - Require status checks to pass：`guard-required`，以及 test.yml 里你要求必过的任务。`guard-required` 始终执行，要求规则、所需性能基准或所选平台矩阵实际成功；必跑任务跳过、取消、缺失都会失败。
   - PR 里的提交超出改动规模时，`规则与契约` 会失败。CI 不认 PR 提交信息里的放行标记（第三方 Agent 可以随便写）；维护者对当前 PR head approve 后，再在 checks 里点 Re-run failed jobs；新提交或撤销批准会重新阻断。
   - Block force pushes
   - Bypass list：Repository admin，模式选 Always。这样你本地直接 push 不受影响（本地 hook 是权威），PR 走 CI。
   - **注意**：第三方 Agent 如果用你本人的 token，它也是 admin，也会绕过。给 Agent 用单独的机器人账号或 GitHub App（非 admin、只有写权限）。

3. **看板**：先手动跑一次 `guard-nightly`（Actions → guard-nightly → Run workflow），它会创建 `bench-data` 分支。然后 Settings → Pages → Deploy from a branch → `bench-data` / `(root)`。地址是 `https://smark2022.github.io/opencode/`。私有仓库的 Pages 需要付费计划；没有的话，可以把 `bench-data` 拉到本地，用任意静态服务器打开。

4. **覆盖率图**：同样由 `guard-nightly` 建好并发布到 release `guard-coverage-map`。本地 `gate.ts push` 会在图缺失或超过一天时用 `gh release download` 自动取，取不到就退回静态 import 图。

## 日常怎么走

### 本地直推（你和本地 Agent）

| 时机                       | 检查什么                                                                    | 大约耗时         |
| -------------------------- | --------------------------------------------------------------------------- | ---------------- |
| Agent 每次编辑后           | 改动文件的写法规则与依赖边界                                                | 1–3 秒           |
| Agent 回合结束             | 本会话改过的文件：规则 + 小模块 + 多余防御提示 + 受影响测试；改动规模只提示 | 取决于测试       |
| `git commit`（commit-msg） | 暂存区快照：改动文件的写法规则、依赖边界与改动规模                          | 2–3 秒           |
| `git push`                 | 对 Git 实际推送的每个提交：规则（含依赖环）、选中测试与契约并行执行          | 取决于测试       |

### 改动规模与放行

| 规则          | 管什么                                                              | 超出时                   |
| ------------- | ------------------------------------------------------------------- | ------------------------ |
| `change-size` | 单个提交里 `packages/*/src` 非测试代码净增 ≤ 300 行，新文件同样计入 | 拆小，或写放行标记       |
| `file-lines`  | 超过 2000 行的文件，单个提交里最多净增 100 行                       | 抽模块，或写放行标记     |
| `tiny-module` | 新文件少于 40 行有效代码且只有一个导入方                            | 合并回调用方（不能放行） |

这几条只看“这一次改了什么”，不读基线，也不和上游比较。阈值来自本 fork 的历史：src 非测试代码单个提交净增的 p90 约 290 行；超过 2000 行的文件，上游只有 8 个。按 fork 自己的 511 个改到 src 的提交回测，大约 10% 会触发 `change-size`。

`tiny-module` 不算拆碎的情况：唯一导入方只是转出它（`export * from`）；导入方是生成的注册表（如迁移清单）；导入方是按目录登记同类模块的聚合文件（`handlers.ts` ↔ `handlers/*`，或目录自己的 `index.ts`）；文件登记在 `package.json` 的 exports 里。`file-lines` 和 `tiny-module` 是互相牵制的：大文件不能无限往里堆，新拆出来的模块又必须有一定分量。

**放行**：确属一个整体的大改动，在提交信息里写一行

```
Guard-Allow-Large: 理由
```

Agent 也可以这样写，但带这行的 `git commit` 会触发 OpenCode 的权限确认，由你决定。放行记录留在提交历史里，pre-push 和 CI 的报告会列出来。

**同一个提交只验证一次。** push 通过后在 `.git/guard/green/` 记下提交和比较基准，再推同一个提交直接放行。

**本地不跑全量测试。** 选测试的结果是全量时（比如改了 `package.json`、`bun.lock`），本地跳过这个包，把同一个提交与固定比较 base 交给 preflight 在线上跑，默认只跑 Linux（`GUARD_PREFLIGHT_FULL_PLATFORMS`）。确实想在本地跑全量时，设置 `GUARD_TESTS=full`。

**工作区里有会被测试加载的未提交改动时，测试也交给 preflight。** 本地测试跑在工作区上；如果本次测试会加载的包（计划内的包、契约包和它们依赖的包）里有未提交的改动，本地结果就不能代表待推送的提交。只改了无关的包（比如 app、desktop）不受影响。preflight 在线上只跑选中的测试，额外开销主要是 checkout 与安装依赖，约 1–2 分钟。

**线上环境问题自动重跑一次。** preflight 失败在门禁那一步之外（checkout、安装依赖、下载工具等）时，自动重跑失败的 job 一次；preflight 的 job 预先装好 ripgrep，测试不再各自从 GitHub 下载。

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

**preflight 是异步的。** 第一次 push 平台敏感的改动（或需要全量测试的改动）时，`gate.ts push` 会把这个 SHA 推到临时分支 `preflight/<sha>`，触发 `guard.yml`，然后拒绝这次 push 并告诉你去忙别的。相同提交、比较 base 和请求平台的实际任务全部成功后，再 push 放行；更新的失败或取消结果会覆盖旧成功。临时分支在运行结束后自动删除。

```sh
bun script/guard/preflight.ts status --base <本次比较提交>
bun script/guard/preflight.ts wait --base <本次比较提交>
bun script/guard/preflight.ts start --base <本次比较提交> --platforms linux,macos,windows   # 手动指定平台
```

push 到 `dev1-smark` 之后，`guard.yml` 会再跑一次规则与契约，作为事后告警；三平台全量测试仍由现有的 `test.yml` 负责。

### 第三方 Agent 的 PR

这些 PR 不经过本地 hook，所以 PR 上的 CI 就是它们的 preflight：

- **规则与契约**：用目标分支上的规则、基线和脚本检查 PR，违规以注释标在 diff 上。
- **性能基准**：PR 改到运行时代码（`packages/{core,opencode,tui,server,cli,llm,plugin,sdk/js}/src/`）时，head 与 merge-base 交替跑 A/B。基准脚本同样来自目标分支，PR 改不了自己的考卷。
- **PR 评论**：上面两项汇总成一条置顶评论，每次更新同一条。
- 单元测试仍由 `test.yml` 负责，这里不重复跑。

## 结果在哪里看

| 位置                | 内容                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| 运行页的 Summary    | 违规表、修复方向、存量计数；基准概览表与全部指标                            |
| PR 的 Files changed | `::error` 注释，直接标在出问题的行上                                        |
| PR 置顶评论         | 规则 + 基准的汇总                                                           |
| 看板（Pages）       | 性能趋势（可选场景和指标，红点是 A/B 判定的退化）、存量趋势、每个提交的结果 |

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

| 指标                 | 含义                                                       |
| -------------------- | ---------------------------------------------------------- |
| 启动到就绪           | 进程启动到健康检查通过                                     |
| 场景耗时、CPU 时间   | 场景本身的墙钟时间和进程 CPU 时间                          |
| 最长阻塞             | 场景进行中，健康检查探针最长一次无响应的时间               |
| 探针 p50/p95/p99     | 场景进行中健康检查的延迟分布（每 50 ms 一次）              |
| 探针失败率、最长掉线 | 探针失败的比例和最长连续失败时长；失败会被计数，不会被吞掉 |
| 峰值内存、内存增量   | RSS 峰值和场景前后的增长                                   |
| 崩溃                 | head 任何一次崩溃直接判为退化                              |

判定退化需要同时满足：中位数变差超过预算比例、超过绝对噪声下限，且单侧 Mann-Whitney 检验 p < 0.05。预算在 `bench/budgets.ts`，它本身是受保护路径。

为减少环境差异造成的误报：两个提交都在各自的缓存工作树里运行（CI 用 `--head HEAD`，不拿工作区和工作树比）；每个场景先两边各空跑一轮预热、不计入；两个提交之间没有运行时代码改动时只记录数据、不判定退化。

## 环境变量速查

| 变量                             | 作用                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GUARD_TESTS`                    | `off` 跳过测试与契约（push 之后由 CI 补测）；`full` 在本地也跑全量。CI 里忽略这个变量                            |
| `GUARD_PREFLIGHT`                | `auto`（默认）gh 不可用时只提示；`required` 时阻断；`off` 不触发 preflight（push 之后由 CI 补测）               |
| `GUARD_PREFLIGHT_PLATFORMS`      | 平台敏感改动的 preflight 平台，默认 `macos,linux`                                                               |
| `GUARD_PREFLIGHT_FULL_PLATFORMS` | 只因全量测试触发的 preflight 平台，默认 `linux`                                                                 |
| `GUARD_UNNEEDED=error`           | 多余防御检查从提示改为阻断                                                                                      |
| `GUARD_MAP_SYNC=off`             | 不自动下载覆盖率图                                                                                              |
| `GUARD_TYPESCRIPT`               | typescript 模块路径（默认从 node_modules 解析）                                                                 |
| `GUARD_IDLE`                     | 见插件一节                                                                                                      |

这些变量都由人在自己的终端里设置，插件会拒绝 Agent 在命令里修改它们。

退出码：`check.ts` 和 `gate.ts` 返回 0 表示通过（只有提示也算通过），1 表示有错误或在等待 preflight，2 表示执行异常；`preflight.ts` 返回 3 表示 gh 不可用，10 表示在等待（已启动或运行中）；`bench/opencode.ts` 返回 1 表示有退化，2 表示没能跑完。

## 修改规则

1. 改 `rules.ts`，并在 `test/guard.test.ts` 里补用例，然后跑 `bun run --cwd script/guard test`。
2. 放宽规则或提高基线时，单独开 PR。CI 用目标分支的基线检查，基线只能下降（C2）。

## 已知局限

- list / open / stream / abort 已用真实 OpenCode 服务和 mock LLM 验证最小规模场景。统计轮数限制为 4–50；完整性能判断仍运行既定规模的同机 A/B。
- `workflow.test.ts` 读取实际 `guard-required` 脚本，执行必跑任务成功、缺失、跳过、失败和取消的反例。各平台运行结果由对应的 GitHub job 给出。
- 覆盖率图按测试文件逐个跑覆盖率，耗时随测试数量增长，nightly 的上限设为 180 分钟。Bun 的覆盖率是行级的，所以选测试也是行级精度。
- 看板上不同 runner 之间的绝对值只能作参考，退化以同机 A/B 的判定为准。

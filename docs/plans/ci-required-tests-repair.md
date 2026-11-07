# 必过 CI 稳定性修复

## 范围
修复累计出现的必过测试问题，所有返修保持在同一 PR。基线为 `dev1-smark` 的 `70670d1b030bee4198887c633ce2607ad6360e66`。不修改 warning-only App E2E 测试，不改主分支，不合并。

## 修复及行为边界
1. 数据库选主测试等待当前 election key 对应的精确锁文件，再启动竞争者。共享目录中的 models-dev 锁不再被误认为选主已完成；原互斥、提示和退出断言保持不变。
2. ProjectCopy 夹具使用已有的 `fs.rm({ recursive: true, force: true })`，构造 Git 元数据不存在的状态。真实 refresh 和数据库结果断言保持不变。
3. 只有精确的 `daemon stop` 两参数入口跳过无关命令加载；仍使用原 parser、命令、停机授权和退出处理。其他参数保留完整命令注册顺序，未知参数与帮助输出用真实 CLI 比较，原帮助快照不改。
4. CLI 夹具让 `PWD` 与实际子进程工作目录一致，ACP 指定目录也同步。原先仅设置 cwd，真实工具请求仍可能进入父仓库。新回归要求真实相对路径 read 的结果包含夹具文件独有的内容，不能用固定模型结尾代替读取成功。
5. CLI 夹具复用已有依赖就绪标记。PURE 没有关闭配置初始化的 npm 安装；该标记消除与行为断言无关的外部包请求，不替换工具或 provider。
6. 三处数据库播种准备直接复用生产 `Database.layerFromPath` 的真实迁移，不再为准备 schema 启动完整 CLI。真实首次运行 JSON、PTY 维护、故障触发及输出顺序仍走原命令。
7. 数据库、daemon、promptAsync 子进程既已使用固定模型文件，明确关闭无关后台模型刷新。没有修改生产默认或模型刷新专项测试。
8. 四处 JUnit 发布使用 `annotate_only: true`，让注释归到实际测试任务，避免新增的独立 check 串到 typecheck。实际测试命令、退出码、摘要、制品和 warning-only 行为不变。

## 累计失败与验证
调查的五次 test.yml 为 [42380368095](https://github.com/SMARK2022/opencode/actions/runs/42380368095)、[42373519357](https://github.com/SMARK2022/opencode/actions/runs/42373519357)、[42358565595](https://github.com/SMARK2022/opencode/actions/runs/42358565595)、[42349679562](https://github.com/SMARK2022/opencode/actions/runs/42349679562)、[42342270890](https://github.com/SMARK2022/opencode/actions/runs/42342270890)。还保留更早的 ProjectCopy 缺失 .git、Windows daemon stop、run-process 连续超时记录，不因离开窗口而忽略。

PR #2 首轮 [42386640407](https://github.com/SMARK2022/opencode/actions/runs/42386640407) 的 18 个必过任务有 16 个通过。Linux/macOS 选主原失败均通过；Windows 仍有：
- run-process 的 unknown stream finish 用例达到原 30 秒子进程期限。
- 数据库维护的故障进度用例达到原 30 秒测试期限。

同一 head 的真实 typecheck 任务通过。显示在 typecheck 下的两个红色 JUnit check 来自 Windows 测试报告，不是类型错误。

已确定的夹具缺陷包括 PWD 错目录、无意 npm 安装、固定模型仍后台刷新及播种的完整 CLI 启动。它们有直接实验支持，但尚不能声称解释了所有 Windows 间歇性超时。SSE 和 noReply 本轮通过，历史风险仍保留，等新 head 的完整验证。

已有 execute、token 估计和旧 TUI 用量修复只做回归，不重复实现。

## 临时日志与最终验收
本轮暂留 `[CI-DIAG-R10]` 和 `[CI-DIAG-R11]` 日志，打印启动、退出、清理等位置的耗时、回复计数和退出码，不记录 prompt、参数、路径、配置或凭据。没有增加 stream reader、放宽超时、降低并发、增加重试或把失败改为成功。原 unknown-finish 的 bash、错误、恢复回复及断言完整保留。

最终移除临时日志，审查最终 diff，再运行该确切 head 的全部必过 CI。不能沿用旧 commit 的通过结果。整理历史时核对远端 head，使用带 lease 的更新，避免覆盖他人提交。

## 本地验证记录
当前修订的新相对路径 read 回归已完成预期红绿：旧夹具返回固定结尾但没有文件内容，修正后收到真实内容。

原 pre-push 关闭可选遥测后仍返回 1：29 项中 21 项缓存成功，CLI 包的 tsgo 被 SIGKILL，未到达子模块检查。没有增加仓库配置或把补充编译冒充原门禁通过。本次发布按已批准的流程跳过本地 hook，由 PR 远端完整 CI 执行门禁。

本轮 CLI 夹具全部 12 个使用方：69 passed、0 failed，34 个快照、952 次断言；数据库完整文件：15 passed、64 次断言；ProjectCopy：13 passed、35 次断言；真实强停双例、SSE、SDK noReply：4 passed、13 次断言。测试使用仓库外的本地出网拦截脚本，允许回环与内嵌资源，不是远端完整 CI 的替代。

默认包级 typecheck 仍被 SIGKILL；仅本次命令使用 `GOMEMLIMIT=512MiB GOGC=20 bun run typecheck --singleThreaded` 的补充检查通过。没有新增仓库配置，补充结果不能代替原 pre-push。Linux 本地结果不能代替 Windows 验证。

## 修改规模
实现文件 8 个，当前新增 216 行、删除 70 行，共 286 行，本说明不计。仅 CLI 入口涉及生产代码，其余为测试夹具、回归、报告设置和临时日志。

# Canonical Implementation Plan: Guard 移除 GitHub Approve 硬依赖

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: ChatGPT 用户消息，见 §1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-22

此文件是唯一 canonical plan，终态 `verified-implementation-and-commit`，单 commit PR 指向 `dev1-smark`，由用户合入。

## 1. Verbatim Requirement

消息 `Sentinel_3abd33c5918881919087d4eca66313e5`：

> 我看了一下，那是相应Gate的问题。那我觉得应该提一个Gate的PR修复，去避免它一定要去被Approve。请注意这点，就是不需要一定被Approve。把那个一定要被Approve的逻辑按照Workflow的流程去移除掉，提一个PR。

本对话的后续需求：

> 就改掉所有的我们仓库里面必须要有GitHub Approve才能放行的这种逻辑。

## 2. Explicit Non-Goals

不改 GitHub 网站的 Ruleset、Code Owners、合并权限、#5/#6 分支，也不改内部方案/实现独立审计。保留 Guard 300 行与单文件增长阈值、所有其他规则/合约/回归/required 汇总、现有代码变更触发和 token 权限。

## 3. Repository Context

| 来源 | 约束 |
| --- | --- |
| `AGENTS.md`、`docs/guides/workflow.md`、规划技能、政策、模板 | 先写 exact baseline-to-target plan，审计通过后才实施。 |
| `CONTEXT.md`、`docs/adr/` | 领域模型不涉及 CI 授权；唯一 triage ADR 与参与人/标签分配不变。 |

pre-R1 固定为 `57a50ae146f8265e6fbbb348cddcfa3d3f3d6c56`；GitHub compare 确认与远端 `dev1-smark` identical。

## 4. Files and Evidence Read

| 证据 | 相关性 | 类别 |
| --- | --- | --- |
| `.github/workflows/guard.yml:1–11,103–171,327–352` | PR 触发、token scopes、规则检查、结果汇总 | observed |
| `script/guard/check.ts:10–12,402–413`、`script/guard/size.ts:18,37–53,120–143`、`script/guard/rules.ts` | 检查范围每 commit；现有超规模 flags 只影响 change-size/file-lines | observed |
| `script/guard/test/workflow.test.ts`、`script/guard/README.md:115–138` | 既有 workflow shell fixture、当前操作步骤 | observed |
| 全仓 Git grep 查找 GitHub review states/API/ruleset 参数，并核实 workflow/脚本中的 approve 同义词 | 唯一实际 GitHub Approve 门禁是 Guard，应用权限 reviewer、模板审计 verdict 与 GitHub review 无关；Ruleset 只在设置教程出现 | observed |
| [PR 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)、[重跑文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)、[Actions 并发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | 原 merge SHA/ref 用于 checkout 和重跑；同 PR 标签事件位于相同取消组 | contracted |
| [GitHub 仓库元数据](https://api.github.com/repos/SMARK2022/opencode) 与 [PR #6](https://github.com/SMARK2022/opencode/pull/6) | 公开仓库，owner.type=User，仓主 51025843，#6 头尾同仓 | observed |
| 用户的 #6 `3495d91f / 1913 > 300` 日志及隔离真实 Bun 重放 | 用户症状及最小 red | observed |

| [IssueComment GraphQL](https://docs.github.com/en/graphql/reference/issues#issuecomment)、[GitHub App GraphQL](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql)、[gh API 分页](https://cli.github.com/manual/gh_api) | 评论正文和作者、编辑元数据是独立字段；现有 GITHUB_TOKEN 用原 pull-requests: read，gh 使用 cursor 取各页 | contracted |

## 5. Current Behavior

```text
PR event -> plan job 固定 policy/base -> rules 对全部 PR 加 --no-trailer
-> 分页读取 reviews，仅当前 head 的 OWNER/MEMBER 最新有效 APPROVED 才添加 --allow-large
-> 两次用同组 flags 调用 check.ts -> size.ts 判各非 merge commit -> guard-required 汇总
```

PR 使用目标分支规则及基线做正式检查，再进行候选基线检查。push/preflight 不读 PR，使用既有 previous-baseline。已扫描 .github 与 script/guard：labeled/unlabeled 只在触发清单，代码没有读取标签。所有 PR 事件共用按 PR 编号命名的取消组，所以标签会取消同 head 正在执行的工作。用户的 PR 即使包含有理由的 Large trailer，在线上仍报 1913 > 300。

## 6. Supported Input Domain and Reachability

| 输入 | 生产者 | 保证 | 路径 | owner | 等级 |
| --- | --- | --- | --- | --- | --- |
| 个人所有者仓库同仓 PR 的 owner opened/synchronize/reopened | GitHub webhook | 原始 actor、owner、PR 作者、同仓 id、head SHA 分属实际字段 | rules 分类 | workflow | contracted |
| 协作者更新 owner PR、外部 PR、rerun | GitHub | 当前载荷与触发者分开；rerun 固定原 SHA/ref | rules 分类 | workflow | reachable |
| 仓主对当前 head 的未编辑 PR 评论 | GitHub GraphQL IssueComment | 作者 ID、当前正文、editor、最后编辑时间分开返回 | rules jq | workflow | contracted |
| 有/无理由的大提交 | Git | diff 与 message 都由同一 commit ID 取值 | check.ts → size.ts | size | observed |

## 7. Required Invariants

| ID | 不变量 | 证据 | 现有测试 |
| --- | --- | --- | --- |
| INV-01 | 仓库 Gate 没有 GitHub Approve 硬依赖；个人所有者仓库 owner 推出的自己 PR 可使用有理由的单 Large 提交 | 用户原文及线上红测 | workflow shell |
| INV-02 | 其他 PR 的 trailer 无自行豁免能力，仓主可用未编辑的明示对具体 head 放行规模 | 现有 OWNER/MEMBER + exact head | workflow shell |
| INV-03 | 旧 SHA、未授权作者、已编辑/缺编辑字段的评论不放行；API 错误保持失败，缺 PR 事件不放行而走默认检查 | 现有 Guard error 语义 | workflow shell |
| INV-04 | 所有大小阈值、其他规则、权限、post-rule 汇总及非 PR 路径不变；不含代码变化的普通 relabel 不取消有效检查 | 现有调用链 | workflow + Guard suite |

## 8. First Divergence and Root Cause

| 不变量 | 首次偏离 | owner | 可重复证据 |
| --- | --- | --- | --- |
| INV-01 | rules shell 对所有 PR 拒绝 trailer，只信 GitHub APPROVED | `.github/workflows/guard.yml` rules | 线上 1913 > 300；最小 301 行有效 trailer + 空 reviews 得 301 > 300；仓主未编辑、明确当前 SHA 的 PR 评论在原实现同样失败 |
| INV-02/03/04 | 现有防线保持 | workflow/check/size | 隔离负例和原现有 suite |

隔离重放实际 YAML rules 命令，唯一远端依赖 `gh api` 替换为分页 JSON，以下游基线真实 Bun CLI 观察。baseline 两个现有部署形状的目标场景都有一条 `change-size` 错误；隔离目标仅去掉这一项。由于最小仓没有完整包注册和 forwarder 拓扑，另 42 个与任务无关的既有规则错误均保持；这不是完整 Guard 绿色。

## 9. Responsibility and Seam

| 关注点 | 责任方 | 接口承诺 | 为什么在这里 |
| --- | --- | --- | --- |
| GitHub 身份/事件/授权明示 | workflow rules | 给两个既有 check.ts 同一组 flags | 读取 GitHub 原始载荷的唯一 owner，CLI 不直接依赖 GitHub |
| Git commit reason、规模和其他规则 | check.ts/size.ts | 复用既有 --no-trailer/--allow-large | 不复制阈值、commit 解析与计算 |

## 10. Single Approved Primary-Path Design

删除 rules step 的 reviews API、APPROVED 与按审核人最新意见计算。改变 workflow 的 PR 触发列表为 opened、synchronize、reopened，去掉不读、不检查且不改变代码的 labeled/unlabeled。保留以 PR 编号为 key 的取消组及 guard-required job，让新代码 head 能及时替换旧 run，同 head 的普通标签不再影响运行。

1. GitHub 原事件 GITHUB_EVENT_PATH 的 pull_request.head.sha 非空且等于 PR_HEAD，也等于本次 checkout 的 merge HEAD 第二亲本。只在这个同一被检 head 上做下述判断；无 GitHub 载荷或查不到该亲本时直接走默认规则。仓库可见性、git author、PR 正文、当前标签和 rerun 点击者不参与。
2. 原事件的 repository.owner.type 为 User，原仓主数字 ID 非空，sender.id 与 PR 作者 id 均相同，非空 head repo ID 与本仓 repo ID 相同，且来自 opened/synchronize/reopened 时，保留既有逐 commit trailer 语义。这个路径不查 API、不加评论步骤。owner 推送没写理由时仍按默认预算。新 head 的协作者同步回到默认分类。
3. 其他同 head PR 保留 --no-trailer。复用原 rules job 的 PR id、GH_TOKEN 和 pull-requests: read，调用 gh api graphql --paginate --slurp，不加任何权限或触发。查询该 PR 的 comments，变量 owner/repo 由 GITHUB_REPOSITORY 分解，number 由现有 PR，cursor 用 gh 的 $endCursor。每页请求 comments.nodes 的 body、author(User.databaseId)、editor、lastEditedAt 和 pageInfo。仅正文整体等于 Guard-Allow-Large: <当前完整 PR_HEAD>，author.databaseId 等于原仓主数字 ID，且 editor、lastEditedAt 两字段均存在并为 null 时，传 --allow-large。作者是仓主但正文后来由任何人修改，或字段不全，都不接受；仓主需要更正时发新评论。空页结果默认不放行，API/JSON/GraphQL errors 保持规则失败，不将错误当成授权。
4. 维护者评论是普通 conversation 里的可选规模明示，无需 GitHub Review；仓主评论后在已有当前 SHA run 上点 Re-run，后续有效运行仍从同一个 PR 读取明示。旧评论绑定完整 SHA，新代码即使沿用旧标签/旧评论，也不继承。删除评论之后重新运行时不放行；不回写历史 Actions 状态。两次 checker 共用一次计算出的 flags。不存在另外一套 checker、门禁或备选成功路径。
5. 两次 checker 未被换掉，所有 gate 合约和非 PR 模式保留。宿主格式仍用同一个流程和 token，只替换远程输入及原本不读的标签触发。CLI/报告中的「审批」改用「仓主放行」，工作流头部旧「保留审批」对应修改。

## 11. Secondary and Replacement Path Inventory

| 路径 | 现有/计划 | 分类 | 成功 | 占比 | 处理 |
| --- | --- | --- | --- | --- | --- |
| 两次 check.ts | 现有 | primary | 按现有规则 | 全部 | 保留 |
| 精确 head APPROVED | 现有 | 旧 CI 前提 | 仅规模 | PR | 删除 |
| 原事件 trailer / 未编辑的仓主 exact-head 评论 | 计划 | 同一授权判定的身份输入分型 | 仅规模 | PR | 进入既有 opts，不在失败后重试 |
| push/preflight | 现有 | 非 PR 原路径 | 按现有规则 | 非 PR | 保留 |
| issue_comment trigger、扩大 token、改 settings | 无 | forbidden | 否 | 0 | 不引入 |

## 12. Workaround Deletion and Replacement

| 旧动作 | 原因 | 替代 | 位置 |
| --- | --- | --- | --- |
| 维护者点击 Approve 和再跑；用户自有 PR 转找其他审阅人 | 不信普通 commit trailers | 可信 owner 原事件直接认既有理由；其他 PR 可由仓主为准确 SHA 留普通未编辑评论 | workflow、现有测试、README/术语 |

## 13. Forward Traceability

| 对象 | 路径 | 文件 | 行为测验 |
| --- | --- | --- | --- |
| INV-01 | rules actor / verified comment | guard.yml + test/workflow.test.ts | 无审批 owner 尺寸理由；用当前 SHA 的仓主未编辑评论放行 |
| INV-02 | event/actor/head → CLI | guard.yml + test/workflow.test.ts | 协作者新头、fork、非 owner actor、旧 SHA、普通正文、仅 review |
| INV-03 | 事件和 checkout → 默认检查 | 同上 | 编辑记录、缺 head、API 错误 |
| INV-04 | flags → size / result | 同上 | flags 一致、其余真实检查仍报错误、旧 required suite |

## 14. Reverse Traceability

| 概念 | 需求 | 证据 | 为什么不能直接复用 |
| --- | --- | --- | --- |
| 个人所有者仓库 owner GitHub 原事件允许每 commit 理由 | INV-01/02 | 301 行 red 和原 --no-trailer | 已有 size 解析直接复用；旧 CI 无可信 source 分类 |
| 仓主未编辑的当前 head 评论 | INV-01/02/03 | 现有 exact head 约束及官方作者/编辑元数据 | 去掉旧审批状态绑定；复用 --allow-large |
| 操作说明与报告词 | INV-01 | README/CLI 仍要求 GitHub approve | 更新为真实输入 |

## 15. File-Level Change Plan

| 文件 | 动作 | 职责 | 预计行差 |
| --- | --- | --- | --- |
| `.github/workflows/guard.yml` | modify | 移除无关标签触发；rules 以原事件或未编辑评论替换 review；原读权限保留 | 净增 ≤20 |
| `script/guard/test/workflow.test.ts` | modify | 重用现有 shell 测试实例，调整 fixture 与场景 | 净增 ≤20，零新测试实例 |
| `script/guard/README.md` | modify | 用原事件/未编辑评论重跑操作替换旧 review 步骤 | 1–3 |
| `script/guard/check.ts`、`script/guard/size.ts` | modify | 已有帮助和报告术语，保持判断不变 | 两个替换行 |
| 本计划 | add | 规格、审计记录 | 文档 |

## 16. TDD Behavior Slices

| 序号 | Red | 基线失败原因 | 最小 Green | 回归 |
| --- | --- | --- | --- | --- |
| 1 | 无 review 的公开个人仓库 owner 当前 head trailer 允许 301 行 | 总是 --no-trailer | 原事件判定后不加 --no-trailer | 未授权更新、fork、缺失标记保持默认 |
| 2 | 其他作者的 PR 带仓主对准确 SHA 的未编辑评论，重跑后通过规模 | 只读 reviews | 查评论的作者与编辑状态，传 --allow-large | 无评论，编辑者未知/他人、旧 SHA、普通正文、未经授权作者、API errors，保持原检查 |
| 3 | 仓主授权的同一 head 后收到无关 relabel，旧检查继续；新 head 照常运行 | 基线订阅两类标签触发并取消同 PR 旧 run | 去掉未消费的两个标签触发 | 现有代码触发、concurrency 和 guard-required 汇总不改 |

使用现有 workflow shell 入口，结合现有 checker 测试和真实隔离 Bun check，不新增测试实例或内部 helper 测试。

## 17. Comments

注释说明忽略无关标签是为了避免取消该 head 的 Guard；记录编辑字段用于确认正文仍为原作者所写，原拉取权限只读评论。

## 18. Verification

| 命令 | 工作目录 | 指标 |
| --- | --- | --- |
| `bun test test/workflow.test.ts` | script/guard | 三条 red/green：公开仓主 trailer、其他 PR 的仓主未编辑 SHA 评论、同 head 无关标签事件序列；负例与 required 退出一致 |
| `bun run typecheck && bun test` | script/guard | Guard 全量及类型检查 |
| `bun script/guard/gate.ts contracts` | 仓库根 | 契约检查 |
| `git diff --check` | 仓库根 | 提交前差异 |
| 实际 YAML shell 循环：stock.sh、r3.sh 使用同一临时 Git fixture、事件 JSON、GH API 分页替身 | 隔离 Git fixture | 库主的公开 repo owner 明示及普通 PR 的未编辑仓主评论各从 43 个夹具错误到 42 个，只去掉 change-size；未授权/编辑过/旧 SHA/普通正文仍为 43 |
| YAML 的订阅序列对照 synchronize(A) → labeled(A) → unlabeled(A) → synchronize(B)，检查同一 PR 并发组 及最终守门步骤 | 隔离 Git fixture、现有 workflow test | baseline 4 次安排且后两个 A 可取消前一次 A；R3 只安排 A/B；新 SHA 仍执行，RULES 非成功仍阻断 |
| 查看本新 PR 当前 head 的 Guard 必需 checks | GitHub PR Actions | 真实工作流运行，保留仓库规则归属 |

隔离证据：/tmp/gate-event-evidence.pp0c0v/r3-results.txt、r3-schedule.txt。前者是真实 shell/jq/Bun checker；后者由实际基线 YAML 配置推导调度，不冒充 GitHub 原生运行。

## 19. Diff Budget

| 项 | 估算 | 理由 |
| --- | --- | --- |
| Files added / modified / deleted | 1 / 5 / 0 | 仅计划、workflow、原测试与既有操作说明/术语 |
| Production lines | 净增 ≤20，外两行替换 | 复用 jq、gh、事件和已有 flags，无新模块或网络权限 |
| Test lines | 净增 ≤20；测试实例零净增 | 复用既有用例表 |
| Generated lines | 0 | 无 |

## 20. Real Risks and Open Decisions

GitHub 在 fork PR Actions 可提供空 payload，此时按默认预算，不宣称放行；有正常载荷的普通 PR 走评论输入。GitHub 的真实 GraphQL token 与调度需此 PR 的线上 check 补验；不把本地 API/调度模型声称为目标机执行。owner 同仓当前 head 路线不依赖 API。

### Open Decisions Requiring the User

无。

### Follow-up

| Concern | Evidence | Baseline behavior | Round |
| --- | --- | --- | --- |
| 外部 Ruleset/Code Owners 审核策略 | README Settings | 仓库代码不直接控制 | R1 |

### Rejected Speculation

不加 webhook、GitHub App、新权限、专用标签 UI、临时镜像 PR 或相同 repo 任意用户 trailer 通行。REST 评论仅给原作者和最新正文，无法证明编辑来源，拒绝使用。

## 21. Audit Contract

独立审计完整原文、exact pre-R1 baseline、实际 event→checker 两条输入和其余规则保持。审计该完整 revision，重建证据，blocking finding 必须给路径和结果；必须获得 `No blocking findings` 与 `APPROVE` 后才实施。

## 22. Revision Delta and Plan Audit Record

| Revision | Sections changed | Prior findings and resolution | Invariants, states, concepts, or files added or removed |
| --- | --- | --- | --- |
| R1 | 初次记录 | 未审计 | 两条原文的完整范围 |
| R2 | §4、§6–20 | B-01：删除仓库 visibility 前置；B-02：去掉可编辑评论，用仓主实际发出的 exact-head 标签事件 | 不新增权限；删除评论路线和 reviews API |
| R3 | §2、§4–20 | B-03：去掉未消费的 relabel 触发，保留现有取消组；普通 PR 改用未编辑的仓主 exact-head 评论 | 删除专用标签 UI，拒绝已编辑评论，不加 token 权限 |

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02 | 见下方原文 | BLOCK | R1-independent-plan-verdict.md · a74677731356caf426948886d35c5272dafc95d31564a35b8997635f3e1ac2f4 |
| 2 | R2 | yes | B-03 | workflow 顶层旧术语 | BLOCK | R2-independent-plan-verdict.md · b119ada0c283780570e69d00224513a910289b64f6054c48d25872ae530f3d02 |
| 3 | R3 | yes | No blocking findings | §18 首个条目列明三条行为验证，已作非实质记录修正 | APPROVE | R3-independent-plan-verdict.md · f1ddfc3445d6a281dcffc07a2c64dcc0067c416cc6846b521ca3043501c1a51b |

<details><summary>R1 独立方案审计原文</summary>

## Blocking findings

### B-01 方案验证了私仓事件，当前 #6 的 trailer 路径仍不可达

- **Violated invariant:** INV-01。用仓库自己的真实 PR 取消 GitHub Approve 硬依赖，并让仓主原提交的 Large 理由走已选主路径。
- **Evidence class:** observed。
- **Producer and execution path:** 现有 #6 的 `pull_request` → §10.1 判断 `repository.private` → §10.2 仍加 `--no-trailer` → 原大小规则。
- **Source evidence:** [仓库实时元数据](https://api.github.com/repos/SMARK2022/opencode) 为 `private:false`、`visibility:public`、owner 类型 `User`；[现有 #6](https://github.com/SMARK2022/opencode/pull/6) 的 head 与 base 都是该公开仓库。准确候选 `3495d91f…` 已带理由 trailer。`r1.sh:3` 要求 `private:true`，owner green 只用了这个条件为真的合成事件。
- **Canonical-plan evidence:** §6–8、§10.1、§16、§18。
- **Responsibility owner:** Guard 对真实仓库事件的身份分类。
- **Concrete behavioral consequence:** 修复所针对的现有 #6 仍无法凭原提交的 Large 理由通过；仍须另有 GitHub 留言。R1 没有验证当前公开仓仓主的路径。
- **Pre-R1 baseline behavior on the same path:** 原 Guard 忽略 PR trailer，实际 #6 报 1,913 > 300。
- **Minimal correction direction:** 用当前公开个人仓及同仓仓主的真实事件形状固定正例，保留未授权来源的默认尺寸检查，验证所选路径能对该 PR 生效。

### B-02 评论原作者字段不能证明当前正文由该作者授权

- **Violated invariant:** INV-02、INV-03。保持原 OWNER/MEMBER 信任边界。
- **Evidence class:** contracted。
- **Producer and execution path:** GitHub 可编辑 PR 评论 → REST 原作者关系及当前正文 → §10.2 → 大小例外。
- **Source evidence:** `r1.sh:6–8` 只使用 `user.type`、原作者关系和正文。[GitHub 评论管理文档](https://docs.github.com/en/communities/moderating-comments-and-conversations/managing-disruptive-comments#editing-a-comment) 允许有仓库 write 权限的人编辑 PR 评论；[REST 评论接口](https://docs.github.com/en/rest/issues/comments#list-issue-comments) 返回作者和正文，[GitHub GraphQL](https://docs.github.com/en/graphql/reference/issues#issuecomment) 则明确把评论作者与编辑者列为不同字段。
- **Canonical-plan evidence:** §10.2 声称同一信任级别；§13、§16 未验证授权内容的实际发布者。
- **Responsibility owner:** Guard 的授权信号来源。
- **Concrete behavioral consequence:** 规则不能确认当前命令由满足原资格的人发出，因而会扩大谁能授予大提交例外。
- **Pre-R1 baseline behavior on the same path:** 原规则读取 GitHub 绑定审核者身份与当前提交的 review 状态，普通评论正文从未参与授权。
- **Minimal correction direction:** 取消用可编辑正文授权，或用 GitHub 可验证且同时绑定真实授权人和准确 head 的信号；保留其他检查。

## Non-blocking findings

GitHub Issues 评论接口支持现有 `pull-requests: read`。权限范围本身无须扩大。仓库代码中未发现第二处活跃的 GitHub Approve 检查；README 里的 Code Owners 与 Ruleset 说明对应外部设置。

## Follow-up

原 workflow 已订阅 `pull_request:labeled`。GitHub 服务器提供事件 sender 和 PR 快照；只认受信 sender 与准确事件 head 的信号可以另案评估，不应只读当前标签列表来推断授权人。还须核对新提交、重跑及后续其它标签事件的实际回执。此次只读核对，未把该路线算作已验证。

## Rejected speculation

无需调整 300 行阈值、跳过其余 Guard、改仓库 settings 或增加 token 权限。最小样本中移除一项规模错误的回执不等同于全 Gate 通过。

## Requirement and traceability coverage

复核了完整用户原话、准确 57a 基线、现有 #6、原规则与两组 shell 对照。R1 已定位唯一的活跃 Approve 判断，现有两个 checker 和汇总可以保留。仓库可见性及评论授权来源尚不符合方案合同。

## Primary-path and fallback verdict

大小计算仍归原 checker。当前两个计划授权来源中，owner 主路径漏掉实际仓库，评论路径不能证明授权人；两项应先修正。

## Release verdict

**BLOCK**。适用于精确 **R1 方案**，SHA-256 `e554aa7dcc1492158185939a0d72e67a69bc86b9c4e203fe422efcf40d16cd2d`。

</details>

<details><summary>R2 独立方案审计原文</summary>

## Blocking findings

### B-03 无关标签会取消同一 head 已获授权的 Guard

- **Violated invariant:** INV-01、INV-02。仓主对当前 head 的授权应让该 head 完成原 Guard；普通标签不应改变其规模判定。
- **Evidence class:** contracted。
- **Producer and execution path:** GitHub `pull_request:labeled/unlabeled` → 同一 PR 的并发组 → 后来的事件取消进行中的 Guard → §10 重新分类 → 两个 checker 按默认尺寸限制执行。
- **Source evidence:** `.github/workflows/guard.yml:12–14,32–34` 订阅标签事件，并按 PR 编号取消旧运行；`:379–380` 要求规则任务成功。[GitHub 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)明确取消行为。`r2-results.txt` 中，两个隔离样本的 head 相同，仓主加专用标签时消除 `change-size`，仓主加普通标签时恢复该错误。该记录是规则步骤的回执；取消行为来自工作流配置。
- **Canonical-plan evidence:** §10.2–4、§16、§18。现有验证单独检查每个事件，未覆盖两个合法事件先后到达。
- **Responsibility owner:** Guard 工作流的授权判定与并发调度。
- **Concrete behavioral consequence:** 已授权且未改代码的 PR，在 Guard 完成前收到普通标签事件，授权运行就会被取消，继任运行因大小超限而失败。仓主自己提交、通过 trailer 授权的运行也会被同一并发组取消。
- **Pre-R1 baseline behavior on the same path:** 同一 PR 的新事件也会取消旧运行，但继任运行重新读取同一 head 的有效批准，因此普通标签不会撤回已有的规模授权。
- **Round basis:** introduced by delta；既有 exact-head 授权连续性回归。
- **Minimal correction direction:** 让同一 head 的普通标签事件保留有效规模授权，或让此类事件不取代授权运行；用“授权后加普通标签”和“换 head 后仍受限”两组顺序验证锁定边界。

## Non-blocking findings

更新 `.github/workflows/guard.yml:3` 的头部说明，其中仍写着「保留审批」。

## Follow-up

正式验收核对 GitHub 的 `guard-required`，以及准确 head 的两次规则检查。当前隔离回执精确证明移除一项 `change-size` 错误，其余 42 项夹具错误仍保留。

## Rejected speculation

无需新增 token 权限、改 GitHub Ruleset、恢复评论正文授权，或调整 300 行及单文件大小阈值。

## Requirement and traceability coverage

R1 的 B-01、B-02 已关闭：公开个人仓的仓主正例已覆盖；可编辑评论已移除，改读 GitHub 原始事件的 sender 和 head，并和 checkout 对齐。复核确认活跃的 GitHub Approve 门禁集中在 Guard 规则步骤。现有两个 checker、非 PR 路径及最终汇总可继续复用。

## Primary-path and fallback verdict

规则步骤统一选定 flags，大小计算继续由原 checker 执行，没有失败后改走另一条成功路径。当前问题在授权事件与原并发调度的衔接。

## Release verdict

**BLOCK**。适用于精确 **R2 方案**，SHA-256 `cc12cb16208a81a2aa66b8b0f772b8ea2f9036556ee768bae3781a976548301a`。

</details>

<details><summary>R3 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的首个测试条目应写明三条行为验证，包括新增的同一 head 标签事件序列。

## Follow-up

线上验收分别记录有理由的仓主同仓提交，以及使用真实 `GITHUB_TOKEN` 查询未编辑评论的结果。仓主直通路径跳过 API，单看这条运行无法验收评论路径。部署后验证 #6 时，应核对运行使用新工作流；GitHub 重跑旧历史运行仍使用原 SHA/ref。[GitHub 重跑文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

## Rejected speculation

无需新增 GitHub 权限、调整规模阈值或保留专用标签。GitHub 删除评论历史中的正文时仍保留编辑人和时间；没有理由为此引入第二套授权逻辑。[GitHub 评论编辑历史](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment)

## Requirement and traceability coverage

B-01、B-02、B-03 已关闭。公开个人仓的仓主同仓路径直接使用原 trailer；评论路径校验仓主、完整 SHA 和独立的编辑字段，已编辑或缺字段的评论不放行；普通标签事件不再调度 Guard，新提交仍走原并发组。源代码确认活跃的 GitHub Approve 门禁只有原 Guard 规则步骤。真实下游 checker 的两个正例均只消除 `change-size`，42 项夹具错误保留；GraphQL 错误仍失败。

## Primary-path and fallback verdict

Guard 统一决定现有规模 flags，再执行原有两次检查。仓主 trailer 与未编辑评论按输入分类，API 失败不会转成成功。其他规则、非 PR 路径和 `guard-required` 汇总保持原有约束。

## Release verdict

**APPROVE**。批准精确 **R3 方案**，SHA-256 `6112d091eb1a2f587b895efbd4688a3cef13620af4b15948cbb8274a388f8ec8`。登记裁决后可实施，实际差分另行审计。

</details>

## 23. Implementation Evidence

### Actual Files and Diff

- .github/workflows/guard.yml：保留 PR/非 PR 规则两次调用和原汇总；移除无关标签事件；以当前 checkout 事件确定仓主 trailer 或同 SHA 未编辑评论；无有效明示走默认规模判定（+29/-9）。
- script/guard/check.ts 与 script/guard/size.ts：各一行授权术语更新，阈值和运算没有改动。
- script/guard/README.md：一行操作说明，解释仓主的两种现有工作路径。
- script/guard/test/workflow.test.ts：更新既有测试实例，不额外增加实例（+71/-105）。
- 本计划：按批准版本登记审计、测试与实际差异。

实际五文件 diff SHA-256：c942dbd4ee4553cf199cee625b4174e4969e44a7443e192615e99ad7e09c546e，源文件 Git tree 3f9e7042113bbb07ffa99c858810bf772372389c。

### Red-Green Test Evidence

在 script/guard 执行 bun test test/workflow.test.ts：Slice 1 stock 实收 default/预期 trailer；Slice 2 实收 default/预期 grant；Slice 3 订阅 A,A,A,B/预期 A,B。逐片修正后分别 2/2 通过，最终 55 个断言。正例和两次 checker flags、已编辑或缺字段、旧 SHA、错误 actor、API error、GraphQL error 均在同一既有 shell 入口验证。

### Verification Commands and Results

- git diff --check：通过。
- bun script/guard/gate.ts contracts（仓库根）：schema/protocol 通过。
- bun run typecheck（script/guard）：tsgo --noEmit 成功。
- bun test（script/guard）：6 个文件、112 passed、399 assertions、0 failed，55.50 秒。
- 最终实际规检查 YAML shell + 真实 Bun checker：两条正例均只去掉 change-size，负例与 stock 保持，GraphQL error fail closed。

### Original Feedback-Loop Result

最终文件原样抽取规则 shell，把 gh 作为唯一替身，同一真实 Git 的 301 行提交及 checker 跑两条正例、编辑/非本人/旧 SHA/描述/无授权和 GraphQL error：两条基线样本各 43 个错误，新路径各 42 个（仅消失 change-size）；其他 42 个不相关夹具错误仍生效；无授权样本各 43 个；API GraphQL 错误退出 5。回执 r3-final-results.txt。

### Actual Secondary and Replacement Path Inventory

仓主当前事件 trailer 与未编辑的当前 SHA 评论是同一规则入口的互斥输入分类，不在失败后引入回退。非 PR 的 previous-baseline、目标分支规则、合约、checked ref、并发组和 guard-required 不变。

### Remaining Unverified Items

GitHub 实际 token 与 Actions 调度应在线核验；仓主直通跳过 API，验收报告需单独看评论路线。尚未创建 commit、PR 或合入。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | 是 | No blocking findings | 补录现有回执 | APPROVE | 独立实现审计，完整裁决见下 |

<details>
<summary>R3 independent implementation audit verdict</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

补录 §23 的三份现有回执：Guard 套件 112 例通过、类型检查退出 0、最终工作流脚本回放完成。正例各只消除一项 `change-size`，其余 42 项夹具错误保留。

## Follow-up

正式 PR 的 `guard-required` 和两条授权路径仍须线上验收。分别记录仓主同仓 trailer 与普通 PR 的真实 `GITHUB_TOKEN` 评论查询；仓主直通不会调用该 API。

## Rejected speculation

无需加权限、修改 GitHub Ruleset、调整大小阈值或保留标签触发。

## Requirement and traceability coverage

核对了 R3 批准稿、固定基线和六条实际变更路径。仓库中唯一活跃的 GitHub Approve 判定已删除。三条预期红测均有原始回执；实际工作流脚本与最终重放脚本逐字相同。Guard 全套 112 例通过，类型检查与 Schema/Protocol 契约通过。

## Primary-path and fallback verdict

规则步骤统一决定规模 flags，两次原 checker 共用。仓主同仓事件允许原 trailer；其他有效 PR 事件只认仓主未编辑、匹配当前完整 SHA 的评论。API 错误阻断规则检查。非 PR 路径、大小阈值及 `guard-required` 汇总保持原样。

## Code quality verdict

变更限于工作流、旧测试夹具和术语说明，测试实例零净增。`git diff --check` 通过。

## Release verdict

**APPROVE**。批准 R3 实际五文件源码、测试及说明差分，SHA-256 `c942dbd4ee4553cf199cee625b4174e4969e44a7443e192615e99ad7e09c546e`，及本次审计所读 canonical Plan，SHA-256 `0217774e93490e98d70d88baea2ba5274f7287f4b17267dddf99334407ee2151`。发布与合并就绪仍以原 hook 和正式线上回执为准。

</details>

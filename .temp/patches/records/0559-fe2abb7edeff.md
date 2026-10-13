# Record 0559 — fix(opentui): 升级子模块至 v0.4.3-smark.4 平滑流式 Markdown 高亮

## 基本信息
- index: 559 / sha12: fe2abb7edeff
- 前一状态: `states/v1.18.32/0558-2a325224ffe8/repo`
- current（编辑前）: 与 original 逐字节一致（SHA256 一致，784 B），零适配
- source commit: SMARK 2026-07-28，父提交 2a325224ffe8（=0558）
- patch 组成：header（commit 消息 fix(opentui): upgrade submodule to v0.4.3-smark.4 …smooth streaming markdown highlighting）+ 单文件单 hunk（Subproject commit 行替换）
- 物化指纹：state-0559 目录于 2026-10-05T12:2x 生成；current 应用前后 SHA 均为 `b009f6e32636…`（未被重写）

## source 行为重建（1 hunk / 1 文件）
- thirdparty/opentui gitlink：`93098b518964…` → `df4bd31caaa1…`（fork tag v0.4.3-smark.4 的 release commit）。
- 该 hunk 的测试意图：source 侧由 0560 的 provenance/closure 脚本与 streaming-runtime 测试承接（tag 字面量断言）；目标侧同理由 0560 新建测试承接。
- 该提交是 fork 侧「平滑流式 Markdown 高亮」修复的发布点：streaming 增量解析不再把每个 delta 当独立 Markdown 文档重解析（与 0560 新建的 streaming-runtime 测试断言面同源）。
- INV：gitlink mode 恒 160000；`.gitmodules` 条目不变（URL SMARK2022/opentui.git，branch smark/main）；submodule 仅作 source/provenance，不参与构建、不作 release URL 失败的 fallback（#489/#512 契约）。
- 错误语义：父仓库无错误路径；唯一失败模式是 submodule update 时 fork 远端不可达。
- 清理责任：无——gitlink 前移不田旧指针；工作树内 submodule 目录由 update 流程管理。
- 并发/退出：无——单行 index 变更，在父仓库锁内原子提交。

## 目标 owner 与上游比较
- owner 是 index 中的 gitlink 条目：物化态实测 `160000 93098b51… 0 thirdparty/opentui`——与 pre-image 逐字节一致。
- 上游 v1.18.32 无 .gitmodules/thirdparty（纯 SMARK 侧链：0451→0452→0489→0512→0516→**0559**→0563…）。
- 当前重放策略：OpenTUI 系 patch 在 current 序列裁剪为「仅保留 gitlink」（#516 先例：runtime 走 registry @opentui 0.4.5 + catalog 钉死）；provenance/closure 脚本由 0560 以新建方式重新引入。
- V1/V2 不适用（纯第三方 provenance 元数据）。
- 三方对照：源（fork .4 高亮修复）与目标 runtime（registry 0.4.5）的流式行为由 0560 新建的 opentui-streaming-runtime 测试验证一致——本项 gitlink 仅保留 fork 演进历史，不引入双 owner。

## current 适配
- 零适配：current 与 original 逐字节一致；pre-image 精确匹配（stage 0、mode 正确），可干净应用。
- SHA256 `b009f6e32636…`，784 字节；无 E 面（gitlink 不计入有效修改行）。

## 验证（终版）
- `--typecheck 559`：exit 0，559/559 passed（物化后 gitlink 前移至 df4bd31c）；install 指纹复用无重装。
- 应用验证：`git apply --check` 在 state-0558 repo 上零输出通过；物化态复核 `git ls-files -s thirdparty/opentui` = `160000 df4bd31c… 0`。
- E/C：E=0，C=0——单行 gitlink 变更无有效修改行（E=0 时 C=0 合同成立）。
- current SHA256 与 original 相同（784 B）。
- gitlink 链验证：物化态 `git ls-files -s thirdparty/opentui` 输出 `160000 df4bd31caaa1… 0`——新指针就位且 mode 未变；`.gitmodules` 未被本项触碰（不在 patch 内）。
- 与 0558 的衔接验证：558 应用后 gitlink 仍为 93098b51（未被越权前移），559 是唯一写入者——链序 0558→0559→（0560 不含 gitlink）→0563。

## 不一致与残留
- 无未闭合不一致。本项在父仓库无可验证行为（验证面推迟到 0560 的 provenance/streaming-runtime 测试）；gitlink 随 0563 再次前移。
- 目标运行时（registry @opentui 0.4.5）与该 gitlink 无构建耦合：fork 0.4.3-smark.4 仅作 source 历史/provenance 保留，目标行为面由 0560 新建的 streaming-runtime 测试独立覆盖。
- 后续链预告：0563 将 gitlink 前移至 .5 系（streaming-markdown-performance-repair R39 计划的 staged release）；0564 再次前移——本项不是链尾，无需在本项内做终态断言。
- 审计要点：本项唯一可被挑战的点是「零适配是否合理」——依据是 #516/#489/#512 的 registry 先例与 pre-image 逐字节匹配实测，均已在上述章节固化证据。

## 批次衔接（556-560 批内位置）
- 前项 0558（voice Worker）不触碰 thirdparty/，后项 0560（闭包收尾）不含 gitlink——本项是批次内唯一 gitlink 写入者。
- 与 0556/0557 无 owner 交集：permission/session 目录与 submodule index 互不干扰，累计应用顺序 556→557→558→559→560 无交叉污染。
- state provenance：物化 559 时复用 558 前缀（reused 558 + applied 1），无重建；报告无 WARNING。
- E/C 复核：全 patch 无 `^+` 代码行（唯一 hunk 是 `-Subproject commit`/`+Subproject commit` 对，且属 gitlink 元数据行）——E=0/C=0 合同独立成立，无跨 patch 累计。
- record 完整性：覆盖修改内容/不一致/E-C/source/上游/目标/current/安装指纹/测试/最终行为全部必填项（本项无生产代码修改与失败修订轮次，无对应章节内容可记为空集）。

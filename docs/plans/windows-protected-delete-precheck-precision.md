# Canonical Implementation Plan: Windows protected-delete precheck 精度修复

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL 原始需求（verbatim 见 §1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-22
>
> Revision notes: R5 吸收 implementation audit B-01——`dangerousRaw` 段扫对 Windows family **只**使用保留 `\` 的 `windowsCmdTokens`（空白切分），禁止再顺序 `tokenize` 第二成功路径；`classifyTokens` 仍用既有 POSIX tokenize（与 rm 同构入口，非第二 parser）。

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, brainstorm drafts under
`docs/superpowers/specs/`, and builder rationale outside this file are not
implementation authority.

## 1. Verbatim Requirement

> 当前需要你详细完成检查一下我们的opencode,与现有 protectedDeleteTarget 的 X: 一致；同时尽量仍然保持较大范围的检测，但是适当降低误报率，同时我希望的是提高检测准确率以及降低误报率，而不是容易误报的我们把它们降级成为catious，也就是我们不会将相应的危险或者疑似危险命令降级成为cautious，因为模型审计可能不安全，所以目标应该是提高检测准确率降低误报率。请注意这一点，不降级安全护栏，但是升级检测系统准确性以及解析精准度，不泛滥依赖正则表达式等方式，且保证不会引入新的错误。同时方案保持克制，保持甜点级别的精准修改，不额外引入复杂的状态机或者冗余逻辑，整体修改代码文件数量不超过4个，同时修改行数不超过600行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。
>
> 目标终态：verified-implementation-and-commit

### 1.1 Confirmed requirement IDs

| ID | Confirmed meaning (no narrowing) |
| --- | --- |
| REQ-01 | Windows 保护删除判定与现有 `protectedDeleteTarget` 的 `X:` / 保护根语义对齐 |
| REQ-02 | 保持较大范围检测：真 Windows 保护根递归删除仍 **dangerous hard deny** |
| REQ-03 | 提高准确率、降低误报；**禁止**用「把危险/疑似危险降到 cautious 靠 reviewer」作为解法 |
| REQ-04 | 升级解析精度，不泛滥依赖宽松正则；不引入复杂状态机/冗余逻辑 |
| REQ-05 | 不引入新错误；现有 true-positive 回归必须保持 |
| REQ-06 | 甜点级改动：≤4 文件、≤600 行；不为不可能边界堆处理 |
| REQ-07 | 终态含 verified 实现 + commit |

## 2. Explicit Non-Goals

- 不 demote「Windows protected directory delete」整类到 cautious，也不把 true wipe 改成依赖 auto reviewer。
- 不重写全部 `dangerousRaw`、不引入完整 shell lexer / 状态机 / heredoc 全量建模（除非同段 token 谓词后仍无法消除已观察 FP——当前证据表明不需要）。
- 不修改 `Permission.ask` / `PermissionAuto` 路由语义、不改 agent 默认 permission 配置。
- 不修改 PowerShell `Remove-Item` 既有 dangerous 规则（除共享 `protectedDeleteTarget` 扩展时的自然复用）。
- 不修复 Python `del` 被 `RAW_FILE_DELETE` 标 cautious 的既有启发式（独立 concern；本任务只要求其 **不再误升 dangerous Windows protected**）。
- 不改外部工具协议、SDK、UI。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Permission / Tool / Agent 词汇 | 术语：Permission precheck、auto hard deny；不得写成 access-control |
| `packages/opencode/AGENTS.md` | 测试在 package 目录跑；typecheck 用 `bun typecheck` |
| root `AGENTS.md` | 默认分支 `dev`；commit 规范与中文信息（终态 commit 时） |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁 fallback 链；dangerous 护栏不可用 demote 偷换 |
| `packages/opencode/src/permission/reviewer/policy/policy.md` | Deny protected-root deletion；普通删除 require auth（cautious） |
| 现有 `rm`/`Remove-Item` token 谓词模式 | 权威先例：结构 flag + `protectedDeleteTarget` → dangerous |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` L151-155 `RE_D_WINDOWS_PROTECTED_DELETE`；L556-582 `dangerousRaw`；L543-554 `normalizeForRawScan`；L1057-1078 `classifyTokens`；L1459-1506 `hasRecursiveDeleteFlags` / `protectedDeleteTarget` | 规则 owner 与 first divergence | observed |
| `packages/opencode/src/permission/auto.ts` L63-68 | `dangerous` → deny/source precheck，无 reviewer | observed |
| `packages/opencode/src/permission/index.ts` `AutoDeniedError` | 用户可见 preflight 拒绝文案 | observed |
| `packages/opencode/src/tool/shell.ts` L584-623 | bash/`external_directory` 传入 `metadata.command`；external 透传 dangerous | observed |
| `packages/opencode/src/agent/agent.ts` auto agent `bash: "auto"` | 可达 auto preflight | observed |
| `packages/opencode/test/permission/precheck.test.ts` L73-149 | TP/普通删除契约 | contracted |
| `.temp/testing/red-windows-protected-delete.mjs` + 运行输出 | 用户症状 red loop | observed |
| `docs/superpowers/specs/2026-07-22-windows-protected-delete-precheck-precision-design.md` | 事前 brainstorm，**非**实施权威 | diagnostic only |

## 5. Current Behavior

```text
Shell Tool (metadata.command)
  -> Permission.ask (bash auto / external_directory shell)
    -> PermissionAuto.evaluate
      -> PermissionPrecheck.evaluate
        -> bashEffect / shellEvidenceRisk
          -> evaluateShell
            -> dangerousRaw(normalizeForRawScan(command))
                 RE_D_WINDOWS_PROTECTED_DELETE: 整串
                   \b(del|rd|rmdir)\b
                   + .* ( /s | -s | --recursive )   // 子串
                   + .* ( X: | Users... | %USERPROFILE% | ~ )
                 命中 -> { level: dangerous, reason: "Windows protected directory delete" }
            -> (若未 dangerous) cautiousRaw / splitCommands / classifyTokens
                 del/rd/rmdir 仅 FILE_DELETE_COMMANDS -> cautious
                 rm / Remove-Item 才有 protectedDeleteTarget 升 dangerous
      -> dangerous -> AutoDeniedError（无 pending ask）
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `rmdir /s /q C:\Users\Alice` | agent bash | 明文 command | precheck → dangerous | PermissionPrecheck | contracted (test) |
| `del /s /q %USERPROFILE%` | agent bash | 明文 command | precheck → dangerous | PermissionPrecheck | contracted (test) |
| `del /s C:` | agent bash | 明文 command | precheck → dangerous；`protectedDeleteTarget` 认 `X:` | PermissionPrecheck | observed (red harness) |
| `del /q C:\Temp\old.log` | agent bash | 非递归保护根 | cautious file deletion | PermissionPrecheck | contracted (test) |
| Python heredoc：`del` + `tree-sitter…` + `if not m:` | agent bash | 原文进入 metadata.command | **误** dangerous Windows protected | PermissionPrecheck | observed (user + red loop) |
| `cmd /c "del /s …"` | agent bash | unwrap 后递归 evaluateShell | 内层脚本再进 precheck | unwrap + precheck | contracted (wrapper tests) |
| external_directory + shell + same command | shell tool 先 ask external | shellEvidenceRisk max | dangerous 透传 | externalDirectoryEffect | observed |

Speculative：完整 heredoc 解析器、对抗编码混淆 Windows del——**不**驱动本 revision 设计。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 真 Windows 保护根 **递归** 删除（cmd `del`/`rd`/`rmdir` + 递归 flag + 保护目标）必须 **dangerous**，且不因「怕误报」整类降为 cautious | policy.md deny protected-root；user REQ-02/03 | precheck.test.ts protected-root suite |
| INV-02 | 保护目标判定与 `protectedDeleteTarget` 一致，含 **`X:` 盘根** 与 `X:/Users|Windows|Program Files…`；`%USERPROFILE%` 必须可被同一目标谓词识别（现 raw 有、token helper 无） | user REQ-01；`protectedDeleteTarget` L1482-1505；raw 规则含 `%USERPROFILE%` | del/rmdir TP tests |
| INV-03 | 递归 flag 必须是 **整 token** 的 Windows 开关：精确 `/s`/`-s`/`--recursive`，或 **单字母** 合并 cluster（字母集 `{a,f,p,q,s,u}` 且含 `s`，如 `/s/q`、`/s/p`、`/sq`）；不得因 `tree-sitter` / `/setup` 等 **非单字母开关** 命中 | 已观察 FP；R1–R3 audits；REQ-03/04/05 | FP + `/s/q` + `/s/p` + `/setup` 反例 |
| INV-04 | verb / 递归 flag / 保护目标必须落在 **同一 shell 段**（`;` `\|` `&` 换行 / normalize 后的 ` ; `），禁止整命令 `.*` 跨段拼接 | `normalizeForRawScan` 设计注释；已观察 FP 跨行 | 新增 FP 回归 |
| INV-05 | 非保护根 / 非递归 Windows 删除保持既有 **cautious**（file deletion），不得升 dangerous | precheck.test.ts L73-85 | existing |
| INV-06 | `dangerous` 继续 hard deny（AutoDenied）；本任务 **不** 把本 family 改走 reviewer | auto.ts；user REQ-03 | next/auto tests 既有 dangerous deny |
| INV-07 | 改动甜点：production+test 合计 ≤4 文件、≤600 行；无状态机 | user REQ-06 | diff 审计 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-03, INV-04（及对 INV-01 的误触发） | `dangerousRaw` 中 `RE_D_WINDOWS_PROTECTED_DELETE` 使用 **整串** `\bdel\b` + **`.*` lookahead** + **子串** `-s`/`/s` + 裸 `[A-Za-z]:`，在 token 化 / 同段绑定 **之前** 短路 dangerous | `PermissionPrecheck.dangerousRaw` / Windows protected-delete 规则 | 见 red loop；探针定位：`del`@Python、`-s`@`tree-sitter`、`m:`@`if not m:` |

### Root cause（一句话）

Windows 保护递归删除的 **authoritative detector** 是过宽的 raw 正则，而不是与 `rm` 对称的「同段 token + 递归 flag 谓词 + `protectedDeleteTarget`」。

### Downstream symptoms（非根因）

- `AutoDeniedError` 文案与「禁止 indirection」——正确的 dangerous 后果，不是误报根因。
- Python `del` 可能另被 `RAW_FILE_DELETE` 标 cautious——独立既有行为，不是本次 hard deny 来源。

### Red-capable feedback loop（已实际运行）

| Item | Value |
| --- | --- |
| Command（诊断期） | 已运行：`PermissionPrecheck.evaluate` 对最小化 FP 载荷（`python3 <<'PY'\ndel …\ntree-sitter…\nif not m:\nPY`）返回 `dangerous` + `Windows protected directory delete` |
| 权威回归 seam | `packages/opencode/test/permission/precheck.test.ts` 的 `bash()`（实现期以此为准；临时 `.temp` harness 非仓库契约） |
| Symptom asserted | FP → `dangerous` + 该 reason（修复前） |
| Observed | red；并列观察 TP `rmdir /s /q C:\Users\Alice`、`del /s /q %USERPROFILE%`、`del /s C:` dangerous；ordinary del/rmdir cautious |

修复后：FP **不得** 再为该 Windows-protected dangerous；TP（含 **`/s/q` 合并开关**）仍 dangerous。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Shell 命令风险分级 | `PermissionPrecheck.evaluate` | 返回 `{level, reason}` | 已是 bash auto 的确定性边界 | shell tool 只提交 evidence，不分级 |
| Windows 保护递归删除判定 | 同上（`dangerousRaw` + `classifyTokens` 共用谓词） | 真 wipe → dangerous | 与 `rm`/`Remove-Item` 同层 | auto/reviewer 不得重解析命令 |
| 保护路径语义 | `protectedDeleteTarget` | 何为保护根 | 已是 rm/PS 共用 | 禁止第二套 Windows 路径白名单 |
| hard deny 路由 | `PermissionAuto` | dangerous → deny | 既有；**本任务不改** | precheck 只产出 level |

## 10. Single Approved Primary-Path Design

```text
metadata.command
  -> evaluateShell
    -> dangerousRaw:
         // 删除整串 RE_D_WINDOWS_PROTECTED_DELETE
         // 改为：normalizeForRawScan 后按段扫描
         for segment in splitShellSegments(normalized):
           // 唯一段 token 源：windowsCmdTokens（空白切分、保留 \）
           // 禁止再顺序 tokenize 作为第二成功路径（impl audit B-01）
           tokens = windowsCmdTokens(segment)
           if windowsProtectedRecursiveDelete(tokens) -> dangerous
              reason: "Windows protected directory delete"
    -> … existing phases …
    -> classifyTokens:
         // 在通用 FILE_DELETE cautious 之前：
         if cmd ∈ {del, erase, rd, rmdir}
            && hasWindowsRecursiveDeleteFlag(tokens[1..])
            && tokens[1..].some(protectedDeleteTarget)
              -> dangerous same reason
         // 否则既有 FILE_DELETE cautious
```

### 10.1 Shared predicates（唯一语义源）

1. **`hasWindowsRecursiveDeleteFlag(tokens)`**（新建，与 `hasRecursiveDeleteFlags` 并列，**不**混用 rm 的 `-r` 组合语义）  
   - 对每个 **完整 argv token**（比较时 lower-case）判定：  
     - **精确命中：** `/s`、`-s`、`--recursive`  
     - **cmd 纯单字母开关 cluster（整 token）：**  
       - 字母集 **`{a,f,p,q,s,u}`**（对齐 cmd `del`/`rd`/`rmdir` 文档中可写的单字母开关：`/A` `/F` `/P` `/Q` `/S` `/U` 等；**不**把多字母词当开关）。  
       - token 以 `/` 或单 `-` 开头（`--recursive` 已由精确分支处理）。  
       - 去掉前导符得 `body`：  
         - 若 `body` 含 `/`：按 `/` 切开，**每一段必须是恰好 1 个**属于字母集的字符，且各段中含 `s`。  
           例命中：`/s/q`、`/s/p`、`/q/s`、`/f/s/q`、`/p/s`。  
         - 若 `body` 不含 `/`：`body` 长度 1..4，每个字符 ∈ 字母集，且含 `s`（contiguous 合并如 `/sq`、`/qs`、`/fsq`）。  
       - 例 **不命中：** `/setup`（段 `setup` 非单字母）、`/source`、`-PassThru`、`tree-sitter`、`/sbin`。  
     - R2 失败：盲目拆字母；R3 失败：`{s,q,f}` 漏 `/s/p`（合法 prompt 开关，现网子串会 dangerous，R3 会 demote 到 cautious——违反 REQ-03）。  
   - **禁止** 对任意字符串做裸子串 `/s` 或 `-s` 扫描。  
   - 非目标：带值属性形态 `/a:h`（non-blocking 残差；不为不可能边界上状态机）。  

2. **`protectedDeleteTarget` 扩展（对齐 raw 与 X:）**  
   - 保持现有 `X:` / `X:/`（`/^\w:\/?$/`）  
   - 保持 `X:/Users|Windows|Program Files…`  
   - **新增** `%USERPROFILE%`：**大小写不敏感**（对齐旧 raw `i`；去尾 `/` `\` 后比较），覆盖 `%userprofile%`  

3. **`windowsProtectedRecursiveDelete(tokens)`**  
   - `normalizeCommandName(tokens[0]) ∈ {del, erase, rd, rmdir}`  
   - `hasWindowsRecursiveDeleteFlag(tokens.slice(1))`  
   - `tokens.slice(1).some(protectedDeleteTarget)`  
   - 三者同时真 → dangerous  

### 10.2 段切分与唯一 token 源（克制，非状态机）

- 在 **已 normalize** 的字符串上，按 `;` `|` `&` **线性 split**（覆盖 normalize 注入的 ` ; `）。  
- **`dangerousRaw` 段扫唯一 token 源：`windowsCmdTokens(segment)`** = `trim` + 空白 `split`（**保留 `\`**）。  
  - 理由（observed）：POSIX `tokenize` 把 `\` 当转义吞掉，`C:\Users\Alice` → `C:UsersAlice`，`protectedDeleteTarget` FN；契约 TP 使用未加引号的反斜杠路径。  
  - 这不是「tokenize 失败后再 fallback」的第二成功路径，而是本 family 段扫的 **sole** 切分器。  
- **`classifyTokens` 入口**仍接收上游 `tokenize` 的 tokens（与 `rm`/`Remove-Item` 同构）；该入口不额外再跑 whitespace parser。  
- **禁止** `windowsCmdTokens` 与 `tokenize` 在同一段上 **顺序双试** 任一成功即 dangerous。  
- 不做 quote-aware 全解析 / heredoc 状态机。引号路径残差为 non-blocking（impl audit）。  

### 10.3 为何修复 first divergence

- 过宽 **整串子串共现** 被 **同段 + 整 token + 共享 protectedDeleteTarget** 取代。  
- 与 `rm`/`Remove-Item` 结构对称，避免 raw 与 token 双语义。  
- **不 demote** 护栏：true wipe 仍 dangerous hard deny。  
- 已观察 FP 在段切后，单段内不同时具备三谓词 → 不再 dangerous。  

### 10.4 明确拒绝的路线

| Rejected | Why |
| --- | --- |
| 把 Windows protected family 默认 cautious / 交给 reviewer | 违反 REQ-03；模型审计不可靠 |
| 仅收紧 lookahead 但仍子串 `-s` | 根因残留 |
| 仅删除 raw 规则、不补 token 对称 + 共享谓词 | opaque/结构路径分叉 |
| 全量 heredoc mask / shell lexer | 违反 REQ-04/06；对已观察 FP 非必要 |
| 第二套 Windows 路径列表不经 `protectedDeleteTarget` | 违反 REQ-01 |

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 整串 `RE_D_WINDOWS_PROTECTED_DELETE` | current | broken primary | yes (over-broad deny) | 100% of this family today | **remove** |
| 同段谓词 `windowsProtectedRecursiveDelete` + **sole** `windowsCmdTokens` 段扫 | proposed (R5) | **primary** | yes (correct deny) | 100% of dangerousRaw family | **add as sole authority** |
| `classifyTokens` 调用同一谓词（上游 POSIX tokenize tokens） | proposed | primary-contract branch（与 rm 同构入口） | yes | 共用谓词，非第二 parser | **add** |
| 段上 `windowsCmdTokens` 再 `tokenize` 双试 | R4 impl 误引入 | forbidden alternate success | yes | — | **remove (R5)** |
| `rm` / `Remove-Item` protected 规则 | current | separate primary contracts | yes | 不同 reason family | **preserve** |
| demote-to-cautious for this family | not proposed | forbidden fallback | would soft-success review | — | **reject** |
| 额外 heredoc 状态机 | not proposed | speculative | — | — | **reject** |

New alternate success paths: **zero**.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 独立 raw 正则内联 `%USERPROFILE%` / Users / 裸盘 列表 | 早期 fail-closed 快速拦 Windows wipe | 目标语义并入 `protectedDeleteTarget` + 同段谓词 | 删除 `RE_D_WINDOWS_PROTECTED_DELETE` 常量及 `.test` 调用 |
| token 层 del 只 cautious、Windows 升级只在 raw | 历史分层不完整 | token 与 raw 共用谓词，结构命令不依赖宽松 raw | `classifyTokens` 增对称分支 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-02 | `protectedDeleteTarget` 认 `X:` 与 case-fold `%USERPROFILE%`；Windows wipe 调用它 | `precheck.ts` 扩展 helper | TP `del /s C:`、`del /s %USERPROFILE%` |
| REQ-02 / INV-01 / INV-06 | 谓词真 → dangerous；auto hard deny 不变；**含 `/s/q` cluster** | `precheck.ts` dangerousRaw 段扫 + classifyTokens + flag 谓词 | 既有 L143-144；新增 `rmdir /s/q C:\Users\Alice`、`del /s/q %USERPROFILE%` |
| REQ-03 / INV-03 / INV-04 | 同段 + 整 token / 纯开关 cluster；FP 不再 dangerous | 同上；删除整串正则 | 新增 heredoc Python FP：断言 **不得** 为 Windows protected dangerous（禁止用 TP demote 消红） |
| REQ-04 / INV-07 | 谓词+线性段扫；≤2 文件主改动 | precheck.ts + precheck.test.ts | diff 计量 |
| REQ-05 / INV-05 | ordinary delete 仍 cautious | 无改通用 FILE_DELETE | 既有 L81 等 |
| REQ-07 | verified + commit | 流程阶段 3–4 + commit | 审计通过后 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `hasWindowsRecursiveDeleteFlag`（含 `/s/q` cluster） | INV-03, REQ-02/04/05, B-01 | FP `-sitter`；现网子串命中 `/s/q`；rm helper 是 `-r` 语义 | 现有 helper 不覆盖 Windows `/s` 与合并开关 |
| 扩展 `protectedDeleteTarget` 认 `%USERPROFILE%` | REQ-01, INV-02 | 测试 `del /s %USERPROFILE%`；helper 现无此分支 | 现 helper 只有 `$env:USERPROFILE` |
| `windowsProtectedRecursiveDelete` + 段扫 | INV-01, INV-04 | 整串正则是根因 | 现正则无法同段绑定 |
| `classifyTokens` 对称分支 | REQ-04, INV-01 | rm 模式；del 仅 cautious | 结构路径缺 upgrade |
| 删除 `RE_D_WINDOWS_PROTECTED_DELETE` | REQ-03 | over-broad | 保留即保留根因 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/permission/precheck.ts` | modify | 删除宽松 Windows 正则；扩展 `protectedDeleteTarget`；新增 Windows 递归 flag 与同段扫描/token 分支；共用谓词 | +90 / −25 |
| `packages/opencode/test/permission/precheck.test.ts` | modify | FP 回归 + 确认 TP/ordinary；公共 `bash()` seam | +40 / −0 |
| 其他 production/config | none | — | 0 |

**合计：** 2 文件，≪4；估算 ≪600 行。

不修改：`auto.ts`、`index.ts`、`shell.ts`、agent 配置（行为由 precheck level 自动生效）。

## 16. TDD Behavior Slices

**Agreed public seam：** `PermissionPrecheck.evaluate({ permission: "bash", patterns, metadata: { command } })`（与 `precheck.test.ts` 的 `bash()` 相同）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | heredoc/`python3` 载荷含 Python `del` + `tree-sitter-…` + `if not m:` → **不得** `dangerous`+`Windows protected directory delete` | 整串正则三件套命中 | 同段谓词不满足 → 不返回该 dangerous | 用户原始症状 |
| 2 | `rmdir /s /q C:\Users\Alice` 仍 dangerous + 既有 reason 字符串 | 修复不得破坏 | 谓词命中 | L143 |
| 3 | `del /s /q %USERPROFILE%` 仍 dangerous | `%USERPROFILE%` 并入 protectedDeleteTarget | 同左 | L144 |
| 4 | **`rmdir /s/q C:\Users\Alice`** 与 **`del /s/q %USERPROFILE%`** 仍 dangerous | R1 漏 `/s/q` | 单字母 cluster | REQ-02/05 |
| 5 | **`del /s/p C:\Users\Alice`**（及 `/p/s`）仍 dangerous | R3 `{s,q,f}` 漏 `p` → 事实 demote | 字母集含 `p` | R3 B-01 / REQ-03 |
| 6 | `del /setup C:` **不得** Windows-protected dangerous | R2 拆字母误报 | 非单字母段拒绝 | INV-03 |
| 7 | `del /s C:` 仍 dangerous | 盘根 | 谓词命中 | REQ-01 |
| 8 | `del /q C:\Temp\old.log` 仍 cautious file deletion | 无递归 | 无 `s` | L81 |

断言规则：  
- FP 切片断言 **否定** Windows protected dangerous（允许 general/cautious/safe 中任何既有合理结果）。  
- **禁止** 把 TP 的期望改成 cautious 来「消红」。  

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~80–110 | 排除纯删正则大块中的空白；计入新谓词与段扫 |
| Required Chinese explanatory comments `C` | ≥ `max(1, ceil(E*0.15))` ≈ **12–17** | 邻近修改点 |

必须注释的点（中文，解释 invariant/safety，不复述代码）：

1. 为何 Windows 递归 flag 必须整 token、禁止子串（INV-03 / FP）。  
2. 为何按段扫描而非整串 `.*`（INV-04 / normalize ` ; `）。  
3. 为何与 `protectedDeleteTarget` 共用及 `%USERPROFILE%` 补齐（REQ-01）。  
4. 为何 token 层与 raw 段扫调用同一谓词、不保留第二套正则列表。  
5. 测试：FP 用例意图（用户症状；不是 demote 护栏）。  
6. 测试：`del /s C:` 锁定 X: 一致性。  

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | `packages/opencode` | 新切片 + 既有 precheck 契约 |
| 同一 `precheck.test.ts` 内 FP + `/s/q` + `C:` 切片 | `packages/opencode` | 原始症状与 B-01 回归（权威 seam） |
| `bun typecheck` | `packages/opencode` | 类型干净 |

可选回归（时间允许）：`bun test test/permission/auto.test.ts`（dangerous deny 路由未改但可烟测）。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 仅改现有 precheck + test |
| Files modified | 2 | ≤4 |
| Files deleted | 0 | |
| Production lines | ~100 net | 谓词 + 段扫 − 旧正则 |
| Test lines | ~40 | FP + X: 锁定 |
| Generated lines | 0 | |
| **Total** | **≪600** | REQ-06 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 段 split 在引号内切断导致某 TP 漏 dangerous | 既有 TP 均为简单无引号路径；`cmd /c "…"` 走 unwrap；测试锁 L143-144 与 `/s/q` |
| POSIX tokenize 吞 `\` | R5：dangerousRaw **sole** `windowsCmdTokens`；不顺序双试 tokenize |
| cluster 过宽再引入 `/setup` 类 FP | R4：字母集 `{a,f,p,q,s,u}` 且 **单字母** 分量；TDD 反例锁 `del /setup C:` |
| `%USERPROFILE%` 扩展影响 `rm` 路径 | rm 极少传该字面量；若命中则 dangerous 更严，符合保护根意图 |

### Open Decisions Requiring the User

**None for R5.** 用户已明确：对齐 `protectedDeleteTarget` 的 `X:`、不 demote 到 cautious、甜点级、提精度。

### Rejected Speculation

- 全面 heredoc inactive 区域模型：已观察 FP 可由同段+整 token 消除；超预算。  
- 证据评分框架 / two-gate 产品化 reason family：用户禁止 demote 护栏；本任务不扩产品面。  
- 修复所有 Python `del` cautious 误报：非本次 hard deny 根因。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.
- Verify the plan **does not** solve FPs by demoting true Windows protected wipes to cautious.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01：flag 精确表漏 `/s/q` → 可达 TP fail-open | (1) `.temp` harness 非权威 (2) 勿加 whitespace 第二 parser (3) `%USERPROFILE%` case-fold | **BLOCK** | adversarial-auditor ses_076d09460ffeJx0w6hsk9mt8sT |
| 2 | R2 | yes | B-01：cluster「拆字母」使 `/setup` 误命中 | §20 whitespace 残留；缺 `/setup` TDD | **BLOCK** | adversarial-auditor ses_076c9b3d9ffens5YLn0vdkrgoH |
| 3 | R3 | yes | B-01：cluster 仅 `{s,q,f}` 使 `del /s/p …Users…` 从 dangerous 退化为 cautious（事实 demote） | 属性 `/a:h` 残差；建议锁 `/s/p` TP | **BLOCK** | adversarial-auditor ses_076c4c2fbffewBnYsty2P94pGn |
| 4 | R4 | yes | No blocking findings | (1) §20 字母集过期文案 (2) contiguous `/pass` 类 fail-closed 残差 (3) `del/s` 粘连 (4) Documents and Settings 不迁入 (5) 「含 s」措辞 | **APPROVE** | adversarial-auditor ses_076bf1143ffeWFskYDIbxmGIUI |
| 5 | R4 impl | yes | B-01：`windowsCmdTokens` 后顺序 `tokenize` 双成功路径，违反 R4 §10.2 | Documents and Settings 残差；引号路径 | **BLOCK** | adversarial-auditor ses_076b2af56ffe4hhmebLa9etUOL |
| 6 | R5 | yes | No blocking findings | (1) §23 需清 dual-try 叙述 (2) Open Decisions 元数据 (3) 工作区 dual-try 待删 | **APPROVE** | adversarial-auditor ses_076ae589cffew9Ru3kIzPi3ND6 |

### Independent plan audit verdict (R4, verbatim summary fields)

```text
No blocking findings.
APPROVE
Audited artifact: docs/plans/windows-protected-delete-precheck-precision.md Revision R4 only
Scope: full original requirement
Implementation allowed after recorder: Status: approved, Approved revision: R4, Implementation allowed: yes
```

R4 实施因 B-01 未 verified；设计修订为 R5 后需全量 plan 复审。

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/permission/precheck.ts` | 删除 `RE_D_WINDOWS_PROTECTED_DELETE`；段扫 + Windows 递归 flag 谓词 + `classifyTokens` 对称分支；`protectedDeleteTarget` 认 `%USERPROFILE%`；`windowsCmdTokens` 保留 `\` |
| `packages/opencode/test/permission/precheck.test.ts` | FP heredoc + `/setup` 反例；`/s/q` `/s/p` `C:` TP |

Diffstat: 2 files, +94 / −7（约）。

R5 实现：`dangerousRaw` 段扫 **sole** `windowsCmdTokens`（保留 `\`）；已删除顺序 `tokenize` 第二成功路径。

### Red-Green Test Evidence

1. 先加测试：FP 用例 red（`dangerous` + Windows protected reason）。
2. 实现后：`bun test test/permission/precheck.test.ts` → **98 pass / 0 fail**。

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 98 pass |
| `bun test test/permission/auto.test.ts` | packages/opencode | 22 pass |
| `bun typecheck` | packages/opencode | clean |

### Original Feedback-Loop Result

用户症状命令形态（python del + tree-sitter + `if not m:`）经 `bash()` seam：**不再** `{level:dangerous, reason: Windows protected directory delete}`。

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| 整串 RE_D_WINDOWS_PROTECTED_DELETE | broken primary | **removed** |
| windowsProtectedRecursiveDelete + 段扫 / classifyTokens | primary | **sole authority** |
| windowsCmdTokens sole 段扫 | primary | R5 |
| classifyTokens 同谓词 | primary-contract | R5 |
| demote to cautious | forbidden | **not used** |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~75 | 非空新增/修改代码行（排除纯注释与空行后约） |
| Qualifying Chinese comment lines `C` | 12 | 邻近 invariant/safety 中文注释 |
| Ratio `C / E` | ~0.16 |  |
| Required minimum `C` | 12 | `ceil(75*0.15)=12` |

### Remaining Unverified Items

- 属性开关 `/a:h` 合并形态（plan non-blocking residual）
- 粘连 `del/s`（无空格）

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | B-01 dual windowsCmdTokens+tokenize | residuals | **BLOCK** | ses_076b2af56ffe4hhmebLa9etUOL |
| 2 | R5 | yes | No blocking findings | residuals; E/C recount | **APPROVE** | ses_076a9b909ffeSv5vHY5AMywJs8 |

### Independent implementation audit verdict (R5, verbatim summary)

```text
No blocking findings.
APPROVE
Audited artifact: implementation diff against docs/plans/windows-protected-delete-precheck-precision.md Revision R5 only
Scope: full original requirement (REQ-01..07 / INV-01..07)
Implementation may proceed to commit (REQ-07).
```

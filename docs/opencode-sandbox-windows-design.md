# opencode Windows Sandbox 设计方案

## 结论

opencode 当前 shell 安全链路主要是“执行前准入”模型：权限规则、静态 precheck、自动 reviewer、人工审批、session cache、circuit breaker 共同决定一次工具调用是否可以开始执行。

Codex Windows sandbox 是“执行时 enforcement”模型：即使一次命令已经被允许执行，子进程仍只能在 OS 级别访问被授予的文件、网络和进程能力。

因此，面向 opencode 的正确迁移方向不是用 sandbox 替换现有 permission，也不是让 reviewer 生成 sandbox 策略，而是在现有 permission 之后、shell spawn 之前新增一个 deterministic sandbox enforcement layer。

目标结构：

```text
+--------------------------------------------------------------------------------+
|                                opencode Agent                                   |
|                                                                                |
|  build / interactive / auto / custom agent                                      |
|  agent.permission + session.permission                                          |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                           Admission / Policy Gate                               |
|                                                                                |
|  Permission.evaluate                                                            |
|  external_directory gate                                                        |
|  PermissionPrecheck                                                             |
|  PermissionReviewer                                                             |
|  user approval                                                                  |
|  session cache / circuit breaker                                                |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                         Sandbox Policy Builder                                  |
|                                                                                |
|  deterministic inputs only                                                      |
|  command / cwd / shell / scan / workspace / config / precheck metadata          |
|                                                                                |
|  output: SandboxProfile                                                         |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                              Sandbox.Service                                    |
|                                                                                |
|  select backend                                                                 |
|  check readiness                                                                |
|  prepare OS policy                                                              |
|  spawn command                                                                  |
|  stream stdout/stderr                                                           |
|  kill / cleanup                                                                 |
+----------------------+-----------------+-------------------+-------------------+
                       |                 |                   |
                       v                 v                   v
+-----------------------------+  +------------------+  +--------------------------+
| Windows Elevated Backend    |  | Windows Legacy   |  | Noop / Observe Backend   |
| dedicated user + runner     |  | restricted token |  | current behavior         |
+-----------------------------+  +------------------+  +--------------------------+
                       |
                       v
+--------------------------------------------------------------------------------+
|                            OS Enforcement Plane                                 |
|                                                                                |
|  restricted token / capability SID / NTFS ACL / Firewall WFP / job object       |
|  named-pipe runner / pipes or ConPTY / optional private desktop                 |
+--------------------------------------------------------------------------------+
```

## 范围

本设计文档只覆盖 opencode shell 工具的 Windows sandbox 迁移方案。

第一阶段建议只接入 `bash` tool，也就是当前 `ShellTool` 暴露的 shell 执行能力。不要一开始替换全局 `ChildProcessSpawner`，因为 opencode 内部大量流程也使用 child process，例如 git discovery、snapshot、ripgrep、formatter、session prompt helper。全局替换会把内部工具链一起沙箱化，兼容风险过大。

本设计不把 opencode 已有的 `Project.sandboxes` 当成安全沙箱。当前字段表示 git worktree 或多 checkout 目录记录，不是 OS-level sandbox enforcement。

## 当前 opencode 安全模型

### 顶层：Agent 与权限来源

opencode 的权限先从 agent/session 层组合出来。

核心事实：

- 默认权限由 `packages/opencode/src/agent/agent.ts` 构造。
- `build` agent 近似全工具可用。
- `interactive` agent 对 shell/notebook run/env 默认 ask。
- `auto` agent 当前把 `bash`、workspace edit gate 与 shell/tool-originated
  `external_directory` 接入 `auto`。
- 用户配置 `config.permission` 会通过 `Permission.fromConfig` 转成 ruleset。
- session permission 会和 agent permission 在工具上下文处 merge。

当前 auto agent 的重要语义：

```text
auto agent
  bash: auto
  external_directory: auto except whitelisted dirs
  edit/write/apply_patch: auto through the shared edit permission gate
```

这说明当前 auto 的重点是 shell risk gate 与 workspace edit gate；`apply_patch`、`write`、`edit`
在运行时共享 `edit` permission，因此文件写入和删除必须在同一个 auto admission seam 上审查，而不是按工具名分散处理。
read/task/notebook 等其他 build-like 权限暂不因此扩大到 auto。

### 中层：Tool Context ask 边界

工具执行时通过 `ctx.ask(...)` 请求权限。

对 shell 来说，`ShellTool.execute` 的逻辑顺序是：

```text
+--------------------------------------------------------------------------------+
|                              ShellTool.execute                                  |
+--------------------------------------------------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  resolve cwd                                                                     |
|  parse command with tree-sitter                                                  |
|  shell compatibility check                                                       |
|  collect external dirs and command patterns                                      |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  ask external_directory if command references paths outside workspace            |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  ask bash with command patterns                                                  |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  run command through ChildProcessSpawner                                         |
+--------------------------------------------------------------------------------+
```

shell 的 `external_directory` 不是独立工具动作。它只是 shell 命令执行前的项目外路径门禁。opencode 当前已经把同一条 shell command、cwd、shell、agent 写入 `external_directory` metadata，避免 auto 模式下项目外路径先退回普通人工 ask，并确保危险 shell payload 在该门禁 deterministic deny；非危险外部路径进入 cautious review 边界。

关键 metadata：

```text
metadata.action_kind = "shell"
metadata.command     = raw shell command
metadata.cwd         = resolved cwd
metadata.shell       = shell name
metadata.agent       = current agent
```

这些 metadata 对未来 sandbox policy builder 也很关键，因为 patterns 是用户展示摘要，不应被当成完整安全事实。

### 权限规则：last-match-wins

`Permission.evaluate` 使用 last-match-wins。

抽象模型：

```text
ruleset = defaults + agent-specific + user config + session permission + approved cache

for each requested pattern:
  find last matching rule by permission and pattern
  default action is ask

  deny  -> immediate DeniedError
  allow -> continue
  auto  -> enter PermissionAuto
  ask   -> create pending request
```

这意味着新增 sandbox config 不应混入现有 permission ruleset。permission ruleset 决定“是否允许尝试执行”，sandbox policy 决定“允许执行后实际可访问什么”。

### Auto admission

当前 `PermissionAuto.evaluate` 的核心行为：

```text
+--------------------------------------------------------------------------------+
|                         PermissionAuto.evaluate                                 |
+--------------------------------------------------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  PermissionPrecheck.evaluate                                                    |
+----------------------------------------+---------------------------------------+
                                         |
              +--------------------------+---------------------------+
              |                          |                           |
              v                          v                           v
+-----------------------------+ +--------------------------+ +--------------------+
| dangerous                   | | safe                     | | general            |
| deny by precheck            | | allow unless strict      | | allow unless strict|
+-----------------------------+ +--------------------------+ +--------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  cautious / strict                                                              |
|  -> reviewer if available                                                       |
|  -> ask when reviewer is unavailable or fails after retry                       |
|  -> deny only for reviewer deny, contract guardrail, or fallback=deny           |
+--------------------------------------------------------------------------------+
```

当前四级 precheck：

```text
safe       known read-only shell command
general    unknown or opaque command that is allowed unless strict review is enabled
cautious   visible sensitive or risky operation requiring reviewer/user boundary
dangerous  critical operation that fails closed before execution
```

`PermissionPrecheck` 目前真正覆盖 `bash` 和所有 `external_directory` 边界。其他非 shell 权限直接回到 `general`，除非结构化 metadata 先把它提升到 `cautious`，例如 workspace delete。

### Reviewer boundary

当前 reviewer 是一个隐藏的 `permission-reviewer` child session。

它接收：

```text
bounded transcript projection
ReviewerRequest
  permission
  patterns
  metadata
  precheck
tenant policy
```

它必须通过 `permission_review_decision` tool 返回结构化结果：

```text
outcome: allow | deny
risk_level: low | medium | high | critical
user_authorization: unknown | low | medium | high
rationale: string
```

硬约束：

- reviewer 不调用 `permission_review_decision` 会先走一次隐藏 protocol retry；重试后仍失败才进入 fallback。
- reviewer timeout、provider/schema/stream error 都必须先保留现有 retry 机会；重试耗尽后默认回到人工审批。
- `fallback: "deny"` 是显式兼容/安全开关，用来把 reviewer 基础设施失败恢复为 terminal fail-closed。
- reviewer allow 对 `critical` 或“非低风险且无用户授权证据”的矛盾结果会被代码层转成 deny，不能通过 fallback 变成人工 ask。

这层适合判断“是否允许尝试执行”，但不应负责生成 OS sandbox policy。

### 当前执行层

权限通过后，shell 实际执行路径是：

```text
+--------------------------------------------------------------------------------+
|                                ShellTool.run                                    |
|                                                                                |
|  metadata live output                                                           |
|  output decoder                                                                 |
|  terminal display snapshot                                                      |
|  truncation sink                                                                |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  ChildProcessSpawner.spawn(cmd(...))                                            |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  CrossSpawnSpawner.spawnCommand                                                 |
|  cross-spawn                                                                    |
|  node child_process                                                             |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  real OS process with host user privileges                                      |
+--------------------------------------------------------------------------------+
```

当前没有 OS-level filesystem/network sandbox。命令一旦通过 permission gate，就以当前用户权限运行。precheck/reviewer 可以阻止一部分命令开始执行，但无法阻止命令运行后动态构造路径、读取未扫描到的文件、访问网络、派生子进程等行为。

## Codex Windows sandbox 基线

`docs/codex-sandbox-windows-design.md` 里的 Codex Windows sandbox 可以概括为三层：

```text
+--------------------------------------------------------------------------------+
|                              Codex Permission Model                             |
|                                                                                |
|  PermissionProfile                                                             |
|      -> FileSystemSandboxPolicy                                                |
|      -> NetworkSandboxPolicy                                                   |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                              Sandbox Selection                                  |
|                                                                                |
|  WindowsSandboxLevel                                                           |
|      Disabled                                                                  |
|      RestrictedToken                                                           |
|      Elevated                                                                  |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                            Windows Backend                                      |
|                                                                                |
|  RestrictedToken legacy backend                                                 |
|  Elevated backend with dedicated sandbox user                                   |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                          Runtime Enforcement                                    |
|                                                                                |
|  dedicated local user                                                           |
|  restricted token                                                               |
|  capability-like SID                                                            |
|  NTFS DACL allow/deny ACE                                                       |
|  Firewall / WFP                                                                |
|  named pipe IPC                                                                |
|  ConPTY or pipes                                                               |
|  job object                                                                    |
|  optional private desktop                                                       |
+--------------------------------------------------------------------------------+
```

Codex 的关键点不是“在命令前面包一个 sandbox.exe”，而是把 policy 转成 Windows 原生 enforcement：用户身份、token、ACL、WFP/firewall、IPC runner、job object 组合起来。

Codex Windows elevated backend 主要有两个 helper binary：

```text
codex-windows-sandbox-setup
codex-command-runner
```

父进程和 command runner 之间使用 named pipe 上的 length-prefixed JSON frame。协议里有 version，例如 Codex 文档里记录的 `IPC_PROTOCOL_VERSION = 2`。runner 接收 `SpawnRequest`，派生 restricted token，设置 pipes 或 ConPTY，再启动真实命令。

Codex 的重要安全不变量：

```text
admission policy is not enforcement
PermissionProfile must be converted to OS policy
DangerFullAccess and ExternalSandbox are rejected by sandbox parse layer
ACL state is reconciled, not blindly appended
network enforcement may require elevated backend
runner identity and pipe client PID must be verified
```

## 差距分析

opencode 当前能力：

```text
+--------------------------------------------------------------------------------+
| Capability                                                                     |
+--------------------------------------+-----------------------------------------+
| permission rules                       | yes                                     |
| external_directory gate                | yes, static scan based                  |
| deterministic shell precheck           | yes                                     |
| LLM reviewer                           | yes                                     |
| user approval                          | yes                                     |
| reviewer audit child session           | yes                                     |
| session review cache                   | yes                                     |
| circuit breaker event                  | yes                                     |
| OS filesystem sandbox                  | no                                      |
| OS network sandbox                     | no                                      |
| restricted token / dedicated user      | no                                      |
| command runner IPC                     | no                                      |
| ACL reconciliation                     | no                                      |
+--------------------------------------------------------------------------------+
```

当前最大安全空洞：

```text
static scan sees: npm test
permission allows: npm test
runtime process can still read: ~/.ssh/id_ed25519, ~/.aws/credentials, arbitrary home files
```

如果接入 sandbox，正确结果应该是：

```text
static scan sees: npm test
permission allows: npm test
sandbox allows: workspace read/write and selected temp roots
sandbox denies: sensitive home credentials and non-approved external paths
runtime dynamic path access: blocked by OS
```

## 目标模型

新增一层 `Sandbox.Service`，只负责执行时限制。

分层职责：

```text
+--------------------------------------------------------------------------------+
| Layer                                | Responsibility                           |
+--------------------------------------+-----------------------------------------+
| Agent / Config                       | declare desired permission and sandbox   |
| Permission.Service                   | decide whether a tool call may run       |
| PermissionPrecheck                   | deterministic risk preclassification     |
| PermissionReviewer                   | model-assisted admission decision        |
| SandboxPolicyBuilder                 | deterministic profile construction       |
| Sandbox.Service                      | backend selection and lifecycle          |
| Windows backend                      | translate profile to OS enforcement      |
| OS                                   | actually deny forbidden access           |
+--------------------------------------------------------------------------------+
```

Important separation：

```text
Permission answer:
  May this tool call be attempted?

Sandbox answer:
  Once attempted, what can the spawned process actually access?
```

## 推荐模块设计

建议新增模块：

```text
packages/opencode/src/config/sandbox.ts
packages/opencode/src/sandbox/profile.ts
packages/opencode/src/sandbox/policy-builder.ts
packages/opencode/src/sandbox/sandbox.ts
packages/opencode/src/sandbox/backend/noop.ts
packages/opencode/src/sandbox/backend/windows-elevated.ts
packages/opencode/src/sandbox/backend/windows-restricted-token.ts
packages/opencode/src/sandbox/backend/errors.ts
```

如果 Windows backend 使用 Rust helper，建议新增独立 package 或 crate 目录，不直接塞入 `packages/opencode/src/tool`：

```text
packages/sandbox/windows-rs/
packages/sandbox/windows-rs/src/bin/opencode-windows-sandbox-setup.rs
packages/sandbox/windows-rs/src/bin/opencode-command-runner.rs
packages/sandbox/windows-rs/src/ipc.rs
packages/sandbox/windows-rs/src/setup.rs
packages/sandbox/windows-rs/src/token.rs
packages/sandbox/windows-rs/src/acl.rs
packages/sandbox/windows-rs/src/firewall.rs
packages/sandbox/windows-rs/src/process.rs
```

TypeScript 层不要直接关心每个 Windows API 细节，只处理 readiness、profile、spawn request、stream/kill/exit 抽象。

## Config 设计

建议新增顶层 `sandbox` 配置，而不是塞进 `permission`。

示例：

```jsonc
{
  "sandbox": {
    "enabled": true,
    "mode": "enforce",
    "scope": "shell",
    "fallback": "deny",
    "filesystem": {
      "workspace": "read_write",
      "external": "approved_only",
      "deny_read": [
        "~/.ssh/*",
        "~/.aws/credentials",
        "~/.config/gcloud/*",
        "~/.kube/config",
        "~/.npmrc",
        "~/.netrc",
        "~/.git-credentials",
        "*.env",
        "*.env.*"
      ]
    },
    "network": {
      "mode": "inherit"
    },
    "windows": {
      "level": "elevated",
      "setup": "auto"
    }
  }
}
```

建议 schema 语义：

```text
enabled:
  false -> preserve current behavior
  true  -> build SandboxProfile for supported tool scopes

mode:
  observe -> build and log profile, but execute current path
  enforce -> backend must enforce or fail closed

scope:
  shell -> only shell tool

fallback:
  deny -> fail closed if backend unavailable in enforce mode
  unsandboxed -> only allowed for explicit development or observe mode

filesystem.workspace:
  read_only
  read_write

filesystem.external:
  deny
  approved_only
  read_only_approved
  read_write_approved

network.mode:
  inherit
  deny
  allowlist
  managed_proxy

windows.level:
  disabled
  restricted_token
  elevated
```

默认值建议保守 rollout：

```text
sandbox.enabled = false
sandbox.mode = observe when explicitly enabled without enforce
sandbox.scope = shell
sandbox.fallback = deny for enforce
network.mode = inherit for first milestone
windows.level = elevated when enforce + network managed/deny is requested
```

## SandboxProfile

`SandboxProfile` 是 TypeScript 层的核心 domain object。它应使用 Effect Schema 定义，保持可序列化、可审计、可传给 Rust helper。

建议形状：

```text
SandboxProfile
├─ id
│  request_id
│  session_id
│  message_id
│  call_id
│
├─ tool
│  name: bash
│  shell: bash | zsh | pwsh | powershell | cmd
│  command: raw command
│  cwd: absolute path
│
├─ mode
│  observe | enforce
│
├─ filesystem
│  workspace_root
│  cwd
│  read_roots
│  write_roots
│  deny_read_roots
│  external_roots
│  temp_roots
│
├─ network
│  mode: inherit | deny | allowlist | managed_proxy
│  allowlist
│  proxy
│
├─ process
│  timeout_ms
│  tty
│  detached
│  kill_tree
│  private_desktop
│
├─ environment
│  inherit_strategy
│  env
│  home_strategy
│  path_strategy
│
└─ audit
   agent
   precheck_level
   precheck_reason
   reviewer_review_id
   permission_patterns
   approved_external_patterns
```

重要不变量：

```text
all paths are absolute and normalized before reaching backend
workspace root never equals global root unless explicitly supported
deny_read_roots cannot be removed by reviewer output
external_roots only come from deterministic approval state
command patterns are audit text, not enforcement roots
```

## ShellTool 接入点

推荐在 `ask(ctx, scan, ...)` 之后、`run(...)` 之前创建 profile。

目标结构：

```text
execute(params, ctx)
  resolve cwd
  parse command
  collect scan
  ask external_directory and bash

  profile = SandboxPolicyBuilder.fromShell({
    ctx,
    params,
    cwd,
    shell,
    scan,
    instanceCtx,
    config,
  })

  run({ ..., sandboxProfile: profile }, ctx)
```

`ShellTool.run` 当前处理 output streaming、decoder、truncation、timeout、abort、metadata。这些能力应该尽量复用。`Sandbox.Service.spawnShell` 应返回接近 `ChildProcessHandle` 的接口：

```text
SandboxProcessHandle
  stdout: Stream<Uint8Array>
  stderr: Stream<Uint8Array>
  all: Stream<Uint8Array>
  exitCode: Effect<number>
  kill(options): Effect<void>
```

这样 `ShellTool.run` 的输出逻辑不需要大改。

## SandboxPolicyBuilder

policy builder 应完全 deterministic。

输入：

```text
InstanceContext
  directory
  worktree
  project

Shell execution
  command
  cwd
  shell
  timeout
  env

Scan result
  dirs
  patterns
  always

Permission metadata
  precheck level/reason if available
  reviewer reviewID if available

Config
  sandbox config
  tool_output config only for output behavior, not enforcement
```

输出规则建议：

```text
workspace_root:
  if git project: instance.worktree
  otherwise: instance.directory

read_roots:
  workspace_root
  cwd if inside workspace
  opencode skill/temp/truncation roots when necessary

write_roots:
  workspace_root when filesystem.workspace=read_write
  configured temp/output roots
  approved external roots when external=read_write_approved

deny_read_roots:
  config sandbox.filesystem.deny_read
  default sensitive credential patterns

external_roots:
  only roots from shell scan that passed external_directory permission
```

注意：静态 scan 只能发现可见路径，不能保证完整。因此外部路径授权应只扩大可访问根，不应作为“命令不会访问其他路径”的证明。真正阻止动态路径访问的是 OS sandbox。

## Reviewer 与 Sandbox 的关系

Reviewer 不应直接生成或扩大 sandbox policy。

允许：

```text
reviewer allow/deny controls admission
reviewID is included in audit metadata
rationale is recorded in child session and tool metadata
```

禁止：

```text
reviewer output adds read root
reviewer output adds write root
reviewer output disables deny_read
reviewer output disables network enforcement
reviewer output switches backend to unsandboxed
```

如果未来希望 reviewer 建议策略变更，应作为 human-visible proposal，由用户显式修改 config 或一次性授权，而不是模型直接修改 OS enforcement profile。

## Windows Elevated Backend

推荐优先实现 elevated backend，因为它能承载 Codex 文档里的完整能力：专用 sandbox 用户、ACL、network enforcement、runner IPC。

整体结构：

```text
+--------------------------------------------------------------------------------+
|                            TypeScript opencode                                  |
|                                                                                |
|  Sandbox.Service.spawnShell                                                     |
|  SandboxProfile                                                                 |
|  readiness check                                                                |
|  create SpawnRequest                                                            |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                    opencode-windows-sandbox client layer                        |
|                                                                                |
|  locate helper binaries                                                         |
|  run setup helper if configured                                                 |
|  create named pipes                                                             |
|  launch runner as sandbox user                                                  |
|  send length-prefixed JSON frame                                                |
|  expose output streams                                                          |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                         opencode-command-runner.exe                             |
|                                                                                |
|  validate IPC protocol version                                                  |
|  receive SpawnRequest                                                           |
|  derive restricted token                                                        |
|  apply capability SIDs                                                          |
|  create pipes or ConPTY                                                         |
|  create job object                                                              |
|  CreateProcessAsUserW                                                           |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                           Sandbox Child Process                                 |
|                                                                                |
|  runs as dedicated sandbox user                                                 |
|  constrained by restricted token                                                |
|  constrained by NTFS ACL                                                        |
|  constrained by firewall/WFP when enabled                                       |
|  constrained by job object                                                      |
+--------------------------------------------------------------------------------+
```

### Setup helper

`opencode-windows-sandbox-setup` 应负责：

```text
create or refresh dedicated local users
create required local groups or capability identities
install or refresh firewall/WFP rules when network sandbox is enabled
prepare base ACLs for workspace/temp roots
apply deny-read ACLs for configured sensitive roots
reconcile stale ACL entries from previous runs
report readiness state and version
```

Setup 必须幂等。多次运行不能不断堆积 ACL 或 firewall rules。

### Runner IPC

建议复用 Codex 风格：named pipe + length-prefixed JSON frames。

抽象 protocol：

```text
Frame
  u32 little-endian length
  JSON payload

Message
  SpawnRequest
  Stdin
  CloseStdin
  Resize
  Terminate
  SpawnReady
  Output
  Exit
  Error
```

`SpawnRequest` 需要包含：

```text
protocol_version
request_id
command
args or shell command form
cwd
env
timeout_ms
filesystem policy
network policy
capability SIDs
stdio mode
tty mode
private_desktop
job options
audit metadata
```

安全约束：

```text
pipe DACL only allows expected sandbox identity
parent validates pipe client PID or identity
runner validates protocol version
runner refuses unknown dangerous policy modes
runner refuses full host access in enforce mode
frame size has strict upper bound
```

### Filesystem enforcement

Windows 文件隔离应组合使用 dedicated user、restricted token、capability-like SID、NTFS DACL。

建议映射：

```text
SandboxProfile.read_roots
  -> DACL allow read/execute for sandbox identity or read capability SID

SandboxProfile.write_roots
  -> DACL allow write/modify for write capability SID

SandboxProfile.deny_read_roots
  -> explicit deny read ACE for sandbox principal

per-run external_roots
  -> per-run capability SID only included in this token
```

为什么需要 per-run capability：

```text
If an old command approved C:\tmp\foo,
future commands must not automatically inherit C:\tmp\foo access.

Persistent ACL may mention capability SID,
but current token only carries capabilities for this run.
```

ACL reconciliation：

```text
+--------------------------------------------------------------------------------+
|                         ACL Reconciliation                                      |
+--------------------------------------------------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  compute desired ACL state for current profile                                  |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  apply missing allow/deny ACE                                                   |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  remove stale ACE owned by opencode sandbox principal                           |
|  only when no longer desired                                                    |
+--------------------------------------------------------------------------------+
```

不要在每次命令结束后立刻撤 ACL。子进程或孙进程可能仍短暂存在。应由 setup/refresh/reconcile 做一致性维护。

### Network enforcement

第一阶段建议 `network.mode = inherit`，先稳定 filesystem sandbox。

第二阶段增加：

```text
network.mode = deny
network.mode = allowlist
network.mode = managed_proxy
```

Windows 网络隔离建议走 elevated backend，因为 dedicated sandbox user 能作为 firewall/WFP 规则作用对象。

抽象：

```text
+--------------------------------------------------------------------------------+
|                              Network Policy                                     |
+--------------------------------------+-----------------------------------------+
| inherit                               | no network restriction yet              |
| deny                                  | block outbound for sandbox user         |
| allowlist                             | allow configured host/port, deny rest   |
| managed_proxy                         | route through opencode-controlled proxy |
+--------------------------------------------------------------------------------+
```

### Process containment

Windows backend 应使用 job object 管理 process tree。

要求：

```text
timeout kills process tree
abort kills process tree
runner death cleans child when possible
child cannot easily escape parent lifecycle
resource limits can be added later
```

TTY 初期可以走 pipes。ConPTY 可作为后续增强，服务于需要真实 terminal 行为的命令。

## Windows Restricted Token Backend

restricted-token backend 可作为低权限 fallback，但能力弱于 elevated。

适合：

```text
no dedicated user setup
basic token restriction
some local filesystem ACL use cases
development or observe path
```

不适合：

```text
strong per-user firewall/WFP enforcement
complex ACL reconciliation
managed network proxy enforcement
multi-run durable isolation
```

建议在 `mode=enforce` 且请求 network deny/proxy 时，不允许自动降级到 restricted token。

## Noop / Observe Backend

noop backend 用于迁移早期。

行为：

```text
enabled=false:
  no profile required
  current spawn path

mode=observe:
  build profile
  emit metadata/event
  current spawn path

mode=enforce with noop selected:
  fail closed unless config explicitly says fallback=unsandboxed for development
```

observe metadata 示例：

```text
metadata.sandbox = {
  mode: "observe",
  backend: "noop",
  profileID: "...",
  workspaceRoot: "...",
  readRoots: 3,
  writeRoots: 1,
  denyReadRoots: 8,
  network: "inherit"
}
```

## Tool Metadata 与事件

应新增可审计事件，但不要泄漏完整敏感路径列表给模型上下文。

建议事件：

```text
sandbox.profile.created
sandbox.backend.selected
sandbox.setup.required
sandbox.setup.completed
sandbox.spawn.started
sandbox.spawn.failed
sandbox.policy.denied
sandbox.process.exited
```

tool metadata 建议只放摘要：

```text
metadata.sandbox = {
  status: "disabled" | "observed" | "enforced" | "failed",
  backend: "noop" | "windows_elevated" | "windows_restricted_token",
  mode: "observe" | "enforce",
  network: "inherit" | "deny" | "allowlist" | "managed_proxy",
  profileID: string,
  setupRequired: boolean,
  failureReason?: string
}
```

完整 profile 可以写入本地 audit store 或 debug log，但不要默认回传给模型。

## Security Invariants

必须保持的安全不变量：

```text
1. sandbox enforcement starts only after permission admission succeeds
2. sandbox profile is deterministic
3. reviewer output cannot widen sandbox profile
4. enforce mode backend unavailable means fail closed
5. unknown backend protocol version means fail closed
6. unknown filesystem policy mode means fail closed
7. full host access is not representable in enforce mode unless explicit developer-only escape hatch
8. external directory approval grants only selected roots, not arbitrary home access
9. deny_read roots override read/write roots where OS allows explicit deny precedence
10. output streaming behavior must not bypass sandbox process creation
11. timeout and abort must terminate sandbox child tree
12. setup helper must be idempotent and auditable
```

Path security rules：

```text
normalize all paths before policy construction
reject relative paths in backend request
resolve cwd before spawn
do not treat project worktree "/" as global allow root
handle Windows drive casing consistently
preserve UNC path rules explicitly
do not follow untrusted symlink assumptions in TypeScript as enforcement proof
```

## 与 external_directory 的关系

当前 shell scanner 会把 visible path arguments 收集到 `scan.dirs`。

这个机制保留，但角色要调整：

```text
before sandbox:
  scan.dirs is the main boundary for asking external_directory

after sandbox:
  scan.dirs is still UX/admission evidence
  approved dirs become extra allowed roots
  unscanned dynamic external access is blocked by OS
```

目标流程：

```text
+--------------------------------------------------------------------------------+
|  command: node -e "fs.readFileSync(process.env.HOME + '/.ssh/id_ed25519')"      |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  static scan may not see final dynamic path                                     |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  permission may allow if reviewer/user approves attempt                         |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|  sandbox deny_read_roots block ~/.ssh/id_ed25519 at OS level                    |
+--------------------------------------------------------------------------------+
```

## Failure Modes

建议错误类型：

```text
SandboxDisabledError
SandboxUnsupportedPlatformError
SandboxBackendUnavailableError
SandboxSetupRequiredError
SandboxSetupFailedError
SandboxPolicyInvalidError
SandboxProtocolError
SandboxSpawnError
SandboxAccessDeniedError
SandboxProcessTerminatedError
```

用户可见错误应简洁，避免给出绕过建议：

```text
Sandbox enforcement rejected this shell command because the Windows sandbox backend is not ready. Configure sandbox setup or ask the user to run without sandbox explicitly.
```

不要提示 agent 用 Python、PowerShell、MCP 或其他工具绕过同一结果。

## Rollout Plan

### Phase 1: schema and noop service

新增：

```text
ConfigSandbox
SandboxProfile schema
Sandbox.Service
Noop backend
observe metadata
```

不改变实际执行行为。

### Phase 2: shell-only policy builder

接入 `ShellTool.execute`。

完成：

```text
after permission ask, build SandboxProfile
mode=observe writes tool metadata
mode=enforce with noop fails closed
unit test profile builder
```

### Phase 3: Windows helper packaging and readiness

完成：

```text
locate helper binaries
version check
setup required detection
setup auto/manual config
surface user-friendly setup failure
```

### Phase 4: Windows elevated spawn path

完成：

```text
named pipe IPC
SpawnRequest
runner process
stdout/stderr/all streams
exit code
kill/timeout
job object cleanup
```

### Phase 5: filesystem ACL enforcement

完成：

```text
workspace read/write
approved external roots
deny_read sensitive roots
ACL reconciliation
per-run capability SIDs
```

### Phase 6: network enforcement

完成：

```text
network=deny
allowlist or managed proxy
firewall/WFP setup
network denial tests
```

### Phase 7: broaden platform/backend support

完成：

```text
Windows restricted-token fallback if useful
Linux sandbox backend
macOS seatbelt or compatible backend
selective support for non-shell tools only after shell is stable
```

## Test Strategy

### Unit tests

```text
ConfigSandbox schema parse and defaults
SandboxProfile path normalization
workspace root selection
external roots mapping
deny_read roots override behavior
network policy parse
unsupported policy fail closed
```

### Integration tests for shell path

```text
observe mode keeps current spawn behavior
enforce mode calls Sandbox.Service
backend unavailable fails closed
timeout kills process tree
abort kills process tree
output truncation and compression unchanged
metadata.sandbox is preserved across running updates
```

### Windows backend tests

```text
setup helper is idempotent
helper version mismatch fails closed
named pipe protocol mismatch fails closed
runner identity validation works
workspace write allowed
non-approved external write denied
approved external write allowed
deny_read sensitive file denied
dynamic sensitive path denied
network deny blocks outbound
job object cleans child tree
```

### Regression tests for existing permission behavior

```text
auto safe shell still allows before sandbox
auto dangerous shell still denies before sandbox
cautious shell still reaches reviewer
reviewer timeout still fails closed
external_directory shell metadata still carries command/cwd/shell/agent
Project.sandboxes behavior unchanged
internal git discovery is not sandboxed by shell-only rollout
```

Tests should run from package directories, for example `packages/opencode`, not repo root.

## Implementation Notes For Effect

Follow opencode local Effect style：

```text
Use Effect.gen(function* () { ... }) for workflows
Use Effect.fn("Sandbox.method") for service methods
Use Schema.Class and Schema.TaggedErrorClass for domain types
Use Layer.effect for service construction
Use InstanceState only when state is per workspace/project
Prefer ChildProcessSpawner abstractions at TypeScript boundaries
Keep helper-specific native protocol behind backend modules
```

`Sandbox.Service` sketch：

```text
export interface Interface {
  readonly profileFromShell: (input: ShellProfileInput) => Effect.Effect<SandboxProfile, SandboxError>
  readonly spawnShell: (input: SpawnShellInput) => Effect.Effect<SandboxProcessHandle, SandboxError, Scope.Scope>
  readonly readiness: () => Effect.Effect<SandboxReadiness, SandboxError>
}
```

Layer wiring should be explicit in `AppLayer` and `ToolRegistry.defaultLayer` once shell starts depending on it.

## Why Not Replace Permission

Sandbox 不能替代 permission，因为：

```text
permission gives user/reviewer intent boundary
sandbox gives OS capability boundary
permission can reject destructive intent before it starts
sandbox can block unexpected runtime behavior after it starts
both are required for defense in depth
```

Example：

```text
rm -rf /
  permission/precheck should deny before execution
  sandbox should also make root deletion impossible if somehow executed

npm test
  permission may allow
  sandbox should still block credential exfiltration
```

## Why Not Let Reviewer Build Policy

Reviewer 是 probabilistic policy advisor，不是 deterministic enforcement compiler。

风险：

```text
model may miss path normalization issues
model may overgrant because command sounds harmless
model may be prompt-injected by transcript/tool arguments
model may generate inconsistent roots across retries
model output is not a stable security boundary
```

正确边界：

```text
Reviewer decides allow/deny for admission.
SandboxPolicyBuilder deterministically constructs roots.
Windows backend enforces roots.
```

## Naming Guidance

避免使用 `Project.sandboxes` 作为安全概念。

推荐命名：

```text
SandboxProfile
ExecutionSandbox
SandboxBackend
SandboxReadiness
SandboxPolicyBuilder
WindowsSandboxBackend
```

避免：

```text
ProjectSandbox
SandboxDirectory
project.sandboxes as enforcement roots
```

因为当前 project sandbox 语义更接近 git checkout/worktree，不是 OS sandbox。

## Open Questions

需要实现前确认的问题：

```text
1. Windows helper binary 是直接移植 Codex Rust crate，还是先做 opencode 最小子集？
2. sandbox.enabled 默认是否永远 false，还是 auto agent 默认 observe？
3. workspace 写权限默认 read_write 还是 read_only + explicit write command allow？
4. shell rc 文件读取失败是否允许 fallback synthetic home？
5. Windows network enforcement 第一版是否必须进入 scope，还是先只做 filesystem？
6. ACL deny_read 默认是否覆盖所有 .env，还是沿用 read tool 中 .env.example allow 例外？
7. helper setup 是否允许自动提权提示，还是只给手动安装命令？
```

## Recommended First Milestone

第一阶段应先做 shell-only observe/enforce 架构，不急于完整移植 Windows helper。

最小可交付：

```text
ConfigSandbox schema
SandboxProfile schema
Sandbox.Service noop backend
ShellTool integration after permission ask
observe metadata
enforce mode fail-closed without backend
profile builder tests
```

这样可以先稳定 TypeScript/Effect 边界和 audit UX，再把 Codex Windows elevated backend 接到底层。否则一开始把 Rust IPC、ACL、WFP、Tool UI、permission 混在一起，会让调试边界非常模糊。

## Final Target

最终 opencode shell 安全模型应是：

```text
+--------------------------------------------------------------------------------+
| User / Agent asks to run shell command                                          |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| Existing opencode admission                                                     |
|                                                                                |
| rules -> external_directory -> precheck -> reviewer/user                        |
+----------------------------------------+---------------------------------------+
                                         |
                                  allowed to attempt
                                         |
                                         v
+--------------------------------------------------------------------------------+
| Deterministic sandbox profile                                                   |
|                                                                                |
| workspace roots, approved external roots, deny_read roots, network mode         |
+----------------------------------------+---------------------------------------+
                                         |
                                  enforced spawn
                                         |
                                         v
+--------------------------------------------------------------------------------+
| Windows sandbox backend                                                         |
|                                                                                |
| dedicated user, restricted token, ACL, WFP/firewall, runner IPC, job object     |
+----------------------------------------+---------------------------------------+
                                         |
                                  constrained process
                                         |
                                         v
+--------------------------------------------------------------------------------+
| Command output streams back through existing ShellTool output pipeline          |
+--------------------------------------------------------------------------------+
```

这保留了 opencode 现有 auto review 的 UX 和审查价值，同时补上 Codex sandbox 的关键能力：运行时 OS enforcement。

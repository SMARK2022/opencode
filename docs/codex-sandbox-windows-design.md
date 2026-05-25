## Assistant (Auto · GPT-5.5 · 170.4s)

**结论**
`codex-rs/windows-sandbox-rs` 的 Windows sandbox 不是一个简单的“命令前面套一个 sandbox.exe”的模型，而是一套多层组合：

- 上层：Codex core 根据权限策略决定是否进入 Windows sandbox。
- 中层：Windows sandbox 后端把权限策略转换成 Windows 可执行的“用户身份 + 受限 token + 文件 ACL + 网络规则”。
- 下层：真正运行命令时，要么由当前进程直接用 restricted token 启动子进程，要么先登录专用 sandbox 用户，再通过 `codex-command-runner.exe` 做 IPC 启动和流式 I/O。
- 权限 enforcement 的核心不是单点机制，而是组合机制：Windows local user、restricted token restricting SIDs、capability-like SID、NTFS DACL allow/deny ACE、防火墙/WFP、环境变量降级、私有 desktop、job object。

下面按顶层到低层梳理。

**源码定位**
关键目录：

```text
.temp/codex/codex-rs/windows-sandbox-rs/
```

关键二进制：

```text
codex-windows-sandbox-setup
codex-command-runner
```

关键模块：

```text
windows-sandbox-rs/src/lib.rs
windows-sandbox-rs/src/setup.rs
windows-sandbox-rs/src/identity.rs
windows-sandbox-rs/src/spawn_prep.rs
windows-sandbox-rs/src/token.rs
windows-sandbox-rs/src/process.rs
windows-sandbox-rs/src/elevated_impl.rs
windows-sandbox-rs/src/elevated/ipc_framed.rs
windows-sandbox-rs/src/elevated/runner_client.rs
windows-sandbox-rs/src/bin/command_runner/win.rs
windows-sandbox-rs/src/bin/setup_main/win.rs
windows-sandbox-rs/src/unified_exec/
```

上层接入点：

```text
core/src/exec.rs
core/src/unified_exec/process_manager.rs
core/src/windows_sandbox.rs
sandboxing/src/manager.rs
protocol/src/config_types.rs
```

**一、最顶层：Codex 如何决定启用 Windows Sandbox**
Windows sandbox 的开关不是由 `windows-sandbox-rs` 自己决定，而是由 Codex core 的权限模型决定。

配置枚举在：

```rust
pub enum WindowsSandboxLevel {
    Disabled,
    RestrictedToken,
    Elevated,
}
```

位置：`protocol/src/config_types.rs`

含义：

```text
Disabled          不用 Windows sandbox
RestrictedToken   使用 legacy/unelevated restricted-token 后端
Elevated          使用 elevated sandbox user + command runner 后端
```

选择逻辑在 `core/src/windows_sandbox.rs`：

- `windows.sandbox = "elevated"` -> `WindowsSandboxLevel::Elevated`
- `windows.sandbox = "unelevated"` -> `WindowsSandboxLevel::RestrictedToken`
- 如果没有显式配置，则看 feature flags：
  - `WindowsSandboxElevated` -> `Elevated`
  - `WindowsSandbox` -> `RestrictedToken`
  - 否则 `Disabled`

然后 `sandboxing/src/manager.rs` 根据运行时权限判断是否需要平台 sandbox：

```text
PermissionProfile
        |
        v
FileSystemSandboxPolicy + NetworkSandboxPolicy
        |
        v
SandboxManager::select_initial(...)
        |
        v
SandboxType::WindowsRestrictedToken
```

注意名字叫 `WindowsRestrictedToken`，但它只是上层统一的 Windows sandbox 类型。真正后端可能是：

```text
RestrictedToken legacy backend
Elevated backend
```

是否用 elevated 后端由 `core/src/exec.rs` 再判断：

```rust
proxy_enforced || matches!(sandbox_level, WindowsSandboxLevel::Elevated)
```

也就是说：

- 配置为 elevated 时，用 elevated 后端。
- 即使配置是 restricted-token，只要有 managed network/proxy enforcement，也会强制走 elevated 后端，因为网络隔离依赖专用 sandbox 用户身份。

**二、整体抽象架构图**
```text
+--------------------------------------------------------------------------------+
|                                Codex Frontend / API                             |
|                                                                                |
|  user tool call / app-server RPC / unified exec request                         |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                                  codex-core                                     |
|                                                                                |
|  PermissionProfile                                                             |
|      -> FileSystemSandboxPolicy                                                |
|      -> NetworkSandboxPolicy                                                   |
|                                                                                |
|  SandboxManager chooses SandboxType::WindowsRestrictedToken                     |
|                                                                                |
|  WindowsSandboxLevel: Disabled | RestrictedToken | Elevated                     |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                         Windows Sandbox Adapter Layer                           |
|                                                                                |
|  core/src/exec.rs                                                              |
|  core/src/unified_exec/process_manager.rs                                      |
|                                                                                |
|  decides backend:                                                              |
|    - legacy restricted-token backend                                           |
|    - elevated sandbox-user runner backend                                      |
+-----------------------------+--------------------------+-----------------------+
                              |                          |
                              v                          v
+------------------------------------------+  +----------------------------------+
| Legacy / Unelevated Backend              |  | Elevated Backend                 |
|                                          |  |                                  |
| Parent creates restricted token directly |  | Parent logs into sandbox user    |
| Parent applies some ACLs                 |  | Parent talks to runner via pipes |
| Parent starts child directly             |  | Runner creates restricted token  |
|                                          |  | Runner starts child              |
+-----------------------------+------------+  +----------------+-----------------+
                              |                            |
                              v                            v
+--------------------------------------------------------------------------------+
|                              Windows OS Primitives                              |
|                                                                                |
|  CreateRestrictedToken                                                         |
|  CreateProcessAsUserW                                                          |
|  CreateProcessWithLogonW                                                       |
|  NTFS DACL / ACE                                                               |
|  Local users/groups                                                            |
|  Windows Firewall / WFP                                                        |
|  Named pipes                                                                   |
|  ConPTY / anonymous pipes                                                      |
|  Job objects                                                                   |
|  Private desktop                                                               |
+--------------------------------------------------------------------------------+
```

**三、命令是如何进入 sandbox 的**
从用户角度看，Codex 收到的是一个普通命令：

```text
command: ["powershell.exe", "-Command", "..."]
cwd: C:\workspace
env: {...}
permission_profile: read-only / workspace-write / managed split policy
timeout
tty/stdin/private desktop
```

Codex core 会把它变成 `ExecRequest`。在 Windows 上，如果 sandbox 类型是 `WindowsRestrictedToken`，不会直接 `spawn_child_async`，而是进入 Windows sandbox 执行路径。

有两类运行入口：

```text
1. shell tool / captured exec
   core/src/exec.rs -> exec_windows_sandbox(...)

2. unified exec / interactive session
   core/src/unified_exec/process_manager.rs
   -> spawn_windows_sandbox_session_legacy(...)
   -> spawn_windows_sandbox_session_elevated_for_permission_profile(...)
```

两类入口共享同一套底层权限模型，但 I/O 形态不同：

```text
captured exec:
  等命令结束，收集 stdout/stderr，返回一次性结果

unified exec:
  返回 SpawnedProcess，支持持续 stdin/stdout/stderr、resize、terminate
```

**四、两条后端：legacy 与 elevated**
Windows sandbox 有两个后端，这一点很重要。

```text
+----------------------------+-----------------------------------------------+
| 后端                       | 特点                                          |
+----------------------------+-----------------------------------------------+
| RestrictedToken / legacy   | 不创建专用用户，直接基于当前用户 token 派生  |
|                            | restricted token，然后 CreateProcessAsUserW   |
+----------------------------+-----------------------------------------------+
| Elevated                   | 创建/使用专用本地用户，父进程用 named pipe   |
|                            | 与 codex-command-runner.exe 通信，runner 再   |
|                            | 派生 restricted token 并启动真实命令          |
+----------------------------+-----------------------------------------------+
```

legacy 后端能力较弱：

- 可以做 workspace-write。
- 可以做 deny-write carveout。
- 不能完整强制 split read restrictions。
- 不能完整强制 deny-read。
- 网络禁用主要靠环境变量和工具 stub，例如 proxy 指向 `127.0.0.1:9`、`CARGO_NET_OFFLINE=1`、`NPM_CONFIG_OFFLINE=true`、禁用 `ssh/scp` 等。

elevated 后端能力更完整：

- 使用专用 Windows 本地用户。
- 能用用户身份做防火墙/WFP 网络隔离。
- 能用 setup helper 提前配置 read/write/deny ACL。
- 能用 command runner 在 sandbox 用户下派生受限 token。
- 支持更复杂的 managed permission profile。

**五、Elevated 后端的总体数据流**
这是最完整、最核心的路径。

```text
+-------------------+
| codex-core         |
| exec request       |
+---------+---------+
          |
          v
+-------------------------------+
| prepare_elevated_spawn_context |
|                               |
| - normalize env               |
| - compute read/write roots    |
| - compute deny-read/write     |
| - require sandbox creds       |
| - ensure setup/refresh        |
| - compute capability SIDs     |
+---------------+---------------+
                |
                v
+------------------------------------+
| parent process                      |
|                                    |
| create named pipes                 |
| launch codex-command-runner.exe    |
| as sandbox user                    |
| using CreateProcessWithLogonW      |
+---------------+--------------------+
                |
                | length-prefixed JSON frames
                v
+------------------------------------+
| codex-command-runner.exe            |
| running as CodexSandboxOffline      |
| or CodexSandboxOnline               |
|                                    |
| receives SpawnRequest              |
| derives restricted token           |
| starts actual command              |
+---------------+--------------------+
                |
                v
+------------------------------------+
| actual user command                 |
|                                    |
| restricted token                   |
| ACL-gated filesystem               |
| firewall/WFP-gated network         |
| optional private desktop           |
| job object lifetime control        |
+------------------------------------+
```

**六、Elevated 后端接收指令的协议**
父进程和 `codex-command-runner.exe` 之间不是用 stdin 文本协议，而是用 named pipe 上的 length-prefixed JSON frame。

协议定义在：

```text
windows-sandbox-rs/src/elevated/ipc_framed.rs
```

frame 格式：

```text
[u32 little-endian length][JSON payload]
```

最大 frame 长度：

```rust
8 * 1024 * 1024
```

协议版本：

```rust
IPC_PROTOCOL_VERSION = 2
```

消息类型：

```text
parent -> runner:
  spawn_request
  stdin
  close_stdin
  resize
  terminate

runner -> parent:
  spawn_ready
  output
  exit
  error
```

核心 `SpawnRequest` 内容：

```text
command
cwd
env
permission_profile
permission_profile_cwd
codex_home
real_codex_home
cap_sids
timeout_ms
tty
stdin_open
use_private_desktop
```

抽象图：

```text
+-------------------------+                  +-----------------------------+
| Parent Codex Process    |                  | codex-command-runner.exe     |
+-------------------------+                  +-----------------------------+
| create pipe-in          |                  | open --pipe-in               |
| create pipe-out         |                  | open --pipe-out              |
| DACL: only sandbox user |                  | runs as sandbox user         |
+------------+------------+                  +--------------+--------------+
             |                                              |
             | SpawnRequest                                 |
             +--------------------------------------------->|
             |                                              |
             | SpawnReady                                   |
             |<---------------------------------------------+
             |                                              |
             | Stdin / CloseStdin / Resize / Terminate      |
             +--------------------------------------------->|
             |                                              |
             | Output(stdout/stderr) / Exit / Error         |
             |<---------------------------------------------+
```

Pipe 安全点：

- pipe name 随机 nonce。
- pipe DACL 只允许 sandbox user 连接。
- parent 连接后校验 named pipe client PID 是否等于刚启动的 runner PID。
- 如果握手失败，parent 会终止 runner，避免遗留进程。

对应模块：

```text
elevated/runner_pipe.rs
elevated/runner_client.rs
```

**七、Runner 如何启动真实命令**
`codex-command-runner.exe` 入口在：

```text
windows-sandbox-rs/src/bin/command_runner/win.rs
```

它的职责很明确：

```text
1. 读取 --pipe-in / --pipe-out
2. 打开 parent 创建的 named pipes
3. 读取 SpawnRequest
4. 根据 permission_profile 决定 token 模式
5. 根据 cap_sids 创建 restricted token
6. 选择 pipes 或 ConPTY
7. 调用 CreateProcessAsUserW 启动真实命令
8. 把 stdout/stderr 编码成 Output frame 发回 parent
9. 接收 stdin/resize/terminate
10. wait 子进程，发送 Exit frame
```

Runner 内部执行图：

```text
+-------------------------------+
| codex-command-runner.exe      |
| running as sandbox user       |
+---------------+---------------+
                |
                v
+-------------------------------+
| read SpawnRequest             |
|                               |
| command/cwd/env/permissions   |
| cap_sids/tty/timeout          |
+---------------+---------------+
                |
                v
+-------------------------------+
| resolve token mode            |
|                               |
| no writable roots             |
|   -> ReadOnlyCapability       |
| writable roots exist          |
|   -> WritableRootsCapability  |
+---------------+---------------+
                |
                v
+-------------------------------+
| CreateRestrictedToken         |
|                               |
| restricting SIDs include:     |
| - capability SIDs             |
| - sandbox user SID            |
| - logon SID                   |
| - Everyone SID                |
+---------------+---------------+
                |
                v
+-------------------------------+
| spawn actual process          |
|                               |
| tty=true  -> ConPTY           |
| tty=false -> anonymous pipes  |
|                               |
| CreateProcessAsUserW          |
+---------------+---------------+
                |
                v
+-------------------------------+
| stream I/O over framed IPC    |
| wait/timeout/terminate        |
| send exit                     |
+-------------------------------+
```

Timeout 逻辑：

- runner 用 `WaitForSingleObject(process, timeout)`。
- 超时则 `TerminateProcess`。
- exit code 设置为 `128 + 64`。
- 上层 core 最终会把 timeout 映射成 shell-style `124`。

生命周期控制：

- runner 会创建 `JobObject`，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- runner 退出或 job handle 关闭时，尽量杀掉子进程树。

**八、权限模型：从 Codex 策略到 Windows enforcement**
Codex 的上层策略不是 Windows 原生格式。它先变成：

```text
PermissionProfile
        |
        v
FileSystemSandboxPolicy
NetworkSandboxPolicy
```

Windows 专用解析在：

```text
windows-sandbox-rs/src/resolved_permissions.rs
```

核心抽象：

```rust
ResolvedWindowsSandboxPermissions {
    file_system: FileSystemSandboxPolicy,
    network: NetworkSandboxPolicy,
}
```

它负责：

- 把 `:workspace_roots` 这种符号路径绑定到实际 `cwd`。
- 计算 readable roots。
- 计算 writable roots。
- 处理 Windows 的 `TEMP` / `TMP`。
- 判断是否需要 network block。
- 判断 token 是 readonly 还是 writable-roots。
- 拒绝 Windows sandbox 无法保证的权限，比如 full-disk write。

抽象图：

```text
+---------------------------+
| PermissionProfile         |
|                           |
| read-only                 |
| workspace-write           |
| managed split policy      |
+-------------+-------------+
              |
              v
+---------------------------+
| Runtime permissions       |
|                           |
| FileSystemSandboxPolicy   |
| NetworkSandboxPolicy      |
+-------------+-------------+
              |
              v
+-------------------------------+
| ResolvedWindowsSandboxPermissions |
+-------------+-----------------+
              |
              +--------------------------+
              |                          |
              v                          v
+------------------------+     +--------------------------+
| readable_roots         |     | writable_roots           |
|                        |     |                          |
| helper bin             |     | workspace cwd            |
| C:\Windows             |     | extra writable roots     |
| Program Files          |     | TEMP/TMP when allowed    |
| explicit read roots    |     | read-only subpath denies |
+------------------------+     +--------------------------+
              |
              v
+-------------------------------+
| Windows token mode            |
|                               |
| no writable roots: readonly   |
| has writable roots: writable  |
+-------------------------------+
```

**九、Capability SID 的设计**
Windows 没有 Linux Landlock 那种直接传策略的接口，所以这里模拟出 capability 的概念。

模块：

```text
windows-sandbox-rs/src/cap.rs
```

它会在 `CODEX_HOME/cap_sid` 持久化随机 SID 字符串：

```text
readonly
workspace
workspace_by_cwd
writable_root_by_path
```

这些 SID 不一定对应真实 Windows account。它们作为 restricted token 的 restricting SIDs 使用，并被写入文件 DACL。

核心思想：

```text
token 里携带某 capability SID
        +
文件/目录 DACL 允许该 capability SID
        =
该 token 才能访问该路径
```

workspace-write 下会为每个 root 生成独立 SID：

```text
workspace root C:\repo
  -> S-1-5-21-a-b-c-d

extra writable root D:\tmp
  -> S-1-5-21-e-f-g-h
```

这样旧的 writable root ACL 不会自动扩大新命令的权限，因为当前 token 只携带本次允许 root 的 cap_sids。

图：

```text
+-----------------------------+
| CODEX_HOME/cap_sid          |
+-----------------------------+
| readonly SID                |
| workspace_by_cwd            |
| writable_root_by_path       |
+--------------+--------------+
               |
               v
+-----------------------------+
| SpawnRequest.cap_sids       |
| only SIDs needed this run   |
+--------------+--------------+
               |
               v
+-----------------------------+
| CreateRestrictedToken       |
| restricting SIDs = cap_sids |
+--------------+--------------+
               |
               v
+-----------------------------+
| NTFS DACL                   |
| path grants/denies cap SID  |
+-----------------------------+
```

**十、文件权限如何 enforce**
文件权限主要靠 NTFS DACL。

模块：

```text
acl.rs
deny_read_acl.rs
deny_read_state.rs
workspace_acl.rs
setup_main/win.rs
```

文件权限分成几类：

```text
read roots:
  给 sandbox group 补 read/execute ACE

write roots:
  给 sandbox group 和 root capability SID 补 read/write/execute/delete ACE

deny-write paths:
  给对应 writable root capability SID 加 deny-write ACE

deny-read paths:
  给 sandbox group 或 capability SID 加 deny-read ACE，并持久化状态

protected workspace children:
  对 .codex / .agents 加 deny-write ACE
```

为什么 setup 要提前创建 missing deny paths？

因为 deny ACE 必须挂在真实 filesystem object 上。如果路径不存在，sandboxed command 可能先在 writable parent 下创建它，再绕过 deny。代码会把 missing deny-read/deny-write path 先 materialize 成目录，再加 deny ACE。

deny-read 的特殊点：

```text
deny-read ACL 是持久状态
```

位置：

```text
.sandbox/deny_read_acl_state.json
```

原因是 sandbox 子进程或孙进程可能在 parent 退出后继续存在，所以不能在每次命令结束后立刻撤 ACL。实现采用 reconcile 模式：

```text
1. 先应用本次 desired deny-read ACL
2. 再撤销同一 principal 旧的、这次不需要的 deny-read ACL
3. 更新 deny_read_acl_state.json
```

文件权限图：

```text
+-------------------------------+
| Resolved permissions          |
+---------------+---------------+
                |
                v
+-------------------------------+
| Compute paths                 |
|                               |
| read_roots                    |
| write_roots                   |
| deny_read_paths               |
| deny_write_paths              |
+---------------+---------------+
                |
                v
+-------------------------------+
| Setup / refresh applies ACLs  |
+---------------+---------------+
                |
                +-----------------------------+
                |                             |
                v                             v
+-----------------------------+   +-----------------------------+
| Allow ACE                   |   | Deny ACE                    |
|                             |   |                             |
| sandbox group read/execute  |   | deny read on secrets        |
| capability write root       |   | deny write on .git/.codex   |
+-----------------------------+   +-----------------------------+
                |
                v
+-------------------------------+
| Child process access check    |
|                               |
| sandbox user identity         |
| restricted token SIDs         |
| NTFS DACL                     |
+-------------------------------+
```

**十一、网络权限如何 enforce**
网络 enforcement 分两层，legacy 与 elevated 差别很大。

Legacy restricted-token 后端：

- 不使用专用 sandbox user。
- 网络禁用主要通过环境变量和工具 stub。
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 指向 `127.0.0.1:9`。
- `NO_PROXY=localhost,127.0.0.1,::1`。
- `PIP_NO_INDEX=1`。
- `NPM_CONFIG_OFFLINE=true`。
- `CARGO_NET_OFFLINE=true`。
- `GIT_SSH_COMMAND=cmd /c exit 1`。
- PATH 前置 denybin，拦截 `ssh` / `scp`。

对应模块：

```text
env.rs
spawn_prep.rs
```

Elevated 后端：

- 根据网络策略选择 sandbox identity：
  - network disabled 或 proxy enforced -> `CodexSandboxOffline`
  - network enabled -> `CodexSandboxOnline`
- offline 用户被 Windows Firewall/WFP 规则限制。
- online 用户不走 offline block。

对应模块：

```text
setup.rs
identity.rs
setup_main/win/firewall.rs
wfp.rs
wfp/filter_specs.rs
```

offline 网络隔离包括：

```text
Windows Firewall:
  - block non-loopback outbound
  - block loopback UDP
  - block loopback TCP except allowed proxy ports
  - optional allow local binding mode

WFP:
  - block ICMP
  - block DNS 53
  - block DNS-over-TLS 853
  - block SMB 445/139
```

网络图：

```text
+-----------------------------+
| NetworkSandboxPolicy        |
+--------------+--------------+
               |
               v
+-----------------------------+
| SandboxNetworkIdentity      |
|                             |
| Offline if network blocked  |
| Online if network enabled   |
+--------------+--------------+
               |
      +--------+---------+
      |                  |
      v                  v
+-------------+    +----------------+
| Offline user|    | Online user    |
|             |    |                |
| Firewall    |    | no offline     |
| WFP filters |    | block rules    |
+-------------+    +----------------+
```

**十二、Setup 机制：为什么需要一个 elevated helper**
完整的 elevated sandbox 需要改系统级状态：

- 创建本地用户。
- 创建本地组。
- 配置 Windows Firewall。
- 安装 WFP filters。
- 修改文件/目录 ACL。
- 锁定 `.sandbox`、`.sandbox-bin`、`.sandbox-secrets`。
- 写入 DPAPI 加密的 sandbox 用户密码。

这些需要管理员权限，所以有独立二进制：

```text
codex-windows-sandbox-setup.exe
```

父进程通过 `ShellExecuteExW` + `runas` 提权启动它，并传入 base64 JSON payload。

payload 主要字段：

```text
version
offline_username
online_username
codex_home
command_cwd
read_roots
write_roots
deny_read_paths
deny_write_paths
proxy_ports
allow_local_binding
real_user
mode
refresh_only
```

setup artifact：

```text
CODEX_HOME/
  cap_sid
  .sandbox/
    setup_marker.json
    deny_read_acl_state.json
    codex-sandbox.log
  .sandbox-bin/
    codex-command-runner-<version>.exe
  .sandbox-secrets/
    sandbox_users.json
```

setup 流程图：

```text
+------------------------------+
| require_logon_sandbox_creds  |
+--------------+---------------+
               |
               v
+------------------------------+
| check setup_marker.json      |
| check sandbox_users.json     |
| check version/proxy drift    |
+--------------+---------------+
               |
      missing/stale?
               |
       +-------+-------+
       |               |
       v               v
+-------------+   +-------------------+
| run setup   |   | use existing creds|
| elevated    |   +-------------------+
+------+------+             |
       |                    |
       v                    v
+------------------------------+
| always run setup refresh     |
| non-elevated helper          |
| refresh ACLs for current run |
+--------------+---------------+
               |
               v
+------------------------------+
| return SandboxCreds          |
| username + DPAPI password    |
+------------------------------+
```

setup helper 内部：

```text
+-----------------------------------------+
| codex-windows-sandbox-setup.exe         |
+-------------------+---------------------+
                    |
                    v
+-----------------------------------------+
| decode base64 JSON payload              |
| validate SETUP_VERSION                  |
+-------------------+---------------------+
                    |
                    v
+-----------------------------------------+
| if full setup:                          |
| - create CodexSandboxUsers group        |
| - create CodexSandboxOffline user       |
| - create CodexSandboxOnline user        |
| - generate random passwords             |
| - DPAPI protect passwords               |
| - write .sandbox-secrets/sandbox_users  |
| - write setup_marker                    |
| - hide users                            |
+-------------------+---------------------+
                    |
                    v
+-----------------------------------------+
| network setup                           |
| - firewall offline block                |
| - proxy allowlist                       |
| - WFP filters                           |
+-------------------+---------------------+
                    |
                    v
+-----------------------------------------+
| filesystem setup                        |
| - apply deny-read synchronously         |
| - spawn read ACL helper                 |
| - grant write roots                     |
| - apply deny-write carveouts            |
| - lock sandbox dirs                     |
+-----------------------------------------+
```

**十三、为什么还有 read ACL helper**
`setup_main/win.rs` 里有 `ReadAclsOnly` 模式。full setup 不直接同步完成所有 read grant，而是可能启动同一个 setup exe 的 read-only helper 模式。

原因从实现看主要是：

- read roots 可能很多。
- read grant 是可刷新、可并发的问题。
- 用 named mutex `Local\CodexSandboxReadAcl` 避免多个 read ACL helper 同时跑。
- deny-read 必须同步应用在命令启动前，而 read allow grant 可以由 helper 刷新。

与 runner 的关系：

- command runner 启动时会探测 read ACL mutex。
- 如果 read ACL helper 正在运行，runner 会给 cwd 创建 junction，避免 ACL helper 改 cwd 相关 ACL 时影响启动路径。
- 逻辑在 `bin/command_runner/win/cwd_junction.rs`。

**十四、真实命令如何被创建**
最终调用 Windows API 的地方在：

```text
process.rs
```

核心 API：

```rust
CreateProcessAsUserW
```

它接收：

```text
restricted token
argv command line
cwd
environment block
stdio handles
private desktop setting
```

stdio 两种方式：

```text
tty=true:
  ConPTY
  stdout/stderr 合并为 PTY output
  支持 resize

tty=false:
  anonymous pipes
  stdout/stderr 分离
```

private desktop：

- 默认配置里 `windows.sandbox_private_desktop` 默认为 true。
- 代码会创建 `CodexSandboxDesktop-<nonce>`。
- 给当前 logon SID 授权 desktop access。
- 子进程的 `STARTUPINFO.lpDesktop` 指向该 private desktop。
- 目的是减少 GUI/desktop 对主用户交互面的影响。

**十五、Captured exec 与 Unified exec 的差异**
Captured exec：

```text
core/src/exec.rs
  -> exec_windows_sandbox(...)
  -> run_windows_sandbox_capture_for_permission_profile_elevated(...)
  -> parent waits for runner output frames
  -> returns stdout/stderr/exit_code/timed_out
```

图：

```text
+-------------+       +---------+       +--------+
| shell tool  | ----> | capture | ----> | result |
+-------------+       +---------+       +--------+
```

Unified exec：

```text
core/src/unified_exec/process_manager.rs
  -> spawn_windows_sandbox_session_elevated_for_permission_profile(...)
  -> returns SpawnedProcess
  -> ProcessDriver wraps pipes/IPC
  -> caller can write stdin, read stream, resize, terminate
```

图：

```text
+------------------+
| unified exec open|
+---------+--------+
          |
          v
+------------------+
| SpawnedProcess   |
| session handle   |
+---------+--------+
          |
          +-----------------+
          |                 |
          v                 v
+----------------+   +----------------+
| live stdout    |   | live stdin     |
| live stderr    |   | resize/kill    |
+----------------+   +----------------+
```

Elevated unified exec 复用 same runner IPC，只是 parent 不是一次性收集 output，而是把 frame 转成 `ProcessDriver` 的 channels。

**十六、Legacy 后端的逻辑**
legacy 后端在：

```text
unified_exec/backends/legacy.rs
lib.rs windows_impl
spawn_prep.rs
```

它没有专用 sandbox 用户，也没有 command runner。流程：

```text
+-----------------------------+
| parent process              |
+--------------+--------------+
               |
               v
+-----------------------------+
| parse legacy SandboxPolicy  |
+--------------+--------------+
               |
               v
+-----------------------------+
| normalize env               |
| maybe apply no-network env  |
+--------------+--------------+
               |
               v
+-----------------------------+
| create capability SIDs      |
| create restricted token     |
+--------------+--------------+
               |
               v
+-----------------------------+
| apply write ACLs / denies   |
+--------------+--------------+
               |
               v
+-----------------------------+
| CreateProcessAsUserW child  |
+-----------------------------+
```

legacy 后端限制：

- 如果不是 full-disk read，会拒绝。
- 如果有 deny-read，会拒绝。
- 如果 split writable root 语义无法映射成 legacy policy，会拒绝。
- 不会为了“安全”降级成 unsandboxed。

这点很重要：代码里多处出现“refusing to run unsandboxed”，说明无法 enforce 时宁可失败，也不悄悄放行。

**十七、Elevated 与 Legacy 对比图**
```text
+----------------------+-----------------------------+-----------------------------+
| 维度                 | Legacy RestrictedToken      | Elevated                    |
+----------------------+-----------------------------+-----------------------------+
| 执行身份             | 当前用户派生 token          | 专用 sandbox local user     |
| 提权 setup           | 不需要完整 setup            | 需要 setup/refresh          |
| 启动真实命令         | parent 直接 CreateProcess   | runner 再 CreateProcess     |
| IPC                  | 无 runner IPC               | named pipe framed JSON      |
| 文件写限制           | capability SID + ACL        | sandbox group + cap SID ACL |
| 文件读限制           | 不支持复杂 deny-read        | 支持 deny-read ACL          |
| 网络限制             | env/stub 降级               | firewall + WFP + identity   |
| proxy enforcement    | 不适合                      | 强制使用                    |
| TTY                  | ConPTY                      | runner 内 ConPTY            |
| stdout/stderr        | parent 读 pipes             | runner 转 Output frames     |
+----------------------+-----------------------------+-----------------------------+
```

**十八、端到端主流程图：Elevated Shell Tool**
```text
+--------------------------------------------------------------------------------+
| User / Model Tool Call                                                          |
|                                                                                |
| command + cwd + env + PermissionProfile + timeout                              |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| codex-core exec_windows_sandbox                                                |
|                                                                                |
| - apply NetworkProxy env if needed                                             |
| - decide elevated backend                                                      |
| - resolve filesystem overrides                                                 |
| - find CODEX_HOME                                                              |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| windows-sandbox elevated_impl                                                  |
|                                                                                |
| - resolve PermissionProfile                                                    |
| - normalize env                                                                |
| - compute read/write/deny roots                                                |
| - require sandbox creds                                                        |
| - compute cap_sids                                                             |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| identity/setup                                                                 |
|                                                                                |
| - check setup marker/users                                                     |
| - if missing/stale: run setup helper with UAC                                  |
| - always run setup refresh                                                     |
| - return sandbox username/password                                             |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| runner_client                                                                  |
|                                                                                |
| - create random named pipe pair                                                |
| - DACL pipes for sandbox user                                                  |
| - launch codex-command-runner.exe via CreateProcessWithLogonW                  |
| - verify pipe client PID                                                       |
| - send SpawnRequest                                                            |
| - wait SpawnReady                                                              |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| codex-command-runner.exe                                                       |
|                                                                                |
| - read SpawnRequest                                                            |
| - create restricted token with cap_sids                                        |
| - spawn real command via CreateProcessAsUserW                                  |
| - send Output frames                                                           |
| - send Exit frame                                                              |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
| codex-core                                                                     |
|                                                                                |
| - aggregate stdout/stderr                                                      |
| - map timeout                                                                  |
| - return ExecToolCallOutput                                                    |
+--------------------------------------------------------------------------------+
```

**十九、完整抽象设计图**
```text
+================================================================================+
|                           WINDOWS SANDBOX ABSTRACT DESIGN                       |
+================================================================================+
|                                                                                |
|  Policy Plane                                                                  |
|  +---------------------+     +------------------------------+                   |
|  | PermissionProfile   | --> | ResolvedWindowsPermissions   |                   |
|  +---------------------+     +------------------------------+                   |
|             |                                |                                  |
|             |                                v                                  |
|             |                  +-----------------------------+                  |
|             |                  | read/write/deny roots       |                  |
|             |                  | network identity            |                  |
|             |                  | token mode                  |                  |
|             |                  +-----------------------------+                  |
|             |                                                                   |
|             v                                                                   |
|  Setup Plane                                                                   |
|  +---------------------+     +------------------------------+                   |
|  | require credentials | --> | codex-windows-sandbox-setup  |                   |
|  +---------------------+     +------------------------------+                   |
|             |                                |                                  |
|             |                                v                                  |
|             |                  +-----------------------------+                  |
|             |                  | local users/group           |                  |
|             |                  | DPAPI secrets               |                  |
|             |                  | ACL refresh                 |                  |
|             |                  | firewall/WFP                |                  |
|             |                  | helper materialization      |                  |
|             |                  +-----------------------------+                  |
|             |                                                                   |
|             v                                                                   |
|  Execution Plane                                                               |
|  +---------------------+     +------------------------------+                   |
|  | parent process      | --> | runner or direct spawn       |                   |
|  +---------------------+     +------------------------------+                   |
|             |                                |                                  |
|             |                                v                                  |
|             |                  +-----------------------------+                  |
|             |                  | CreateRestrictedToken       |                  |
|             |                  | CreateProcessAsUserW        |                  |
|             |                  | ConPTY / pipes              |                  |
|             |                  | Job object                  |                  |
|             |                  | private desktop             |                  |
|             |                  +-----------------------------+                  |
|             |                                                                   |
|             v                                                                   |
|  Enforcement Plane                                                             |
|  +---------------------+     +------------------------------+                   |
|  | NTFS DACL           |     | Windows Firewall / WFP       |                   |
|  | capability SIDs     |     | offline/online sandbox user  |                   |
|  | deny ACEs           |     | proxy allowlist              |                   |
|  +---------------------+     +------------------------------+                   |
|                                                                                |
+================================================================================+
```

**二十、核心安全边界总结**
文件系统边界：

- 不是靠拦截 syscall。
- 靠 Windows token access check + NTFS DACL。
- read roots/write roots/deny roots 都会转换成 ACL。
- writable root 用 capability SID 精确绑定。
- deny-read/deny-write 用 deny ACE 强制 carveout。
- `.codex` / `.agents` 作为 workspace 内的敏感目录会额外保护。

身份边界：

- elevated 使用专用本地用户，而不是当前真实用户。
- offline/online 两个用户分离网络语义。
- 密码随机生成并用 DPAPI 保护。
- 用户放入 `CodexSandboxUsers` 组，便于统一 ACL 管理。

token 边界：

- 真实命令不是拿完整 sandbox 用户 token 跑。
- runner 会再次调用 `CreateRestrictedToken`。
- restricted token 携带本次命令允许的 capability SIDs。
- 这样即使历史 ACL 留在某路径上，本次 token 没有对应 SID，也不能获得对应权限。

网络边界：

- elevated offline 用户被 firewall/WFP 规则限制。
- WFP 额外阻断 ICMP、DNS、SMB 等容易绕过普通代理语义的通道。
- proxy-enforced 会强制 elevated，因为只有 sandbox 用户身份才能让防火墙规则可靠生效。

进程边界：

- 命令用 `CreateProcessAsUserW` 启动。
- TTY 用 ConPTY。
- 非 TTY 用匿名 pipes。
- runner 用 job object 管理生命周期。
- 可选 private desktop 降低 GUI/desktop 交互风险。

IPC 边界：

- parent 与 runner 通过 named pipes。
- pipe DACL 限制为 sandbox user。
- parent 校验 connected client PID。
- frame 有版本和最大长度限制。
- output/stdin 都 base64 放在 JSON payload 内，避免二进制流破坏协议。

**二十一、一个具体例子**
假设策略是 workspace-write，网络禁用，命令为：

```text
powershell.exe -Command "npm test"
cwd = C:\repo
```

elevated 后端会抽象成：

```text
filesystem:
  read:
    helper bin
    C:\Windows
    C:\Program Files
    C:\Program Files (x86)
    C:\ProgramData
    C:\repo
  write:
    C:\repo
    TEMP/TMP if policy allows
  deny-write:
    C:\repo\.git
    C:\repo\.codex
    C:\repo\.agents
  deny-read:
    explicit secret paths if policy contains them

network:
  offline identity
```

执行时：

```text
1. setup 确保 CodexSandboxOffline 存在。
2. setup 给 C:\repo 添加 sandbox group/capability write ACE。
3. setup 给 .git/.codex/.agents 添加 deny-write ACE。
4. firewall/WFP 确保 CodexSandboxOffline 出网受限。
5. parent 用 CodexSandboxOffline 登录 runner。
6. parent 把 SpawnRequest 发给 runner。
7. runner 创建含 C:\repo capability SID 的 restricted token。
8. runner 用 restricted token 启动 powershell/npm。
9. npm 可以在 C:\repo 写测试产物。
10. npm 不能写 protected carveout。
11. npm 出网会被 offline 用户规则限制。
12. stdout/stderr 通过 runner frames 回到 Codex。
```

**二十二、需要注意的设计取舍**
这个 Windows sandbox 的设计很工程化，但不是“完美内核级 sandbox”：

- 它大量依赖 Windows ACL 的正确性。
- elevated 模式需要一次性 setup，有 UAC 和本地用户管理成本。
- deny-read/deny-write 会修改真实文件系统 ACL，因此需要状态文件和 refresh/reconcile。
- legacy 模式网络隔离明显弱于 elevated。
- elevated 模式更完整，但复杂度更高，涉及 helper copy、DPAPI、firewall、WFP、named pipe、runner。
- 对无法直接 enforce 的策略，代码倾向于拒绝运行，而不是悄悄降级成无 sandbox。

整体看，Codex 的 Windows sandbox 设计目标不是“每次临时创建一个容器”，而是：

```text
先长期准备一套可复用的 Windows sandbox 基础设施，
每次运行时再把当前命令的 permission profile 映射成：
  - 当前应该用哪个 sandbox 用户
  - 当前 token 应携带哪些 capability SIDs
  - 当前文件系统上哪些 ACL 必须存在
  - 当前网络身份是否应该 offline
  - 当前 I/O 应如何通过 runner 转发
最后用 Windows 原生安全检查完成 enforcement。
```

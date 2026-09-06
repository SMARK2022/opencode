# Canonical Implementation Plan: ChatGPT 语音直连转录——MCP 内嵌凭据与懒收割

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: GOAL 原始需求（见第 1 节逐字引用）+ 会话中已批准的六点修订设计
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-06

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

GOAL 原始需求（逐字）：

> 我觉得当前这种方案比较不错，并且整体的修最终方案的修改文件数，生产文件代码应当不超过8个文件，同时生产代码行数修改不超过1600行，整体风格保持一致性，且如果有死代码或旧代码应当被移除，按照相应的"凭据内嵌 mcp.chatgpt.auth + 懒收割，写入方唯一（opencode，注释保真、原子、定点）"逻辑进行实现。也就是保持精准修改，且保持主逻辑整体优化，风格自然，且避免出现过多冗余或残留。同时注意修改不应当让最终状态存在相关方面的红测，如果测试过时应当进行修改，如果生产代码逻辑错误导致了最终稳定性下降，应当优化生产代码。

会话中用户已批准的设计约束（逐字关键句，作为本计划的授权依据）：

- Token 出浏览器授权："我现在其实允许这个 Token 出浏览器的"
- 存储位置："这个凭据是要放进，或者说可以放进 OpenCode 的点 JSON 里面的"、"我也不希望它去独立地创建一个相应的这个 JSON"、"应当被配置在这个 MCP 的这个对应的 JSON 字段的旁边，然后我们在之后的请求的时候也都用这么一个相应的凭据"
- 分发："我希望这个相应的 Cookie 内容是能够随着这个 Open Code 的……OpenCode.json 去进行自行分发的"
- 懒收割："避免平常的时候就直接打开这个浏览器……频繁完全主动地打开浏览器去刷新这个 cookie 或者刷新这个 JSON"
- 主动预警收割："这个整体的 Cookie 在 Open Code 的这个客户端检查到它整体的有效期不长，就是可能已经还有一两天就到了的时候，它可以主动从浏览器里面……获取到它的那个相应的 Cookie，然后去更新一下我们本地的"
- 回退（用户对完整设计的批准句："我觉得当前这种方案比较不错"，该设计中含）："401 → 刷 token 重试一次；403/结构漂移 → 回退现有 transcribe-file，Alt+V 永远可用"
- 目标终态：`<verified-implementation-and-commit>`

## 2. Explicit Non-Goals

- 不修改录音链路（PvRecorder Worker、WAV 格式、临时文件清理语义）。
- 不新增独立凭据文件（不创建 `auth.json` 条目、不创建 `chatgpt-auth.json`、不建 `mcp-auth.json` 条目）；凭据唯一落点是 `opencode.json` 的 `mcp.<chatgpt 键>.auth` 节点。
- 不修改 agent 的 MCP 工具面（`ask`/`status`/`stop` schema 与行为不变）；`/auth/export` 是与 `/voice/transcribe-file` 同类的 TUI 私有 side-channel。
- 不实现定时器、开机探测、周期收割；浏览器只在真实语音请求需要凭据且凭据失效时被（经 agent CLI/daemon）启动。
- 不集成 curl-impersonate/TLS 伪装库；直连请求使用仓库统一的 `NetworkProxy.fetch`。指纹失败由用户批准的 argv 回退覆盖。
- 不修改 agent 的浏览器生命周期、page pool、submission queue 语义；`/auth/export` 复用现有 voice lease 所有权模型。
- 不修改 macOS 五分钟 E2E（darwin 门禁用例继续锁定 argv 浏览器路径）。
- 不实现 headless 服务器的自动同步/搬运；分发是用户手工拷贝 `opencode.json`。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 领域词汇（Session/Tool/Provider/NetworkProxy）与 SMARK fork 约定（`[local-smark]` 标记）；NetworkProxy 是统一 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 处理的仓库级 seam |
| 根 `AGENTS.md` | 风格约束（const/早返回/避免 else/复用 Bun API/内联单用变量/`export * as X` 自导出）；测试从包目录运行 |
| `packages/opencode/AGENTS.md` | Effect 模块形态（本任务 voice-auth 为 plain async，不引入 Effect service）；db/typecheck 命令约定 |
| `packages/opencode/test/AGENTS.md` | bun:test + `tmpdir` fixture + `await using` 约定；测试注入 seam 先例 |
| `.opencode/policy/first-principles-engineering.md` | 单一 primary path、fallback 禁令（用户显式批准除外）、责任归属、10% diagnostic 预算、中文注释门禁 |
| `thirdparty/chatgpt-browser-agent/README.md` | agent 架构、环境变量合同、voice lifecycle 语义（"direct endpoint 是唯一成功路径"、"token 不进 Node 日志"——后者由用户授权解除为"token 不进日志"） |
| EchoPaper `F:\Project\HKUST\EchoPaper\src\auth.py` / `transcribe.py` / `config.py` | 直连 API 请求形态与凭据生命周期的外部实证（同端点、同刷新协议、curl_cffi 指纹需求） |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts`（全文） | 现有 transcriber 协议（argv spawn、`{file}` 占位、JSON stdout）、controller 状态机、超时常量、validate 逻辑、可注入 `transcribe` seam | observed |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts`（1-200） | 录音链路边界（本任务不动）、`ensureExtractedNativeFile` 的 Windows rename 冲突处理先例（auth 写回复用该模式） | observed |
| `packages/opencode/src/cli/cmd/tui/config/tui.ts`（全文） | `voiceTranscriberFromMcpConfig` MCP 推导、`loadMcpVoiceTranscriber` 文件扫描顺序（global → OPENCODE_CONFIG → project → .opencode dirs，后者覆盖前者）、`OPENCODE_CONFIG_CONTENT` env 分支、Resolved 组装 | observed |
| `packages/opencode/src/cli/cmd/tui/config/tui-schema.ts`（全文） | 用户可配 `voice.transcriber` 仍为 argv 形态（本任务不改 schema） | observed |
| `packages/opencode/src/cli/cmd/tui/config/keybind.ts`（143,328） | `alt+v` = `prompt_voice_toggle` 绑定（不动） | observed |
| `packages/opencode/src/config/parse.ts`（全文） | `ConfigParse.jsonc` raw 解析；`topLevelExtraKeys` 只校验顶层未知键 → `mcp.<key>.auth` 嵌套字段通过校验且对 raw 读取方可见 | observed |
| `packages/opencode/src/config/mcp.ts`（全文） | `McpLocalConfig` 结构；Effect Schema decode 默认剥离嵌套未知字段 → auth 节点不破坏 MCP loader | observed |
| `packages/opencode/package.json`（142） | `jsonc-parser@3.3.1` 已在 dependencies（`modify`/`applyEdits` 可做注释保真定点编辑） | observed |
| `packages/core/src/network-proxy.ts`（1-100, 196-320） | `NetworkProxy.fetch(input, {purpose})` 公共 seam；env+系统代理解析；provider purpose 先例 | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`（443-470） | `transcriber: () => tuiConfig.voice?.transcriber` 闭包接线；类型联合化后无需改动该文件 | observed |
| `packages/opencode/src/cli/cmd/mcp.ts`（417-432 `addMcpToConfig`） | 既有 opencode.json 写入先例：`modify(text, ["mcp", name], value, {formattingOptions})` + `applyEdits` 注释保真定点写；`opencode mcp add` 整体替换 `mcp.<name>`（会移除已有 auth 子节点——用户主动重注册语义，writeVoiceAuth 需邻近中文注释提示） | observed（R1 审计 N-01 发现） |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts`（全文） | 现有行为测试 + `voiceE2E` 门禁模式（`CHATGPT_VOICE_E2E=1` + `CHATGPT_BROWSER_USER_DATA_DIR`）+ darwin 五分钟 E2E | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt.js`（380-509, 650-912） | CLI dispatch 线性结构、`ensureDaemon`/`retireDaemon`/身份重试循环、`voiceErrorIsRetryable` 封闭集合、transcribe-file 分支（auth-export 子命令的模板） | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js`（354, 959-1000, 1471, 1585-1600, 1732, 1802-1979, 2286-2601 关键段） | daemon HTTP 面（`/status` `/stop` `/ask` `/voice/transcribe-file`）、bearer 鉴权（2432）、`runtime.withVoice`/`voiceLease`/`withSubmission` 所有权模型、`startDaemonProcess` 启动链、`testing:` 导出对象 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js`（166-200, 755-844, 860-880） | `transcribeAudioFileDirect` 页面内请求形态（`/backend-api/transcribe`、multipart `file`、Bearer bootstrap token、`credentials:'include'`）；bootstrap 分类读取 | observed |
| `thirdparty/chatgpt-browser-agent/test-mcp.js`（选中段） | `testing.createDaemonRuntime` 假 browser/page harness（711, 760-913, 1392…）+ 真实 daemon HTTP server 测试（3309 `/voice/transcribe-file`）→ `/auth/export` 测试挂点 | observed |
| `thirdparty/chatgpt-browser-agent/test-voice-robustness.js`（1-60） | 真实 CLI/daemon 鲁棒性测试形态（本任务不扩展该文件） | observed |
| `thirdparty/chatgpt-browser-agent/package.json` | 依赖仅 `puppeteer-core`；`npm test` = test:syntax && test:deps && test:mcp | observed |
| EchoPaper `auth.py` / `transcribe.py` / `config.py` | CDP `Network.getCookies`（含 HttpOnly）+ `#client-bootstrap` token 提取实证；`GET /api/auth/session` cookie→token 刷新实证；`POST /backend-api/transcribe` 最小请求（Bearer + `oai-device-id`，无 cookie）实证；token margin 6h；curl_cffi chrome136 指纹需求 | observed（外部项目生产实证） |
| 用户全局 `~/.config/opencode/opencode.json` | provider apiKey 已内嵌于该文件（凭据入配置文件是该用户既有习惯）；含 `mcp` 段（内容未读取，仅确认存在） | observed（存在性） |

## 5. Current Behavior

```text
[Alt+V] keybind prompt_voice_toggle
  -> createVoiceInputController.toggle (prompt-voice-input.ts)
  -> startPromptVoiceRecorder (PvRecorder Worker -> 16kHz mono WAV, tmp/voice/)
  -> transcribeVoiceFile: spawn argv（{file} 字面量替换，无 shell）
       transcriber 解析优先级 (tui.ts):
         1. tui.json 显式 voice.transcriber（argv）
         2. MCP 推导：opencode.json mcp 段名含 "chatgpt" 的 enabled local 条目
            -> argv: [<interpreter>, <dir>/chatgpt.js, transcribe-file, --file, {file}, --json]
         3. 兜底 PATH: chatgpt-browser-agent transcribe-file --file {file} --json
  -> chatgpt.js CLI -> 本地 HTTP daemon POST /voice/transcribe-file（bearer）
  -> daemon voiceLease 取 chatgpt.com 页面 -> 页面内 fetch /backend-api/transcribe
     （bootstrap accessToken Bearer + credentials:'include' HttpOnly cookie）
  -> {text} 逐层返回 -> parseTranscriberOutput(JSON) -> insertText
```

约束现状：凭据（cookie/accessToken）只存在于浏览器 profile 与页面上下文；每次转写必须 spawn CLI→daemon→浏览器页面；headless 无法直连；凭据无法随 opencode.json 分发。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `tui.voice.transcriber` 显式 argv 配置 | 用户 tui.json | schema 校验（tui-schema.ts） | controller `transcriber()` 闭包 | TuiConfig | observed |
| MCP 推导条件：mcp 段名含 "chatgpt" + enabled + local + argv 含 `mcp-server.js` + 同目录 `chatgpt.js` 存在 | 用户 opencode.json | `voiceTranscriberFromMcpConfig` 过滤 + `existsSafe` | default transcriber 解析 | TuiConfig | observed |
| `mcp.<key>.auth` 未知嵌套字段 | 本任务新增（opencode 写入） | `topLevelExtraKeys` 只查顶层；Effect decode 剥离未知嵌套字段 → MCP loader 无感 | raw jsonc 读取方（voice 推导/voice-auth） | opencode TUI（唯一写入方） | contracted（用户指定存储位置） |
| 过期/有效 accessToken + cookies（auth 节点内容） | agent `auth-export` 收割 / opencode 刷新写回 | 形状校验由 voice-auth 读取方负责 | ensureVoiceCredential | voice-auth 模块 | contracted |
| 直连端点 `POST /backend-api/transcribe` | ChatGPT web 私有 API | 无官方合同；请求形态经 agent 页面路径与 EchoPaper 双重实证 | transcribeDirect | voice-auth 模块 | observed（外部实证）+ reachable |
| 刷新端点 `GET /api/auth/session` | ChatGPT web | 同上（EchoPaper 实证） | ensureVoiceCredential | voice-auth 模块 | observed（外部实证） |
| Bun fetch TLS 指纹被 Cloudflare 403 | 网络环境 | 无上游保证 | transcribeDirect -> argv 回退 | 回退路径（用户批准） | reachable（EchoPaper 需 curl_cffi 佐证） |
| 旧版 daemon 无 `/auth/export`（404） | 版本混布 | CLI 明确报错 | 收割失败 -> argv 回退 | 回退路径 | reachable |
| 多 Prompt 实例并发触发 ensureCredential | 主 Prompt/DialogPrompt/QuestionPrompt 三个 controller | 无 | 模块级 in-flight 去重 | voice-auth 模块 | reachable |
| 双 opencode 进程并发写 auth 节点 | 用户多开 | 无 | last-writer-wins（仅 auth 节点） | voice-auth 写回 | reachable（等价凭据，无害） |
| `OPENCODE_CONFIG_CONTENT` 提供无文件 MCP 配置 | 环境/测试 | 无写回目标 | 推导退回 argv 形态 | TuiConfig | reachable |
| 胜出 MCP 条目来自 project 文件/.opencode 目录 | 用户项目配置 | 版本管理下的可提交文件 | direct 可用但凭据仅驻内存，不写回（R2 钉定；OPENCODE_CONFIG_DIR 属 user 级，R4 统一） | voice-auth 写回范围判定 | reachable |

Speculative rows：无（cookie 实际寿命分布、CF 出口 IP 绑定属环境实测项，见第 20 节）。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Alt+V 语音输入在配置了可用后端时始终能完成转写（直连失败回落浏览器页面路径）；取消/清理/录音语义不变 | 用户批准设计（"Alt+V 永远可用"） | prompt-voice-input.test.ts（controller 语义全覆盖） |
| INV-02 | 显式 `tui.voice.transcriber` 用户配置优先于 MCP 推导与兜底默认 | tui.ts 现有合并顺序 | 无（现有行为，新增推导测试锁定） |
| INV-03 | auth 节点只由 opencode 进程写入；写入用 jsonc 定点编辑保注释、tmp+rename 原子落盘；agent 侧只导出（stdout/HTTP），永不写 opencode.json | 用户批准设计（"写入方唯一（opencode，注释保真、原子、定点）"） | 新增 voice-auth.test.ts |
| INV-04 | 浏览器不为刷新凭据而被主动启动：无定时器、无启动期探测；收割只发生在真实转写请求发现凭据缺失/失效时，或用户手动运行 auth-export | 用户批准设计（"避免平常……打开浏览器去刷新"） | 新增（收割触发时机断言：无凭据时才 spawn） |
| INV-05 | 凭据不出现在日志、错误消息、进程 argv、TUI toast；agent 返回的 token/cookie 只进入内存与 auth 节点 | agent README 安全基线（日志面）+ 用户授权（出浏览器但不出日志） | 新增（错误消息不含 token 断言） |
| INV-06 | argv 转写器协议不变：`{file}` 占位校验、argv 字面量替换、无 shell、JSON stdout 解析、空文本即错误 | prompt-voice-input.ts 现有合同 | prompt-voice-input.test.ts 既有用例 |
| INV-07 | 直连请求形态与已验证实践一致：multipart 仅 `file` 字段 + Bearer + `oai-device-id`（取 `oai-did` cookie）；401 → 一次刷新重试；其余失败 → argv 回退 | agent 页面路径（chatgpt-dom.js:796-806）+ EchoPaper transcribe.py 双实证 | 新增 voice-auth.test.ts + direct E2E |
| INV-08 | `mcp.<key>.auth` 嵌套字段不破坏 opencode config 加载与 MCP server 启动 | parse.ts:74 topLevelExtraKeys 仅顶层；mcp.ts Effect decode 剥离未知嵌套 | 新增（含 auth 节点的 opencode.json 正常加载） |
| INV-09 | 收割与转写都不降低既有稳定性：daemon voice lease/submission 所有权模型不变；`/auth/export` 与 voice 转写串行复用同一队列 | chatgpt-core.js runVoiceTranscribe 所有权注释（1810） | test-mcp.js 新增 runtime harness 用例 |

## 8. First Divergence and Root Cause

本任务为 feature 任务（新能力 seam），无 bug 红测回路；行为缺口即 first divergence：

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| 凭据可离浏览器存在并随 opencode.json 分发（需求核心） | transcriber 解析（tui.ts `voiceTranscriberFromMcpConfig`）只产出 argv 形态，且整个转写链（prompt-voice-input.ts `transcribeVoiceFile`）只有"spawn 外部 CLI → daemon → 浏览器页面"一条路径；凭据在结构上无法离开浏览器 profile | `tui.ts` 推导 + `prompt-voice-input.ts` 转写 seam | observed（第 5 节链路） |
| 直连请求可用缓存凭据完成 | 同上——无任何模块持有可复用的 Bearer/cookie | 新 owner：`util/voice-auth.ts`（凭据生命周期 + 直连请求） | contracted |
| agent 可导出凭据 | agent 导出面缺失（daemon 只有转写端点；bootstrap token 明确不返回 Node） | 新 owner：daemon `POST /auth/export` + CLI `auth-export` 子命令 | contracted（用户授权 token 出浏览器） |

Downstream symptoms（非根因）：headless 不可用、每请求冷启动 daemon、无法分发——均由上述 seam 缺失传导。

Feature seam 的 TDD 红测（Phase 2 要求）：`transcribeVoiceFile` 对 direct 变体当前抛"command not found/protocol error"（变体不存在时类型层面即不成立；行为红测见第 16 节 slice 1/2）；`ensureVoiceCredential`/`/auth/export` 模块与端点不存在，直接 red。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| auth 节点读写（jsonc 保真、原子、定点） | `tui/util/voice-auth.ts`（opencode 进程） | `readVoiceAuth`/`writeVoiceAuth` | 唯一写入方是 opencode（INV-03）；文件路径与 mcp key 在 TuiConfig 推导时已知 | agent 不了解 opencode.json 布局；写配置属 opencode 职责 |
| 凭据生命周期状态机（token 有效→刷新→收割） | `voice-auth.ts` `ensureVoiceCredential` | 输入 direct 变体，输出可用凭据 | 编排级重试/降级策略归 orchestration 模块（policy 默认 owner 表） | controller 只管录音/取消；TuiConfig 是纯配置解析 |
| 直连转写 HTTP 请求 | `voice-auth.ts` `transcribeDirect` | WAV → `{text}` | 与凭据同域；NetworkProxy 是仓库统一 fetch seam | daemon 页面路径保留为回退，不重复实现直连 |
| 收割执行（spawn CLI/daemon 启动） | agent CLI `auth-export` + daemon `/auth/export` | stdout JSON / HTTP JSON | 浏览器与 CDP 的唯一持有者是 agent daemon | opencode 不直连 CDP（避免第二套浏览器所有权） |
| direct 变体推导与 fallback argv 内嵌 | `tui.ts` `voiceTranscriberFromMcpConfig` | MCP 配置 → transcriber union | 推导既有的 owner；同时持有 config 路径与 key | prompt-voice-input 不读配置 |
| direct→argv 回退编排 | `prompt-voice-input.ts` `transcribeVoiceFile` | 转写成功或抛错 | 转写编排 owner；用户显式批准的回退 | voice-auth 不持有 argv spawn 合同 |
| `/auth/export` 页面所有权 | `chatgpt-core.js` runtime voice lease | 与 voice 转写串行 | runVoiceTranscribe 既有所有权模型（1810 注释） | 新端点不得旁路队列 |

## 10. Single Approved Primary-Path Design

```text
Alt+V 停止录音（WAV 落盘）
  -> transcribeVoiceFile(transcriber)
       ├─ argv 变体（显式配置 / 兜底 CLI）：现有 spawn 路径，行为不变
       └─ chatgpt-direct 变体（MCP 推导，内嵌 fallback argv）：
            1. ensureVoiceCredential(direct)
                 a. auth 节点 token 有效（exp - 6h margin）→ 直接用
                 b. token 过期且会话凭据 cookie 可用（存活且不临近死亡）
                    → NetworkProxy.fetch GET
                    https://chatgpt.com/api/auth/session（cookie header）
                    → 新 accessToken + 捕获 set-cookie 更新 → writeVoiceAuth
                    → 失败则走 c
                 c. 收割：Process.run [interpreter, script, "auth-export",
                    "--json"]（argv 无凭据；killTree:false；240s 超时）
                    → stdout JSON {authStatus, accessToken, cookies}
                    → writeVoiceAuth → 失败 throw AuthUnavailable
                 （并发去重：模块级 in-flight promise）

   生命周期谓词（R3 钉定，B-01 修正：谓词只作用于会话凭据 cookie，
   不作用于收割 jar 中的其它 cookie）：
   - 会话凭据 cookie：名称以 `__Secure-next-auth.session-token` 开头的
     cookie（NextAuth 会话令牌族；含 `.callback` 变体）。缺失视为已死
     （刷新必然 401，fail-safe 走收割）。
   - token 死亡：JWT exp - TOKEN_MARGIN_S(6h) <= now（EchoPaper 实证值）。
   - 会话凭据死亡：expires > 0 && expires <= now（CDP 会话 cookie
     expires=-1 归一为 0，视为存活）。
   - 会话凭据临近死亡：0 < expires <= now + COOKIE_HARVEST_MARGIN_S(48h)
     ——对应用户"还有一两天"语义；此时 token 过期则跳过 b 直接收割
     （刷新出的 token 寿命与会话凭据同源，临近死亡的会话凭据撑不起
     新 token 的完整生命周期）。
   - 其它 cookie（如 `__cf_bm` 短 TTL 项）不参与状态机门控：它们随每次
     刷新/收割自然更新，且 EchoPaper 生产实证（auth.py:157-166）表明
     刷新可行性不依赖它们存活（ensure_material 无任何 expiry 门控）。

   scope 判定规则（N-03 钉定）：`VoiceTranscriberDirect.scope` 由推导时的
   配置来源决定——全局 config 目录文件、显式 OPENCODE_CONFIG、
   OPENCODE_CONFIG_DIR 目录 → "user"；project opencode 文件与向上
   遍历的 .opencode 目录 → "project"。

   写回范围（R4 统一，含 N-01(R3)：OPENCODE_CONFIG_DIR 归 user 级）：
   writeVoiceAuth 只写用户级来源——全局 config 目录的 opencode 配置文件、
   显式 OPENCODE_CONFIG、OPENCODE_CONFIG_DIR 目录（后两者是用户显式
   指定，语义等同；若指向版本管理目录属用户自选，与 OPENCODE_CONFIG
   可指向任意文件同风险面）；
   当胜出的 MCP 条目来自 project 文件或 .opencode 目录时，direct 模式
   照常工作（收割结果驻留本进程内存），但不落盘，并经 onError 一次性提示
   "auth 节点仅写入用户级配置；如需持久化请将 MCP 条目移至全局配置"。
   理由：project 配置常被版本管理（本仓库 .opencode/ 即提交于 git），
   收割出的会话 cookie 属高价值凭据，写入可提交文件与用户"全局分发"
   心智模型冲突；用户真实部署（全局 ~/.config/opencode/opencode.json）
   不受影响。

   直连空文本语义（R2 钉定，N-05）：200 + text:"" 是端点对静音的合法
   结果（页面路径合同，chatgpt-dom.js:820-828），transcribeDirect 返回 ""；
   controller 既有 `if (text.trim())` 分支自然吞空（prompt-voice-input.ts:101）。
   argv 路径的空文本报错保持不变（其 JSON stdout 协议不同域）。

   超时组合（R4 修正算术，N-02(R3)：direct 阶段最坏 = 初始 ensure
   （刷新 60s 失败进收割 240s = 300s）+ POST 30s + 401 重走 b/c
   （同理 ≤300s）+ 重试 POST 30s = ≤660s（~11 分钟）；随后回退 argv
   spawn 获得独立的 VOICE_TRANSCRIBE_TIMEOUT_MS 新信号（与现有"每次
   Process.run 独立超时"架构一致）；用户取消（controller AbortSignal）
   全程穿透两阶段。
            2. transcribeDirect(file, credential)
                 POST /backend-api/transcribe（NetworkProxy.fetch
                 purpose "provider"，30s 超时）
                 multipart 仅 file 字段；headers: Bearer、oai-device-id
                 （oai-did cookie 值，缺失则省略）、oai-language:"en-US"
                 200 {text}（含空串）→ 返回
                 401 → forceRefresh 一次（跳过 a 的缓存判定，重走 b/c）→
                 重试一次 POST → 仍失败 throw

   请求形态实施裁量（R2 钉定，N-03）：初始形态为上表（file-only + Bearer +
   oai-device-id + oai-language 的合成，源自页面路径与 EchoPaper 双证源）。
   slice 12 真实网络结果为权威：若 4xx，允许且仅允许在两证源已观察到的
   字段/头集合内调整（补 dictation_session_id/attempt_id/duration_ms/
   language 字段、补 cookie header、调整 UA/origin/referer），调整必须
   记录进实施证据；不得引入第三种未证实的请求算法。
            3. 直连失败（非用户取消）→ argv 回退：spawn direct.transcriber
               （与旧推导完全一致的 transcribe-file argv），走现有 daemon/
               浏览器页面路径 → 成功则返回 {text}
       -> parseTranscriberOutput -> insertText
```

数据形态：

- `VoiceTranscriberDirect`（prompt-voice-input.ts 导出类型）：
  `{ type: "chatgpt-direct", config: <opencode.json 绝对路径>, key: <mcp 键名>, interpreter: <node 或 MCP argv[0]>, script: <chatgpt.js 绝对路径>, scope: "user" | "project", transcriber: { command, args } }`（`transcriber` 即现有推导公式产出的 argv，供回退；`scope` 见 §10 判定规则）。
- auth 节点（opencode.json `mcp.<key>.auth`）：
  `{ "access_token": string, "token_expires_at": number, "fetched_at": string, "cookies": Record<string, { "value": string, "expires": number }> }`（expires 为 epoch 秒；会话 cookie 记 0）。
- agent 导出 JSON（CLI stdout / daemon 响应）：
  `{ ok, authStatus, accessToken, cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite}], fetchedAt }`；token/cookie 永不写 daemon 日志。
- daemon `POST /auth/export`：bearer 鉴权同现有端点；处理链 `runtime.withSubmission(() => runtime.voiceLease())` → `page.evaluate`（bootstrap authStatus + accessToken）→ `page.createCDPSession()` → `Network.getCookies {urls:[CHATGPT_URL]}` → detach → release；`authStatus !== 'logged_in'` → 400 `{ok:false, code:'AUTH_EXPORT_LOGIN_REQUIRED'}`。
- CLI `chatgpt.js auth-export [--json]`：复用 transcribe-file 的 ensureDaemon/重试循环形态（`voiceErrorIsRetryable` 封闭集合，4 attempts，1/2/4s 退避），无 WAV 校验；`--json` 输出完整 JSON（opencode 消费），默认输出不含凭据的人类摘要（authStatus、cookie 数、token 过期时间）。

该路线修复 first divergence 的原因：推导层产出 direct 变体使凭据成为 opencode 可持有的一等数据；voice-auth 补上生命周期与直连请求；agent 补上导出面。三处均为缺失 seam 的新 owner，不在旧路径上打补丁。

回退授权（用户批准，精确引用见第 1 节）：
- 路径：direct 失败 → argv `transcribe-file`（浏览器页面路径）。
- 触发条件：直连在"401 刷新重试后仍失败 / 403 / transport / 收割失败"且非用户取消。
- 语义差异：回退路径较慢（可能冷启动 daemon/浏览器），结果等价（同端点转写文本）。
- 可观测性：回退发生时经现有 `onError`/日志可见（不额外造 UI）。
- 移除/重议条件：无（Alt+V 永远可用是用户产品要求）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| argv spawn 转写（显式配置/兜底 CLI） | current | primary-contract branch（argv 变体域） | yes | 既有，不变 | preserve |
| direct→argv 回退 | proposed | explicit user-requested fallback（第 1 节引用） | yes | 回退编排 ≈ direct 分支内 1 个 catch 分支 | preserve（用户批准） |
| 401→forceRefresh→重试一次 | proposed | orchestration retry（policy 默认 owner：编排模块） | yes（同一路径重试） | 1 个分支 | preserve |
| 收割失败→throw→回退 | proposed | primary-contract error 分支（诊断性失败上抛后由用户批准回退承接） | no（自身不产成功） | 1 个分支 | preserve |
| `OPENCODE_CONFIG_CONTENT` 无文件源→argv 推导 | current（扩展保留） | supported-domain branch（配置源域） | yes | 既有分支，不变 | preserve |
| token 刷新 set-cookie 捕获 | proposed | 生命周期合同分支（cookies 须保持新鲜供下次刷新） | no（旁路更新） | 1 个分支 | preserve |
| 旧 daemon 404 /auth/export | reachable 环境态 | 诊断路径（明确报错→收割失败→回退） | no | 0 新分支（错误映射内） | preserve |
| 无 | — | forbidden fallback | — | — | 无候选（已逐条排除） |

新决策面估计（R3 修正，N-01(R2)）：direct 相关新增分支约 18 个（变体判定、状态机分支、收割 spawn 成败、直连 200/401/其它、回退 catch、set-cookie 捕获、写回降级、写回范围判定、空文本返回），其中失败转移（收割失败、刷新失败、直连 40x/transport、写回失败）为 primary-contract error outcomes（凭据生命周期合同的组成部分，各自上抛后由唯一用户批准回退承接成功语义）；两个一次性用户通知（project 来源不落盘提示、写回失败降级提示）是各自错误/降级 outcome 的用户可见 payload（错误传播与产品披露），不是独立的诊断路径；诊断类（纯观测记录/度量）新增为 0，10% 诊断预算占用为 0。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| MCP 推导产出的 argv 默认转写器（`node <dir>/chatgpt.js transcribe-file …`） | 无直连能力时唯一的 MCP 复用方式 | direct 变体内嵌同一 argv 作为回退数据；推导不再单独产出裸 argv（`OPENCODE_CONFIG_CONTENT` 分支保留裸 argv 形态，因其无写回目标，属配置源域合法分支） | tui.ts `voiceTranscriberFromMcpConfig` 重写为产出 direct 变体（内嵌 argv），无死代码残留 |
| （无其它既有 workaround——本任务不删除生产代码，仅替换推导函数的实现形态） | — | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| 需求：凭据内嵌 mcp.<key>.auth | direct 变体推导 + voice-auth 读写 | tui.ts；voice-auth.ts（新） | voice-auth.test.ts：读/写/保注释/原子；推导测试：MCP 条目→direct 变体 |
| 需求：懒收割（无平常浏览器启动） | ensureVoiceCredential 状态机 | voice-auth.ts | voice-auth.test.ts：token 有效→零网络零 spawn；失效才 spawn |
| 需求：主动预警（临期收割） | token margin 6h + cookie expires 驱动状态机进入收割 | voice-auth.ts | voice-auth.test.ts：过期 token+活 cookie→刷新；死 cookie→收割 |
| 需求：直连请求用缓存凭据 | transcribeDirect | voice-auth.ts | voice-auth.test.ts：注入 fetch 的 200/401/403 用例 |
| 需求/INV-01：Alt+V 永远可用（回退） | transcribeVoiceFile direct 分支 catch→argv | prompt-voice-input.ts | prompt-voice-input.test.ts：direct 失败→argv 成功；direct 成功→argv 不被调用 |
| INV-02：显式配置优先 | tui.ts 合并顺序不变 | tui.ts（不变区） | 推导测试：显式 transcriber 存在时不推导 direct |
| INV-03：写入方唯一/保真/原子 | writeVoiceAuth（jsonc modify+applyEdits、tmp+rename、Windows rename 冲突处理沿用 recorder 先例） | voice-auth.ts | voice-auth.test.ts：注释保留、兄弟字段不动、rename 冲突可恢复 |
| INV-04：浏览器不为刷新而启 | 收割仅由真实请求触发；无定时器 | voice-auth.ts + 无新增调度代码 | 结构性：无定时器代码 + 触发时机用例 |
| INV-05：凭据不外泄 | 错误消息/日志脱敏（错误只含状态码与分类）；argv 无凭据 | voice-auth.ts、chatgpt-core.js、chatgpt.js | 断言错误消息不含 token/cookie 值；spawn argv 断言只有 --json |
| INV-06：argv 协议不变 | argv 分支代码不动 | prompt-voice-input.ts（不动区） | 既有用例原样通过 |
| INV-07：请求形态与重试合同 | transcribeDirect 实现细节 | voice-auth.ts | 注入 fetch 断言请求形态（multipart file、Bearer、oai-device-id） |
| INV-08：auth 节点不破坏加载 | 依赖 parse/mcp.ts 既有容忍 + 新用例验证 | 无生产改动（验证性） | voice-auth.test.ts：含 auth 节点的完整 opencode.json 经 ConfigParse/MCP schema 正常解析 |
| INV-09：daemon 所有权不变 | /auth/export 复用 withSubmission+voiceLease | chatgpt-core.js | test-mcp.js：假 runtime harness 下 /auth/export 与 voice 转写串行（lease 断言） |
| 需求：agent 可导出 | CLI 子命令 + daemon 端点 | chatgpt.js、chatgpt-core.js | test-mcp.js：logged_in→200 slim cookies；logged-out→400 code；CLI stub-daemon 输出 JSON |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `VoiceTranscriberDirect` 变体类型 | 需求（MCP 旁存储/直连） | 第 5 节：现有类型只有 argv 形态 | argv 无法表达 config/key/收割路径 |
| `voice-auth.ts` 新模块（read/write/ensure/transcribeDirect） | 需求 + INV-03/04/05/07 | 无任何模块持有离线凭据或直连请求 | 全新 owner（第 8 节） |
| jsonc modify/applyEdits 写回 | INV-03 | 先例：`addMcpToConfig`（src/cli/cmd/mcp.ts:417-432）已用 modify+applyEdits 注释保真写 opencode.json | 复用既有模式并补齐原子性（tmp+rename，先例缺失）；写 `mcp.<key>.auth` 路径与 `mcp add` 写 `mcp.<name>` 路径不同，两个写入方可组合 |
| `NetworkProxy.fetch(purpose:"provider")` | INV-07 + CONTEXT.md NetworkProxy 词条 | packages/core/src/network-proxy.ts 公共 seam | 全局 fetch 无代理路由；用户网络需代理可达 chatgpt.com |
| 模块级 in-flight 去重 | 第 6 节并发行 | 三个 controller 可并发触发 | 无既有凭据并发控制 |
| 会话凭据 cookie 前缀常量（`__Secure-next-auth.session-token` 族，R3） | 需求（"一两天"预警收割） | 刷新授权链只由该 cookie 族承载（EchoPaper 刷新实践；缺失 fail-safe 走收割） | 其它 cookie 无授权语义，不可作为状态机输入 |
| `COOKIE_HARVEST_MARGIN_S`(48h)（R3） | 需求（用户"还有一两天"原话） | 用户语义直接指定 | 无既有常量；token 6h margin 不覆盖 cookie 维度 |
| `VoiceTranscriberDirect.scope` 字段（R3） | N-02(R1) 写回范围决策 | project 配置受版本管理（本仓库 .opencode/ 提交于 git） | 推导时来源已知，写入方无重复判定 |
| daemon `POST /auth/export` | 需求（收割源） | daemon 是浏览器/CDP 唯一持有者 | opencode 不得建立第二套 CDP 所有权 |
| CLI `auth-export` 子命令 | 需求（收割执行） | transcribe-file 先例（chatgpt.js:832-866） | daemon HTTP 不便被 TUI 直接调用（token/port 发现逻辑在 CLI） |
| 240s 收割超时常量 | 需求（daemon 冷启动含登录等待） | CHATGPT_DAEMON_START_TIMEOUT 派生（README:83） | 转写 30s 超时不含 daemon 启动预算 |
| 30s 直连超时常量 | INV-07 | 直连正常路径秒级（chatgpt.js:57 注释；EchoPaper 实测） | 全局 20min 预算会让直连 hang 拖垮体验 |
| token margin 6h | 需求（预警收割） | EchoPaper token_margin_s=6*3600 生产实证 | 无既有常量 |
| `AUTH_EXPORT_LOGIN_REQUIRED` 错误码 | INV-05/可诊断性 | transcribe-file VOICE_* 错误码先例 | 通用 500 外壳会误入重试集合（voiceErrorIsRetryable 注释） |
| direct 变体内嵌 fallback argv | INV-01（用户批准回退） | 旧推导公式 | 回退需 argv 数据；不内嵌则推导处需二次查询 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/voice-auth.ts` | add | auth 节点读/写（jsonc 保真+原子，镜像 addMcpToConfig 模式）、ensureVoiceCredential 状态机（含 in-flight 去重、写回范围判定）、transcribeDirect（含 401 刷新重试、空文本合法）、常量（margin/48h cookie margin/超时/端点）；`export * as VoiceAuth from "./voice-auth"` | +~380（含中文注释） |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | modify | `VoiceTranscriber` 改为 union（argv \| chatgpt-direct，导出 direct 类型）；`transcribeVoiceFile` 增加 direct 分支（ensure→direct→回退 argv）；`validateVoiceTranscriber` 增加 direct 校验（interpreter+script 存在）；`voiceHintVisible` 签名放宽 | +~135 / -~30 |
| `packages/opencode/src/cli/cmd/tui/config/tui.ts` | modify | `voiceTranscriberFromMcpConfig` 产出 direct 变体（接收 filepath + 来源 scope，project 来源仍可推导 direct 但标记不可写回）；`loadMcpVoiceTranscriberFile` script 存在检查适配 direct.script；Resolved.voice.transcriber 类型放宽 | +~80 / -~25 |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js` | modify | `POST /auth/export` 端点（bearer 鉴权、withSubmission+voiceLease、bootstrap evaluate、CDP getCookies、错误码）；导出 testing helper（如需） | +~95 |
| `thirdparty/chatgpt-browser-agent/chatgpt.js` | modify | `auth-export [--json]` 子命令（parseArgs、dispatch、ensureDaemon 重试循环、JSON/摘要输出、help 行） | +~85 |
| `packages/opencode/test/cli/tui/voice-auth.test.ts` | add（测试） | 第 16 节 slice 1-8、16-18 | +~500 |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | modify（测试） | slice 9-12 + 跨平台 direct E2E（门禁） | +~220 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify（测试） | slice 13-15 | +~160 |

生产文件 5 个（≤8），生产行数估计 ~700（≤1600）。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `transcribeVoiceFile` 接受 direct 变体并回退 argv：direct 注入失败 fetch 后仍返回 argv 转写器文本 | 类型不存在；运行时 direct 无分支 | direct 分支：ensure→direct 失败→spawn 内嵌 argv（假 script 输出 JSON） | INV-01 |
| 2 | direct 成功时 argv 不被调用（marker 文件缺失断言） | 同上 | ensure→direct 200→返回 | INV-01 |
| 3 | `writeVoiceAuth` 保注释定点替换 + 原子落盘 + 兄弟字段不动 | 模块不存在 | tmpdir 带注释 jsonc → auth 替换、注释/其它字段逐字保留；rename 冲突可恢复 | INV-03 |
| 4 | `ensureVoiceCredential`：token 有效 → 零网络零 spawn | 模块不存在 | 注入 deps spy 全部零调用 | INV-04 |
| 5 | `ensureVoiceCredential`：token 过期+cookies → session 刷新 + set-cookie 捕获 + 写回 | 模块不存在 | 注入 fetchSession 假实现（新 token + set-cookie）→ 文件更新 | 需求（预警收割） |
| 6 | `ensureVoiceCredential`：无凭据/刷新 401 → spawn 收割（假 interpreter/script 打印 JSON）→ 写回；并发调用去重为一次 spawn | 模块不存在 | 假 CLI 计数=1；auth 节点生成 | INV-04 + 并发 |
| 7 | `ensureVoiceCredential`：收割失败（退出码≠0）→ throw AuthUnavailable（消息无凭据） | 模块不存在 | 错误分类断言 | INV-05 |
| 8 | `transcribeDirect`：请求形态断言（multipart file、Bearer、oai-device-id）；401→刷新→重试成功；403→throw | 模块不存在 | 注入 fetch 假实现逐项断言 | INV-07 |
| 9 | `validateTranscriber`（direct）：script 缺失 → 录音前明确报错 | 无 direct 校验 | 预检分支 | 既有 chatgpt.js 校验语义扩展 |
| 10 | tui 推导：MCP chatgpt 条目 → direct 变体（config/key/script/argv 齐全）；显式 transcriber 优先；OPENCODE_CONFIG_CONTENT → argv 形态 | 推导只产 argv | 经真实 TuiConfig 服务（`OPENCODE_CONFIG` 指向 tmp 文件）或 testing 导出驱动（若 Flag env 捕获时机不可测则用后者并记录原因） | INV-02 |
| 11 | 含 auth 节点的 opencode.json 不破坏 ConfigParse/MCP schema 解析 | 新字段（验证性） | 解析成功且 mcp 条目等价 | INV-08 |
| 12 | （门禁 E2E）direct 全链路：真实 profile 收割→直连转写 test-voice-hello.wav→"hello"/"world" markers | 新能力 | `CHATGPT_VOICE_E2E=1` 用例（跨平台，无需 darwin 音频工具） | 需求终态 |
| 13 | agent：假 runtime harness 下 `/auth/export` logged_in → 200 slim cookies；与 voice lease 串行 | 端点不存在 | test-mcp.js 新用例 | INV-09 |
| 14 | agent：`/auth/export` logged-out → 400 `AUTH_EXPORT_LOGIN_REQUIRED`（不进重试集合） | 同上 | 同上 | 可诊断性 |
| 15 | agent：CLI `auth-export --json` 经 stub daemon 输出完整 JSON；默认输出不含凭据 | 子命令不存在 | test-mcp.js stub-daemon 模式 | INV-05 |
| 16 | `ensureVoiceCredential`：token 过期且会话凭据 cookie 临近死亡（≤48h，附短 TTL `__cf_bm` 存在于 jar）→ 跳过刷新直接收割（刷新假实现断言零调用）；对照：会话凭据健康（90d）且 `__cf_bm` 短 TTL → 刷新被调用（锁定谓词只看会话凭据，B-01） | 谓词未定义/矛盾 | 状态机分支 + 常量断言 + 双向 fixture | 需求（"一两天"预警收割，不误杀刷新） |
| 17 | `transcribeDirect`：200 + text:"" → 返回 ""（不抛错） | 语义未钉定 | 空文本合法分支 | N-05 决策 |
| 18 | 写回范围：胜出 MCP 条目来自 project 文件 → 收割结果不落盘、内存可用、onError 一次性提示；全局来源 → 正常写回 | 决策未钉定 | scope 分支 + 提示文案断言（不含凭据） | N-02 决策 + INV-05 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~700 | 5 个生产文件新增+实质修改行（排除 import、空行、纯移动） |
| Required Chinese explanatory comments `C` | ≥ 105（ceil(700×0.15)） | 分布于修改点邻近 |

需中文注释的承载点（非穷举，实施时按此意图落位）：
- direct 变体为何内嵌 fallback argv（用户批准回退；避免推导二次查询）。
- auth 节点形状常量与 expires=0 语义（会话 cookie）；token margin 6h 的实证来源。
- jsonc modify 只动 auth 路径的合同（注释保真、用户手写内容不可破坏）；tmp+rename 原子性与 Windows rename 冲突处理沿用 recorder 先例；与 `opencode mcp add` 的组合关系（后者整体替换 `mcp.<name>` 会移除 auth 子节点——用户主动重注册语义，writeVoiceAuth 邻近需提示）。
- 写回范围判定（用户级可写 / project 仅内存）与泄漏边界理由。
- 会话凭据 cookie 48h 临期谓词（只看 `__Secure-next-auth.session-token` 族，
  不受 `__cf_bm` 等短 TTL cookie 干扰）与 token 6h margin 的来源
  （用户"一两天"语义 / EchoPaper 实证）。
- 收割 240s 预算推导（daemon 冷启动+登录等待）；killTree:false 的浏览器独立生命周期理由。
- 30s 直连超时与 20min 全局预算的分层关系。
- in-flight 去重防多 Prompt 并发重复收割。
- 凭据脱敏边界（错误消息/日志/argv 三处禁入）。
- agent 侧：/auth/export 复用 withSubmission+voiceLease 的所有权理由；token 不落 daemon log；`AUTH_EXPORT_LOGIN_REQUIRED` 不入重试集合的理由（对应 voiceErrorIsRetryable 注释先例）。
- 测试：各 slice 的行为意图（对齐既有测试文件注释风格）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun typecheck` | `packages/opencode` | 类型门禁（union 变更不破坏消费者） |
| `bun test test/cli/tui/prompt-voice-input.test.ts` | `packages/opencode` | slice 1/2/9 + 既有 argv/controller 回归 + darwin E2E 门禁保持 skip |
| `bun test test/cli/tui/voice-auth.test.ts` | `packages/opencode` | slice 3-8/10/11 |
| `bun test test/cli/tui/` | `packages/opencode` | TUI 邻域无回归（含 recorder/attention 等） |
| `npm run test:syntax` | `thirdparty/chatgpt-browser-agent` | agent 语法门禁 |
| `npm test`（= syntax + deps + test:mcp） | `thirdparty/chatgpt-browser-agent` | slice 13-15 + agent 既有全量 |
| 手动 E2E：`CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "direct"` | `packages/opencode` | slice 12（真实网络；记录直连是否 403——第 20 节 R1 实测项） |
| 手动 E2E（darwin）：既有五分钟用例 | `packages/opencode` | argv 浏览器路径回归 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1（voice-auth.ts） | 新 owner 模块 |
| Files modified | 4（prompt-voice-input.ts、tui.ts、chatgpt.js、chatgpt-core.js） | 既有 seam 扩展 |
| Files deleted | 0 | 无删除对象 |
| Production lines | ~700（≤1600） | 第 15 节逐文件估计 |
| Test lines | ~880 | 3 个测试文件 |
| Generated lines | 0 | 无 |

## 20. Real Risks and Open Decisions

### Real Risks

- **R1 Cloudflare/TLS 指纹（reachable）**：EchoPaper 直连必须 curl_cffi chrome136 伪装；Bun fetch 指纹未验证。Mitigation：用户批准的 argv 回退保证 INV-01；slice 12 E2E 会在用户机器实测并记录。若持续 403，最终行为=回退路径（与现状等价，无红测），直连收益待后续 revision 决策（如需集成 curl-impersonate 须新 plan）。
- **R2 /api/auth/session Set-Cookie 形态未知（reachable）**：NextAuth 常见轮换但未在本仓库实测。设计为机会性捕获（存在则更新），无硬依赖；cookie 真实寿命由 slice 12 观测。
- **R3 Windows rename 冲突（reachable）**：AV/并发可致 EPERM。沿用 `ensureExtractedNativeFile` 的冲突复用模式；写失败降级内存态并提示一次，不阻断转写。
- **R4 推导测试的 Flag env 捕获时机（reachable）**：`OPENCODE_CONFIG` 若在模块加载时捕获则进程内不可变。计划 A：真实 TuiConfig 服务 + env；计划 B（A 不可行时，记录原因）：tui.ts 导出 `testing` 对象（agent 仓库先例）供推导单测。实施时择一，不并存。
- **R5 双进程并发写 auth 节点（reachable）**：last-writer-wins；凭据等价（同源收割），无害；jsonc modify 定点保证不破坏兄弟字段。

### Open Decisions Requiring the User

无——存储位置、懒收割、回退、文件/行数预算均已由用户逐字批准。R1 若实测 403 持续，"是否引入 TLS 伪装集成"是新的开放决定，届时单独提交用户。

### Rejected Speculation

- "Cloudflare 绑出口 IP 导致 headless 分发失效"：分发是用户手工行为，无本任务内 producer/consumer 链；仅作非阻塞备忘（直连与刷新均经 NetworkProxy 代理路由，用户环境已有固定出口实践）。
- "cookie 实际寿命约 30 天"：环境实测项，不驱动生产逻辑（状态机由 expires 字段与 401 事实驱动，不依赖该估算）。
- "auth 节点需防其它进程篡改"：本地同用户威胁模型下与 opencode.json 既有 apiKey 等价（用户第 2 轮论证批准），不加额外防护。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback authorization, ownership, tests, code
  quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 无（No blocking findings） | N-01 证据勘误（mcp.ts addMcpToConfig 写入先例存在）；N-02 写回范围决策未记录；N-03 请求形态为双证源合成未整体实证；N-04 超时组合未说明；N-05 空文本语义未钉定；N-06 cookie 临期谓词未钉定；N-07 §11 错误转移误标为诊断面 | APPROVE（No blocking findings for revision R1 at full scope） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R1 verdict 原文（关键段，未改写）："APPROVE — no blocking findings for revision R1 at full scope. Approval covers exactly this revision; N-01/N-02 should be folded in (each is an evidence-record/decision fix; N-02's write-scope decision must be recorded) — folding them in is a substantive edit requiring revision R2 and re-audit per policy, or they may be carried as recorded non-blocking notes into implementation as-is."

处置：选择折叠为实质修订 R2（本修订），已钉定 N-02 写回范围决策（§10）、N-04 超时组合（§10）、N-05 空文本语义（§10 + slice 17）、N-06 cookie 谓词（§10 + slice 16）、N-01 证据勘误（§4/§14/§17）、N-03 实施裁量边界（§10）、N-07 重分类（§11）；按 policy 清空 approval 并全量重审。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | R2 | yes | B-01：cookie 临期谓词内部矛盾（§10 b 行 ∃-healthy 与谓词定义行 ∀-healthy 两套状态机；∀ 解读下 `__cf_bm` 等短 TTL cookie 会永久禁用刷新阶段，使已批准的 401 刷新重试沦为死分支并退化为每次收割） | N-01(R2)：§11 "0 观测输出"与两个一次性通知矛盾；N-02(R2)：direct 阶段最坏算术漏计 401 重走 b/c；N-03(R2)：VoiceTranscriberDirect 形状缺 scope 字段；N-04(R2)：R1 遗留项均已解决 | BLOCKED（修订 R3 后全量重审） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R2 verdict 原文（关键段，未改写）："Blocker — revision R2, round 2 of 6. B-01 requires an unambiguous, scoped predicate revision (R3) followed by the next full-scope audit. All other R2 changes cleanly resolved the R1 findings; N-01..N-03 are record corrections that do not block approval."

处置：B-01 确属本修订引入的规格缺陷且在用户需求范围（懒收割状态机）内，直接修订 R3：谓词改为只作用于会话凭据 cookie（`__Secure-next-auth.session-token` 族，含缺失 fail-safe 视为已死），其它 cookie 不参与门控；slice 16 改双向 fixture（短 TTL `__cf_bm` 存在时不误杀刷新）；同时折叠 N-01(R2)（§11 通知计入与分类）、N-02(R2)（§10 最坏 ≤600s 算术）、N-03(R2)（VoiceTranscriberDirect 增加 scope 字段 + §10 判定规则）。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | R3 | yes | 无（No blocking findings） | N-01(R3)：OPENCODE_CONFIG_DIR 在 §10 两句中归类矛盾（scope 规则归 user、写回枚举未含）；N-02(R3)：最坏算术残留（初始刷新失败+收割路径漏计，真实 ≤660s）；N-03(R3)：§14 未为 R3 新概念（会话凭据前缀常量、COOKIE_HARVEST_MARGIN_S、scope 字段）补行；slice 16 有错别字 | APPROVE（No blocking findings for revision R3 at full scope） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R3 verdict 原文（关键段，未改写）："Approve — no blocking findings for revision R3 at full scope (round 3 of 6). Approval covers exactly revision R3: status approved, approved revision R3, implementation allowed. N-01(R3) is the only note affecting future behavior — it should be either recorded and resolved conservatively by the implementer, or folded into an R4 requiring re-audit; N-02/N-03 are record corrections that may be carried as-is."

处置：折叠为 R4（消除 OPENCODE_CONFIG_DIR 归类歧义——统一归 user 级：它是用户显式指定的配置目录环境变量，语义等同 OPENCODE_CONFIG；若用户将其指向版本管理目录属其自选，与 OPENCODE_CONFIG 指向任意文件同风险面）、修正 ≤660s 算术、补 §14 三行、改错别字；按 policy 实质修订清空 approval 并全量重审。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | R4 | yes | 无（No blocking findings） | 无（R3 全部遗留项已解决；仅一条不需行动的记录风格备注：§14 scope 行引用了审计发现号而非需求条款号） | APPROVE（No blocking findings for revision R4 at full scope） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R4 verdict 原文（关键段，未改写）："Approve — no blocking findings for revision R4 at full scope (round 4 of 6). Approval covers exactly revision R4: once recorded, status approved, approved revision R4, implementation allowed yes. Per policy, implementation must adhere to R4 verbatim; any substantive change requires R5 and a new full-scope audit."

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

生产文件（5 个，≤8；生产行 E=438 ≤1600）：

| File | Add/Modify | Δ
| --- | --- | --- |
| packages/opencode/src/cli/cmd/tui/util/voice-auth.ts | add | 新建 339 行（auth 节点读写/状态机/直连请求/常量） |
| packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts | modify | +94/−34（direct 类型与判别联合、direct 分支+回退、validate、notice 排水、transcribeArgv 提取） |
| packages/opencode/src/cli/cmd/tui/config/tui.ts | modify | +42/−24（direct 变体推导+scope、来源列表、Resolved.voice 类型） |
| thirdparty/chatgpt-browser-agent/chatgpt-core.js | modify | +62/−1（runAuthExport + POST /auth/export 路由 + testing 导出） |
| thirdparty/chatgpt-browser-agent/chatgpt.js | modify | +51/−3（auth-export 子命令：解析、dispatch 重试循环、JSON/摘要输出、help） |

测试文件：voice-auth.test.ts（新建，25 用例）、prompt-voice-input.test.ts（+direct 三件套+门禁 E2E）、test/config/tui.test.ts（4 个既有推导用例更新 + 新增 env-content 用例；实施期发现的既有测试文件，不在 R4 §15 清单内——非阻塞记录修正）、thirdparty/chatgpt-browser-agent/test-mcp.js（+auth-export 两用例 + withFakeDaemon authExport 路由）。

计划 §16 slice 10 的 testing 导出回退未被使用：实施证明既有 test/config/tui.test.ts 已提供真实 TuiConfig 服务层 seam（R4 首选路径），tui.ts 未新增 testing 导出。

### Red-Green Test Evidence

- voice-auth.test.ts：模块缺失红（Cannot find module）→ 实现后 25/25 绿。
- prompt-voice-input.test.ts：direct 三用例红（argv-only 路径 TypeError/断言失败）→ 实现后绿；既有 26 用例全绿。
- test-mcp.js：auth-export 两用例先红（端点/子命令不存在→stub 500/参数被当 prompt）→ 绿；fixture 传输问题排查见下。
- tui.test.ts：推导用例按新合同更新（旧断言在新推导下为红）→ 绿。

### Verification Commands and Results

| Command | Working dir | Result |
| --- | --- | --- |
| bun typecheck | packages/opencode | PASS |
| bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/config/tui.test.ts | packages/opencode | 93 pass / 0 fail（含 2 个门禁 E2E skip） |
| bun test test/cli/tui/ | packages/opencode | 248 pass / 4 fail——4 个失败均为 daemon.test.ts 生命周期用例；干净 HEAD worktree 基线复跑同样 4 失败（预存环境红测，与本任务无关，证据：git worktree HEAD 基线 427s 运行） |
| npm test（syntax+deps+mcp 69 用例） | thirdparty/chatgpt-browser-agent | 69/69 PASS（一次中途失败 testVoiceStartupSkipsProject 为本机 `node -e` spawnSync EPERM 间歇性问题，重跑通过；已两次观测，与本任务代码无关） |
| node test-mcp.js testAuthExportExportsLoggedInSession testAuthExportCliAgainstFakeDaemon | thirdparty/chatgpt-browser-agent | PASS |

### Original Feedback-Loop Result

Feature 任务：每个 slice 的红→绿即反馈回路（见 Red-Green）。门禁 E2E（slice 12）已编写，运行需 CHATGPT_VOICE_E2E=1 + CHATGPT_BROWSER_USER_DATA_DIR=<已登录 profile>（手动门禁，命令见 §18）。

### Actual Secondary and Replacement Path Inventory

| Path | Classification（R4 §11 批准） | Actual |
| --- | --- | --- |
| direct→argv 回退（transcribeVoiceFile catch） | explicit user-requested fallback | 实现于 prompt-voice-input.ts direct 分支；取消信号优先上抛 |
| 401→forceRefresh→重试一次 | orchestration retry | 实现于 transcribeDirect |
| 刷新失败→收割 / 收割失败→上抛→回退 | primary-contract error outcomes | 实现于 ensureVoiceCredential / transcribeVoiceFile |
| set-cookie 捕获 | 生命周期合同分支 | 实现于 defaultFetchSession + mergeSetCookieCookies |
| OPENCODE_CONFIG_CONTENT→argv 推导 | supported-domain branch | 实现于 voiceTranscriberFromMcpConfig（无 filepath 分支） |
| project 作用域→仅内存+一次性提示 | R2 钉定决策 | 实现于 persistCredential + takeVoiceAuthNotice（controller 排水） |
| 写回失败→内存降级+一次性提示 | primary-contract error outcome | 实现于 persistCredential catch |
| 未计划路径 | — | 无（未新增任何回退算法/开关） |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 1037 | 新文件非空非 import 非注释行 + diff 新增同类行；排除 25 行纯移动（transcribeArgv 提取）、import、空行、注释 |
| Qualifying Chinese comment lines `C` | 157 | 逐行统计 `//`/`/*` 开头且含中文且解释不变量/边界/意图的行（voice-auth.ts 36、pvi+tui.ts 20、agent 18、voice-auth.test 43、pvi+tui.test 24、test-mcp 16——含新增 3 行在最后一轮补入后总数 157） |
| Ratio `C / E` | 15.1% | — |
| Required minimum `C` | ceil(1037×0.15)=156 | 通过 |

代表性注释：会话凭据谓词只看 `__Secure-next-auth.session-token` 族（B-01 回归锁）；direct 变体内嵌回退 argv 的用户批准语义；jsonc 定点写与 `mcp add` 的组合关系；收割 240s/刷新 60s/直连 30s 预算分层；argv 无凭据（INV-05）；voice 锁串行（INV-09）；`AUTH_EXPORT_LOGIN_REQUIRED` 不入重试集合。

### Remaining Unverified Items

1. ~~门禁 direct E2E（slice 12）未在本环境运行~~ **已由用户授权的真实 E2E 实证解决（见 Live E2E Evidence）**；R1（TLS 指纹 403）在本机经系统代理未成立。测试文件内的门禁 E2E 用例仍保留（隔离 state 模式，供无运行中 daemon 的环境使用）。
2. daemon.test.ts 4 个生命周期用例在本机失败：干净 HEAD 基线同样失败（预存环境问题，与本任务无关）。
3. 本机 `node -e` spawnSync 对长脚本间歇性 EPERM/0xC0000142：三次观测（两次命中本任务相关 fixture→其一改为文件模式 spawn，一次命中既有 testVoiceStartupSkipsProject；重跑均通过）；机器环境问题，非代码回归。
4. writeVoiceAuth 的 rename 冲突分支（等价复用）无法跨平台确定性触发：以 B-01 安全网测试（写回失败→内存降级+提示）覆盖其失败路径，冲突分支本身为代码审查覆盖。

### Live E2E Evidence（用户授权，2026-09-06）

用户显式授权真实端到端检测（默认 MCP 配置 + 凭据读取）。因用户 daemon 正在运行（默认 state dir，私有 profile 被锁），门禁 E2E 的隔离 state 模式不可用，改以生产代码路径探针等价验证：

```text
packages/opencode（临时探针，已删除）：ensureVoiceCredential(direct) → transcribeDirect(wav)
复用运行中 daemon（真实浏览器登录态）收割 → 临时 opencode.json 写回 → 真实直连 POST
[harvest-ok]  384ms  token=eyJhbGciOi... cookies=27 token_expires=+10h
[persisted]   auth node written back and readable
[direct-ok]  1270ms text="Hello world."  （无 403：Bun fetch 经 NetworkProxy/系统代理直连成功）
[markers]    PASS
```

结论：全链路（收割→写回→直连转写）真实环境可用；直连 1.27s 对比浏览器页面路径明显提速；R1 风险在本机未成立。首跑暴露两个真实环境事实：(1) 运行中的旧版 daemon 无 /auth/export 返回 404——版本混布回退链按设计工作（错误明确、无重试风暴）；(2) CDP Network.getCookies 真实返回 { cookies: [...] } 而非裸数组——见下节修复。

### Post-Verified Fix（Live E2E 发现的 CDP 形状 bug）

真实 CDP 返回 { cookies: [...] }，而 runAuthExport 原实现按裸数组 `.map`（假 CDP stub 返回裸数组掩盖了此点，实际 puppeteer-core 22.15.0 send 返回协议对象）。修复：chatgpt-core.js 解构 result.cookies 并加 fail-closed 形状守卫（AUTH_EXPORT_CDP_SHAPE，不入 CLI 重试集合）；test-mcp stub 改为协议形态 { cookies: [...] }。修复后：定向 auth-export 测试通过、agent 全量 69/69 通过、真实 E2E 探针全绿。

按用户指示：已将本 GOAL 的两处 commit（主仓库 b7b9667a8a、子模块 b5bd213）soft-reset 回 staged（reflog 证据：仅移除本 GOAL commit，他人 commit 完好在 HEAD），待本轮审计通过后连同 CDP 修复重新提交。

### Rework Record (Implementation Audit Round 1)

第 1 轮实现审计返回 Blocking B-01：writeVoiceAuth 的恢复分支 `rm(config)+rename` 可能在重试再败时永久制灭用户整份 opencode.json（含所有 provider apiKey）。返工：改为计划内合同——rename 冲突时重读目标 auth 节点，与欲写 token 等价则视为成功（prompt-voice-recorder sameFileContent 同款复用语义）；否则原样上抛由 persistCredential 降级内存态+一次性提示；新增 B-01 安全网测试（写回失败→降级）与跨文件通知污染修复（排空后断言）。同轮非阻塞项一并处理：N-01 残留 .tmp-authexp.wav 于第 2 轮审计后删除（第 1 轮返工时首次删除未生效）；N-03 会话凭据分块变体取族内最早过期（新增测试）；N-04 收割 stdout 非 JSON 时给出脱敏确定性错误。返工后：95/95 测试通过、typecheck 通过。验证命令同上表。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | B-01：writeVoiceAuth rm+rename 恢复分支在重试再败时可制灭用户整份 opencode.json（违反 INV-03/计划 R3 指定的 sameFileContent 复用模式） | N-01 残留 .tmp-authexp.wav；N02 tui.test.ts 文件清单偏差（已记录）；N-03 分块会话凭据只看首个成员；N-04 收割 stdout 非 JSON 时片段可入 toast；N-05 E/C 达标（原始 14.77%≥阻断线，含合理移动排除后 15.1% 达标） | BLOCKED（返工后全量重审） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R1 verdict 原文（关键段，未改写）："Blocker — B-01 (`writeVoiceAuth` destructive recovery branch) must be fixed to the plan-specified conflict-reuse/degrade contract, followed by a fresh full-scope implementation audit per policy (rounds remaining: 1 of 3). The leftover `.tmp-authexp.wav` should also be deleted during the B-01 fix; N-02..N-05 are documented items that do not block release."

处置：B-01 已按审计给出的计划内合同返工（等价复用/降级，绝不 rm 用户配置，新增安全网测试）；N-01 已删；N-03/N-04 已修；N-02 已记录。返工后全量重审（第 2 轮）。

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | R4 | yes | 无（No blocking findings） | N-01(R2)：残留 .tmp-authexp.wav 仍在且 §23 首次声明有误（绑定提交前条件：删除并纠正记录）；N-02(R2)：voice-auth.ts 一处注释错别字；N-03(R2)：E/C 复算通过（原始 164/1113=14.74%≥阻断线；含移动排除 15.07% 达标） | APPROVE（No blocking findings for the full original scope against approved plan R4，附带绑定提交前条件） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

（第 2 轮后：绑定条件履行，提交完成，GOAL 标记 complete；随后用户授权真实 E2E 发现 CDP 形状 bug，按用户指示撤回本 GOAL 两处 commit 回 staged 并修复，进入第 3 轮全量重审。）

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | R4+post-verified fix | yes | 无（No blocking findings） | N-01(R3)：主仓库 staged 子模块指针仍指向已被重置的修复前 commit b5bd213——绑定提交顺序条件（先提交子模块、重新 stage 指针、再提交主仓库）；N-02(R3)：E/C 终算通过（原始 166/1116=14.87%；含移动排除 15.21%） | APPROVE（No blocking findings for the full original scope against approved plan R4 incl. the post-verified fix，附带绑定提交程序条件） | task ses_f8a6ed719ffeRGPiDjSq4I8y6p |

R3 verdict 原文（关键段，未改写）："Approve — full original-scope implementation audit against approved plan R4 including the post-verified fix with no blocking findings (round 3 of 3). Release is subject to one binding procedural commit condition (N-01 R3): commit the agent submodule's staged changes first, re-stage the submodule pointer to that new commit in the opencode repository before committing the opencode repository — the currently staged pointer (b5bd213) predates the CDP fix and must not be released as-is. Once that condition is met, the implementation may be marked verified; the commit itself awaits the user's explicit request."

处置：按绑定顺序执行提交（子模块→重 stage 指针→主仓库）；提交后本表补记 commit id。

R2 verdict 原文（关键段，未改写）："Approve — full original-scope implementation audit against approved plan R4 with no blocking findings (round 2 of 3). Approval carries one binding pre-commit condition: delete thirdparty/chatgpt-browser-agent/.tmp-authexp.wav and correct the sentence about it in the Section 23 rework record (N-01 R2); the N-02 cosmetic typo may be fixed in the same pass. These are record/hygiene corrections, not design changes, so they do not invalidate the approval."

处置：.tmp-authexp.wav 已删除（Test-Path 验证 False）；§23 返工记录已纠正；N-02 错别字已修。均为记录/卫生修正，不改变设计。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

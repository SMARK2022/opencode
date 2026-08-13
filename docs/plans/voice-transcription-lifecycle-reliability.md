# Canonical Implementation Plan: Voice 转录生命周期与稳定性修复

> Status: verified
>
> Revision: R63
>
> Approved revision: R63
>
> Audit mode: implementation
>
> Requirement source: 原始 voice 生命周期需求，以及用户本轮关于孤儿浏览器、Unicode 日志偏移、about:blank、不强杀浏览器、错误自解决、冷启动和至少三次完整预算重试的补充要求
>
> Implementation allowed: no further material changes without revision or audit rework
>
> Last updated: 2026-08-14

本文件是本任务唯一的实现规格。`thirdparty/chatgpt-browser-agent/docs/voice-runtime-hardening-plan.md` 是上一轮已经落地的历史方案，不是本任务的canonical plan；本轮从当前仓库和当前日志重新建立证据。稳定性是主修复和主测试目标，取消只保留为已有生命周期的回归保护。R21至R24已把voice收敛为唯一bootstrap/Bearer direct路径。R26让`withSubmission`包围整个`submitAsk`与voice direct；实现审计发现旧压力harness五次命中completed replay。distinct prompt暴露的第4次existing-Session composer reset发生在全部voice结束后，属于独立generic ask缺陷，R31明确不修改production处理它。R31统一压力合同为六个并发调度的独立new Session ask，并按用户配置名称`MCP`解析Project；不得在代码、测试或plan命令中硬编码用户给出的conversation URL或Project token。R32至R33修复同一sidebar交互主路径。R34发现Project首页DOM早于`conversation/init`完成，但只覆盖live click且漏算诊断。R35把live sidebar click与cache/currentProject驱动的fresh `goto`统一到同一个Project-home network-convergence seam。R36由完整压力的新证据触发：cold Project的可信expander click与另页voice direct `Runtime.callFunctionOn`重叠时确定性不settle；因此首次Project single-flight必须进入已有submission transaction owner。R37按独立审计补足长语音验收：300秒有效WAV只在末端放置运行时合成的两个确定性语音marker，必须返回两个marker，不能再以任意非空文本证明完整处理。R38的复测发现R36只移动了Project任务，`runVoiceTranscribe`仍在queue外启动voice lease/preflight；当Project先入FIFO时，voice稳定性检查继续与Project click重叠，voice direct随后被队头Project阻塞并触达60秒deadline。R38只收敛这个既有queue owner，不延长deadline、不猜URL、不改变Session identity或增加fallback。R39由R38后的fresh `4 voice + 2 ask`复测触发：两次ask的`pageFor`/`newPage`已经正常完成，Project root/sidebar/可信expander也正常完成，但DOM adapter在选择请求的`MCP`之前，因页面上存在无关的重复Project名称`个人`直接抛出`PROJECT_AMBIGUOUS`。R39拟在DOM discovery按请求名称判歧义，独立审计指出这仍会在URL去重和Project ID解析前误拒绝同一身份的响应式重复表示，并复制现有policy/click owner。R40据此只删除通用discovery中的全局名称裁决：有URL候选继续由现有纯Project policy按不同身份判歧义；无href且即将按名称点击的row继续由现有DOM click路径判歧义。不新增target参数、第二套解析、fallback、重试、配置或URL猜测。

R63是本轮唯一current revision。它保留R62设计，并删除R62 plan audit发现的旧401-retire残留授权：local 401唯一合同是重新读取current discovery，身份已变化且新state通过`/ping + /status`时才允许既有下一attempt复用；身份未变/缺失/不可验证原样失败。任何local 401都不得调用`retireDaemon`、`/stop`、`unlinkDaemonFiles`或映射为`BROWSER_DISCONNECTED`。R62及更早revision、审计和实现记录均为不可篡改历史，不授权R63实施。

## 1. Verbatim Requirement

> 当前我发现了我们的chatgpt的voice转录机制出现了较大的问题，每次进行转录的时候页面都会先加载然后反复刷新几次进行转录，与此同时当前貌似转录流程也仍然极为卡顿，当前而言出现了很多次的转录失败问题，你可以自行检查log，请你自行独立完整完成相应的调研与检查，并进行多轮的负载、并发、高压、模拟用户在用完之后关闭浏览器并不清理环境稍等后继续调用、或者长语音的相关逻辑；当前经常观察到反复的错误，经常是一好一坏且浏览器反复刷新不知道js在干什么；因此请你完整准确检查逻辑链条，检查当前问题以及失败原因，我希望整体的项目保持自己维护生命周期不要以报错作为fallback，同时优化响应链路以及高负载、长时间（5分钟）间隔调用等问题。

本轮用户还明确指出：缓存理论上不应莫名消失，页面一直反复跳转，并且经常出现一次成功后后续失败的交替行为。

本轮最终Project约束：真实ask、最小overlap和完整压力统一设置`CHATGPT_PROJECT=MCP`，由既有cache-first/live discovery解析当前Project身份；live sidebar discovery必须先使真实侧栏进入可交互终态。用户给出的现有conversation只证明目标名称，conversation URL、conversation ID和Project token都不得硬编码。线上CI无需真实登录或Project E2E。

## 2. Explicit Non-Goals

- 不重写 Puppeteer/CDP、MCP 协议或 opencode TUI voice recorder。
- 不新增 Browser-use CLI、Direct CDP harness 或新的外部依赖。
- 不修改 ChatGPT ask 的 Session、pending、artifact、Project 身份语义；只允许修复本轮已观察到的新页面分配与Project click重叠，以及可信send已被远端接受却被10秒DOM窗口误记为lost的入口时序。
- 不把未知的ChatGPT DOM文案、未观察到的浏览器崩溃模式或未来API变化写成生产分支。
- 不强制接管正在运行且没有CDP入口的日常Edge Default profile；shared CDP仍须由用户显式配置，默认owned agent profile继续独立持久化。
- 不为测试伪造畸形认证输入、未来session schema或未观察到的浏览器状态；只覆盖本轮真实观察到的`client-bootstrap` logged-in/logged-out事实、guest composer误判和官方`SendIfAvailable` direct链。
- 不通过新增配置开关让用户自己选择“旧启动路径/新启动路径”。
- 不恢复UI听写、第二转录端点、Enter/DOM点击或不同上传算法。R56按用户明确要求把同一`transcribe-file`调用定义为一个最多四次尝试的direct事务；每次都重新经过同一个daemon/browser/page/direct主路径，不存在失败后改走另一种成功语义。
- 不把取消信号当作页面稳定、转录完成或浏览器健康的判断依据；取消只验证请求停止和资源清理，不替代稳定化检测。
- 不把“预上传阶段发现页面已过期”误判为本次voice必须失败：在没有音频POST副作用前，页面退役和一次有界续租属于同一primary page-acquisition lifecycle，不是错误fallback。
- 不新增direct响应解析算法；当前`response.text()`、JSON解析和`text`字段校验仍是完整body边界。HTTP/transport/page/browser失败只触发同一primary transaction的下一次尝试，不切换wire或构造成功。
- 不扫描、附加或关闭用户日常Edge。默认`STATE_DIR/profile`由daemon生命周期合同独占；显式CDP URL或WS endpoint继续使用shared-browser合同并只disconnect。显式`CHATGPT_BROWSER_USER_DATA_DIR`在未锁定时保留既有daemon受控launch/close，在已锁定且无endpoint时明确拒绝。
- 不通过`taskkill /F`、`SIGKILL`或Puppeteer child handle强制终止私有浏览器；正常停止和可连接的退化浏览器只用CDP `Browser.close`，关闭未在有界时间完成则断开控制并由下一次尝试重连。
- 不把登录过期、token消失、需要用户介入、确定性认证/响应契约拒绝、browser path/profile配置错误、WAV输入错误或其它非可恢复4xx重复四次；至少三次重试只适用于有稳定producer code的可恢复运行错误。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 项目术语；本任务只涉及TUI voice、外部browser daemon、Project和Session，不把它们混称为同一状态。 |
| `AGENTS.md` | 要求第三方测试在包目录运行、保留现有风格、避免无关重构和不必要抽象。 |
| `.opencode/policy/first-principles-engineering.md` | 要修复第一处分歧；禁止新增alternate success path、责任泄漏和无证据防御。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须完成证据、traceability、TDD、验证、审计和实现证据章节。 |
| `docs/adr/README.md`、`docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 本任务没有需要新增ADR的跨模块架构决策；当前ADR不改变browser-agent职责。 |
| `thirdparty/chatgpt-browser-agent/README.md` | 规定Edge/profile复用、shared CDP只disconnect、owned browser才可close，以及`CHATGPT_PROJECT`和voice相关边界。 |
| `packages/opencode/AGENTS.md` | 若验证TUI TypeScript，必须从`packages/opencode`运行Bun测试和typecheck；不能从仓库根目录运行测试。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js` | daemon启动、Project解析/缓存、runtime页面/锁、voice请求、浏览器断连、HTTP入口和清理。 | observed / reachable |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | Project sidebar/root导航、direct转录、UI听写路径、页面前台动作和response pulse。 | observed / reachable |
| `thirdparty/chatgpt-browser-agent/chatgpt.js` | `transcribe-file`入口、daemon启动/健康探活、voice HTTP调用和BROWSER_DISCONNECTED重试。 | observed / reachable |
| `thirdparty/chatgpt-browser-agent/chatgpt-project.js` | Project URL/ID身份策略；确认缓存只提供候选而不应替代网页验证。 | contracted / reachable |
| `thirdparty/chatgpt-browser-agent/mcp-server.js` | ask侧child取消、MCP并发上限和daemon保留策略，确认TUI voice不经过MCP schema。 | reachable |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | 当前Project、voice lifecycle、cancel、health、stale daemon和E2E测试seam。 | observed |
| `thirdparty/chatgpt-browser-agent/test-voice-robustness.js` | 真实voice cold start、daemon kill、快速连续调用反馈环。 | observed |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | TUI录音后通过AbortSignal取消外部转录、90秒上限、WAV清理和结果插入。 | contracted / reachable |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts` | 临时WAV路径、native录音生命周期、stop/abort和残留清理。 | contracted / reachable |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | 现有TUI controller、`transcribeVoiceFile`、AbortSignal、错误输出和录音清理行为seam；本轮用于长语音deadline回归。 | observed |
| `packages/opencode/src/cli/cmd/tui/config/tui.ts` | TUI如何从ChatGPT MCP配置推导`chatgpt.js transcribe-file`，确认配置路径。 | observed |
| `thirdparty/chatgpt-browser-agent/package.json` | 第三方项目的syntax、dependency和MCP测试命令。 | contracted |
| `thirdparty/chatgpt-browser-agent/README.md:61-110,125-180` | 环境变量、Edge/profile、Project cache、shared/owned browser和安全边界。 | contracted |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:20-26` | 证明历史上`MCP`确实被实时发现并成功启动。 | observed |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:113-118` | 证明direct HTTP失败后曾进入composer/dictation UI。 | observed |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:2387-2398,2425-2449,2518-2537` | 证明direct成功、fallback、client disconnect和任务未收敛交替发生。 | observed |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:2539-2546` | 本轮最小红反馈：启动时Project缓存验证/恢复失败，voice尚未开始。 | observed |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:2547-2555` | 历史上把`CHATGPT_PROJECT`临时改为一个已有缓存别名后，同一voice入口成功；该非目标Project只用于证明旧startup耦合，不进入当前验收。 | observed |
| `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/projects.json` | 当前没有`MCP` alias，但存在其它历史Project alias；缓存不是从未写入，当前真实ask仍必须按`MCP`名称走cache-first/live discovery。 | observed |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node test-voice-robustness.js` | 真实反馈环；失败输出为冷启动130秒超时，daemon日志给出具体Project恢复错误。 | observed |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node chatgpt.js transcribe-file --file /private/tmp/opencode/voice/test-hello.wav --json` | 单变量voice复测；voice不解析Project，输出`{"text":"Hello world."}`。 | observed |
| 严格TUI长链在用户完成登录后复测 | 默认owned daemon仍返回`session=200 authenticated=false`，专用profile窗口显示未登录；证明R10 wire/启动路径仍阻断真实链。 | observed |
| R11阶段专用profile Cookies元数据与普通Edge/CDP关闭重启对照 | 当时两段持久session cookie写入磁盘；普通Edge关闭并重启后DOM仍为已登录。该历史对照不替代R24当前profile事实。未读取或输出cookie值。 | observed / historical |
| 同一专用profile经默认Puppeteer daemon启动 | 旧token-based probe随后报告`authenticated=false`，但该probe没有读取DOM `isLoggedOut`，不能证明浏览器启动清除了profile；R13阶段cookie-only默认路径首个cold voice曾成功。 | observed / historical |
| 当前`/api/auth/session` page-context探测 | HTTP 200、JSON仅含`WARNING_BANNER`，没有`accessToken/access_token`；该旧endpoint不能充当当前token owner。 | observed |
| R11阶段同一已登录page对`/backend-api/transcribe`执行一次无Authorization、`credentials: include`短WAV请求 | 当时HTTP 200且完整JSON含`text`；这只证明一次cookie-only请求曾成功，不足以覆盖当前官方client和当前profile状态。 | observed / historical |
| 当前direct链在高频诊断后、完整五分钟冷却后各执行一次CLI请求 | 两次都返回`ChatGPT direct transcribe returned HTTP 429`，后者首个请求即失败；429不能再归因于短时高频窗口。 | observed |
| 当前页面实际DOM与bootstrap对照 | `composer=true`、存在登录按钮、旧guest文案正则不匹配，因此`heuristicLoggedOut=false`；同页`client-bootstrap.authStatus='logged_out'`、无session/access token。 | observed |
| 当前ChatGPT前端已加载bundle的transcribe实现 | FormData写`file`及可选`language/duration_ms`，调用`safePost('/transcribe', { authOption: SendIfAvailable })`；shared client将其解析到`https://chatgpt.com/backend-api`，`SendIfAvailable`从bootstrap session state取access token并在可用时加`Authorization: Bearer`。 | observed / current wire |
| 当前agent专用profile的浏览器cookie元数据 | 当前页面没有登录session credential，reload后的bootstrap明确logged out；只读取cookie名/属性，未读取或输出cookie值。 | observed |
| `/Users/sunbenteng/.config/opencode/opencode.json`的ChatGPT MCP条目 | 只配置本地`mcp-server.js`命令，没有覆盖browser profile/CDP环境；实际使用默认agent专用profile。未使用或输出其它provider凭据。 | observed |
| owned Edge启动顺序单变量对照 | 直接携带ChatGPT URL曾出现“无法加载订阅：Failed to fetch”；`about:blank -> CDP ready -> daemon导航ChatGPT`保持登录，10秒内无dialog、同源4xx/5xx或requestfailed。R56采用后者，空白页只允许作为CDP启动过渡，绝不作为daemon ready或失败残留终态。 | observed |
| `.temp/testing/chatgpt-voice-auth-evidence/inspect-current-wire.cjs`及`evidence.json` | 可独立执行`node inspect-current-wire.cjs`：真实logged-in主page、真实无痕guest page和本次部署两个公共frontend bundle；输出只有布尔、公开source excerpt/hash，无token/cookie值。三项verdict均为true。 | observed / directly inspectable |
| `evidence.json:14-23`真实guest producer | `readyState=complete`、composer和登录入口同时存在，旧正文正则仍使`currentHeuristicLoggedOut=false`；唯一观察到的`#client-bootstrap`为`logged_out`且无session/token。 | observed |
| `evidence.json:25-49`当前frontend wire | conversation bundle明确FormData `file`、可选language/duration、`safePost('/transcribe')`和`SendIfAvailable`；shared client明确`/backend-api`、bootstrap state accessToken和可用时Bearer。 | observed / current wire |
| 当前专用profile重新登录后的内存与磁盘元数据 | 主page为`logged_in`且session/token存在；活动`Default/Cookies`中两个分片session-token均`is_persistent=1`、加密值存在、到期`2026-10-13 07:23:38`。未读取cookie/token值。 | observed |
| 一次只验证profile的production graceful stop/restart | 关闭后磁盘session-token仍存在；新daemon不发voice即ready，新Edge保持登录。证明正常关闭/重开可持久；此前测试确实在用户登录后反复stop/SIGTERM，但当前没有证据表明一次graceful stop会删除持久cookie。 | observed |
| `.temp/testing/chatgpt-voice-auth-evidence/bootstrap-convergence.json` | 正常重启中bootstrap在790ms已登录，composer在1356ms收敛且无登录入口，daemon在1458ms才ready；无订阅dialog、同源HTTP错误或request failure。本轮加载顺滑，不把composer hydrate阶段误报为混合登录。 | observed |
| 用户观察到的异常启动页 | 页面曾同时显示登录入口和“你好SMARK”，手工刷新后恢复；这是logged-in bootstrap与DOM长期不一致的真实producer，不能用更多正文文案修补。 | observed / user report |
| R24实施后的首轮`--load` | 第一轮两个voice已入队时首个new Session ask在`clickSend`的10秒acceptance wait失败；返回Session `#f75496a167`。daemon仍connected、locks=0，两页bootstrap均logged-in。 | observed |
| 失败后只读Project composer现场 | composer仍保留完整测试prompt，send button存在且enabled，user turn为0；Session registry已是lost，证明`beforeSend`和trusted click已开始，但网页没有接受本轮prompt。 | observed |
| 同daemon全新Session单次ask对照 | `node chatgpt.js --raw "Reply exactly OK."`立即返回`OK / Status: completed`；登录、Project和一般submit路径可用，故障绑定并发/时序窗口而非永久失效。 | observed |
| 当前MCP fresh-page侧栏现场 | 新ask页`readyState=complete`、bootstrap为`logged_in`、composer存在；Project sidebar网络资源已返回且DOM含可见文本`MCP`，但侧栏内部容器为`pointer-events:none`、导航与“打开边栏”控件位于视口外，首页按钮的几何中心命中外层surface而非按钮。 | observed |
| R32最小Project解析反馈环 | `CHATGPT_PROJECT=MCP node chatgpt.js --raw "Reply exactly OK."`在同一daemon连续两次失败：`Discovered ChatGPT project links: none`，随后`Live Project sidebar recovery failed: Waiting failed: 15000ms exceeded`；手工触发同一“打开边栏”按钮后其位置从屏外恢复到`x=8`，侧栏row转为可交互。 | observed |
| R34 MCP cold ask红反馈 | 无MCP cache时live discovery/open-home成功，`Submitted via send button`后20秒仍停在`/g/...-mcp/project`，`rememberCurrentSessionUrl()`失败；随后同一页面才出现user/assistant turn并进入`/g/...-mcp/c/...`，证明首屏Project网络收敛晚于ask acceptance deadline。 | observed |
| R34 MCP fresh-page网络对照 | 新Session page在Project首页加载后先发`POST /backend-api/conversation/init`并返回200，随后发`POST /backend-api/f/conversation`并返回200，约5秒后才发生脱敏后的`/g/.../c/...`路由切换；warm ask在该顺序下成功。只记录路径、方法、状态和时间，不读取body/token。 | observed |

## 5. Current Behavior

当前R60已实施工作树的实际链路如下；R63目标状态不属于当前行为，见第10节：

```text
TUI Alt+V
  -> prompt-voice-input.ts stop()
  -> transcribeVoiceFile()
  -> node chatgpt.js transcribe-file --file ... --json
  -> ensureDaemon()
  -> spawn chatgpt.js --daemon-internal
  -> startDaemonProcess()
  -> 默认私有profile：先连接DevToolsActivePort marker；不存在活动browser才spawn blank并marker connect
     或显式CDP/WS：connect shared；或unlocked external profile受控puppeteer.launch
  -> prepareBootstrapPage()
  -> 已验证bootstrap四态收敛；不解析Project
  -> HTTP server ready
  -> POST /voice/transcribe-file
  -> runVoiceRequest()
  -> runVoiceTranscribe()
  -> borrowed-or-dedicated voice lease
  -> fresh terminal wait + 两次sessionPageFact
  -> chatgpt-dom.transcribeAudioFile()
  -> page-local bootstrap Bearer direct POST /backend-api/transcribe
  -> 完整JSON text或HTTP/transport诊断；不进入UI fallback
  -> CLI最多四次同主路径attempt；TUI总预算1,237,000ms且取消只终止CLI父进程
```

当前已确认的导航、profile和认证行为：

- daemon启动已不再解析Project；bootstrap只为root/login检查导航，ask在new/legacy Session边界才lazy初始化default Project。
- 当前default-private先消费自身profile的完整marker endpoint；cold时spawn `about:blank`只等CDP ready，再由唯一bootstrap owner导航ChatGPT。显式unlocked external profile仍由`puppeteer.launch`受控启动；shared CDP/WS只disconnect。
- voice新建page会导航官方root，健康复用page不重复导航；direct路径不`bringToFront`、不进入composer、不再有UI dictation fallback。
- R24已把stable probe和direct收敛为bootstrap四态与page-local Bearer；R55不再修改认证wire。
- ask的8秒foreground pulse仍会`bringToFront()`并滚底；它不应在direct voice成功路径中参与，但必须在voice与ask并发测试中保持不互相导航。

当前缓存读写职责：

- `cacheProject()`按id、token、key和规范化名称写多个alias。
- ask的`resolveProject()`先使用exact cache候选；`projectHomeState`区分`readable/unavailable`。
- 瞬态验证失败保留cache；稳定root/no-ID或不同Project ID证明stale后才进入唯一live discovery，替代验证成功后在同一锁内原子替换旧alias。
- valid existing Session先恢复registry Project，不被当前default Project失败阻断；并发new Session共享runtime single-flight。

R10/R18 production baseline已经完成Project lazy/cache、direct-only、稳定lease和状态计数；R24的single-source bootstrap、startup/fresh-page收敛、page-local Bearer及auth-first profile harness已在当前worktree落地，离线suite、profile restart、加速idle和browser-close均已通过。R25新增缺口仅是voice direct POST与ask composer submit的远端提交窗口仍彼此独立；它们的结果等待继续并发，但副作用发起不能重叠。

R32当前观察补充：Project页的失败发生在身份选择之前。`readSidebarProjects()`看到的是隐藏sidebar副本，`openProjectHomeFromSidebar()`随后找到同名row，却在不可命中的首页按钮上等待路由变化；因此失败不是cache缺失、认证失败或MCP不存在，而是DOM侧栏交互前置条件未恢复。当前voice页仍可独立direct成功，故不得把该修复移入core voice lifecycle。

R34当前观察补充：R33恢复侧栏后，第一次无cache的MCP ask已经能完成Project身份解析和可信send click，但`ensureProjectHome()`只验证Project URL、h1、composer和Chat mode，随即把页面交给`submitAsk()`。真实页面仍在等待`/backend-api/conversation/init`；`rememberCurrentSessionUrl()`的20秒轮询先超时，随后页面才切换到严格Project conversation URL。warm/cache ask在相同网络顺序稳定完成，故第一处分歧是Project页交互返回过早，而不是应当放宽conversation身份校验或增加同请求重发。

R36当前观察补充：R35两条delayed-init TDD切片、54项离线suite、无cache MCP cold ask及`2 voice + 1 ask`最小overlap均已通过；但fresh隔离state的`4 voice + 2独立new ask`连续三次在130秒达到CLI timeout。定向日志证明`ensureProjectSidebarInteractive`与expander `evaluateHandle`已完成，唯一可信`ElementHandle.click()`开始后不settle；同一期间四个direct voice全部一次成功，停止daemon后该click才以`Target closed`退出。无voice cold ask和`2 voice + 1 ask`均完成，因此第一处分歧是首次Project acquisition仍位于R26 submission transaction之外，而不是selector、登录、endpoint、URL identity或模型回答。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| TUI生成的有效RIFF/WAVE临时文件 | `prompt-voice-recorder.ts` | stop完成写文件；controller在转录后清理 | `chatgpt.js validateVoiceFile -> core validateVoiceInput` | CLI/core trust seam | observed / contracted |
| TUI在转录期间Abort | `prompt-voice-input.ts` | `AbortSignal`传给外部Process | `Process.run -> chatgpt.js child -> HTTP close -> runVoiceRequest` | CLI/core orchestration | observed / contracted |
| 空闲、仍在官方origin的voice/session page | daemon runtime | Puppeteer page未关闭；健康检查可访问同源session | `borrowVoicePage`或`voicePage` | core runtime | reachable |
| direct endpoint HTTP/transport/response错误 | ChatGPT page fetch | 页面内只返回结构化失败，不把token返回Node | `transcribeAudioFileDirect -> DOM adapter -> core` | DOM adapter + core orchestration | observed / reachable |
| daemon运行但browser已被用户关闭 | Edge/Puppeteer | `browser.isConnected()`为false或HTTP状态不可用 | `ensureDaemon -> isDaemonUsable -> retire/start`；请求中则browser disconnect | CLI/core lifecycle | observed / reachable |
| daemon.json存在但daemon/port已失效 | 进程异常退出或未清理环境 | 本地索引不是可信真相 | `readDaemonState -> ping/status -> retire` | CLI lifecycle | observed / reachable |
| 两个以上voice调用重叠 | TUI/多个opencode调用方 | 每个调用有独立WAV；daemon共享profile | `runVoiceRequest -> withVoice` | core runtime | reachable |
| voice与ask同时运行 | TUI voice + MCP ask | ask session page和voice page必须隔离 | `pageFor/voicePage/foreground` | core runtime | observed / reachable |
| 约5分钟无voice后再次调用 | 用户时间间隔 | persistent page可能仍存在，健康检查必须重新验证 | `VOICE_PAGE_MAX_AGE_MS`与`voicePage` | core runtime | contracted / reachable |
| 5分钟级WAV，文件不超过现有50MiB上限 | TUI/native recorder或测试fixture | RIFF/WAVE且size受限 | `readFileSync -> page FormData` | CLI/core/DOM transport | reachable |
| `CHATGPT_PROJECT`名称已删除或改名 | 部署环境缓存/配置 | 名称不是稳定ID；cache只作候选 | `resolveProject -> ensureProjectHome`，仅ask路径 | core Project owner | observed |
| 默认owned agent profile冷启动 | daemon | profile目录未被其它Edge锁定；当前profile可能没有有效登录session，startup必须等待而不能伪ready | `launchBrowser -> prepareBootstrapPage -> startup auth fact` | core browser owner + DOM fact owner | observed / reachable |
| 当前ChatGPT登录态与direct认证 | ChatGPT网页 | 唯一观察到的`#client-bootstrap`提供`authStatus/session.accessToken`；token只允许在页面上下文参与当前同源请求 | `sessionPageFact -> transcribeAudioFileDirect` | DOM adapter | observed / current frontend contract |
| 两个排队voice与一个new ask重叠 | robustness harness | voice输入独立且由`withVoice`串行；ask使用独立Session page | 两次`runVoiceRequest`与一次`runAsk`并发，direct POST窗口覆盖ask submit | core runtime concurrency owner | observed |
| fresh ask页的Project侧栏已可交互 | ChatGPT页面渲染/侧栏状态 | DOM可能已含Project row，但侧栏控件必须可命中且pointer-events有效；不能以offset尺寸代替交互终态 | `resolveProject -> discoverProjects/openProjectHome -> sidebar control` | DOM adapter | observed |
| 无Project cache时4个voice与2个独立new ask同时启动 | robustness harness | voice direct由`withVoice`串行但与首次Project single-flight并发；两个ask共享同一Project初始化Promise | `runVoiceTranscribe -> withSubmission`与`runAsk -> ensureProject -> ElementHandle.click`重叠 | core runtime submission owner | observed / deterministic |
| R36修复后的ask-first cold overlap | runtime已把Project初始化放入FIFO submission queue，但voice lease/preflight仍在入队前执行 | ask先入队、voice随后开始`sessionPageFact`，Project未完成时voice direct不入队并触达60秒deadline | `ensureProject -> withSubmission`与`runVoiceTranscribe -> voiceLease -> sessionPageFact`重叠 | core runtime submission owner | observed / deterministic |

 speculative concerns such as arbitrary malformed CDP frames, future DOM selectors
without a producer, or a browser process killed by an unrelated administrator are
not allowed to drive this plan.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 一个有效voice请求在daemon启动时只需要浏览器和voice transport可用；不得先完成Project discovery、Project首页验证或ask专属导航。 | 用户要求、真实冷启动红反馈、`startDaemonProcess`调用链 | 缺少启动期voice隔离测试 |
| INV-02 | direct voice成功路径不导航、不刷新、不抢前台、不进入composer；成功延迟主要由上传/服务端返回决定。 | `chatgpt-dom.js` direct实现、已有direct fast-path测试、真实direct复测 | `testDirectVoiceTranscribeSkipsComposerWait` |
| INV-03 | voice只有一个权威成功语义；一次CLI事务对可恢复运行错误最多执行初次加三次重试，每次都是同一authenticated direct主路径。错误不得触发UI听写、第二端点或不同上传算法；登录/token介入、输入错误、取消、确定性4xx/响应契约和browser配置错误立即返回，最后可恢复attempt失败才向TUI返回错误。 | 用户本轮明确要求至少三次重试，同时确定性错误无法由自动重复自解决 | 旧不重试测试替换为recoverable成功与完整non-recoverable单次矩阵 |
| INV-04 | 每个可产生voice成功的lease都必须连续确认同源、document complete、唯一`#client-bootstrap`为logged-in并含session token、composer存在且无登录入口。DOM adapter只向core返回非敏感typed fact；core独占启动收敛、voice acquisition和两次稳定决策。新建/刚导航candidate先有界等待terminal，再做连续snapshot；复用页直接snapshot。guest/mixed DOM都不得ready，startup持续混合最多reload一次。 | 真实guest、混合页面、顺滑重启及1356ms composer收敛时间线 | bootstrap fact、startup convergence、fresh voice convergence和stable lease测试 |
| INV-05 | direct结果只在现有`response.text()`和正常JSON `text`字段边界完成后返回；取消信号不能被当作完成或稳定信号。当前adapter职责不扩展到未观察的畸形响应。 | 当前生产边界、历史一次200完整JSON、已观察HTTP/transport失败；用户补充稳定化约束 | `testDirectVoiceUsesBootstrapAuth`和既有direct-error/no-fallback测试 |
| INV-06 | TUI取消后，daemon底层voice operation必须在释放voice lock前真实settle或被隔离；迟到任务不能操作下一次voice的页面或composer。 | 当前日志`cancelled voice task did not settle`；TUI AbortSignal契约 | `testVoiceDeadlineAndForeground`部分覆盖，需作为回归而非主修复 |
| INV-07 | 多个voice请求共享同一daemon时串行使用voice page；ask session page永不被voice导航或清composer。 | runtime `withVoice`、page ownership设计 | `testVoiceTaskLifecycle`部分覆盖 |
| INV-08 | 私有daemon/browser任一方异常结束时，当前CLI事务先恢复同一私有browser lifecycle；marker可连接就复用，浏览器不存在就冷启动。voice错误在清理当前page/request后继续下次尝试，最多四次；显式shared browser不被关闭或转成owned。 | README ownership契约、本轮孤儿Edge PID 56832与可连接marker、用户明确生命周期自维护要求 | 需替换stale/disconnect测试并新增daemon异常退出E2E |
| INV-09 | 5分钟级空闲后再次voice，若稳定健康page仍可用则复用且不导航；若过期/不稳定而新建或导航candidate，先在POST前等待正常terminal hydration，再做两次snapshot；失败才占用一次退役/续租预算。续租成功继续本次voice，续租失败才明确错误。 | page age、真实正常hydrate时间线、用户长间隔要求 | fresh-page convergence离线行为 + 加速/真实idle E2E |
| INV-10 | Project缓存是ask的身份加速器，不是voice启动依赖；瞬态不可验证保留cache；稳定官方非Project路由或不同Project ID证明stale后，必须沿唯一live discovery route寻找同名替代并原子替换/清理旧alias。 | `projects.json`历史/当前对比、README stale-cache恢复契约 | 缺少transient retain和stale no-ID replacement测试 |
| INV-11 | default Project只服务新Session或没有有效历史Project的兼容记录，并由runtime single-flight拥有；有效existing Session先从registry恢复自己的Project快照，pending/completed/exact continuation不得被当前`CHATGPT_PROJECT`失败阻断。 | `runAsk`/`projectForSessionEntry`现有分界、MCP并发4、当前MCP缺失证据 | 缺少existing Session在default Project失败时的恢复测试，以及两个new first ask + voice重叠测试 |
| INV-12 | 5分钟级长WAV必须通过真实`TUI controller -> transcribeVoiceFile子进程 -> chatgpt.js -> daemon/core -> DOM direct`链返回完整的独立预期内容。门禁在300秒有效PCM的末端放置两个运行时合成、与短fixture不同的确定性语音marker；结果必须同时含两个marker，任意非空文本、短fixture旧结果或只处理开头都不能通过。timeout只能作为定位第一处预算/transport owner的失败证据。TUI必须清理WAV，且下一次真实short voice返回其独立预期词。 | 用户明确长语音失败需修复；R36 plan audit B-01；当前测试只断言非空 | late-marker完整性整链 + 清理 + 独立short结果 |
| INV-13 | 3轮高压必须在MCP Project home上完成12/12 voice和6/6独立new-Session真实ask、0超时/失败、`voiceSubmitted`增量恰为12、p95不超过120000ms；每个ask使用不同request hash、返回唯一Session并各有一次`Prompt sent`可信URL接受事实，不能把completed replay计作提交。每轮结束active/queued/locks为0，voice page不超过1，累计managed page不超过7且低于现有cap 12，最终健康检查和后续voice成功。 | 用户明确多轮voice/new-ask负载/并发/高压与MCP Project；R26实现审计B-01；原始伪发送发生于new ask | MCP Project + 六个独立Session + distinct prompt + 本轮daemon log acceptance计数 |
| INV-14 | 默认private、external、explicit shared与debug-port ownership互斥。debug-port daemon-spawned browser的owned事实必须跨daemon异常退出：`browser-owner.json`只记录规范化profile/port/CDP browser PID；后继通过当前endpoint自身PID完全匹配才恢复owned，未知/mismatch按shared。正常close compare-delete；daemon discovery cleanup不删除它。 | README debug-port合同、daemon.json stale删除链、CDP已验证可提供browser PID、原始孤儿问题 | debug-port spawn→daemon crash→reconnect owned→normal stop closes browser行为测试 |
| INV-15 | voice继续使用官方当前同源direct契约：`POST /backend-api/transcribe`、multipart `file`、`credentials: include`、accept/language头，并按前端`SendIfAvailable`从page-local bootstrap session附带Bearer。token不得返回Node/status/log。无认证事实时不得POST；429、5xx、transport/page/browser/daemon运行错误完成清理后由CLI重试同一wire，确定性4xx和登录介入不重试。 | 当前frontend bundle、18次历史429及随后成功、当前hello-world同线200、用户明确重试合同、登录超时可达链 | R24 wire test保留；新增可恢复前三次失败第四次成功、401/403/登录单次失败测试 |
| INV-16 | voice与new ask重叠时，ask唯一可信click必须产生新增user turn并固定可信conversation URL；在此之前Session保持lost防重发语义。完整click-to-URL acceptance不得与voice POST重叠，`finishAsk`结果等待仍并发。 | 首轮load、最小`2 voice + 1 ask`连续red、`1 voice + 1 ask`及非重叠观察green | 新core并发行为slice + 最小真实反馈环 |
| INV-17 | Project按名称解析前，目标侧栏必须处于真实可交互终态；隐藏/移出视口的响应式副本不能被当作可点击row，且恢复侧栏不能改变Project身份、导航或voice路径。 | 当前MCP fresh-page DOM与两次解析失败；同一按钮DOM语义触发后侧栏可交互 | 新增collapsed-sidebar Project discovery行为测试 + MCP最小反馈环 |
| INV-18 | 任一fresh/navigated Project首页返回给ask前，已观察的同一页面`conversation/init`初始化必须成功；live sidebar click和cache/currentProject驱动的`page.goto`必须共享同一收敛合同。初始化失败或在既有有界预算内不可见时只能返回诊断，不得延长全局deadline、猜conversation URL或重发prompt。 | MCP cold ask真实红反馈、fresh-page network对照、`restoreSessionPage -> ensureProjectHome`两类导航producer | DOM live-click与core cached-goto两个行为slice + MCP cold/六Session反馈环 |
| INV-19 | 首次default Project acquisition的可信导航/click/`conversation/init`必须与voice direct POST和ask click-to-URL acceptance共用同一submission transaction owner；并发first ask仍共享一个Project Promise。Project完成后立即释放queue，existing Session、后续已初始化Project和assistant等待不占queue。 | fresh `4 voice + 2 ask`连续三次red、`2 voice + 1 ask`与无voice cold ask green、定向click边界日志 | runtime受控并发slice + 原始4/2和完整12/6 E2E |
| INV-20 | 每次voice尝试的page acquisition/stability/direct仍由同一submission owner排序；失败尝试必须先settle或隔离自己的page/request并释放锁，下一尝试才进入queue。取消立即终止整个CLI事务，不创建后续尝试。 | R36/R54 queue与取消证据；用户要求错误处理完成后准备下一重试 | 既有queue/cancel回归 + retry-after-cleanup行为测试 |
| INV-30 | `daemon.log`的启动游标是UTF-8字节位置；读取`Startup error`和`Login required`必须从该字节位置读取Buffer尾部，不能把字节数当UTF-16字符串下标。 | 本轮确定性反馈环：中文前缀后stub立即写具体错误，CLI耗时2196ms等满1500ms并只报通用失败 | Unicode startup-error黑盒CLI测试 |
| INV-31 | 私有Edge cold spawn允许内部`about:blank`仅作为CDP ready前的有界过渡；marker连接后必须由唯一bootstrap owner导航并验证ChatGPT，daemon不得在空白页ready，也不得在失败/timeout后留下无主空白browser。 | 用户反复观察about:blank；直接URL曾触发订阅Failed to fetch，而about:blank→CDP→bootstrap导航对照保持登录且无同源失败 | 私有spawn顺序/真实daemon cold-start页面E2E |
| INV-32 | TUI不得在CLI四次完整voice预算、1/2/4秒退避和30秒清理余量结束前用总时限中止，也不得在Windows取消时`taskkill /T /F`连带终止daemon/browser树。默认严格为`4*(180000+120000)+7000+30000=1237000ms`。用户主动取消只终止transcriber CLI，socket关闭驱动daemon现有request取消；daemon/browser继续维护profile。 | 当前90秒AbortSignal与Windows tree kill可达链；用户要求每次完整预算和避免强制结束浏览器；R55 plan audit B-02 | TUI process abort行为测试 + 真实retry E2E |
| INV-33 | 每个失败必须由首次产生owner提供稳定recoverability code；browser acquisition同时返回经当前连接验证的shared/owned provenance。debug-port owner record缺失/mismatch不是错误或owned证据，按shared fail-safe；配置/spawn拒绝仍为`BROWSER_CONFIG`。 | DOM/startup混合错误、static shared布尔、R55-R59 audits | producer-code、owner-record/provenance matrix、CLI classification测试 |
| INV-34 | browser acquisition从成功取得连接开始直到daemon ready前，必须持续拥有本次provenance；任意pre-ready失败都在该owner内按shared disconnect或owned graceful close收敛。只有持续`SESSION_PAGE_DID_NOT_CONVERGE`且owned close已证明profile释放时允许一次同route cold recovery；其它失败关闭后原样返回，不产生第二成功路径。 | R60 implementation audit B-01；隔离headless repro观察`failed=true, orphanReachable=true` | pre-ready异常后marker endpoint不可达且profile可重新cold acquisition的真实default-private测试 |
| INV-35 | 本地daemon HTTP 401代表本次请求携带的state/token已不被目标daemon接受。HTTP adapter产生专属identity code后，orchestration只能重新读取当前发现文件：若`daemonID/token/pid/port`身份已变化且新state通过`/ping + /status`，下一attempt复用该current state；身份未变、缺失或不可验证时立即失败。不得用旧token stop current daemon，不得删除发现文件或启动竞争daemon；page-local ChatGPT `VOICE_AUTH_REQUIRED`和其它确定性4xx仍立即失败。 | R60 implementation audit B-03、R61 plan audit B-01；旧token无法通过同一全局auth gate访问`/stop` | A voice切换发现文件到B后401→下一attempt只复用B成功且stop=0；unchanged/missing/unusable identity fail closed；ChatGPT auth/403单次 |

## 8. First Divergence and Root Cause

下表中INV-01至INV-13记录R10实施前已经确认并由当前worktree修复的历史first divergence；它们用于解释原始red，不是R24待重复实施的production缺口。R24保留INV-14 observer，并重新打开被当前证据反证的INV-04/INV-09/INV-15认证与收敛owner。

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `startDaemonProcess()`在HTTP server ready前无条件调用`resolveProject()`和`ensureProjectHome()`，voice请求尚未到达。 | `chatgpt-core.js` daemon startup owner | 本轮红环日志2539-2546；历史非目标Project单变量复测成功且日志先ready后voice |
| INV-02 | voice成功前置链路已进行Project/root导航；direct adapter内部还有独立UI fallback导航/前台分支。 | `chatgpt-core.js` orchestration + `chatgpt-dom.js` adapter | 全量`.goto/.bringToFront`搜索和代码行99-1040、211-214；直接voice日志耗时与startup分离 |
| INV-03 | direct adapter捕获endpoint/transport错误后转入UI dictation，CLI还对`BROWSER_DISCONNECTED`自动重试同一voice。 | `chatgpt-dom.js`和`chatgpt.js` voice boundary | 日志113、2387-2398、2425-2537；用户明确禁止错误fallback |
| INV-04 | DOM adapter把guest判断绑定有限正文正则，startup又用`Promise.race(composer, login button)`把“任一先出现”当作可判定；真实guest因此伪logged-in，用户混合DOM也可能在React收敛前/失败时被接受。 | `chatgpt-dom.js` fact owner + `chatgpt-core.js` startup convergence owner | 可复跑guest artifact三项verdict；用户混合页面观察；顺滑重启证明正常状态在ready前可自然收敛 |
| INV-05 | 当前direct已通过`response.text()`完成body读取和JSON/`text`验证；R24不改变响应算法。 | `transcribeAudioFileDirect` baseline evidence | 历史一次请求返回完整JSON text；历史日志已有HTTP/transport错误，用户禁止错误fallback |
| INV-06 | caller race返回后，当前底层页面operation在某些取消窗口未settle，core最终记录`cancelled voice task did not settle`并触发fatal。 | `runVoiceTranscribe` / `runVoiceRequest` orchestration | 日志2480-2484；作为取消回归，已有测试仍未覆盖真实late operation |
| INV-07 | voice与ask虽各有page/lock，但voice启动前共享bootstrap Project初始化，fallback还共享foreground竞争；这使页面跳转发生在责任边界之外。 | runtime allocation + startup owner | `createDaemonRuntime`和startup调用链；现有ownership测试没有启动期voice |
| INV-08 | stale browser的发现/淘汰只在CLI请求入口可靠；若请求在browser断连后进入已有页面任务，当前daemon只能通过fatal shutdown收敛。 | `chatgpt.js`/`chatgpt-core.js` lifecycle | README shared/owned契约、已有stale test和日志browser disconnected |
| INV-09 | `voicePage()`将新page只导航到`domcontentloaded`，随后两次probe只相隔一个event-loop turn；真实正常页面到composer一致状态还需约370ms，因此age/recovery后的健康fresh page会先消耗续租预算。 | core voice page acquisition + DOM terminal observer | core 1434-1444、1525-1549；`bootstrap-convergence.json:22-64` |
| INV-10 | 即使typed validation保留transient cache，R4仍未规定readable root/no-ID或不同ID如何进入唯一live discovery并原子替换；否则stale cache会被保留到永久阻断ask。 | core Project registry + DOM validation result | 代码621-645、979-991、1036-1083；README stale name-cache契约 |
| INV-11 | lazy Project若在所有first ask进入`runAsk`前无条件执行，会让有效existing Session的registry Project快照被当前default Project失败阻断；而并发new Session仍需要single-flight。 | ask orchestration + runtime Project initialization | 代码1648-1704、`projectForSessionEntry:123-126`；当前MCP缺失但其它Project/Session可存在 |
| INV-12 | 当前测试把TUI模拟transcriber和真实CLI长WAV拆开，无法证明TUI实际启动的`chatgpt.js`在90秒边界、daemon取消和WAV清理后仍可继续voice。 | TUI/core/DOM timeout owners | 代码`prompt-voice-input.ts:83-113,156-188`、`chatgpt.js:800-822`、core 1624-1636、DOM 775-855 |
| INV-13 | 当前没有多轮压力、精确成功/超时/延迟/资源阈值或direct提交计数；因此“锁存在”与status最终归零都不能证明没有重复提交。 | CLI/daemon/runtime orchestration | `chatgpt.js:59,800-822`、`chatgpt-core.js:1409-1422,1501-1506,1624-1636`和DOM单POST路径 |
| INV-14 | R20 observer和主Edge/helper识别已落地，但`runProfileRestart`在voice失败后`finally stopDaemon()`，把登录持久性、endpoint和清理揉在一起并再次关闭现场。 | `test-voice-robustness.js` profile lifecycle harness | 用户两次登录后测试关闭；当前无voice graceful restart证明profile本身可持久 |
| INV-15 | DOM adapter绕过当前frontend `safePost`的`SendIfAvailable`鉴权，只发送cookie和少量header；startup又把无session guest页伪判为ready，最终在没有bootstrap token时POST并稳定429。 | `chatgpt-dom.js:transcribeAudioFileDirect` | 当前bundle明确`SendIfAvailable -> bootstrap session token -> Authorization`；完整五分钟冷却后的首个CLI请求仍429 |
| INV-16 | `withVoice`和`withForeground`是两条独立队列；voice direct POST可以覆盖ask的composer submit/acceptance窗口。最小`2 voice + 1 ask`连续两次red，`1 voice + 1 ask`green；成功观察轮中conversation POST只在两次transcribe结束后出现。失败时trusted click已开始但composer未清空、user turn为0。 | core runtime remote-submission owner | 最小环与低开销network/click artifact；不是按钮selector、登录或Project永久失败 |
| INV-17 | `resolveProject`的live discovery先读到隐藏sidebar结构；现有`visible()`只检查尺寸，`openProjectHomeFromSidebar()`也未先恢复侧栏，首页按钮点击坐标命中外层surface，15秒内没有路由/h1/composer终态。 | `chatgpt-dom.js` Project sidebar adapter | 现场`pointer-events:none`、按钮x=-179且elementFromPoint不是按钮；同一按钮DOM click后x=8/nav=0并可交互，随后页面具备MCP row |
| INV-18 | live `openProjectHomeFromSidebar()`和cached/currentProject的`ensureProjectHome -> page.goto()`都只等URL/h1/composer/Chat mode；任一fresh page都可在`conversation/init`完成前进入submit。首个cold样本中`rememberCurrentSessionUrl()`先耗尽20秒，随后迟到路由才出现。 | `chatgpt-dom.js` network fact owner + `chatgpt-core.js` Project-page acquisition owner | log 3030-3032、后续页面turn、network顺序及源码`currentProject -> restoreSessionPage -> ensureProjectHome -> goto`可达链 |
| INV-19 | `runtime.ensureProject()`直接执行`initializeProject()`，没有经过已经保护voice direct和ask submit的`submissionQueue`；cold sidebar expander的可信CDP click因此可与另页direct `Runtime.callFunctionOn`重叠并永久占住first-ask single-flight。 | `chatgpt-core.js` runtime submission owner | 隔离state 4/2三次timeout；诊断顺序为`evaluateHandle done -> click start`后四次voice成功但无click done，daemon stop后`Target closed`；2/1与无voice对照green |
| INV-12 (R37 current) | `writeExtendedWav()`把short语音保留在data开头并把其余约299秒填零；整链只断言结果非空，因此没有观察末端音频是否被处理，也不能排除short旧结果。 | `prompt-voice-input.test.ts`本地E2E验收owner | 当前代码714、748-750、799只生成开头语音/末端silence并记录`nonEmptyChars`；R36独立方案审计B-01 |
| INV-20 | R36只把Project initializer放进queue，`runVoiceTranscribe()`仍在`withSubmission()`之前调用`runtime.voiceLease()`；ask-first到达时，voice `sessionPageFact`与Project click重叠，且voice direct被Project FIFO队头延迟到60秒deadline。 | `chatgpt-core.js` voice orchestration + runtime queue owner | R36修复后隔离fresh `4 voice + 2 ask`：仅首条`voice: transcribing`，无direct完成，60秒后两个voice timeout；status仍有2 locks；没有引入新endpoint或fallback |
| INV-30 | `ensureDaemon()`以`fs.statSync(daemon.log).size`记录UTF-8字节偏移，随后两个consumer对已解码字符串执行`slice(offset)`；日志含中文后偏移越过字符串末尾，已写出的具体错误永远不可见。 | `chatgpt.js` daemon startup log consumer | 确定性最小loop返回`ok=false, elapsed=2196, Daemon did not start`；真实日志`bytes=769971, utf16 units=752171, slice(bytes).length=0` |
| INV-31 | 默认owned路径把私有浏览器交给`puppeteer.launch()`；Puppeteer在没有非flag参数时追加`about:blank`，daemon失去launch连接后退出，已启动Edge仍持有profile而下一daemon再次launch失败。 | `chatgpt-core.js:launchBrowser/startDaemonProcess` private-browser lifecycle | 真实Edge PID 56832命令行含private user-data-dir、remote-debugging-port=0和about:blank；marker端口33436可`puppeteer.connect`，但当前CLI不读取marker并连续启动失败 |
| INV-32 | TUI把整个external transcriber限制为90秒并经通用`Process.run`取消；Windows abort使用`taskkill /T /F`终止CLI整棵子进程树。四次完整voice尝试尚未结束时，上游会先破坏daemon/browser生命周期。 | `prompt-voice-input.ts:transcribeVoiceFile` + `util/process.ts:abort` voice consumer | 当前常量90秒、core单次80秒、CLI voice HTTP 120秒；producer-to-consumer调用链确定可达，用户明确要求每次完整预算且不强杀浏览器 |
| INV-03 / INV-08 / INV-15 | 当前CLI对voice endpoint只调用一次；`BROWSER_DISCONNECTED`只retire后抛错，HTTP/transport/page错误直接抛错。错误清理完成后没有下一次同一direct尝试，browser生命周期错误也不在本事务内重建。 | `chatgpt.js:transcribe-file` orchestration owner | `testVoiceDoesNotRetryAfterBrowserDisconnect`显式锁定旧单次失败；日志18次429中同一/下一WAV数秒至约60秒后成功；用户明确要求初次后至少3次重试 |
| INV-34 | `acquireBootstrapBrowser()`取得`acquired`后仅对持续不收敛owned分支close；其它`prepareBootstrapPage/goto/sessionPageFact`异常直接throw。`startDaemonProcess()`要等helper成功返回才赋值`browser/ownedByDaemon`，outer catch无法清理该detached browser。 | `chatgpt-core.js` browser acquisition/bootstrap owner | 已运行隔离headless repro：注入pre-ready fact异常后输出`{"failed":true,"orphanReachable":true}`，repro随后通过CDP清理 |
| INV-35 | `httpJSON()`把daemon业务401仅表示为`statusCode=401`；`voiceErrorIsRetryable()`对无code 4xx fail closed。R61曾计划调用`retireDaemon(oldState)`，但旧token对current daemon的`/stop`同样401，现有retire会吞错并删除current发现文件。 | `chatgpt.js` local HTTP adapter/discovery orchestration | fake daemon红环：`status=1, voice=1, stop=0`；R61 plan audit证明旧token stop失败后unlink会制造无索引live daemon |
| INV-33 | DOM把所有HTTP状态归为`VOICE_ENDPOINT`，voice route除输入/BROWSER_DISCONNECTED外统一500；startup log不带结构化code。CLI若按R55“其它错误全重试”会把logged-out→login wait timeout重复四次。 | `chatgpt-dom.js:transcribeAudioFileDirect` + core voice route/startup log + `chatgpt.js` retry classifier | 当前source可达链；R55 plan audit B-01 |
| INV-33 (R57) | R56仍把`VOICE_ENDPOINT`和`BROWSER_STARTUP`列为可重试；前者包含token消失/invalid 200 response，后者包含公开`CHATGPT_BROWSER_PATH`的ENOENT/EACCES。 | DOM direct catch + core spawn/startup owner | 当前source可达链；R56 plan audit B-01/B-02 |

本轮红反馈环：

```text
TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node test-voice-robustness.js
=> normal cold start [130.0s] FAIL; stderr only shows Starting browser daemon
=> daemon.log: Project page validation failed for MCP; rediscovering from live sidebar
=> daemon.log: Project page self-recovery failed: Waiting failed: 15000ms exceeded
=> daemon.log: Startup error: ChatGPT Project "MCP" could not be opened in Chat mode after automatic rediscovery.
```

单变量对照环：

```text
TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice \
  node chatgpt.js transcribe-file --file /private/tmp/opencode/voice/test-hello.wav --json
=> Daemon ready.
=> {"text":"Hello world."}
=> daemon.log: voice started after ready; Direct voice transcription finished in 15335ms
```

R32 Project侧栏红反馈：

```text
TMPDIR=/private/tmp CHATGPT_PROJECT=MCP node chatgpt.js --raw "Reply exactly OK."
=> Could not find ChatGPT project "MCP"
=> daemon.log: Discovered ChatGPT project links: none
=> daemon.log: Live Project sidebar recovery failed: Waiting failed: 15000ms exceeded

同一失败page只读DOM：authStatus=logged_in；composer=true；MCP row存在；sidebar pointer-events=none；首页按钮中心命中外层surface。
同一按钮DOM语义触发后：aria-expanded=true；nav pointer-events=auto；MCP row/home button可命中。
```

R6实施期真实反馈（触发R7新cycle）：

```text
CHATGPT_VOICE_E2E=1 TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice \
  bun test --timeout 240000 test/cli/tui/prompt-voice-input.test.ts \
  --test-name-pattern "runs a five-minute WAV through the configured ChatGPT transcriber"
=> long WAV completed and controller cleanup ran
=> immediate short WAV failed: ChatGPT session did not expose an access token: status=200
```

该信号证明失败发生在stable lease与direct session-token读取之间；不是TUI、WAV、Project、取消或HTTP status问题。

R10实施期profile/wire反馈（触发R11）：

```text
CHATGPT_VOICE_E2E=1 ... bun test ... "runs a five-minute WAV ..."
=> [ERROR] Voice page is not stable: origin=https://chatgpt.com ready=complete session=200 authenticated=false

普通Edge + agent专用profile：登录 -> graceful close -> 普通Edge重启
=> loggedOut=false; persistent session cookies仍存在

同一profile默认daemon/Puppeteer启动（R10旧probe）
=> 旧session-token判据报告authenticated=false；没有DOM loggedOut或cookie删除的直接证据

已登录page fetch('/api/auth/session')
=> 200; rootKeys=['WARNING_BANNER']; no access token

同页一次POST /backend-api/transcribe，credentials=include且无Authorization
=> 200; JSON keys=['conversation_detail_metadata','text']

owned Edge直接打开ChatGPT
=> 曾显示“无法加载订阅：Failed to fetch”
owned Edge打开about:blank -> CDP ready -> goto ChatGPT
=> loggedOut=false; dialogs=[]; failures=[]
```

这组R11阶段证据当时把一次cookie-only 200提升成当前长期contract；R21当前frontend source和稳定429已经反证该提升。仍不能在TUI重登、core猜token或direct错误后重试来补偿；正确owner仍是DOM adapter，但事实来源必须是网页自己的bootstrap session，wire必须对齐网页自己的`SendIfAvailable`。

R21红反馈和最小化对照：

```text
env -u CHATGPT_BROWSER_CDP_URL -u CHATGPT_BROWSER_WS_ENDPOINT CHATGPT_BROWSER_DEBUG_PORT=0 \
  TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice \
  node test-voice-robustness.js --idle --gap-ms 300000
=> daemon ready
=> idle first voice failed: ChatGPT direct transcribe returned HTTP 429

同一真实page的非敏感事实：
=> composer=true; hasLoginBtn=true; guestComposer=false; heuristicLoggedOut=false
=> client-bootstrap.authStatus=logged_out; session=false; accessToken=false

当前已加载ChatGPT frontend source：
=> transcribe: FormData(file[, language, duration_ms])
=> safePost('/transcribe', { authOption: SendIfAvailable })
=> base URL https://chatgpt.com/backend-api
=> SendIfAvailable从client bootstrap session state读取access token；存在时附带Authorization Bearer
```

最小场景不包含Project、ask、取消、长音频或第二次请求：一个默认profile、一个guest composer、一次startup和一个短WAV即可稳定进入错误链。删除任一load/idle压力维度不改变429；真正的第一处分歧发生在POST之前的登录事实归一化。

R25并发伪发送反馈环与最小化：

```text
TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_PROJECT=<historical-project> \
  node test-voice-robustness.js --load --rounds 1 --voice-per-round 2 --ask-every 2 \
  --expect-voice 2 --expect-ask 1 --max-p95-ms 120000 --max-voice-pages 1 --max-managed-pages 2
=> 连续两次：ask round=1 index=2 failed: Waiting failed: 10000ms exceeded
=> 失败现场：composer保留完整prompt；send enabled；userTurns=0；Session已lost

同参数改为 --voice-per-round 1 --ask-every 1 --expect-voice 1
=> PASS load: voice=1 ask=1

低开销CDP观察的成功对照：
=> 两次transcribe response均先结束，之后才出现POST /backend-api/f/conversation
=> pointerdown/click均命中data-testid=send-button；ask完成
```

去掉第二个排队voice后producer转绿，说明保持voice提交窗口覆盖ask submit是负载条件；失败后新Session单独ask立即完成，排除登录、Project和永久composer损坏。第一处分歧位于core把voice direct与ask submit交给两条独立并发队列，而非DOM adapter是否点击按钮。观察器只保存path/status/长度/计数，不保存prompt、token或cookie。

R27真实六次ask反馈（R26实现审计B-01修正后的第一轮）：

```text
TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_PROJECT=<historical-project> \
  node test-voice-robustness.js --load --rounds 3 --voice-per-round 4 --ask-every 2 \
  --expect-voice 12 --expect-ask 6
=> ask round=2 index=4 failed: Waiting failed: 10000ms exceeded
=> daemon.log: ask -> Composer ready -> 10s error；没有 Submitted via send button
=> 此前3个ask各有 Submitted/Prompt sent/Done；本轮voice direct均已结束
=> live DOM: userTurns=3; composerLength=0; send button absent
=> performance: 本次有 /backend-api/f/conversation/prepare，无 /backend-api/f/conversation
```

这条真实传导证明失败在可信click之前：本地prompt fill触发ChatGPT prepare/React composer替换，当前`clickSend`只等待“同一composer仍含expected text且send enabled”，节点重挂后文本被清空，因此到10秒失败。没有user turn、conversation POST或`beforeClick`后的lost副作用，故一次本地refill属于同一pre-side-effect DOM收敛，不是第二次click、远端prompt重发或错误fallback。宽泛循环、提高10秒、Enter fallback和click retry均不允许。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| daemon是否因voice启动Project | `chatgpt-core.js` startup/orchestration | daemon startup提供可驱动browser和HTTP服务 | 这是voice请求到达前的第一处分歧 | TUI只启动外部命令；DOM adapter不拥有daemon启动顺序 |
| bootstrap与DOM收敛及一次恢复 | `chatgpt-core.js` startup + `chatgpt-dom.js:sessionPageFact` | DOM唯一接口报告四态非敏感事实并可等待terminal；core只按`kind`决定login wait、一次reload或ready | 页面分类/Mutation属于adapter，timeout/reload预算和ready时机属于browser lifecycle owner | direct不能自行reload；core不得解析bootstrap/selector；TUI/CLI看不到页面 |
| fresh voice page正常hydrate | `chatgpt-core.js:voicePage/stabilizeVoicePage` | daemon新建或刚goto的candidate先调用同一`sessionPageFact(waitForTerminal=true)`，terminal后才执行两次snapshot | core知道candidate是否由本次acquisition创建/导航；DOM只知道页面事实 | adapter不能决定续租；复用页不应每次等待；CLI/TUI不知道page age |
| Project身份解析与缓存 | `chatgpt-core.js` + `chatgpt-project.js` + DOM validation result | existing Session优先自己的registry Project；new Session才使用default Project；cache只作候选；瞬态不可验证不能等价于stale | Project policy判断身份，DOM adapter保留可验证/不可验证事实，core决定是否初始化或清理 | voice不需要Project；TUI不拥有Project cache |
| Project侧栏交互前置条件 | `chatgpt-dom.js` Project discovery adapter | live discovery/open首页前，侧栏必须由网页自己的toggle进入可交互终态；只使用当前结构化sidebar control，不猜URL | 侧栏DOM状态、可命中性和按钮事件属于DOM owner；core只消费Project URL/错误 | core不应解析CSS/aria状态；voice/TUI/MCP wrapper不拥有ChatGPT侧栏 |
| Project首页首屏网络收敛 | `chatgpt-core.js` Project-page acquisition + `chatgpt-dom.js` network adapter | core标记本次page是否需要live click或URL goto；DOM在导航前登记同页`conversation/init`并只在成功后返回；already-current页直通 | core拥有哪个Session page发生导航的生命周期事实，DOM拥有ChatGPT endpoint/method/status事实 | DOM不选择Project身份；core不解析网络response；TUI/voice不参与ask首页初始化 |
| voice页面会话事实/direct wire格式与错误归一化 | `chatgpt-dom.js` | `sessionPageFact`只从当前`#client-bootstrap`和DOM归一四态；direct按官方`SendIfAvailable`在页面内附带现有session token并发送唯一POST，token不离开page | ChatGPT bootstrap与私有wire兼容只有一个owner | core只消费`kind/origin/readyState`并决定lease稳定/退役，不解析bootstrap/token/HTTP body；TUI不懂ChatGPT wire |
| owned Edge/profile生命周期 | `chatgpt-core.js` + robustness harness | 默认private profile以marker连接同一browser；正常stop CDP优雅关闭，异常daemon退出保留browser供重连 | browser进程和shutdown属于daemon owner；孤儿browser/profile lock与可连接marker直接证明现有启动器需替换 | DOM不启动进程；CLI只做daemon acquisition；显式shared endpoint仍由用户拥有 |
| voice超时、取消、串行和退役 | `chatgpt-core.js` runtime | 请求完成/取消/超时后锁和页面可再次使用或被隔离 | orchestration拥有deadline和资源生命周期 | DOM不拥有并发队列；TUI只能取消外部process |
| voice/ask远端提交互斥 | `chatgpt-core.js` runtime | voice唯一direct POST与core `submitAsk`完整click-to-URL acceptance共享短submission queue；`finishAsk`不持锁 | runtime拥有voice、Session、URL registry和foreground编排，能覆盖真实acceptance边界 | DOM只拥有单次click/user-turn事实，不拥有URL registry或其它page任务；CLI/MCP看不见daemon并发 |
| daemon stale/browser close | `chatgpt.js` + core shutdown | 本地daemon索引不是browser健康真相；CLI淘汰daemon索引，core通过private marker复用或cold恢复browser | CLI掌握启动锁/daemon文件，core掌握browser/profile ownership | TUI不应杀浏览器或清daemon索引 |
| TUI recorder和WAV清理 | `prompt-voice-input.ts` / recorder | cancel不上传且删除临时音频 | 录音文件产生和隐私清理属于TUI | browser daemon不能可靠管理native recorder |
| 行为证据 | `test-mcp.js` +现有TUI测试 | 离线fake adapter锁定一次提交，受保护status提供E2E提交/资源计数，环境门禁TUI测试启动真实CLI/Edge整链 | 需要锁定真实链路，不复制内部算法 | 源码字符串或无行为输出的私有调用次数不能证明用户行为 |
| 默认私有浏览器连接、重连、优雅关闭与冷启动 | `chatgpt-core.js:launchBrowser/startDaemonProcess/shutdownOnce` | `STATE_DIR/profile`对应一个daemon维护的私有浏览器生命周期 | core是唯一持有Puppeteer Browser和bootstrap convergence的模块，能统一spawn/connect/close | CLI只发现HTTP daemon；TUI不应理解CDP/profile；DOM adapter不管理进程 |
| daemon启动日志游标与错误消费 | `chatgpt.js:ensureDaemon` | 子daemon在ready前失败时，调用方应尽早得到本次追加的具体错误 | CLI创建字节offset并轮询日志，类型转换错误首次发生在这里 | core只追加日志；TUI/MCP不读取daemon.log |
| voice四次尝试、每次完整预算与daemon重新取得 | `chatgpt.js:transcribe-file` | 一个CLI事务执行初次加三次同语义尝试，最后一次失败才退出 | CLI横跨daemon健康检查与HTTP voice请求，是唯一能在尝试间重新`ensureDaemon`的orchestrator | core只拥有单daemon请求及锁清理；DOM只拥有一条wire；TUI只运行transcriber进程 |
| 单次voice请求清理和可重试错误分类 | `chatgpt-core.js:runVoiceRequest`与voice HTTP route | 每次失败在返回前已settle/隔离page、释放voice/submission lock并给CLI稳定code | core已拥有request context、lease和browser/page分类 | CLI不能判断页面是否settle；DOM不能重建daemon |
| TUI总兜底与CLI-only取消 | `prompt-voice-input.ts:transcribeVoiceFile` | 外层预算覆盖四个完整尝试；用户取消终止CLI但不强杀daemon/browser | 此处创建AbortSignal并选择Process终止语义 | 通用`Process.run`不能为所有命令改变tree-kill合同；browser-agent不拥有TUI用户取消 |
| 可恢复错误code生产与消费 | DOM direct、core route/startup、`chatgpt.js` CLI | 首个owner产生稳定code，CLI按封闭集合决定retry/retire；message只展示不决策 | 各owner掌握HTTP状态、页面/browser事实或login状态，CLI掌握attempt循环 | TUI不理解daemon错误；CLI按message会复制owner并受文案漂移；DOM不能重建daemon |

唯一跨模块事实接口定义为`CHATGPT_DOM.sessionPageFact(page, { waitForTerminal, timeoutMs })`，返回且只返回：

```text
{ kind: 'authenticated', origin: 'https://chatgpt.com', readyState: 'complete' }
{ kind: 'logged-out',    origin, readyState }
{ kind: 'loading',       origin, readyState }
{ kind: 'inconsistent',  origin, readyState }
```

- `authenticated`：document complete，唯一`#client-bootstrap.authStatus === 'logged_in'`，session access token非空，composer存在且无登录入口。
- `logged-out`：document complete且唯一bootstrap明确`authStatus === 'logged_out'`；guest是否有composer不改变该状态。
- `loading`：document尚未complete，或complete前bootstrap/DOM尚未出现；它不是登录失败。
- `inconsistent`：document complete后，logged-in bootstrap缺token、composer缺失、仍有登录入口，或bootstrap没有当前已观察的明确状态；它不能ready，也不尝试未来schema。
- `waitForTerminal=false`只返回当前snapshot；`true`时adapter通过load/MutationObserver等待`authenticated/logged-out`，到`timeoutMs`后返回最新`loading/inconsistent`。adapter不reload、不决定失败；core不读取DOM字段、不区分文案、不接触token。
- 旧`isLoggedOut()`和`voiceSessionFact()`两个重叠authority删除/收敛到该接口；startup和两次voice probe都消费同一判别联合。

## 10. Single Approved Primary-Path Design

唯一主路径：

```text
TUI WAV
  -> TUI以CLI-only取消运行transcriber，并提供覆盖四次完整尝试的总兜底
  -> CLI本地WAV校验一次
  -> attempt 1..4:
       ensureDaemon
       -> 默认私有profile：连接DevToolsActivePort；不存在则spawn内部blank、marker ready后连接
       -> 唯一bootstrap owner导航ChatGPT并收敛；blank不能ready或残留
       -> 退化browser优雅关闭后冷启动一次
       -> daemon HTTP ready
       -> core request context/withVoice/submission queue
       -> 健康borrowed-or-dedicated voice lease与稳定preflight
       -> 同源页面内同一个authenticated direct transcribe wire
       -> 成功则返回；可恢复失败完成settle/隔离/锁释放后进入下一attempt
       -> 登录介入、输入/取消、确定性4xx立即返回
  -> 第四次仍失败才向TUI返回最后错误
  -> TUI插入文本或展示最终失败
```

Project初始化、voice lease/preflight、voice direct和ask的trusted click/URL接受共享这一个queue owner；`finishAsk`、assistant生成等待、artifact和其它结果处理始终在queue外。不存在“先获取voice lease再进入queue”的第二主路径。

具体修复方向：

0. `acquireBrowser()`返回`{ browser, ownedByDaemon }`，shutdown/页面管理只消费该provenance。默认`STATE_DIR/profile`使用private marker：先连`DevToolsActivePort`；否则spawn `--remote-debugging-port=0 about:blank`后marker connect，异常daemon后重连仍保持private-owned，正常stop graceful close。显式external profile未锁定时保留现有受控`puppeteer.launch`并返回owned；已锁定且无endpoint返回`BROWSER_CONFIG`。显式`CHATGPT_BROWSER_CDP_URL`或WS endpoint连接返回shared，永远只disconnect。

0.1. `CHATGPT_BROWSER_DEBUG_PORT`单独形成既有兼容输入。端口不可达后daemon受控spawn固定port与blank，连接后通过CDP `SystemInfo.getProcessInfo`读取type=browser PID，并以原子temp+rename写`STATE_DIR/browser-owner.json`：`{ profile: realpath/normalized path, debugPort, browserPid }`，不含token、WS path或cookie。该文件不属于daemon发现索引，`unlinkDaemonFiles()`不删除。端口启动前已可达时，只有当前CDP browser PID、port和profile与owner record完全匹配才返回owned，否则shared；不扫描进程、不按端口猜ownership。正常owned close后仅当记录仍匹配本次三元组才compare-delete；browser已退出但record残留时，下一次受控spawn成功后原子替换。固定端口冲突/无效值为`BROWSER_CONFIG`，启动后暂时不可达为`BROWSER_STARTUP`。

0.2. owned browser连接成功但bootstrap在现有一次reload预算后仍不收敛时，core发送CDP `Browser.close`并有界等待profile释放，再按对应input的同一cold route启动一次；shared只disconnect并明确失败。正常`/stop`和SIGTERM对owned也用`Browser.close`，超时只disconnect并留下browser供下一daemon重连，删除child.kill后备。browser自己退出时daemon清索引并退出，下一attempt按同input恢复。

0.3. `ensureDaemon()`记录daemon.log的字节offset后，两个marker consumer都以Buffer字节尾解码追加内容；不再对完整UTF-8字符串使用字节offset。启动子进程`error/exit`与日志具体错误均尽早消费；登录等待仍不是startup error。

0.4. 错误首次产生处给出稳定code。DOM在POST前token缺失产生`VOICE_AUTH_REQUIRED`，HTTP 429为`VOICE_RATE_LIMIT`、5xx为`VOICE_SERVER`、其它4xx为`VOICE_REJECTED`，fetch TypeError/Abort为`VOICE_TRANSPORT`、origin漂移为`VOICE_PAGE`、200但JSON/`text`合同无效为`VOICE_RESPONSE_INVALID`；其它未知endpoint异常保持`VOICE_ENDPOINT`但不进入retry集合。core route原样保留这些code及`BROWSER_DISCONNECTED/VOICE_TIMEOUT/VOICE_RUNTIME_FATAL/VOICE_CANCELLED`，本地body/file为400非重试。

0.5. browser startup owner在产生副作用前验证`CHROME_PATH`存在且可执行；确定性path/spawn `ENOENT/EACCES/EPERM`、locked external profile且无endpoint、显式CDP/WS或debug-port配置拒绝统一为`BROWSER_CONFIG`。默认private、daemon-spawned debug-port和其它owned runtime的marker/CDP/bootstrap故障才是`BROWSER_STARTUP`；unlocked external launch失败保留准确code。daemon startup log为`Startup error [CODE]: message`；login wait为`LOGIN_REQUIRED`。byte-tail parser返回code与message；unknown fail closed。

0.6. `chatgpt.js transcribe-file`在一次本地文件校验后执行初次加最多三次重试。可重试封闭集合仅为`VOICE_RATE_LIMIT/VOICE_SERVER/VOICE_TRANSPORT/VOICE_PAGE/BROWSER_DISCONNECTED/BROWSER_STARTUP/VOICE_TIMEOUT/VOICE_RUNTIME_FATAL`以及本地daemon HTTP connection reset/refused/timeout和HTTP 5xx；local 401只按第0.9项identity reconciliation处理，不进入通用retire或status classifier。`VOICE_ENDPOINT/VOICE_AUTH_REQUIRED/VOICE_RESPONSE_INVALID/LOGIN_REQUIRED/BROWSER_CONFIG/VOICE_REJECTED/VOICE_CANCELLED`、本地400、其它确定性4xx、CLI signal和unknown立即返回。每次完整预算，清理后1/2/4秒退避。

0.7. TUI的`transcribeVoiceFile`复用`Process.run`并仅为voice设置`killTree:false`；默认总兜底覆盖四次`DAEMON_START_TIMEOUT + VOICE_HTTP_TIMEOUT`、7秒退避和30秒清理：`1_237_000ms`。用户主动取消仍立即终止CLI父进程，不递归杀daemon/browser。
0.8. R61把`acquireBootstrapBrowser()`定义为从`launchBrowser()`成功返回到bootstrap fact产生之间的唯一provenance owner。每轮取得`acquired`后，任何pre-ready异常都必须在重新throw前完成同一清理合同：shared仅disconnect；owned发送CDP `Browser.close`并验证PID/profile释放，匹配的fixed-port owner record才compare-delete。只有首轮owned错误code严格为`SESSION_PAGE_DID_NOT_CONVERGE`且close返回true时进入现有唯一一次cold loop；其它异常即使close成功也原样失败，不重跑primary operation。close不能证明释放时保留marker/owner record供下一CLI重连，禁止同进程spawn、强杀或合成成功。
0.9. R63在`httpJSON()`这个local-daemon wire owner把HTTP 401映射为`DAEMON_IDENTITY_MISMATCH`，只因该函数连接的是本地daemon协议；不依赖错误文案。voice catch收到该code后重新读取`daemon.json`，要求current state存在、四元身份`daemonID/token/pid/port`与本attempt旧state不同，且`isDaemonUsable(current)`通过，才让既有loop进入下一attempt；不调用`retireDaemon(old)`、`/stop`或`unlinkDaemonFiles`，也不直接把current state注入成功结果。身份未变/缺失/unusable立即throw原401。下一attempt仍调用`ensureDaemon()`并按正常发现路径复用current daemon。DOM/page产生的`VOICE_AUTH_REQUIRED`、`VOICE_REJECTED`和其它4xx code不经过该转换，继续立即失败。
0.10. R61在`test-voice-robustness.js`增加两个显式mode，每个mode自行创建随机`CHATGPT_STATE_DIR`和`CHATGPT_SESSION_DIR`，因此production default-private仍自然推导为该隔离state下的`profile`；只允许`CHATGPT_TEST_HOOKS=1`下的headless test browser。`--daemon-crash-reconnect`以production CLI/daemon启动首个voice，只终止daemon PID、不动Edge，记录marker endpoint/PID，下一CLI必须重连同endpoint并成功，再用真实`--stop`验证browser/profile释放。`--bootstrap-cold-recovery`通过test-only daemon wrapper只让首个browser lifecycle的bootstrap fact持续不一致、第二生命周期authenticated，browser acquisition/close/profile release/cold route仍全部来自production；随后真实voice和`--stop`成功。两个mode的finally先走daemon/CDP graceful close再有界删除隔离目录，失败也不得遗留可见未登录窗口。

1. 启动期只做browser/profile/bootstrap和HTTP server；把`resolveProject/ensureProjectHome`从daemon startup移动到ask的Project-owned分界。`runAsk`先读registry：有效existing Session直接使用`projectForSessionEntry`得到的历史Project并恢复pending/completed/exact conversation，不触发当前default Project；只有`newSession`或没有有效历史Project的兼容记录才调用唯一`ensureProject(page, log)` single-flight。第一个需要default Project的ask持有自己的已被`withSession`锁定的page执行初始化，后续同类ask等待同一Promise；失败后compare-delete in-flight引用，下一次new ask可以重新开始。voice不能借用被Session锁占用的Project初始化page。
2. `resolveProject`在ask路径使用有效exact cache作为候选，先交给已有`ensureProjectHome`验证；只有没有cache或cache已经被验证为stale时才做live sidebar discovery。live discovery和按名称打开首页前，DOM adapter先恢复当前页面的sidebar toggle并等待其真实交互终态；这不是第二Project来源，也不刷新或改写URL。`projectHomeState`不再把所有evaluate/导航异常压成普通`null`：DOM adapter返回`readable`或`unavailable`的验证结果；readable状态由Project policy检查URL，稳定官方root/no-ID或不同Project ID证明stale并进入唯一live discovery，只有替代通过验证后才在一次JSON锁内原子写新alias、删除旧ID alias；执行上下文、渲染、网络或sidebar暂时不可用仍返回诊断，不能把“这次看不清”当成“身份已不存在”。
2.1. 把Project-home network convergence收敛为一个DOM adapter seam：live sidebar首页按钮click和core对fresh Session page执行的candidate URL `goto`都在各自导航动作之前登记同一页的`POST /backend-api/conversation/init`观察；只接受同页、POST、已观察path且2xx的响应，随后才返回既有Project URL/h1/composer/Chat验证。already-current的有效Project页保持既有直通；init响应在有界预算内不可见统一传播Project unavailable诊断，不延长`rememberCurrentSessionUrl`、不把init当conversation身份、不猜URL、不重发prompt。core只调用该DOM seam，不复制endpoint匹配。
2.2. `runtime.ensureProject(page, log)`仍是default Project唯一single-flight owner，但第一个初始化任务必须先通过已有`withSubmission()`进入同一远端副作用队列，再执行完整`resolveProject -> ensureProjectHome`。后续并发first ask等待同一个已排队Promise，不各自占队；Project验证完成或失败后立即释放submission queue，compare-delete仍允许下一次独立new ask重新初始化。该事务只覆盖cold Project acquisition的可信导航/click/init，不包`finishAsk`、assistant等待、artifact、existing Session恢复，也不重试expander/home/send click。这样voice不依赖Project，但首次ask的Project CDP副作用不再与voice direct POST重叠。
2.3. voice的`runtime.voiceLease()`也必须在同一`withSubmission()`事务内开始，随后才进入现有唯一direct POST；voice page的bootstrap读取、terminal wait、两次稳定probe不能在Project click或ask submit期间占用CDP。queue前取消先锁存并跳过lease，queue内取消沿现有settle/隔离路径释放，不新增voice deadline、第二次lease或重发。voice仍由`withVoice`串行，`finishAsk`和assistant等待仍在queue外。
3. voice只保留direct作为成功路径。voice page acquisition统一返回lease：borrowed与dedicated都是同一contract。复用页直接做两次snapshot；由本次acquisition新建或`goto`的candidate先调用`sessionPageFact(waitForTerminal=true, timeoutMs=15_000)`等待正常hydrate，得到authenticated后再做两次snapshot。terminal等待失败才把candidate算作一次退役并续租。一个attempt只发一次POST；失败完成清理后，由CLI下一attempt重新执行同一主路径。
4. voice page只在首次创建或生命周期健康检查需要时导航到官方root；已经是官方ChatGPT页时不因每次voice而`goto`或`reload`。direct成功不`bringToFront`，避免voice本身抢用户前台。
5. 稳定性检测是voice的完成/复用依据：`chatgpt-dom.js`用唯一`sessionPageFact`按上表四态归一`#client-bootstrap`和DOM，不读取`window.CLIENT_BOOTSTRAP`、旧session endpoint或其它兼容来源。Node/core只能看到`kind/origin/readyState`，token不出page。startup和fresh/navigated voice candidate使用bounded terminal wait；已收敛candidate与复用页再用snapshot，且只有连续两次`kind='authenticated'`才通过。
6. startup不再使用`Promise.race`后的单次布尔快照。core第一次以现有15秒页面准备预算等待`sessionPageFact`：`authenticated`直接继续；`logged-out`进入现有手工登录等待；`loading/inconsistent`只允许一次`reload({ waitUntil: 'domcontentloaded' })`，随后再以同一接口和同一预算等待。第二次`authenticated`才ready，`logged-out`进入登录等待，第二次仍`loading/inconsistent`则记录明确startup错误且绝不写daemon ready；不能循环reload。所有bootstrap/selector判断仍留在DOM adapter。
7. 浏览器断连或daemon文件过期时，CLI清除无效索引并在当前voice事务的下一attempt重新`ensureDaemon`。默认私有profile先marker reconnect，浏览器不存在才冷启动；shared CDP只disconnect。恢复后仍走相同direct wire，不把错误合成成功。
8. 5分钟idle场景复用现有page age/health策略：稳定健康则继续direct且不导航；过期后fresh candidate先完成bounded terminal wait，不把正常hydrate记作失败。只有terminal失败或后续两次snapshot不连续才退役并续租一次；本attempt失败后由CLI下一attempt重走相同acquisition。不要新增周期刷新。
9. 为高压验收补齐runtime现有bearer保护`/status`的诊断计数：`voiceActive`、`voiceQueued`、`voicePageCount`、`managedPageCount`和单调`voiceSubmitted`。`voiceSubmitted`只在进入唯一direct adapter前递增，不记录音频、文本、token、Project URL或页面句柄；离线fake adapter断言每个请求恰好一次调用，真实压力harness断言计数增量恰为12。
10. 压力harness显式设置`CHATGPT_PROJECT=MCP`，使用一个隔离daemon和3轮工作负载；每轮并发4个voice，并在每2个voice后立即并发启动1个不带`--session-id`的new ask。六个ask分别使用唯一prompt且不得由harness串行等待前一个回答；生产`withNewConversationLock`只串行短创建/URL接受，`finishAsk`可并发。通过标准固定为12/12 voice、6/6 ask、六个唯一Session且各URL由既有Project policy证明归属MCP、`accepted=6`、0 timeout/failure、voice p95 `<=120000ms`、`voiceSubmitted`增量12；每轮结束`voiceActive=0`、`voiceQueued=0`、`activeLocks=0`、`voicePageCount<=1`，累计`managedPageCount<=7`且低于cap 12，末尾额外短voice成功。
11. 长语音E2E保留现有`prompt-voice-input.test.ts`环境门禁和真实`node chatgpt.js transcribe-file --file {file} --json`子进程。测试在Darwin本地门禁内用系统`/usr/bin/say`和`/usr/bin/afconvert`通过argv运行时生成只属于本次测试的PCM marker语音，不执行shell字符串；RIFF helper保留真实fmt/data chunk并将marker frames放在300秒容器末端，其余数据为silence，总尺寸仍低于50MiB。长结果按大小写/标点归一后必须同时包含预先确定的两个marker词，短fixture结果必须包含自己不同的预期词；这样截断到开头、旧short结果或任意非空文本都会red。测试仍要求controller回idle、长短WAV与中间marker文件清理、同一daemon后续short voice成功；任何timeout都失败。普通CI不设置门禁，不启动Edge、不依赖TTS artifact。
12. owned-browser恢复E2E由`test-voice-robustness.js --browser-close --gap-ms 5000`执行：先通过现有`--stop`有界结束任何agent daemon并确认索引不可达，再显式清空CDP/WS endpoint、设置debug port 0启动本场景。首个voice成功后，从新daemon PID后代中只选择带本agent `--user-data-dir`的Edge主进程发送SIGTERM，绝不匹配shared/user Edge。关闭后不再调用`--stop`或手工删除state，等待生产`disconnected -> shutdownOnce`自行移除索引；5秒后下一独立voice必须用原profile成功。若无法唯一证明owned descendant则测试fail-closed，不发送信号。
13. 默认private profile使用marker connect或blank→CDP→bootstrap spawn状态机，不依赖Puppeteer launch child handle；显式unlocked external profile保留既有受控launch。`--profile-restart`先挂载bootstrap observer，只验证auth一致、无订阅dialog和daemon ready；随后graceful stop、确认持久登录、第二次启动再次只读验证，最后才发一个short voice。新增daemon-only异常退出场景：首个voice后只终止daemon PID、不动Edge，下一CLI必须连接同一marker并成功；再优雅关闭browser后下一CLI必须cold成功。显式shared测试继续断言只disconnect。
14. direct adapter在同一个page.evaluate内再次读取唯一`#client-bootstrap` session token，并按网页`SendIfAvailable`的已认证分支附带`Authorization: Bearer`，同时保留`credentials: include`、当前endpoint、FormData `file`和accept/language头。token只用于该请求，不进入返回值、Node、status或日志；token在stable probe后消失时在POST前明确失败。不要从429响应猜新端点，也不要引入第二种上传算法。每个attempt保持一个POST，真实HTTP错误返回稳定code供CLI下一attempt重走同一wire。
15. runtime已有内部`submissionQueue`，失败后也必须推进后继。`runVoiceTranscribe`把本attempt唯一`runtime.voiceLease()`和随后唯一`CHATGPT_DOM.transcribeAudioFile`纳入同一队列事务；adapter直到完整response才返回，故voice bootstrap/stability与Project click/ask submit不重叠。ask侧既有事务不改变。attempt失败必须先完成现有lease release/discard、cancel settle或runtime fatal shutdown，HTTP response才返回CLI；下一attempt因此不会与旧页面任务重叠。ask click不纳入R55 retry。

R63 primary route保持唯一：`validated WAV -> ensure local daemon identity -> acquire one browser provenance -> bootstrap -> one authenticated direct POST -> complete text`。pre-ready cleanup是同一次acquisition的失败收敛，不产生成功；identity reconciliation只承认发现文件已发布且健康的新daemon，不停止/删除未知owner，仍由用户批准的最多四attempt orchestration执行下一次direct。

R10/R18已经修复voice被ask Project bootstrap阻断；R24修复当前新的第一处分歧：guest/mixed DOM不再因易漂移文案和过早快照被当成已登录，fresh voice page也不把正常hydrate当作不稳定，官方page-local鉴权不再被cookie-only旁路。bounded terminal wait和一次startup reload都发生在POST前的primary acquisition，不是transcribe错误fallback。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| direct same-origin bootstrap-auth transcription | R24 proposed correction | primary-contract branch | yes | primary | replace cookie-only wire at the same DOM owner; no endpoint or fallback change |
| startup Project resolution before voice | implemented R10/R18 baseline | removed responsibility leak | no/blocks voice | N/A | already removed; R20 regression verifies no reintroduction |
| direct error -> UI dictation | implemented R10/R18 baseline | forbidden fallback removed | no | N/A | already removed; R20 regression verifies direct-only |
| `BROWSER_DISCONNECTED` -> same-call daemon restart/retry | implemented R10/R18 baseline | forbidden retry removed | no | N/A | already removed; R20 regression verifies next-call lifecycle |
| borrowed idle Session page -> direct voice | implemented R10/R18 baseline | primary-contract lease branch | yes | primary | regression verify shared stable lease |
| healthy page reuse | implemented R10/R18 baseline | primary-contract branch | yes | primary | regression verify |
| unhealthy/aged page预上传退役并续租 | implemented R10/R18 baseline | primary-contract acquisition branch | yes | primary | regression verify one bounded renewal |
| existing Session -> registry Project snapshot | implemented R10/R18 baseline | primary ask-contract branch | yes | ask-only | regression verify stored identity |
| new/legacy-without-valid-Project Session -> default Project single-flight | implemented R10/R18 baseline | primary ask initialization branch | yes | ask-only | regression verify concurrency |
| runtime fatal after unisolatable task | implemented R10/R18 baseline | diagnostic lifecycle shutdown | no | <=10% | regression verify; no success synthesis |
| stable voice readiness/response check | R24 corrects DOM fact source | primary-contract gate | no | primary gate | one four-state `sessionPageFact` replaces two boolean authorities |
| fresh/navigated voice candidate -> terminal wait -> two snapshots | R24 proposed | primary page-acquisition branch | yes | primary | normal hydrate does not consume renewal; bounded before POST |
| startup mixed DOM -> wait -> at most one reload -> same convergence gate | R24 proposed | primary page-acquisition recovery | no by itself | primary gate | user-observed refresh repair; only before daemon ready, never after voice POST |
| voice direct / core submitAsk -> shared submission queue | R26 proposed | primary concurrency branch | yes | primary | serialize through trusted conversation URL; preserve finishAsk concurrency |
| complete direct response validation | implemented baseline | existing primary-contract behavior | yes | existing primary | regression verify normal success and observed HTTP/transport error only |
| long-WAV transport handling | verification remaining | supported input branch | yes/no | diagnostic | execute real TUI chain; no new production algorithm without red owner evidence |
| repeated load/pressure harness | verification remaining | diagnostic verification path | no | diagnostic | execute exact workload and convergence assertions |
| `/api/auth/session` token fetch | implemented baseline deletion | obsolete wire workaround | no | N/A | remain deleted; current token owner is bootstrap session, not a second fetch |
| guest DOM copy/selector as login authority | current incorrect gate | obsolete heuristic | no | N/A | replace with single `#client-bootstrap` authStatus/session plus DOM consistency in the same adapter |
| bootstrap subscription dialog observer | R20 implemented test | diagnostic verification path | no | diagnostic | keep bootstrap-to-ready observation and rerun after profile login |
| direct request-shape contract | R24 corrected regression | primary-contract regression | no | diagnostic | assert official endpoint and page-local optional-auth shape without new algorithm |
| Project sidebar已经可交互 -> 既有live discovery/open-home | R33 proposed | primary Project gate | yes | primary | 直接复用既有名称唯一性与首页可信click，不触发toggle |
| Project sidebar折叠 -> 同一结构化toggle -> bounded交互终态 | R33 proposed | primary Project acquisition branch | yes | primary | 只恢复`stage-slideover-sidebar`，不新增URL来源或第二点击算法 |
| Project sidebar在预算内仍不可交互 | R33 proposed | diagnostic failure | no | diagnostic | 传播现有Project解析失败；不猜URL、不返回成功、不切换Project来源 |
| Project首页click -> `conversation/init`成功响应 -> ask可用首页 | R35 proposed | primary Project page-acquisition branch | yes | primary | 只观察同页已确认网络事件；沿现有Project unavailable诊断处理事件失败，不改conversation identity |
| cache/currentProject fresh Session page `goto` -> 同一`conversation/init`收敛 -> ask可用首页 | R35 proposed | primary Project page-acquisition branch | yes | primary | core只提供导航生命周期事实，DOM复用同一network seam，不复制endpoint匹配 |
| cold default Project single-flight -> existing submission queue -> Project acquisition | R36 proposed | primary concurrency branch | yes | primary | 复用R26 queue排序真实远端副作用；不新增Project算法、retry或第二click，完成后立即释放 |
| voice lease/stability preflight -> existing submission queue -> one direct POST | R38 proposed | primary concurrency branch | yes | primary | 将已观察的page evaluate与Project/ask浏览器副作用纳入同一已有owner；queue前取消跳过lease，不新增lock或retry |
| private marker connect -> bootstrap convergence | R60 implemented/R61 preserved | primary browser-lifecycle branch | yes | primary | 默认私有profile有活动marker时连接同一浏览器；不扫描或接管用户Edge |
| no private browser -> spawn blank -> marker connect -> bootstrap navigation | R60 implemented/R61 preserved | primary browser-lifecycle branch | yes | primary | 采用已验证启动顺序；blank只作有界过渡，不是ready状态 |
| private bootstrap不可收敛 -> CDP graceful close -> cold transition | R60 implemented/R61 corrected | primary browser-lifecycle repair branch | yes | primary | R61让所有pre-ready失败先收敛；只有持续不收敛可执行一次同route cold，不强杀、不切换profile |
| unlocked external profile -> existing controlled launch/close | R58 preserved compatibility | existing compatibility | yes | primary-contract compatibility | 不进入private marker算法；locked且无endpoint明确拒绝 |
| debug port reachable before acquisition -> shared connect/disconnect | R59 preserved compatibility | existing compatibility | yes | primary-contract compatibility | 不关闭预先存在browser或tab |
| debug port unreachable -> daemon spawn fixed port -> owned connect/close | R59 preserved compatibility | primary browser-lifecycle branch | yes | primary | provenance由acquisition result携带；异常daemon后同端口恢复 |
| matching browser-owner record -> debug-port reconnect remains owned | R60 implemented/R61 preserved | primary browser-lifecycle recovery | yes | primary | CDP browser PID/profile/port三元组验证；daemon索引清理不破坏owner事实 |
| missing/mismatched owner record -> debug-port connect is shared | R60 implemented/R61 preserved | safety pass-through | yes | existing compatibility | fail-safe不关闭未知browser；不扫描PID或猜测 |
| recoverable voice failure -> cleanup -> next identical attempt | R56 user-required replacement | primary retry iteration | yes | primary | 最多四次同一direct语义；登录/4xx/取消/输入失败不进入迭代 |
| owner-produced recoverability code | R60 implemented/R61 corrected | primary error-contract gate | no | primary gate | DOM/core/startup原位分类；R61补local daemon 401，CLI不猜message |
| Unicode daemon log byte-tail consumption | R60 implemented/R61 preserved | primary startup-consumption behavior | no | primary gate | 立即消费具体启动事实与code，不合成成功 |
| TUI CLI-only abort | R60 implemented/R61 preserved | primary caller lifecycle | no | primary cancellation | 终止transcriber父进程但保留daemon/browser owner |

R57不授权alternate success path。初次与三次可恢复错误重试执行同一个browser lifecycle和同一个direct wire，是用户明确要求的单一primary operation迭代；UI dictation、第二endpoint、第二profile、不同鉴权或成功合成仍禁止。

R41保留R38新增的3个core primary decisions，并删除DOM通用discovery中1个越权的全局名称歧义diagnostic；该分支在R38表中属于`chatgpt-dom.js`的4个diagnostic之一，也是DOM 27个decision之一。R41不新增production decision、diagnostic、fallback、retry或DOM算法。当前总计`7 / 85 = 8.24%`。

| Owner | R38 total | R41 primary additions | R41 diagnostic removals | Current total | Current diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: |
| `chatgpt-core.js` | 51 | 0 | 0 | 51 | 3 |
| `chatgpt.js` | 8 | 0 | 0 | 8 | 1 |
| `chatgpt-dom.js` | 27 | 0 | -1 | 26 | 3 |
| Combined | 86 | 0 | -1 | 85 | 7 |

R41删除的是`discoverProjects()`在URL去重与身份解析前构造`PROJECT_AMBIGUOUS`的一个条件/错误结果路径，按一个diagnostic decision计入减项；错误对象构造和throw是该同一结果，不拆成额外路径。其余7个diagnostic owner和R38的3个core primary decisions不变。R31独立new-Session压力、acceptance日志计数、R37 late-marker artifact及R41 discovery fixture仍是test-only，不进入production分母或分子。合计`7 / 85 = 8.24%`。R27 composer refill、第二click、click timeout后retry和Project失败后换路均继续排除。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| daemon startup先解析Project | ask需要固定Project，最初把所有请求统一初始化 | 已由R10/R18 baseline移到ask-owned lazy boundary；R24只回归验证 | `chatgpt-core.js` baseline，R24无重复改动 |
| `resolveProject`先sidebar再cache | 旧实现把live discovery当作名称解析第一步 | baseline已cache-first并保留网页身份验证 | `chatgpt-core.js` baseline，R20无重复改动 |
| transient Project验证即删除cache | 旧实现把所有异常视为ID失效 | baseline已区分unavailable/stale并原子替换 | `chatgpt-core.js` baseline，R20无重复改动 |
| direct失败后UI dictation | 私有direct接口变化时维持可用 | baseline已删除；R24只验证不复活 | `chatgpt-dom.js` baseline |
| voice BROWSER_DISCONNECTED只报错、等待下一独立调用 | R54担心未知副作用而禁止同事务恢复 | 用户本轮明确要求错误自解决；每个core request先settle/隔离后，CLI下一attempt才重走同一direct主路径 | `chatgpt.js`替换旧单次分支与旧测试 |
| owned `puppeteer.launch` + child.kill close fallback | 简化私有profile进程管理 | daemon/browser连接耦合并产生孤儿profile lock；R56统一为spawn blank/marker connect/bootstrap导航与CDP graceful close | `chatgpt-core.js:launchBrowser/closeOwnedBrowser` |
| daemon启动日志完整字符串 + byte offset slice | 复用文件size作为追加游标 | UTF-8多字节日志使具体错误和recoverability code不可见；R56从byte offset直接读Buffer尾部 | `chatgpt.js:daemonStartupErrorSince/daemonLoginRequiredSince` |
| TUI 90秒 + Windows tree force-kill | 旧单次voice总兜底 | 四次完整预算前抢先中断，并可终止daemon/browser后代 | `prompt-voice-input.ts`预算与`Process.run` voice-only `killTree:false` |
| voice期间的Project/foreground耦合 | fallback和ask共用DOM前台 | baseline已让direct不抢前台，ask保留自身owner | `chatgpt-core.js` baseline |
| `/api/auth/session` token fetch | 旧ChatGPT Web曾从该endpoint取token | 当前frontend从bootstrap session state取token；删除endpoint fetch不等于删除官方Bearer语义 | 保持删除；`chatgpt-dom.js`只读取当前page bootstrap |
| guest正文正则 + composer/login组合 | 试图区分匿名composer与已登录composer | 当前真实guest文案已绕过该正则；bootstrap authStatus/session是网页自己的会话事实 | `chatgpt-dom.js:readLoginPageState`替换，不叠加更多文案 |
| `Promise.race(composer, login)`后立即判定 | 缩短startup等待 | 任一早到不代表bootstrap与React DOM一致；用户已观察长期混合页面 | 改为一个typed convergence seam；持续混合只在startup reload一次 |
| cookie-only direct | R11阶段一次真实请求曾200 | 当前官方client与稳定429证明它不能继续作为唯一长期contract | `chatgpt-dom.js:transcribeAudioFileDirect`原位补page-local SendIfAvailable auth，不新增第二请求路径 |
| voice lock与foreground queue完全独立 | voice和ask原本被视为不同page的独立副作用 | 真实最小producer证明两次voice覆盖ask click-to-URL acceptance会伪发送；finishAsk无需串行 | `chatgpt-core.js`收敛完整submitAsk与direct，不删除原Session/voice锁 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R-01至R-03、R-05至R-13 / 对应INV | 已落地daemon/runtime/DOM/TUI baseline | 当前worktree已包含Project/lease/direct-only/cleanup修复；R24不重复实现 | offline regression、load、long-WAV、idle、browser-close、package-local TUI/typecheck |
| R-04 / INV-04 bootstrap会话稳定事实 | daemon startup或voice lease -> `sessionPageFact`四态联合 -> core只按kind执行gate | `chatgpt-dom.js`删除双authority并实现single-source fact/Mutation wait；`chatgpt-core.js`等待terminal并对非terminal只reload一次 | 四态adapter行为；真实guest不能ready；正常hydrate不reload；持续混合一次reload后成功或明确失败；token不出page |
| R-09 / INV-09 fresh/idle voice convergence | age/recovery -> new/goto candidate -> bounded terminal wait -> two snapshots -> one bounded renewal -> one POST | `chatgpt-core.js`在现有voice acquisition seam携带fresh/navigated事实并调用同一adapter wait | normal fresh hydrate不消耗renewal；terminal失败才续租；加速/真实5分钟idle同调用成功 |
| R-12 / INV-12 五分钟WAV完整性 | TUI controller -> real child CLI -> daemon/direct -> late-marker transcript -> cleanup -> short transcript | `prompt-voice-input.test.ts`运行时生成末端双marker合法WAV并断言双marker/不同short预期；production无改动 | 任意非空/旧short/截断在当前测试可通过，R37测试会red；真实完整处理才green |
| R-14 / INV-14 profile持久与bootstrap首屏dialog | auth-only daemon restart -> persistent login -> second auth-only startup -> one short voice | 重构R20 `--profile-restart`，先隔离登录持久与429，失败保留现场；生产启动owner不改 | 两次bootstrap一致且无dialog，磁盘登录不丢，之后一次voice成功 |
| R-15 / INV-15 当前direct端点与429处理 | DOM direct wire -> page-local bootstrap token -> one official endpoint POST -> complete text or diagnostic error | `chatgpt-dom.js`原位对齐`SendIfAvailable`已认证分支；`test-mcp.js`更新wire契约 | 正常authenticated shape返回已知text且只POST一次；无bootstrap session零POST；HTTP错误无endpoint/DOM切换或重发 |
| R-16 / INV-16 voice/ask并发提交 | voice/ask准备并发 -> submission queue -> one direct或完整submitAsk -> 各自结果等待 | `chatgpt-core.js`新增内部队列并包围direct与click-to-URL acceptance；不改adapter算法 | offline真实runAsk/runVoiceRequest重叠：ask URL已记录、无lost、各提交一次；最小E2E转绿 |
| R-17 / INV-17 Project sidebar交互 | `resolveProject` -> DOM sidebar restore -> existing live discovery/open-home click -> Project policy | `chatgpt-dom.js`只补侧栏交互终态和真实命中判断；不改Project身份、voice或URL/token | collapsed-sidebar fixture从red转green；MCP最小真实ask解析到MCP |
| R-18 / INV-18 Project首页网络收敛 | live sidebar home click或cached/current URL goto -> `conversation/init` response -> existing `ensureProjectHome` -> `submitAsk` | core与`chatgpt-dom.js`共享同一Project导航owner和初始化事件；不改core URL identity或全局deadline | delayed-init与fresh-goto fixture red/green；MCP cold ask和六Session acceptance |
| R-19 / INV-19 cold Project与voice并发副作用 | first ask `ensureProject` -> existing submission queue -> single-flight Project acquisition -> release -> existing ask create/submit | `chatgpt-core.js`只把首次`initializeProject`纳入已有queue；不改DOM算法、voice endpoint或Session identity | runtime受控并发slice先red后green；4/2 cold overlap与12/6完整压力转绿 |
| R-20 / INV-20 voice preflight与Project/ask副作用互斥 | voice request -> queued `voiceLease`/stability -> one direct POST; Project/ask actions use same queue | `chatgpt-core.js`把`voiceLease`从queue外移入既有submission owner，保留queue前取消和settle/隔离语义 | ask-first 4/2 red/green、voice preflight不与Project click重叠、取消后下一voice可用 |
| INV-30 / 具体启动错误尽早消费 | byte log offset -> Buffer tail -> marker parse | `chatgpt.js`统一两个log consumer按字节读取 | 中文前缀+stub startup error在约1秒返回具体错误，不等1500ms deadline |
| INV-31 / 私有browser自维护 | private marker connect或spawn blank -> marker connect -> one bootstrap navigation/convergence -> daemon ready | `chatgpt-core.js`替换默认puppeteer.launch；保留显式shared分支 | orphan marker重连同一Edge；cold blank仅过渡且最终ChatGPT ready；退化页优雅关闭后cold成功 |
| INV-03/08/15/33 / 初次加三次可恢复重试 | validate once -> owner code -> up to 4 x ensureDaemon/direct -> cleanup/backoff -> success/final error | `chatgpt-dom.js`HTTP code、core route/startup code、`chatgpt.js`封闭classifier | 429/5xx/transport/browser前三次失败第四次成功；ChatGPT login/auth/403/400/cancel只一次；local daemon identity 401按INV-35恢复；真实daemon crash整链成功 |
| INV-32 / TUI不抢先破坏生命周期 | Alt+V -> external CLI with 1,237,000ms fallback + parent-only cancel | `prompt-voice-input.ts`和`util/process.ts`添加voice-only `killTree:false` | Windows/portable process fixture证明abort不终止grandchild；controller仍可立即取消并清理WAV |
| INV-34 / pre-ready acquisition不遗留browser | acquire provenance -> bootstrap preparation/navigation/fact -> success return or owner-local cleanup -> error/cold | `chatgpt-core.js`让`acquireBootstrapBrowser`在所有异常出口按provenance收敛；cold条件保持唯一 | isolated default-private真实Edge注入pre-ready异常后endpoint不可达、profile可cold；shared只disconnect |
| INV-35 / daemon本地401恢复 | old local daemon state `/voice` 401 -> adapter code -> reread changed current state -> verify usable -> next existing attempt | `chatgpt.js`仅在local HTTP adapter与voice orchestration增加稳定code和identity reconciliation；不调用retire/unlink | A切换发现文件到B后401，A/B stop均0、B同wire成功；unchanged/missing/unusable fail closed；`VOICE_AUTH_REQUIRED`和403仍一次 |
| INV-08/31/34 / default-private完整生产链 | isolated state -> production CLI/daemon -> default `state/profile` marker -> daemon crash/bootstrap cold -> production recovery | `test-voice-robustness.js`增加两个显式headless隔离mode；production无test-only cleanup算法 | `--daemon-crash-reconnect`同endpoint成功；`--bootstrap-cold-recovery`首browser关闭、第二browser cold且voice成功；无测试进程残留 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| R-01至R-03、R-05至R-13 baseline concepts | 对应requirements | 当前worktree source、已运行baseline tests和历史audits | 这些概念已由R10/R18实现；R24只回归/整链验证 |
| DOM-owned `sessionPageFact`四态联合 | R-04 | 可复跑guest/logged-in artifact；当前frontend source | 现有两个boolean接口无法区分logged-out/loading/inconsistent；单一联合让core无需复制DOM解释 |
| core startup convergence + one reload | R-04, R-14 | 用户混合DOM观察、手工refresh恢复、正常重启在ready前自然收敛 | 当前`Promise.race`不能区分hydrate与长期矛盾；adapter只分类，导航预算必须由core owner执行 |
| fresh voice candidate terminal wait | R-04, R-09 | `domcontentloaded`后约370ms才有composer的正常时间线；当前core立即两次snapshot | `sessionPageFact`已有bounded observer能力；core必须在知道fresh/navigated的acquisition owner消费它 |
| page-local `SendIfAvailable` direct auth | R-04, R-05, R-15 | 当前frontend bundle、稳定429、bootstrap token owner source | cookie-only旁路不承载当前官方wire；复用同一page evaluate即可，不新增endpoint或token出page |
| bootstrap subscription observer | R-14 | 用户dialog观察、default daemon marker可达 | R20已经前移；R24保留并与auth-only restart合并验收 |
| direct request-shape contract observation | R-15 | 当前frontend method/base/form/authOption source与真实429 | 旧测试明确断言无Authorization，必须改成当前官方wire并保留diagnostic边界 |
| runtime submission queue around complete `submitAsk` | R-16 | red/green对照；DOM submit后仍有core URL acceptance责任 | 现有队列没有跨操作副作用边界；只有core能同时拥有voice direct、lost墓碑、user turn和URL registry转换 |
| no new config/public endpoint | all | README and repository policy | baseline和R20都不新增消费者或公开边界 |
| DOM sidebar restore before Project discovery | R-17 | 当前MCP页面真实`pointer-events:none`/屏外按钮与可复现15秒失败 | 现有live discovery在隐藏侧栏上无法点击；只有DOM adapter拥有侧栏状态和事件语义，core不能自然承载 |
| Project `conversation/init` network convergence | R-18 | MCP cold ask日志在20秒URL观察失败后才出现conversation；fresh-page network明确init先于f/conversation和/c route | `ensureProjectHome`当前只等待DOM/title/composer，无法观察同页初始化响应；core不应复制ChatGPT网络匹配 |
| Project single-flight加入existing submission queue | R-19 | 4/2 cold overlap连续三次卡在expander可信click；无voice和2/1对照green | R26 queue已经拥有跨页远端副作用排序，但`ensureProject`当前在queue外；复用它比新增Project锁、click retry或DOM fallback更内聚 |
| test-only末端双marker长WAV合同 | R-12 | R36 audit B-01与当前`nonEmptyChars`断言 | 已有RIFF helper和真实整链可复用，但开头语音+尾部silence/非空断言看不到截断；运行时TTS提供独立expected且不引入production路径 |
| voice lease/preflight进入existing submission owner | R-20 | R36修复后4/2日志显示Project队头阻塞voice direct且voice lease仍在queue外执行；已有`withSubmission`可复用 | 现有voice acquisition在队列外，导致Project和另页`sessionPageFact`重叠；新增Project锁或延长voice deadline都不能承载已观察跨页CDP边界 |
| private marker browser lifecycle | INV-08, INV-14, INV-31 | 当前私有profile marker可连接Edge PID 56832；当前launch重试被同profile lock拒绝；用户要求自维护且不强杀 | 现有显式CDP分支只在配置存在时运行，默认launch从不读取private marker且close fallback会kill child |
| byte-tail log reader | INV-30 | 确定性Unicode feedback loop与真实bytes/UTF16差值 | 当前`readFileSync(...,'utf8').slice(byteOffset)`无法正确消费多字节日志 |
| four-attempt voice transaction | INV-03, INV-08, INV-15 | 用户明确至少三次重试；历史429随后成功；现有core在HTTP response前完成cleanup | 当前CLI只调用一次endpoint，且BROWSER_DISCONNECTED分支故意retire后抛错 |
| owner-produced recoverability codes + closed CLI classifier | INV-03, INV-15, INV-33 | DOM已拥有HTTP status/kind，core拥有login/page/browser/request cleanup，R55 audit证明统一500会重复确定性失败 | 现有message/500不能区分429、5xx、登录介入和4xx；CLI不能安全从文案重建这些事实 |
| acquisition provenance `{ browser, ownedByDaemon }` | INV-14, INV-33 | debug-port-only当前既可连接已有browser也可由daemon spawn，但静态`BROWSER_CDP_URL`把两者都当shared | shutdown/page cleanup必须消费实际启动来源，配置字符串无法承载ownership |
| persistent `browser-owner.json` verified by CDP browser PID | INV-14 | daemon.json在stale启动前必删；CDP `SystemInfo.getProcessInfo`真实返回browser PID；debug-port固定endpoint可重连 | daemon state无法跨异常退出，端口/profile alone会误关用户browser；三元组是最小可验证事实 |
| 1/2/4秒retry backoff | INV-03, INV-15 | 近期429后3.7至7.5秒下一条成功；旧批量同一WAV约60秒后成功 | 当前没有retry pacing；固定短退避无需引入新配置、header parser或长期timer |
| Process `killTree` option consumed only by TUI voice | INV-32 | Windows通用abort当前`taskkill /T /F`；voice child会启动独立daemon/browser且用户禁止强杀 | 改全局默认会破坏其它Process consumers；voice call-site需要显式关闭tree kill |
| acquisition-local provenance cleanup | INV-31, INV-34 | 隔离headless repro在helper异常后仍可连接marker；outer daemon变量尚未赋值 | 现有`closeOwnedBrowser`与shared disconnect合同可复用，但必须由仍持有`acquired`的helper在throw前调用 |
| local daemon identity code + current-state reconciliation | INV-15, INV-35 | `/ping`确认旧state后业务401红环；R61审计证明旧token不能retire current daemon；page auth已有独立code | adapter是最早能标识local 401的owner；只有orchestration能重新读取current discovery并验证身份变化/usable，现有retire会错误unlink |
| isolated default-private lifecycle modes | INV-08, INV-31, INV-34 | R60批准file plan/commands未实施；用户观察到前一可见临时profile干扰 | `test-mcp` direct/fixed-port不能证明production default-private daemon chain；随机state+headless保留production profile推导且不触碰用户profile |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js` | modify | R60 provenance/profile矩阵保持；R61让`acquireBootstrapBrowser`在所有pre-ready异常出口执行shared disconnect或owned verified graceful close，仅持续不收敛可cold一次。 | R61约+20/-8 |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 不改wire/重试编排；仅在现有direct catch中把HTTP 429、5xx、其它4xx原位映射稳定code，transport/page/endpoint保持现有kind。 | 约+12/-3 |
| `thirdparty/chatgpt-browser-agent/chatgpt.js` | modify | R60 byte-tail/four-attempt保持；R63把local daemon HTTP 401映射code，重新读取并验证changed current state后才允许下一attempt；不retire/stop/unlink。 | R63约+18/-2 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 增加pre-ready异常不遗留default-private browser，以及local daemon identity A→B reconciliation后下一attempt成功；断言A/B stop均0并保留auth/403单次回归。 | R63约+70/-5 |
| `thirdparty/chatgpt-browser-agent/test-voice-robustness.js` | modify | 增加headless随机state的default-private daemon crash marker reconnect与bootstrap cold recovery production modes；失败时graceful cleanup。 | R61约+110/-5 |
| `thirdparty/chatgpt-browser-agent/README.md` | modify | 同步private profile marker生命周期、graceful close、最多四attempt和non-retry边界。 | 约+20/-12 |
| `packages/opencode/src/util/process.ts` | modify | 为既有`Process.run`增加默认保持现状的`killTree?: boolean`；仅voice caller传false，使主动取消只终止CLI父进程。 | 约+12/-4 |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts` | modify | 总兜底改为`4 * (180s daemon + 120s HTTP) + 7s backoff + 30s cleanup = 1,237,000ms`并对transcriber使用`killTree:false`；用户Abort仍立即生效。 | 约+8/-3 |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | modify | 锁定新总预算、父进程取消不递归终止grandchild、WAV清理和后续调用。保留300秒末端marker E2E。 | 约+55/-10 |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts` | no change | 录音native资源和WAV文件生命周期不属于browser daemon根因。 | 0 |

R61相对当前R60 worktree新增production有效修改估算不超过30行；完整任务production有效修改预计不超过470行，仍低于用户600行硬上限。新增测试不引入公开配置、依赖、migration、generated file或第二browser/voice实现。实现审计必须按完整实际diff逐hunk检查。

## 16. TDD Behavior Slices

1至13是R10/R18实施期已完成的baseline行为证据，不是R24授权重复实施的red slice。R20 slice 14 observer已落地但profile/voice耦合错误；R24执行14（auth-first profile）、15（四态single-source fact）、16（startup convergence）、17（官方direct auth wire）与18（fresh voice convergence）。约定seam是现有adapter、daemon/voice acquisition testing hooks和CLI robustness harness；静态bundle只作producer evidence。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1-13 | R10/R18 baseline：Project lazy/cache、direct-only、稳定lease、取消/资源/提交计数均已有实现和对应red-green记录；其中DOM文案事实、fresh page立即snapshot和cookie-only wire已被R24当前证据反证。 | 其它历史red已修复；下面四个认证/收敛vertical slice不能重做其余baseline。 | 只做当前worktree回归验证；在现有DOM/core owner原位替换。 | 保持voice启动、ask兼容、direct-only和安全边界。 |
| 8 | TUI cancel在direct pending和页面任务pending时返回；下一次voice能成功，旧任务不再写页面。 | 当前日志出现task未settle，现有测试没有真实late operation。 | 有界abort、真实settle或page隔离后释放voice lock；仅作为回归。 | voice cancel后daemon后续请求阻塞。 |
| 9 | 4路voice与ask并发时，voice串行、ask不共享voice page，所有结果不串台。 | 现有锁部分覆盖，但startup/bootstrap和fallback前台耦合未验证。 | 复用既有runtime allocation/lock，不增加全局串行。 | 高负载并发回归。 |
| 10 | R54历史：offline seam证明disconnect handler与旧单次voice不重发；owned E2E关闭唯一agent Edge后下一独立voice成功。 | 旧合同不能证明R55同一CLI事务恢复。 | R55由slice 31、33、34替换其恢复合同；旧browser-close仍作回归。 | 用户关闭Edge后的完整生命周期。 |
| 11 | 现有ask/session/pending/Project/foreground离线测试继续通过。 | lazy Project可能影响runtime project读取。 | 只在ask入口ensureProject，保留原Session身份链。 | 既有ask兼容和安全边界。 |
| 12 | 环境门禁TUI controller使用真实`node chatgpt.js transcribe-file`和约300秒WAV：有效PCM只在末端含运行时TTS双marker，长结果必须含两个独立预期词、回idle并删除WAV/marker中间文件；随后同一controller/daemon的短fixture必须返回另一组预期词。 | 当前测试只断言`inserted[0]`非空，截断、旧short结果或任意非空文本都可通过；接受timeout同样保留用户缺陷。 | test-only RIFF helper把合法marker frames置于末端并归一文本断言；production算法/timeout不改，只有真实red定位到owner后才修。 | 长音频末端完整性、TUI deadline、stale结果、临时文件和daemon共同生命周期。 |
| 13 | 隔离daemon执行3轮，每轮4路voice并在每2路后立即启动一个独立new ask：要求12/12 voice、6/6 ask、六个唯一Session、`accepted=6`、0失败/超时、voice p95<=120s、`voiceSubmitted`增量12；每轮active/queued/locks=0、voice pages<=1、累计managed pages<=7，最后短voice成功。 | 旧同Session同prompt会completed replay；harness级askTail还会把第二ask推迟到voice结束，降低真实overlap敏感度。 | 删除harness的session复用和askTail；仍依赖现有production new-conversation lock/submission queue，不增加生产并行或重试。 | 多轮voice/new-ask高压、六次真实接受、无重复提交和daemon长期稳定。 |
| 14 | profile模式先观察第一次bootstrap一致且无dialog，不发voice；graceful stop后第二次bootstrap仍一致，再只发一个short voice。任一步失败时daemon/browser保持可检查。 | 当前`runProfileRestart`在第一次voice后才验证，并在任何错误的`finally`中stop；登录持久与429互相污染。 | 重排现有harness，不新增production启动器；只在全部步骤成功后显式清理。 | 长期登录、首屏错误、失败现场和不重复关闭用户profile。 |
| 15 | `sessionPageFact`公开adapter seam覆盖四个真实/可达状态：guest complete为logged-out；logged-in bootstrap + composer + 无登录入口为authenticated；document未完成为loading；logged-in bootstrap与login/composer矛盾为inconsistent。wait模式只在terminal时提前返回，timeout返回最新非terminal；结果不含token。 | 当前只有两个重叠boolean接口，真实guest被误判且无法表达loading/inconsistent。 | 删除正文正则和双authority，只读`#client-bootstrap`并通过load/MutationObserver实现同一四态接口。 | guest copy漂移、source disagreement、core责任泄漏、token泄露和stable lease误用。 |
| 16 | startup seam依次收到inconsistent后authenticated时等待且不reload；持续nonterminal超时后只reload一次并重新消费同一fact，一致后ready；第二次仍nonterminal则失败且不写ready；logged-out只进入login wait不reload。 | 当前`Promise.race`后立即布尔判定，无法表达这些不同transition。 | core只switch `kind`，导航预算严格为一次且只在daemon ready前。 | 半加载、误刷新登录页、反复刷新、过早ready和无限恢复循环。 |
| 17 | 正常logged-in `#client-bootstrap` fixture通过现有DOM adapter发起一次direct：实际请求必须是当前endpoint、multipart `file`、credentials、accept/language和Bearer；adapter返回已知text且不返回token；logged-out fixture在POST前失败且request count为0。 | 当前实现明确不构造Authorization，并会在无bootstrap session时POST；wire测试在当前实现下确定性red。 | 同一page.evaluate内读取bootstrap token并附带官方`SendIfAvailable`已认证头；不恢复`/api/auth/session`fetch，不新增endpoint/fallback/retry。 | 稳定429根因、官方direct契约、无凭证副作用和同请求一次提交。 |
| 18 | fresh/navigated dedicated page在`domcontentloaded`后先返回loading/inconsistent、随后authenticated：同一candidate必须等待后通过两次snapshot并只POST一次，不能关闭/续租；terminal wait超时才允许既有一次续租。复用authenticated页不得新增等待或导航。 | 当前new page在goto后立即两次probe，真实正常hydrate延迟足以使该测试red并消耗renewal。 | voice acquisition携带fresh/navigated布尔给stabilize seam；只对该candidate调用一次bounded terminal wait，再沿用两次snapshot。 | age/5分钟idle、browser recovery、好坏交替、无多余页面和无POST后重试。 |
| 19 | 同runtime并发两个voice和一个new ask：第一个voice direct pending、第二voice排队；ask在第一个voice后完成唯一click、user turn和conversation URL记录，再与第二voice并发等待回答。结果必须2 voice/1 ask成功、无lost、各一次。 | 当前voiceLock与foregroundQueue独立，最小环产生user turn不增长/lost。 | 新增`withSubmission`；包`transcribeAudioFile`和完整`submitAsk`，`finishAsk`在外；失败推进后继且不重试。 | 伪发送、URL未记录、Session lost、压力和全局串行。 |
| 20 | 完整压力中每个ask都不带`--session-id`并使用唯一prompt，六个结果必须返回六个不同Session；两个new ask可并发启动，生产`withNewConversationLock`只串行短创建/接受事务，回答等待并发。本轮daemon log必须恰有六次`Prompt sent`。 | 旧同Session同prompt五次completed replay；同Session distinct prompt又进入与voice无关的generic continuation reset。 | 只修harness producer，不改production；使用原始缺陷对应的new ask，累计managed pages阈值调整为7且低于cap 12。 | 多轮真实voice/new-ask overlap、无replay假通过、无generic ask范围扩张和资源有界。 |
| 21 | collapsed sidebar页面仍含MCP row，但Project discovery必须先恢复侧栏交互终态，再通过现有首页按钮完成真实导航；隐藏/不可命中的副本不能造成15秒等待失败。 | 当前DOM结构中侧栏`pointer-events:none`、首页按钮屏外且命中外层surface；现有adapter只按几何尺寸判断。 | DOM owner按结构化sidebar toggle恢复并等待可命中状态，然后复用现有row/home trusted click；不新增URL导航或第二Project来源。 | MCP名称解析、fresh-page half-loaded页面和Project identity安全边界。 |
| 22 | live sidebar首页click后，真实Project页先完成`POST /backend-api/conversation/init`成功响应，再交给ask submit；若初始化延迟，不能在20秒conversation URL观察前让prompt click与首屏网络竞争。 | R35 MCP cold ask首个真实red；页面顺序由脱敏CDP观察确认，当前`ensureProjectHome`只按DOM/title/composer返回。 | DOM owner在真实ChatGPT首页click前登记同页init response并有界等待成功；超时沿既有Project unavailable诊断，不能延长全局acceptance、猜URL或重发。 | 首次MCP ask稳定acceptance、既有trusted click/lost墓碑和无重复发送。 |
| 23 | cache/currentProject已解析但new Session拥有fresh page时，`ensureProjectHome -> page.goto(candidate.url)`也必须等待同一`conversation/init`成功事件；不能只有live sidebar producer受保护。 | 每个独立new Session的`restoreSessionPage`可达该goto路径；R34审计B-02确认其绕过live sidebar gate。 | core只标记fresh URL navigation并调用DOM统一seam；DOM不复制Project policy，既有same URL/valid identity路径保持直通。 | 六个独立new Session压力不会在后续page上重新触发20秒URL acceptance red。 |
| 24 | 一个voice submission占用queue时，并发两个first ask调用`ensureProject`：Project initializer不得与voice remote transaction重叠，两个ask必须得到同一Project结果；voice释放后initializer才开始，initializer完成后普通ask submission仍可继续。 | 当前`ensureProject`直接调用`initializeProject`，受控并发seam会观察`maxRemote=2`；真实4/2 cold overlap卡在可信expander click。 | single-flight创建的唯一task先通过已有`withSubmission`，再执行initializer；不新增锁、retry或adapter分支。 | cold Project/voice高压、single-flight、queue失败推进、existing Session与结果等待并发。 |
| 25 | ask-first时Project initialization先入queue；voice随后进入，必须先排队整个voice lease/stability再direct。Project click不能与voice `sessionPageFact`重叠，voice queue前取消不创建page，queue内取消后下一voice成功。 | R36只移动Project而保留`runtime.voiceLease()`在queue外，真实4/2出现voice direct无完成并60秒timeout。 | 将voice lease创建置于已有submission transaction并用请求局部取消锁存跳过未开始任务；不引入第二队列、retry或deadline扩张。 | ask-first 4/2真实反馈环、取消/迟到任务回归、完整12/6压力。 |
| 26 | new Session的target allocation不得与cold Project trusted click重叠；target allocation仍可在voice direct期间准备页面，以保持第一voice后ask优先进入接受窗口。 | R53中第一ask已进入Project click时第二ask仍执行`browser.newPage()`；button具备React onClick但trusted event始终未产生，root与`about:blank`保持至60秒。R51候选把allocation放进submissionQueue后，既有2 voice/1 ask测试超时，证明它错误改变第二voice/ask顺序。 | 抽取既有`pageCreateQueue`临界区为私有`withPageCreationExclusion()`；page claim/allocation与cold Project initializer共用该排他边界，Project仍同时经过submissionQueue。 | allocation与Project initializer不重叠；既有2 voice/1 ask顺序保持green；fresh 4/2不再因target creation卡住click。 |
| 27 | 页面内direct fetch的AbortController必须消费当前voice请求剩余总预算，不能按短音频大小另造15秒更早deadline；POST仍只有一次，真实transport失败仍原样失败并退役page。 | R52中ready bootstrap在147ms稳定，唯一direct随后精确约15秒报`signal is aborted without reason`；源码短音频公式固定为15秒，而当时core请求仍有约45秒。 | core在唯一POST前读取`shouldCancel.remaining()`并通过现有internal options传给DOM；DOM page timer使用该剩余值。R53默认core绝对deadline为80秒，取消和退役逻辑不变。 | 本地同源endpoint在15秒后、剩余预算内返回时成功且POST一次；超时/取消仍settle或隔离。 |
| 28 | trusted send click开始后，新增user turn是唯一接受事实；它应在既有20秒conversation acceptance边界内等待事件，不能用独立10秒窗口把稍晚出现的真实turn记为lost。 | R55双ask中一条在10秒报`Waiting failed`并写lost，但同一受控page随后出现严格MCP conversation URL、1个user turn和1个assistant turn。 | `clickSend()`继续等待同一user-turn predicate，只把上限改为`min(responseTimeout, 20_000)`以对齐随后既有URL记录边界；不接受URL/composer清空替代，不重发。 | 延迟超过10秒但小于20秒的trusted acceptance成功；route-only仍失败且`promptMayHaveBeenSent=true`。 |
| 36 | default-private browser已连接后，bootstrap preparation/navigation/fact抛普通异常；调用失败后marker endpoint必须不可达且profile可被下一cold acquisition使用。shared endpoint仍保持活。 | 当前helper仅清理`SESSION_PAGE_DID_NOT_CONVERGE`，已运行repro得到`orphanReachable=true`。 | 在持有`acquired`的catch内统一收敛；只有首轮owned持续不收敛且close成功继续cold，其它异常close/disconnect后原样throw。 | 原始孤儿profile、about:blank失败、shared不误关和cold预算不扩张。 |
| 37 | CLI先使用state A通过`/ping/status`，A的`/voice`处理时原子发布state B并返回local 401：下一attempt必须只复用usable B并成功，A/B `/stop`均为0。A仍是current、发现文件缺失或B unusable时原401立即失败；ChatGPT auth/403仍只请求一次。 | 当前401无code不进入classifier；R61的旧token retire会401后unlink B。 | local adapter产专属code；orchestration比较A/B四元身份并验证B usable，只授权existing loop下一attempt；不stop、不unlink、不直接成功。 | 并发daemon replacement identity自解决，无竞争daemon、无误删current索引，不放宽其它4xx。 |
| 38 | `test-voice-robustness.js --daemon-crash-reconnect`在随机state/default-private profile首voice后仅终止daemon PID；Edge endpoint保持，下一production CLI重连同endpoint且voice成功，真实stop释放profile。 | R60只在`test-mcp`覆盖direct marker和fixed-port daemon，批准mode缺失。 | test-only wrapper只注入authenticated voice结果；production CLI/daemon/acquisition/marker/stop全部真实，headless仅由test hooks启用。 | default-private daemon异常退出完整producer-consumer链和用户profile隔离。 |
| 39 | `--bootstrap-cold-recovery`首个default-private lifecycle持续不一致，production必须graceful close并验证release，再cold第二browser、voice成功和stop清理；失败也无可见/后台测试browser残留。 | 批准mode缺失，已有helper测试不覆盖daemon/CLI/state/profile边界。 | test-only DOM fact只控制首/第二lifecycle事实；production acquisition/close/cold/HTTP route保持真实。 | bootstrap退化自解决、无强杀、无替代profile、测试不干扰用户。 |
| 29 | R54历史：voice总deadline从入队前绝对计时，默认80秒容纳已观察cold FIFO，并受当时TUI 90秒和CLI 120秒外层约束。 | R57历史red。 | R54已实施；R55不改core单attempt预算，只替换TUI transaction外层。 | R54 deadline/cancel fixture继续green。 |
| 30 | daemon log在中文前缀后立即追加`Startup error: fixture launch failed`；CLI必须约1秒返回该具体错误而非等满startup timeout。 | byte offset被用于UTF-16 string slice，确定性fixture当前只返回通用错误。 | 两个consumer从offset读Buffer尾部再UTF-8 decode，不改变marker语法。 | 多字节日志不再造成180秒假卡死；ASCII日志与login-required仍正确。 |
| 31 | private marker已指向仍运行的Edge而daemon不存在；新daemon必须connect同一browser并完成bootstrap，不执行第二次spawn。 | 默认`puppeteer.launch`不读取marker并因profile lock立即失败。 | 默认private owner先解析`DevToolsActivePort`完整endpoint并connect；只在marker不可连接且profile可启动时cold spawn。 | daemon异常退出后自恢复，用户手动可用页面不再成为孤儿锁。 |
| 32 | 无private browser时cold spawn先出现内部blank，marker/CDP ready后由唯一bootstrap owner导航ChatGPT；daemon ready时不得有about:blank，失败后不得留下无主blank browser。 | 直接URL启动已有订阅Failed to fetch；blank→CDP→bootstrap导航对照保持登录且无同源失败。 | 使用现有executable/args spawn blank，轮询marker后connect，再复用现有startup goto/convergence。 | cold startup、登录态、订阅首屏与bootstrap单一authority不回归。 |
| 33 | 已连接private browser的bootstrap持续不可用时，必须发送一次CDP `Browser.close`、等待profile释放，再沿同一cold path成功；关闭超时只disconnect并明确失败，不强杀。 | 当前close fallback调用child kill；daemon/browser异常边界会遗留profile或破坏持久状态。 | private lifecycle owner执行graceful close-to-cold transition；shared只disconnect。 | 退化about:blank/坏页面可自解决，同时保护cookie和普通Edge。 |
| 34 | fake daemon前三次分别返回429、5xx、transport/browser稳定code，第四次返回文本；CLI应有四次同一POST并成功。第四次仍失败时返回最后错误。 | 当前CLI只有一次endpoint调用；统一500不能安全分类。 | producer code表 + 单一for-attempt orchestration，每次完整预算，清理后1/2/4秒退避。 | 429、daemon重启、page和transport按用户合同恢复，无alternate wire。 |
| 35 | login wait timeout、ChatGPT auth/401/403、无效WAV、用户Abort、CLI signal和未知code只执行一次/零次endpoint并立即终止；取消后不得排队后续attempt。local daemon identity 401只由slice 37覆盖。 | R55宽泛runtime重试会让登录等待重复四次。 | 本地校验在loop外；DOM/core/startup原位产code；CLI只消费封闭集合，unknown fail closed。 | 用户介入及时、确定性失败不放大、WAV仍清理。 |
| 36 | TUI默认允许四个完整attempt、三次退避与清理余量，但用户取消时只终止transcriber CLI，不在Windows递归杀daemon/browser grandchild。 | 当前90秒/tree kill抢先破坏；R55的1230000ms漏算7000ms退避。 | 新总兜底1237000ms；`Process.run({ killTree:false })`仅voice opt-in。 | parent abort fixture、精确预算、TUI cleanup与后续voice；其它Process caller默认行为不变。 |
| 37 | debug-port-only在端口预先可达时连接且stop只disconnect；不可达时daemon spawn固定端口并在stop graceful close；两者bootstrap行为相同，ownership断言不同。 | 当前静态`sharedBrowser=!!BROWSER_CDP_URL`会把daemon自己spawn的固定端口browser误判shared。 | acquisition返回provenance；shutdown/stale-page只消费result。 | README公开debug-port reuse/launch合同、用户browser安全和daemon正常关闭。 |
| 38 | debug-port不可达→spawn owned→只终止daemon→新daemon先删除stale daemon.json→同端口重连仍为owned→正常stop必须使endpoint不可达并删除匹配owner record。mismatch fixture必须只disconnect并保留record/endpoint。 | daemon discovery state不保存browser provenance，R59会在崩溃后退化shared。 | 原子owner record + 当前CDP browser PID/profile/port全匹配；close compare-delete。 | 原始孤儿/profile lock闭环、普通Edge fail-safe、不依赖PID扫描。 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | 约680 | 完整R63 production与tests实际行为行；排除空行、import-only、文档、pure move、formatter和generated。actual implementation audit逐行重算。 |
| Required Chinese explanatory comments `C` | 至少102 | `ceil(680 * 0.15) = 102`；当前R60实际候选已超过该值，R63新增注释仍须就近解释acquisition cleanup、local 401 owner和隔离E2E。 |

必须解释的非显然点：

- voice启动不能读取或验证Project的责任边界。
- cache-first仍必须经过Project网页身份验证，不能把缓存当可信真相。
- direct失败为何返回诊断而不是UI fallback或重发。
- 稳定health/完整body为什么是voice复用和完成的依据，为什么不能用一次成功或取消信号代替。
- cancel为什么只作为回归边界，仍必须等待真实页面任务settle或隔离后才能释放lock。
- shared CDP为何只disconnect，owned launch为何可bounded close。
- 为什么bootstrap token只能在页面上下文用于当前direct，不能进入Node/core/status/log；为什么不再访问旧session endpoint。
- 为什么正常composer hydrate只等待事件，而持续混合状态最多reload一次且不能在voice POST后恢复。
- 为什么只有fresh/navigated voice candidate先等待terminal，已收敛复用页仍使用立即snapshot。
- 为什么submission queue覆盖到core记录可信conversation URL，随后必须在`finishAsk`前释放，且不能演变成失败重试。
- 为什么profile测试只识别主Edge进程并排除helper，不能用宽泛进程名关闭用户浏览器。
- 5分钟idle测试为何使用缩短age环境模拟而不新增生产轮询。
- 为什么侧栏DOM已存在仍不能代表可点击；恢复同一网页toggle是Project adapter的前置条件，不是Project URL fallback。
- 为什么Project首页h1/composer出现仍不能代表首屏网络已完成；`conversation/init`只作为同页初始化事实，不能当作conversation身份或成功结果。
- 为什么live sidebar click与cache/currentProject fresh-goto必须共享一个DOM网络事实，而不能由core复制endpoint匹配；already-current页为何不重复注册初始化事件。
- 为什么cold Project single-flight属于现有远端submission transaction，而不是新增Project锁；为什么该queue在Project验证后、ask submit前必须释放。
- 为什么voice lease/stability也必须在该queue内开始，且queue前取消必须跳过page创建；为什么不能只移动direct POST或抬高voice deadline。
- 为什么长WAV必须把独立marker放在末端并断言具体词，而任意非空文本不能证明完整处理；为什么TTS只属于显式本地E2E且不能进入普通CI。
- 为什么通用Project discovery只采集URL候选并按href去重；不同ID身份由纯policy裁决，无href名称歧义由可信click owner裁决。
- R41 discovery fixture为什么同时包含同href MCP副本和无关重复名称，以锁定采集责任而不复制production身份算法。
- 为什么`aria-expanded=false`的Project row不能被当作列表展开控件；真实页面的Project内容状态与列表可见性是两个DOM语义。
- R43 discovery fixture为什么必须观察Project row的可信click副作用，而不是只断言候选数量。
- 测试断言用户可观察的导航、返回、后续调用和资源副作用，而不是helper调用次数。
- 为什么默认`STATE_DIR/profile`的marker可作为daemon私有browser连接事实，而显式shared profile/CDP不能进入该owner。
- 为什么daemon异常退出后保留browser并重连比重新launch或强杀更能维护profile；正常stop为何只能CDP graceful close。
- 为什么日志游标必须保持UTF-8 byte语义，不能先decode再按byte slice。
- 为什么四次attempt是同一primary transaction迭代，且每次必须等前一request settle/隔离后才退避，不能在DOM adapter内部重发。
- 为什么本地输入错误和用户取消不重试，而HTTP/transport/page/browser/daemon运行错误按用户合同进入下一attempt。
- 为什么TUI总兜底按四个完整daemon+HTTP预算计算，但主动取消仍立即终止CLI且不递归终止daemon/browser。
- 为什么HTTP status、login和browser事实必须在producer原位变成稳定code，CLI只能消费封闭集合且unknown fail closed。
- 为什么cold spawn允许内部blank作为CDP过渡，但必须由bootstrap owner导航后才ready；为什么不能直接URL启动或把blank留给用户。
- 为什么debug-port已可达与daemon本次spawn必须产生不同ownership，且shutdown不能再由静态URL配置推导。
- 为什么debug-port owner record必须独立于daemon.json并由当前CDP browser PID验证；为什么缺失/mismatch只能shared fail-safe。
- 为什么pre-ready任意异常必须由仍持有provenance的acquisition helper清理，而outer daemon catch无法补偿；为什么只有持续不收敛可进入一次cold。
- 为什么local daemon 401属于daemon identity lifecycle，而page-local `VOICE_AUTH_REQUIRED`仍是确定性登录错误；不能按status泛化所有401。
- 为什么default-private E2E必须使用随机state自然推导`state/profile`并headless隔离，不能借用户登录profile或fixed-port替代默认producer。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `node --check chatgpt-core.js && node --check chatgpt-dom.js && node --check chatgpt.js && node --check test-mcp.js` | `thirdparty/chatgpt-browser-agent` | JS语法和删除fallback后的引用完整。 |
| `TMPDIR=/private/tmp node test-mcp.js testVoiceStartupSkipsProject testExistingSessionSkipsDefaultProjectInitialization testLazyProjectInitializationSingleFlight testProjectCacheRetainsTransientValidation testProjectCacheReplacesProvenStale testSessionPageFactUsesBootstrapAuth testStartupRecoversMixedLoginOnce testFreshVoicePageWaitsForConvergence testVoiceAndAskSerializeRemoteSubmission testSubmitUsesTrustedClick testBorrowedVoiceStablePreflightRenewsOnce testVoiceStablePreflightRejectsLoggedOutPage testDirectVoiceUsesBootstrapAuth testDirectVoiceSubmitsOnce testOwnedBrowserDisconnectLifecycle testVoiceStatusCounts` | `thirdparty/chatgpt-browser-agent` | R24/R26回归；ask不lost、一次trusted click、voice各一次、结果等待并发、无fallback和资源收敛。R29不新增composer-remount行为。 |
| `TMPDIR=/private/tmp node test-mcp.js testProjectDiscoveryCollectsDistinctProjectLinks testProjectHomeDiscoveryUsesLiveSidebar testProjectPinUsesSingleRecoveryChain` | `thirdparty/chatgpt-browser-agent` | R41 discovery只采集/按href去重；R33 name-only目标同名在click前拒绝；纯Project policy对不同ID目标同名拒绝；并覆盖可信首页click和R35网络收敛。 |
| `TMPDIR=/private/tmp node test-mcp.js testCoreProjectStateMachine` | `thirdparty/chatgpt-browser-agent` | R36/R38毫秒级受控并发：Project initializer与active voice不重叠；voice lease/preflight进入同一queue；两个first ask共享结果；queue前取消不创建lease且后续voice继续。 |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_PROJECT=MCP node test-voice-robustness.js --load --rounds 1 --voice-per-round 2 --ask-every 2 --expect-voice 2 --expect-ask 1 --max-p95-ms 120000 --max-voice-pages 1 --max-managed-pages 2` | `thirdparty/chatgpt-browser-agent` | MCP Project原始最小伪发送环：2/2 voice、1/1 new ask、0 lost/timeout、提交数和资源阈值全部通过。 |
| `CHATGPT_STATE_DIR=/private/tmp/chatgpt-cold-overlap-r38 CHATGPT_SESSION_DIR=/private/tmp/chatgpt-cold-overlap-sessions-r38 CHATGPT_BROWSER_USER_DATA_DIR=/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/profile CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_PROJECT=MCP node test-voice-robustness.js --load --rounds 1 --voice-per-round 4 --ask-every 2 --expect-voice 4 --expect-ask 2 --max-p95-ms 120000 --max-voice-pages 1 --max-managed-pages 3` | `thirdparty/chatgpt-browser-agent` | R38 ask-first cold高压：4 voice/2独立ask成功，Project click与voice preflight/direct不重叠，voice不因Project FIFO队头达到60秒deadline，两个Session各有可信acceptance。 |
| `TMPDIR=/private/tmp CHATGPT_PROJECT=MCP node chatgpt.js --raw "Reply exactly OK."` | `thirdparty/chatgpt-browser-agent` | R35 red/green反馈环：MCP live/cache两类fresh Project page都必须先完成同页初始化再接受一次真实ask；不得硬编码URL/token。 |
| `node .temp/testing/chatgpt-voice-auth-evidence/inspect-current-wire.cjs` | repository root | 前置：default owned daemon与已登录Edge正在运行且`DevToolsActivePort`可连接。独立复跑真实logged-in/guest producer与公开frontend wire；只产生忽略目录非敏感artifact，不发transcribe。 |
| `TMPDIR=/private/tmp npm test` | `thirdparty/chatgpt-browser-agent` | 完整离线suite、依赖和MCP协议回归。 |
| `bun test test/cli/tui/prompt-voice-input.test.ts` | `packages/opencode` | 普通环境只跑TUI AbortSignal、录音清理和转录器协议离线回归；真实Edge用例因门禁而跳过。 |
| `bun typecheck` | `packages/opencode` | package-local TypeScript类型检查。 |
| `CHATGPT_STATE_DIR=/private/tmp/chatgpt-pressure-r38 CHATGPT_SESSION_DIR=/private/tmp/chatgpt-pressure-sessions-r38 CHATGPT_BROWSER_USER_DATA_DIR=/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/profile TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_PROJECT=MCP node test-voice-robustness.js --load --rounds 3 --voice-per-round 4 --ask-every 2 --expect-voice 12 --expect-ask 6 --max-p95-ms 120000 --max-voice-pages 1 --max-managed-pages 7` | `thirdparty/chatgpt-browser-agent` | fresh隔离state的MCP Project同一daemon下12/12 voice、6个独立new Session/distinct ask、6个唯一句柄和`accepted=6`；0超时/失败、voice提交增量12、每轮锁收敛、累计page不超过7、最后voice通过。 |
| `TMPDIR=/private/tmp node test-mcp.js testOwnedBrowserDisconnectLifecycle testVoiceRetriesAfterBrowserDisconnect testVoiceSkipsStaleBrowserDaemon` | `thirdparty/chatgpt-browser-agent` | 离线证明disconnect后request先清理、CLI下一attempt重连/cold恢复及stale索引淘汰。 |
| `env -u CHATGPT_BROWSER_CDP_URL -u CHATGPT_BROWSER_WS_ENDPOINT TMPDIR=/private/tmp CHATGPT_BROWSER_DEBUG_PORT=0 CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node test-voice-robustness.js --browser-close --gap-ms 5000` | `thirdparty/chatgpt-browser-agent` | 只关闭唯一owned agent Edge后代，不手工清state；生产disconnect自清理后下一独立voice必须成功。 |
| `env -u CHATGPT_BROWSER_CDP_URL -u CHATGPT_BROWSER_WS_ENDPOINT TMPDIR=/private/tmp CHATGPT_BROWSER_DEBUG_PORT=0 CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node test-voice-robustness.js --profile-restart` | `thirdparty/chatgpt-browser-agent` | 真实default daemon启动后立即通过其`DevToolsActivePort`挂载观察器，覆盖bootstrap到ready的首屏dialog；随后cold voice、graceful stop、同profile再次cold voice成功；harness只识别主Edge进程，不把helper误判为多个owner。 |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice CHATGPT_VOICE_PAGE_MAX_AGE_MS=100 node test-voice-robustness.js --idle --gap-ms 250` | `thirdparty/chatgpt-browser-agent` | 加速5分钟age策略；voice不解析Project，因此该命令不设置`CHATGPT_PROJECT`。 |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node test-voice-robustness.js --idle --gap-ms 300000` | `thirdparty/chatgpt-browser-agent` | 最终真实5分钟间隔Edge/profile验证；voice不依赖Project，只在前述加速回归通过后执行。 |
| `TMPDIR=/private/tmp CHATGPT_VOICE_FILE_ROOTS=/private/tmp/opencode/voice node chatgpt.js transcribe-file --file /private/tmp/opencode/voice/test-hello.wav --json` | `thirdparty/chatgpt-browser-agent` | 使用默认缺失MCP配置的direct cold start仍不先Project导航并返回真实文本；短fixture由robustness harness生成。 |
| `node chatgpt.js --stop` | `thirdparty/chatgpt-browser-agent` | TUI长链E2E前清理agent daemon；shared CDP只disconnect，owned browser按既有契约关闭。 |
| `CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> CHATGPT_VOICE_E2E_EVIDENCE=/private/tmp/opencode/voice/long-voice-e2e.json TMPDIR=/private/tmp bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "five-minute WAV"` | `packages/opencode` | 仅Darwin本地人工门禁：300秒WAV末端两个独立marker和short独立预期均匹配，全部WAV/TTS中间文件删除，精确daemon退出；可选JSON只含匹配布尔/长度/cleanup，不含token/audio/text/PID。普通CI门禁关闭并skip。 |
| `node chatgpt.js --stop` | `thirdparty/chatgpt-browser-agent` | 最终E2E后有界停止agent daemon并保存profile状态；不关闭shared user browser。 |
| `git diff --check` and changed-file inspection | repository/nested repo as applicable | whitespace、无关文件和submodule工作树边界。 |
| `node test-mcp.js testDaemonStartupErrorUsesByteOffset testBrowserAcquisitionProvenance testPrivateBrowserReconnectsMarker testPrivateBrowserColdStartsViaBootstrap testPrivateBrowserRecoversBootstrapGracefully testDebugPortConnectIsShared testDebugPortSpawnIsOwned testDebugPortOwnedSurvivesDaemonCrash testDebugPortOwnerMismatchIsShared testVoiceRetryCodes testVoiceRetriesRecoverableFailure testVoiceRetryStopsAfterFourthFailure testVoiceDoesNotRetryLoginAuthResponseConfigInputRejectOrCancel` | `thirdparty/chatgpt-browser-agent` | R60确定性red/green：Unicode/code、profile/debug-port provenance跨crash、blank/graceful close、recoverability/non-retry。 |
| `node test-voice-robustness.js --daemon-crash-reconnect` | `thirdparty/chatgpt-browser-agent` | 真实默认private profile：首个voice后只终止daemon，browser保持；下一CLI重连同一marker并成功，不扫描或强杀Edge。 |
| `node test-voice-robustness.js --bootstrap-cold-recovery` | `thirdparty/chatgpt-browser-agent` | 可连接但bootstrap不可收敛的private browser经CDP graceful close、profile释放和同一cold path恢复；shared模式明确skip close。 |
| `node test-mcp.js testPreReadyFailureReleasesPrivateBrowser testDaemonIdentityMismatchReconcilesCurrentDaemon testDaemonIdentityMismatchFailsClosedWithoutChangedUsableState` | `thirdparty/chatgpt-browser-agent` | R63最小red-green：pre-ready异常后无marker endpoint/profile lock；A→B identity切换后不stop/unlink并由下一attempt成功；unchanged/missing/unusable fail closed，ChatGPT auth/403仍单次。 |
| `$env:CHATGPT_DAEMON_START_TIMEOUT_MS='3000'; node chatgpt.js transcribe-file --file <hello-wav> --json` | `thirdparty/chatgpt-browser-agent` | 原始快速反馈环不再返回通用startup timeout；健康private marker时输出`Hello world.`，真实启动错误则立即输出具体producer错误。 |
| `bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "voice transcriber"` | `packages/opencode` | R56 TUI默认1237000ms（含7000ms退避与30000ms清理）、主动取消、parent-only kill、WAV cleanup及后续调用；其它Process caller tree-kill默认不变。 |

真实登录/长语音E2E只在离线红绿完成后使用现有Edge和用户profile；R61 default-private lifecycle E2E使用随机state自然派生的headless隔离profile，不需要登录且不得触碰用户profile。两类测试结束都必须通过production `--stop`或CDP graceful close；shared CDP只disconnect，不清理用户profile/session缓存。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 0 | canonical plan在根docs中已创建，不属于实现文件；生产/测试不新增文件。 |
| Files modified | 10 | R60九个文件加`test-voice-robustness.js`；R61只继续修改core、CLI和nested两类测试及plan。 |
| Files deleted | 0 | fallback helper优先在同一DOM文件内删除或收敛，不删除模块。 |
| Production effective lines | 完整任务约470，硬上限600 | R60当前约441，R61 acquisition与401 transition预计新增不超过30。 |
| Test effective lines | 完整任务约390 | R61新增最小CLI/browser tests与两个production-chain robustness modes约170行。 |
| Generated lines | 0 | 不涉及SDK、数据库迁移或生成代码。 |

## 20. Real Risks and Open Decisions

### Confirmed or Reachable Risks

- ChatGPT私有`/backend-api/transcribe`可能返回真实HTTP/transport错误；R57只对封闭可恢复code最多四次执行同一direct事务，确定性错误立即返回，绝不切UI fallback或第二endpoint。
- pre-ready cleanup自身可能无法证明owned browser已释放；R61在这种情况下原样失败并保留marker/owner record供下一CLI重连，禁止本进程cold spawn。该结果是安全诊断，不是成功fallback。
- local daemon identity 401与ChatGPT页面认证错误都可能显示“Unauthorized”；R62只按local HTTP adapter的status+连接边界产生`DAEMON_IDENTITY_MISMATCH`，随后必须证明current discovery身份已变化且usable；DOM code优先且不从message推断。
- default-private E2E会启动真实Edge lifecycle，但仅使用随机state下的headless profile；finally必须先graceful close并确认无测试进程，再删除隔离目录。用户原`state/profile`不作为fixture。
- Project名称`MCP`当前没有有效cache alias；lazy后voice可用，但首个ask必须通过同一live sidebar acquisition解析并验证MCP，侧栏仍不可交互时必须明确失败，不能回退到其它Project或用voice成功掩盖ask验收失败。
- 首个live-discovered或cached/current Project首页可能在h1/composer出现后仍等待`conversation/init`；若过早提交，prompt可被远端接受但20秒内没有conversation URL。R35必须让两类fresh导航共享DOM网络收敛，失败仍按Project unavailable诊断，不能放宽lost墓碑或重发。
- 用户在voice期间关闭private agent Edge时，当前attempt先由core settle/隔离，再由CLI下一attempt冷启动；显式shared Edge断连也只disconnect/retire，不由agent关闭或接管。
- 5分钟idle后页面可能保持官方origin但网络上下文退化；稳定health失败时先在音频POST前有界续租一次，只有续租失败才报错，不能用下一次用户调用作为必需恢复步骤。
- Project页面的一次瞬态render/执行上下文错误不能删除缓存；只有明确身份不匹配或确定不存在才允许清理旧alias，保留缓存本身也不绕过后续网页验证。
- `/api/auth/session`当前只返回warning，不能充当登录或token owner；唯一观察来源是`#client-bootstrap`。adapter只返回typed非敏感事实，token只参与page-local POST；HTTP错误只允许CLI下一attempt重新经过完整authenticated主路径。
- 直接Edge+URL诊断曾出现订阅fetch弹窗；R20 observer已绑定default daemon。当前受控重启无dialog/同源错误，但用户观察到另一次混合DOM；R24只为持续混合增加一次startup recovery，不替换启动器。
- 历史18次429之后已有同一/下一WAV成功，当前同线hello-world为200；R55不猜quota或新endpoint，只在当前attempt清理后按1/2/4秒执行用户要求的三次同wire重试。
- 429最小核对范围是当前frontend实际method/base path/FormData/authOption与当前页面bootstrap事实；不复制全部minified client、不硬编码build号、不从错误体猜新端点。
- 当前profile已重新登录，内存bootstrap和磁盘持久cookie均成立，一次无voice graceful restart继续登录。真实E2E必须保留该profile，先验证auth-only restart，再允许一个voice；失败不能在`finally`关闭现场。
- 5分钟WAV必须成功；若触达TUI/core/direct嵌套timeout，该次验收失败并定位最先到期owner，只允许调整该owner且必须重新整链验证，不能整体抬高所有层期限。
- R37本地marker生成依赖Darwin系统`/usr/bin/say`与`/usr/bin/afconvert`；显式E2E门禁开启而工具缺失时必须在发送音频前明确失败，不能退回旧开头语音/非空断言。普通CI不进入该分支。
- owned-browser关闭E2E只能向daemon的唯一后代且命令行包含agent user-data-dir的Edge主进程发SIGTERM；零个或多个候选都fail-closed，绝不尝试关闭普通用户Edge。
- 多轮压力可能暴露锁尾部、页面增长或daemon健康漂移；固定验收为12/12 voice、6/6独立new Session ask、六个唯一句柄和`accepted=6`、0超时/失败、voice p95不超过120秒、提交增量恰为12，每轮active/queued/locks归零、voice page最多1、累计managed page最多7且低于cap 12，最后短voice成功。`max-managed-pages=2`只属于最小`2 voice + 1 ask`反馈环，不是完整压力上限。
- 删除fallback会改变此前direct接口错误时的兼容行为，必须在README和TUI错误路径中明确，不可静默改变。
- profile lifecycle测试只读取当前daemon祖先进程的命令行和主Edge形态；helper、普通用户Edge和shared CDP均不得进入kill/close路径。
- submission queue会让重叠ask最多等待当前voice direct的既有有界POST预算；ask持有它直到conversation URL记录，但不能覆盖`finishAsk`，否则会退化成全局串行。
- queue中的失败任务必须像现有Session/voice锁一样推进后继；失败只传播给自己的调用，不能触发另一路重试或成功合成。
- cold Project初始化加入queue后最多等待其前方已经进入队列的远端事务；当前voice绝对deadline包含排队时间，故受控slice必须证明Project只插入一次且完成即释放，真实4/2和12/6仍须满足既有120秒p95/130秒CLI边界。
- voice lease进入queue后，queue前取消必须在任务真正获得queue所有权前跳过page创建；queue内稳定性失败/取消仍沿既有settle或隔离路径释放，不能让Project队头或voice迟到closure毒化后续任务。
- `DevToolsActivePort`可能在browser退出后暂时残留；connect失败不是第二browser已安全启动的充分条件。private owner只能在同一profile可启动时进入cold path，若仍被锁定则返回具体错误给CLI下一attempt，不能扫描PID或强杀进程。
- CDP `Browser.close`可能超时；为了保护profile持久性，R55禁止用child kill兜底。该attempt明确失败并disconnect，后续attempt重新读取marker；这比强制结束更符合用户边界。
- 四个完整attempt的最坏兜底较长，但具体daemon startup/core/HTTP错误会提前返回并立即进入清理/退避；1237000ms只防止上游抢先杀死合法长attempt，不是每次固定等待。
- 登录过期和确定性认证拒绝不能自动恢复；稳定`LOGIN_REQUIRED/VOICE_REJECTED`立即返回，让用户尽早登录或修正账号状态，而不是重复browser lifecycle。

### Open Decisions Requiring the User

无设计决策待用户选择。用户已经明确要求“不以报错作为fallback”、优先解决反复跳转/好坏交替，并要求验证长期登录、高负载、浏览器关闭和长间隔路径。当前profile已恢复，不授权改变认证设计或跳过验收。

### Rejected Speculation

- “MCP缓存从未写入”：被历史日志20-26反证，日志曾实时发现并使用`MCP` ID。
- “缓存随机丢失”：当前代码有明确的`removeCachedProject`调用；本轮日志的验证失败紧接着发生，优先解释为已证实的失效清理链。
- “direct成功一定需要前台激活”：现有fake page和真实direct复测证明direct可以在daemon ready后直接完成；前台动作只属于ask或旧UI fallback。
- “所有页面跳转都来自voice direct”：全量搜索显示direct成功不含goto；startup Project和fallback是可达的实际导航源。
- “5分钟调用必然需要周期刷新”：当前没有该观察证据；计划只验证已有age/health owner，不新增固定刷新任务。
- “需要并行voice才能提速”：当前单一ChatGPT voice composer/页面语义要求串行；并发应验证隔离和不死锁，不作为成功路径。
- “给Project click增加timeout后重试即可”：当前唯一事实是可信click与voice direct重叠时不settle；重试会产生第二次不确定UI副作用并违反无fallback约束。正确owner是已有submission transaction排序，不修改DOM click算法。
- “只把voice direct POST放进queue就足够”：R36复测已证明voice `sessionPageFact`在queue外仍能与Project click重叠，且direct尚未开始就被Project队头延迟；必须排序完整voice lease/preflight事务，不能只移动最后一个POST。
- “继续为guest正文补更多正则”：当前文案已经使启发式误判；网页自己的bootstrap authStatus/session是可复用owner，叠加文案只扩大漂移面。
- “从`/api/auth/session`恢复旧token parser”：当前endpoint只返回warning；R24只读取当前frontend实际页面中的`#client-bootstrap`，不维护第二套schema或fetch。
- “因为429切换端点或DOM听写”：不授权；用户要求的重试只重复相同authenticated direct primary path，不改变wire、profile或上传算法。
- “构造畸形cookie、损坏DevToolsActivePort或未知认证JSON以增强防御”：这些输入本轮未观察且无公开producer，不进入生产分支或阻塞测试。
- “把click acceptance从10秒整体抬高”：失败现场在10秒后仍无user turn且composer原样，单独ask立即成功；延长等待只延迟lost，不修复提交重叠。
- “click失败后改按Enter、DOM click或再次可信click”：无法证明第一次click没有远端副作用，任何第二次提交都会形成重复prompt fallback。
- “串行整个ask直到回答结束”：只有remote submission窗口被证明冲突，assistant生成和voice direct仍属于可并发结果等待。
- “扫描Edge进程并杀死持有profile者”：private marker已经提供正确连接入口；PID扫描会扩大到用户浏览器且破坏cookie持久性。
- “daemon退出必须同步关闭browser”：异常退出正是需要下个daemon重连的场景；只有显式正常stop或已连接private bootstrap不可恢复时才CDP graceful close。
- “在DOM direct adapter内部自动重发fetch”：adapter没有daemon/browser事务和attempt cleanup所有权；重试只能由`chatgpt.js transcribe-file`编排。

## R41 Revision Delta: 收敛Project身份裁决与审计账目

R41只记录R39/R40独立审计后已经确认的Project owner收敛和审计账目修正；R38的voice lease/preflight queue、Project single-flight、direct-only、取消、Session identity、长语音和生命周期范围全部保持有效。当前目标仍是原始用户需求的完整范围，不能因为本次分歧较小而缩小implementation audit。

### R41 Evidence and Current Path

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `/private/tmp/chatgpt-cold-overlap-r39b/daemon.log:5-62` | fresh `4 voice + 2 ask`运行中，两个ask的`session-new-page`均完成；Project root/sidebar以及5次expander可信click均完成；随后请求MCP时实际报`Multiple ChatGPT projects are named "个人"`，voice请求因client disconnect结束。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1008-1032` | `resolveProject`在discovery后调用现有`selectDiscoveredProject(discovered, value, direct)`，该policy拥有请求目标与Project ID/token。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:80-109` | 通用discovery当前先对`sidebar.names`中的任意重复名称抛错，再对`sidebar.links`按相同href去重，导致名称表示在身份解析之前越权裁决。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:346-415` | 无href、即将按名称执行可信首页click的路径已经通过`projectSidebarMatchCount()`拒绝目标可见row歧义。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-project.js:107-121` | 有URL候选经过解析后，纯Project policy只在requested匹配多个不同Project ID时拒绝，并允许精确ID/URL消歧。 | observed |
| `thirdparty/chatgpt-browser-agent/test-mcp.js:1139-1143, 2036-2072, 2079-2095` | 现有core fixture覆盖不同ID的目标同名拒绝，open-home fixture覆盖无href目标row歧义；独立discovery fixture需改为证明通用采集器只按href去重。 | observed |
| `thirdparty/chatgpt-browser-agent/README.md:110-120` | 公开文档把所有可见同名一概描述为拒绝，未区分不同身份、同href响应式表示和无href点击歧义。 | observed |

### R41 Invariant and First Divergence

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-21 | 只有会改变请求目标身份选择的重复候选才构成歧义；无关名称和同一href的响应式重复表示不能阻断目标Project。 | `chatgpt-dom.discoverProjects()`在候选URL去重、Project ID解析和requested选择之前，对名称全集执行全局重复拒绝。 | 通用DOM discovery只拥有候选采集/同href去重；`chatgpt-project.select()`拥有有URL身份裁决；`openProjectHomeFromSidebar()`拥有无href名称点击前歧义。 | r39b由无关`个人`重名阻断MCP；当前代码还明确证明same-href重复会在名称检查之后才被去重。 |

### R41 Single Primary Path

```text
CHATGPT_PROJECT value -> DOM采集并按href去重 -> parse Project identity -> selectDiscoveredProject(value)
  -> 若无URL候选才进入现有name-only openProjectHome歧义检查 -> verified Project home/init
```

1. `chatgpt-dom.discoverProjects(page, log)`删除全局`sidebar.names`重复拒绝，只返回现有按href去重后的候选；不新增requested参数。
2. 有URL候选继续经过现有`parseProjectRef()`和`selectDiscoveredProject()`；同一href表示先去重，不同Project ID但请求名称相同才由纯policy拒绝。
3. 无href且必须按名称点击的row不进入URL policy；现有`openProjectHomeFromSidebar()`在唯一可信click前继续按请求名称拒绝多个可见row。
4. R38既有cache-first、Project single-flight、voice submission queue、direct-only、取消/cleanup和identity acceptance不变。

该路径直接删除错误的通用裁决并复用两个既有owner，不通过catch后改用其他Project、不跳过目标身份校验、不重试click、不猜URL，也不新增第二个成功路径。

### R41 TDD and File Delta

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `testProjectDiscoveryCollectsDistinctProjectLinks` fixture同时提供唯一MCP href、同href响应式副本和两个无关`个人`name-only row；预期只返回一个MCP URL候选。 | 当前通用discovery在href去重前对名称全集抛`PROJECT_AMBIGUOUS`。 | 删除通用名称裁决，保留同href去重；fixture得到单一MCP候选。 | 真实r39b无关重名不再阻断MCP，同一身份响应式副本也不误报。 |
| 2 | 现有core fixture中两个不同Project ID均名为MCP继续拒绝；现有open-home fixture中两个无href MCP row继续在click前拒绝。 | 这些owner当前已正确，不需要新逻辑。 | 保持既有policy与name-only click断言green。 | 删除通用检查不会放宽真实目标身份歧义。 |
| 3 | 通过R38既有voice lease/project queue行为测试，确认R41只删除越权discovery分支并同步审计账目。 | R41不应改变voice或runtime owner。 | 现有R38离线slice、真实MCP overlap和完整压力重新通过。 | 防止误改voice、queue、cancel、Session或页面分配生命周期。 |

| File | Change | Responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 删除通用discovery的全局名称重复分支；保留href去重、policy选择和name-only click检查。 | +1/-7 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 将`testProjectDiscoveryRejectsVisibleDuplicates`重命名为`testProjectDiscoveryCollectsDistinctProjectLinks`，把错误的“discovery拒绝可见重名”fixture替换为“discovery只采集并按href去重”，复用既有两个目标歧义测试。 | +12/-12 |
| `thirdparty/chatgpt-browser-agent/README.md` | modify | 说明不同身份目标与无href目标row拒绝；同href表示和无关名称不阻断选择。 | +2/-2 |

R41不修改`chatgpt-core.js`，不新增公共接口、配置、状态机、队列、retry、fallback、缓存、迁移、生成文件或外部依赖。Production仅删除错误分支并调整邻近中文不变量注释；test fixture保持约等量替换并同步测试名。R41的decision surface已明确为`7 / 85 = 8.24%`，E/C预估已将约20行实质测试修改计入`E≈1770`和`C≥266`；最终implementation audit仍需按完整diff重算。

### R41 Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-21 / unique MCP must not be blocked by unrelated or same-identity representations | `discoverProjects()` -> href dedupe -> existing `select()` | 删除DOM discovery全局名称裁决 | unique MCP + same-href copy + unrelated duplicate names returns one candidate |
| Target identity ambiguity remains unsafe to guess | parsed candidates -> `select()`；name-only rows -> `openProjectHome()` | 无新增逻辑；保留既有owner | distinct-ID duplicate MCP rejects；two name-only MCP rows reject before click |
| R38 lifecycle behavior remains unchanged | existing runtime queue and direct path | no R38 production changes | R38 offline suite plus fresh `4/2` and full `12/6` |

### R41 Risks and Rejected Speculation

- Confirmed risk: current sidebar包含无关重复名称，通用discovery把它错误提升为MCP身份歧义；同文件证明same-href响应式重复也可达。
- Confirmed safety boundary: 不同Project ID的目标同名仍由纯policy拒绝；无href目标row仍由可信click owner在副作用前拒绝；显式ID/URL继续精确选择。
- Rejected speculation: page allocation、更多click等待、voice deadline、retry和endpoint均不由r39b支持；这些边界已在观察到的错误前正常完成。
- No user decision is required;现有owner已经给出唯一自然修复，R41只同步审计账目和行为测试命名。

## R44 Current Revision Delta: Project row与列表展开控件边界

R44按R43完整方案审计的四项阻塞意见重建当前规范：补齐可独立读取的first-divergence evidence artifact，把selector修复和INV-22放进当前第1至21节的traceability范围，明确decision surface保持`7 / 85 = 8.24%`的替换计数，并将metadata设为`audit-required`。R41已实现的href候选去重、Project policy身份裁决和R38 voice/Project queue全部保持有效；R44只处理真实DOM selector首次分歧，不引入timeout fallback。

### R44 Evidence and Reachability

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/testing/chatgpt-r42-inspect/expander-first-divergence.json` | 保存R42 fresh `4 voice + 2 ask`的非敏感daemon log excerpt、只读CDP命中元素快照、复现命令和cleanup事实；不含token、cookie、conversation identity、音频或转录文本。 | observed |
| `/private/tmp/chatgpt-cold-overlap-r42b/daemon.log:5-21` | 原始反馈环中voice首条direct完成，Project解析开始，`expander-evaluate-done`后进入`expander-click-start`且无click完成，随后voice达到60秒超时。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:286-301` | 当前DOM adapter先找第一个Project row建立section，再在section内取第一个`aria-expanded=false`元素；该选择没有排除Project row。 | observed |
| R42只读CDP快照（artifact `cdpReadOnlySnapshot`） | 真实命中元素为`DIV`、文本`个人`、`role=button`、`data-sidebar-item=true`、`aria-expanded=false`，祖先为`group/project-unfurl-row relative`；没有执行click。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1481-1500, 1684-1710` | Project initializer和voice lease/direct共用submission queue；Project click不settle会阻住后续voice，解释60秒voice symptom而不改变voice owner。 | reachable / observed |

复现命令已在artifact原样保存；诊断期间临时`[DEBUG-R42]`仅写入隔离state日志，已从production删除，`grep`无残留。该artifact是plan审计证据，不是CI依赖，也不会进入普通代码发布路径。

### R44 Required Invariant and First Divergence

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-22 | Project discovery只能点击真实列表/section展开控件；Project row的`aria-expanded`只表示该Project自身内容状态，不能被当作列表展开控件点击。 | `clickProjectListExpander()`的collapsed candidate没有排除`project-unfurl-row`，真实页面选择了`个人`Project row；`ElementHandle.click()`从artifact记录的`expander-click-start`起未settle。 | `chatgpt-dom.js:clickProjectListExpander()`拥有DOM结构选择和可信click副作用；core只拥有Project生命周期/queue，不解析DOM。 | artifact同时提供事件顺序和实际命中元素祖先class；R42原始反馈环在该边界后60秒red。 |

### R44 Single Approved Primary Path

```text
Project section discovery -> exclude project-unfurl-row from collapsed candidates -> click only actual list control -> read href candidates -> existing Project policy
```

1. 在现有collapsed selector的同一DOM evaluate中，只排除位于`project-unfurl-row`内的候选；不新增selector体系、文本猜测、第二click算法或timeout fallback。
2. 如果当前section没有真实collapsed/structural/兼容文案控件，继续返回无控件并直接读取当前href候选；不能把任意Project row当作展开动作。
3. R41已有href去重、Project policy身份裁决、name-only open-home歧义、R38 voice/Project submission queue和direct-only全部保持不变。

该路径修复的是DOM adapter第一次选择错误元素的owner，不是通过catch后换Project、跳过身份、延长voice deadline、重试click或增加第二成功路径。

### R44 Responsibility and Traceability

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Project list control selection | `chatgpt-dom.js` | DOM adapter提供可信Project sidebar discovery | 只有DOM adapter能识别row与section控件的结构及可信click边界 | core只编排Project lifecycle；policy只处理已解析Project identity；voice不应解析侧栏 |
| Project identity selection | `chatgpt-project.js` | 纯policy按URL/ID/token/name裁决候选 | R41已复用且未被R44改变 | DOM采集器不拥有Project identity，避免重复authority |
| Voice/Project submission ordering | `chatgpt-core.js` | existing submission queue短事务排序 | R38已证明这是远端副作用owner | DOM不管理跨request并发，TUI不管理daemon page lifecycle |

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-22 / no Project-row click during list discovery | `clickProjectListExpander()` excludes row ancestor | `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` one selector predicate plus nearby Chinese invariant comment | `testProjectDiscoveryCollectsDistinctProjectLinks` observes row click remains false and returns one MCP href |
| R41 target identity safety | href dedupe -> `selectDiscoveredProject()`; name-only open-home checks | no policy change | existing `testProjectPinUsesSingleRecoveryChain` and `testProjectHomeDiscoveryUsesLiveSidebar` |
| R38 voice/Project lifecycle | submission queue -> voice lease/preflight/direct | no core change | `testCoreProjectStateMachine`, `testVoiceLeaseWaitsForProjectSubmission`, queue/cancel regressions and fresh 4/2 |

### R44 TDD and File-Level Change Plan

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 在`testProjectDiscoveryCollectsDistinctProjectLinks` fixture中，把MCP href放入`project-unfurl-row`，其row使用`role=button aria-expanded=false`并记录click；discovery后row必须仍未被点击且仍返回唯一MCP href。 | 当前collapsed selector把Project row当列表控件，真实页面会在第一次可信click处不settle。 | selector只接受不在`project-unfurl-row`内的collapsed控件；没有真实控件时直接读候选。 | 锁定artifact中的真实first divergence，同时保留R41同href去重/无关重名行为。 |
| 2 | 运行R41 Project policy/discovery、R33/R35 open-home和R38 queue/cancel行为测试。 | 这些既有owner不得因selector收窄而改变。 | 全部回归green。 | 目标身份、可信click、voice queue和取消语义不回归。 |
| 3 | 重跑artifact对应的fresh `4 voice + 2 ask`原始反馈环；之后才继续12/6及其它完整E2E。 | 离线fixture不能证明真实Edge click协议已不再阻塞。 | Project discovery完成，voice direct和ask acceptance满足既有压力合同。 | 真实daemon不再因Project row click卡住submission queue。 |

| File | Add / modify / delete | Exact responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 在collapsed candidate选择中排除`project-unfurl-row`内Project row；邻近中文注释解释`aria-expanded`语义边界。 | +2/-0 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 在R41 discovery fixture加入可观测Project row click和独立行为断言；不新增production seam。 | +8/-0 |
| `.temp/testing/chatgpt-r42-inspect/expander-first-divergence.json` | add | 保存非敏感诊断证据，不参与CI或production。 | +44/-0 |

### R44 Decision Surface and Comment Budget

R44的selector predicate是对现有collapsed-candidate选择决策的修正，不新增独立primary/diagnostic path；因此继续使用R41已重算的production surface：`chatgpt-core.js 51/3`、`chatgpt.js 8/1`、`chatgpt-dom.js 26/3`，Combined `85` decisions、`7` diagnostics、`7 / 85 = 8.24%`。实现审计必须按最终diff核对该替换计数；R44不得用timeout或fallback增加新的diagnostic路径。

以R41 `E≈1770/C≥266`为基线，R44增加selector行为修改、fixture断言和证据文件中的test-only内容约20行有效代码，计划估算`E≈1790`、`C≥269`（`ceil(1790 * 0.15)=269`）。`.temp`证据JSON、plan、README和临时日志不计入E；最终implementation audit仍需排除import-only、formatter-only、generated、纯移动和非解释性注释并重算实际值。新增/修改邻近中文注释必须解释Project row与列表控件的真实语义边界及测试为何观察用户可见副作用。

### R44 Risks and Rejected Speculation

- Confirmed risk: 当前真实页面的Project row具有`aria-expanded=false`，与列表控件共享属性形态；错误点击会占住Project single-flight并让voice触达既有60秒deadline。
- Confirmed safety boundary: 只排除Project row，不删除真实section/structural/兼容控件分支；Project identity和name-only目标歧义继续由既有owner裁决。
- Rejected speculation: 不增加click timeout后重试、延长voice deadline、跳过Project discovery、猜MCP URL、换endpoint或新增fallback；artifact只证明selector选错元素。
- No user decision is required;现有DOM adapter owner足以承载该修复。

## R46 Historical Delta (superseded by R47): 禁止跨section的“更多”fallback

R46由R45实现后的fresh `4 voice + 2 ask`复测触发。R45已正确排除Project row，但真实页面随后被文档级本地化文本fallback选中的顶层`更多`div再次阻塞；R46把该fallback限制在没有可识别Project section时才可运行，保留旧页面无section的已存在兼容分支，不新增第二个Project来源、retry或timeout fallback。R45 selector修复、R41 identity、R38 queue/direct和完整原始生命周期范围全部纳入本revision。

### R46 Evidence and Reachability

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/testing/chatgpt-r42-inspect/global-more-first-divergence.json` | 保存R46c的非敏感log excerpt、只读CDP命中元素、section对照、about:blank观察和cleanup事实；不含token、cookie、conversation identity、音频或转录文本。 | observed |
| `/private/tmp/chatgpt-cold-overlap-r46c/daemon.log:5-21` | R45排除Project row后，`expander-element=true`且descriptor为`DIV text=更多 role=null data-sidebar-item=true ancestor=null`，随后`expander-click-start`，反馈环中voice被取消。 | observed |
| R46只读CDP section map（artifact `cdpReadOnlySnapshot`） | 当前页面同时有`已置顶`和`项目`section；选中的`更多`父级是顶层sidebar section wrapper，不属于任何Project row或Project section。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:286-301` | R45 row过滤后，如果section内没有本地控制，代码仍无条件执行document-wide localized text fallback。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1417-1439,1512-1548` | 并发ask/voice在Project事务阻塞期间可先创建新的session/voice page；这些页面初始为`about:blank`，后续导航尚未开始时用户可观察到空白tab。 | reachable / observed |

R46诊断期间的`[DEBUG-R46]`仅写入隔离state，已从production删除，`grep`无残留。about:blank是当前失败时序的可见副作用证据，不授权新清理算法；先修复Project selector的first divergence，再按既有managed-page cleanup验证是否仍会残留。

### R46 Required Invariant and First Divergence

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-23 | 已识别Project section后，Project discovery只能在该section内选择展开控件；文档级“更多/More”不能被当作Project列表展开动作。没有可识别section时才保留旧页面的全局文本兼容路径。 | `clickProjectListExpander()`完成row排除后，`structural`为空，仍无条件在整个document中按`更多`文本取第一个`div`并可信click。 | `chatgpt-dom.js:clickProjectListExpander()`，因为DOM adapter拥有section边界和兼容selector；core只编排queue/page，不能判断“更多”归属。 | artifact命中元素无role且ancestorProjectRow为空，section map同时显示项目section存在；R46日志在click-start后反馈环失败。 |

### R46 Single Approved Primary Path

```text
discover Project section -> exclude project rows -> use local structural control
  -> if no local control and section exists, return no control
  -> only when no section exists, use existing legacy text compatibility -> read candidates
```

1. 在现有DOM evaluate中保留R45 `project-unfurl-row`排除。
2. 当`section`已经被识别但没有collapsed或structural控件时，直接返回`null`，禁止document-wide文本fallback跨section点击；当前页面候选仍由`readSidebarProjects`和后续`openProjectHome`既有路径处理。
3. 只有完全没有可识别section的旧页面才继续使用原有本地化文本fallback；这是既有兼容分支，不是失败后的新成功路径。
4. R41 href去重、Project policy身份裁决、name-only open-home歧义、R38 voice/Project queue和direct-only全部保持不变。

该路径修复的是R45之后DOM adapter第一次跨section选择错误，不通过catch后换Project、跳过身份、延长voice deadline、重试click、关闭用户页面或合成成功。

### R46 Responsibility and Traceability

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Section-local Project expander selection | `chatgpt-dom.js` | DOM adapter提供可信Project sidebar discovery | 只有DOM adapter知道候选属于哪个sidebar section | core不解析DOM；policy不处理控件；voice不管理sidebar |
| Legacy no-section text compatibility | `chatgpt-dom.js` | 旧页面无结构时保留已有兼容采集路径 | 该分支已存在且只在无section时可达 | 新增core fallback会复制DOM责任并扩大导航面 |
| about:blank lifecycle validation | existing runtime/test harness | managed page count和owned cleanup已有约定 | R46只验证修复后失败时序不再制造无界空白tab，不新增清理owner | core现有pageFor/voicePage已经拥有页面分配；若仍残留需另有red事实再修订 |

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-23 / no cross-section More click | `clickProjectListExpander()` returns null when section exists without local control | `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` one section guard and nearby Chinese boundary comment | `testProjectDiscoveryCollectsDistinctProjectLinks` observes top-level More remains unclicked and MCP href remains unique |
| R45 INV-22 / no Project-row click | same selector row exclusion | existing R45 change retained | same discovery fixture observes Project row remains unclicked |
| R38 voice/Project lifecycle and page ownership | existing submission queue and managed pages | no core change | queue/cancel regressions, fresh 4/2, managed-page/blank-tab observation |

### R46 TDD and File-Level Change Plan

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 在`testProjectDiscoveryCollectsDistinctProjectLinks` fixture中加入section外顶层`更多`div及独立click marker；discovery后Project row和More都必须未点击且仍返回唯一MCP href。 | R45代码排除row后会进入document-wide文本fallback并点击More。 | `section`存在且没有本地控件时返回null；旧无section fallback不变。 | 锁定R46真实first divergence，同时保留R41/R45采集和row边界。 |
| 2 | 运行R41/R45 discovery、R33/R35 open-home、R38 queue/cancel和Project identity行为测试。 | 这些owner不应依赖跨section文本点击。 | 全部回归green。 | 防止section guard放宽身份或破坏旧页面兼容。 |
| 3 | 重跑fresh `4 voice + 2 ask`；记录CDP页面URL，确认成功路径不留下daemon-owned about:blank；失败时确认既有cleanup可收敛且不操作用户Edge。 | R46真实问题只有fresh Edge/CDP压力能触发；离线fixture不能证明页面分配时序。 | Project discovery完成、voice/ask成功，owned page集合有界且无新的空白tab泄漏。 | 保护用户观察到的about:blank与前台主页面体验，不新增关闭用户页行为。 |

| File | Add / modify / delete | Exact responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 保留R45 row过滤；section存在时阻断document-wide More fallback，并增加中文owner边界注释。 | +2/-0 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 加入顶层More click marker和未点击断言，继续复用公开discovery seam。 | +6/-0 |
| `.temp/testing/chatgpt-r42-inspect/global-more-first-divergence.json` | add | 保存R46非敏感真实诊断，不参与运行时/CI/发布。 | +39/-0 |

### R46 Decision Surface and Comment Budget

R46把document-wide文本fallback限制为“无section时才可达”的既有兼容分支替换，不新增成功、诊断或错误路径；R45已重算的production surface保持：`chatgpt-core.js 51/3`、`chatgpt.js 8/1`、`chatgpt-dom.js 26/3`，Combined `85` decisions、`7` diagnostics、`7 / 85 = 8.24%`。实现审计必须核对该替换计数，不得通过page cleanup或timeout增加diagnostic。

以R45 `E≈1790/C≥269`为基线，R46增加section guard、More marker和行为断言约10行有效代码，计划估算`E≈1800`、`C≥270`（`ceil(1800 * 0.15)=270`）。`.temp`证据JSON、plan、README和临时日志不计入E；最终implementation audit仍需排除import-only、formatter-only、generated、纯移动和非解释性注释并重算实际值。新增中文注释必须解释section存在时禁止跨sectionfallback、旧无section兼容为何保留，以及测试为何观察用户可见副作用。

### R46 Risks and Rejected Speculation

- Confirmed risk: 当前真实页面的Project section存在，但document-wide`更多`属于其它sidebar section；错误click会占住Project single-flight并让并发newPage短暂暴露about:blank。
- Confirmed safety boundary: 只在section存在时阻断跨section文本fallback；不关闭用户Edge、不删除managed-page owner、不放宽Project identity。
- Rejected speculation: 不增加click timeout后重试、延长voice deadline、跳过Project discovery、猜MCP URL、换endpoint、全局关闭about:blank或新增fallback；R46证据只证明跨section文本误选。
- No user decision is required;现有DOM adapter和runtime page ownership足以承载本修复与验证。

## R47 Current Revision Delta: 删除无证据的文档级文本fallback

R47按R46完整审计删除无section document-wide localized-text fallback；R46的section guard不再作为独立production分支保留。R45已实现的Project-row排除、R41 href/identity收敛、R38 voice/Project queue和全部原始生命周期范围保持有效。没有可复核consumer、外部兼容合同或正向行为测试证明“无section时点击任意更多文本”是受支持行为，继续保留它会让任意sidebar控件重新进入Project可信click路径。

### R47 Evidence and First Divergence

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/testing/chatgpt-r42-inspect/global-more-first-divergence.json` | R46c真实log和只读CDP快照证明R45 row过滤后选中section外顶层`更多`；artifact也记录daemon-owned about:blank观察及cleanup边界。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:286-301` | 当前R45实现保留document-wide `/show more|more|显示更多|更多|展开/` fallback；它可对任何页面文本执行可信click。 | observed / reachable |
| `thirdparty/chatgpt-browser-agent/test-mcp.js:1926-1936` | 真实已覆盖的Project列表fixture使用明确`sidebar-expando-section`和结构化`data-sidebar-item`按钮，不需要文档级文本fallback。 | observed |
| `thirdparty/chatgpt-browser-agent/test-mcp.js:2079-2102` | 当前discovery fixture可在section内验证row排除、href去重和无关重名；R47只需加入section外More副作用断言。 | observed |

### R47 Required Invariant and Owner

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-23 | Project discovery只能点击已识别Project section内的结构化展开控件；无section或无结构化控件时不能凭任意本地化文本制造可信click。 | R45排除Project row后，`clickProjectListExpander()`仍扫描整个document并选中顶层`更多`div，随后click不settle并阻塞Project single-flight。 | `chatgpt-dom.js:clickProjectListExpander()`；该adapter拥有DOM控件边界，core不解析文本或section。 | R46 artifact：命中元素`DIV text=更多 role=null ancestorProjectRow=null`，同时页面存在`项目`section；daemon在`expander-click-start`后失败。 |

### R47 Single Approved Primary Path

```text
Project section discovery -> exclude project rows -> choose section-local collapsed/structural control -> otherwise return no control -> read candidates/open-home existing path
```

1. 保留R45对`project-unfurl-row`的排除和既有section-local collapsed/structural选择。
2. 删除document-wide localized-text fallback；section不存在或没有结构化控件时直接返回`false`，不执行可信click。
3. 既有`openProjectHomeFromSidebar()`在当前可见name-only row上仍使用独立首页按钮可信click；Project policy继续裁决URL/ID身份。
4. about:blank只作为原始失败时序的验证观察；不新增扫描、关闭用户页面、page cleanup算法或错误后替代路径。

该路径直接删除无证据的成功-capable兼容分支，恢复“一个DOM责任只有一个权威路径”；不通过catch、retry、timeout、换Project、猜URL或合成成功。

### R47 Responsibility and Traceability

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Section-local Project control selection | `chatgpt-dom.js` | DOM adapter提供可信Project sidebar discovery | 只能在DOM层判断row/section和可信click | core不解析DOM；policy不拥有控件；voice不管理sidebar |
| Unsupported/no-structure discovery | `chatgpt-dom.js` | discovery返回无控制事实，让后续现有候选读取/Project open-home路径决定结果 | 没有证据支持任意文本click成功，adapter应fail-closed | core不能以错误触发第二导航；TUI不拥有网页状态 |
| about:blank observation | existing runtime/test harness | managed page status和owned browser cleanup既有合同 | R47只重跑原始反馈环确认上游阻塞消失，不新增production owner | pageFor/voicePage已有页面分配职责，当前first divergence在DOM selector |

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-23 / no arbitrary More click | `clickProjectListExpander()` stops after section-local controls | `thirdparty/chatgpt-browser-agent/chatgpt-dom.js`删除document-wide text fallback；保留R45 row predicate | `testProjectDiscoveryCollectsDistinctProjectLinks` observes Project row和top-level More均未点击 |
| R41/R45 identity safety | href dedupe -> Project policy; name-only open-home existing owner | no policy change | existing Project identity/open-home regressions |
| R38 lifecycle/page ownership | existing queue and managed page semantics | no core change | queue/cancel, fresh 4/2, full 12/6, browser-close/profile/idle checks |

### R47 TDD and File-Level Change Plan

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 在R45 discovery fixture加入section外顶层`更多`div及click marker；discovery后Project row和More都必须未点击且仍返回唯一MCP href。 | 当前R45代码会执行document-wide text fallback并点击More。 | 删除fallback后无section/local control不会产生click，候选仍按href去重。 | 锁定R46真实first divergence，不放宽Project identity。 |
| 2 | 运行R41/R45 discovery、R33/R35 open-home、R38 queue/cancel和Project identity测试。 | 既有section-local结构化按钮和name-only click不得被删除或绕过。 | 全部回归green。 | 保留真实Project导航、身份安全和voice queue。 |
| 3 | 重跑fresh `4 voice + 2 ask`；记录owned页面URL，确认不再因Project click阻塞而制造/保留about:blank；随后执行12/6及其它完整E2E。 | only fresh Edge/CDP能证明真实daemon不会在错误More click处卡住。 | Project discovery完成、voice/ask通过，owned页面集合有界且空白页不因该失败路径残留。 | 覆盖用户观察到的about:blank和主Edge不受操作边界。 |

| File | Add / modify / delete | Exact responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 删除document-wide localized-text fallback；保留R45 row排除和section-local controls。 | +0/-5 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 加入top-level More click marker/断言，复用公开discovery seam。 | +6/-0 |
| `.temp/testing/chatgpt-r42-inspect/global-more-first-divergence.json` | preserve | 只作为非敏感诊断证据，不进入运行时、CI或发布。 | 0 |

### R47 Decision Surface and Comment Budget

R47删除一个未经支持的document-wide primary-contract compatibility path，不新增成功、diagnostic或fallback。R45的`chatgpt-dom.js 26/3`中该文本选择路径属于一个primary decision；删除后当前surface为`chatgpt-core.js 51/3`、`chatgpt.js 8/1`、`chatgpt-dom.js 25/3`，Combined `84` decisions、`7` diagnostics、`7 / 84 = 8.33%`。实现审计必须按最终diff核对该删除，不得把about:blank观察变成新诊断分支。

以R45 `E≈1790/C≥269`为基线，R47加入测试marker约6行、删除production fallback不增加E，计划估算`E≈1800`、`C≥270`（`ceil(1800 * 0.15)=270`）。证据JSON、plan、README和临时日志不计入E；最终implementation audit必须按完整实际diff排除import-only、formatter-only、generated、纯移动和非解释性注释，并验证新增中文注释解释为何没有consumer合同的文本fallback必须删除。

### R47 Risks and Rejected Speculation

- Confirmed risk: document-wide More fallback已经在真实页面命中其它section控件并占住Project queue；用户观察到的about:blank发生在该阻塞时序的并发page allocation阶段。
- Confirmed safety boundary: 删除只影响无结构文本fallback；不关闭用户Edge、不扫描shared CDP页面、不改变Project policy、voice endpoint、queue或取消。
- Rejected speculation: 不为无section页面猜测未来DOM、不增加新的本地化selector、click timeout/retry、延长deadline、跳过Project discovery或换endpoint。
- No user decision is required;当前仓库没有无section fallback的consumer/contract证据，删除是最小primary-path repair。

## R49 Current Revision Delta: Project首页采用事件收敛

R49由R48 implementation后的fresh `4 voice + 2 ask`触发。R48已删除错误Project row和document-wide More点击，真实链路进入正确MCP首页按钮；按钮可命中、可信click在22ms内完成，但现有`page.waitForFunction(... timeout: 15_000, polling: 200)`在`conversation/init`首个真实响应15.487秒时提前487ms失败。页面随后进入正确MCP Project home并具备composer/h1。R49不抬高固定timeout，而是复用R35已有`conversation/init`事件，再以Puppeteer同页navigation事件确认SPA route；删除重复的固定DOM轮询gate。

### R49 Evidence and Reachability

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/testing/chatgpt-r42-inspect/project-home-init-delay.json` | 保存R49非敏感click trace、按钮可命中事实、eventual Project home和两个init资源时长；不含token、Project token、conversation identity、音频或转录文本。 | observed |
| `/private/tmp/chatgpt-cold-overlap-r49/daemon.log:12-21` | discovery无URL候选后，MCP match=1、正确`打开项目首页`按钮pointer=auto；click完成但URL当时仍是root，15秒DOM wait失败。 | observed |
| R49只读CDP performance snapshot | 页面最终为MCP Project home、`readyState=complete`、composer=true、h1=MCP；首个`conversation/init` duration=15487.1ms，第二个=8506.7ms。 | observed |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:261-275,346-401` | `withProjectHomeInitialization()`已经在click前注册并等待成功`POST /backend-api/conversation/init`；open-home task又独立执行固定15秒DOM polling，形成两个收敛owner。 | observed |
| Puppeteer `page.waitForNavigation()` current interface | 当前依赖已支持History API/same-document navigation事件；无需引入新依赖、轮询器或DOM selector。 | contracted by existing dependency interface |

R49诊断期间的`[DEBUG-R49]`已从production删除，`grep`无残留。about:blank仍是Project事务提前失败时并发page allocation的次生可见现象；R49继续通过原始fresh反馈环验证，不新增全局page cleanup。

### R49 Required Invariant and First Divergence

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-24 | 正确Project首页click后的成功收敛必须由已注册的same-document route事件和`conversation/init`成功事件决定；固定15秒DOM polling不能在真实init仍进行时把有效导航判失败。 | `openProjectHomeFromSidebar()`在已由`withProjectHomeInitialization()`等待init的task内部，又用固定15秒`waitForFunction`要求URL/composer/h1；真实init为15.487秒，因此该下游gate先失败。 | `chatgpt-dom.js` Project-home navigation adapter；它拥有trusted click、SPA route和init response，core不应复制endpoint或延长voice deadline。 | artifact记录click正确且完成、固定wait失败、init时长超过15秒、页面最终收敛为MCP。 |

### R49 Single Approved Primary Path

```text
register same-document navigation event + register conversation/init response
→ trusted Project-home click once
→ await route event and init success
→ existing Project URL/policy/home-state verification
```

1. 在click前注册`page.waitForNavigation({ timeout: responseTimeout })`；该Puppeteer事件覆盖History API/same-document route，不通过固定polling观察DOM。
2. 将click与navigation event放入现有`withProjectHomeInitialization()` task；外层继续等待唯一`conversation/init`成功响应。
3. 删除固定`page.waitForFunction`的15秒/polling/URL+composer+h1重复gate；后续现有`ensureProjectChatMode`、`resolveProject` URL解析和`ensureProjectHome/projectHomeState`继续验证页面身份/可用性。
4. 不延长voice deadline、不重试click、不再次发送ask、不猜Project URL、不新增fallback或第二个init owner。

该路径修复Project DOM adapter中第二个过早收敛owner；网络和route事件是同一次click的两个必要事实，不是失败后替代成功算法。

### R49 Responsibility and Traceability

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Trusted home click and SPA route | `chatgpt-dom.js` | DOM adapter完成Project首页导航 | same-document route属于Puppeteer page事件，只有adapter持有page/click | core只消费返回URL和Project fact；policy不操作页面 |
| Project init network convergence | existing `withProjectHomeInitialization()` | 同页`conversation/init`成功后才返回 | R35已建立唯一endpoint event owner，可直接复用 | 新增core wait会复制endpoint匹配 |
| Project identity/home availability | existing core policy + DOM fact | URL/ID/title/composer继续fail-closed验证 | route/init只证明导航完成，不替代身份 | R49不放宽或重写这些owner |

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-24 / no premature fixed DOM failure | click + same-document navigation event inside existing init event owner | `thirdparty/chatgpt-browser-agent/chatgpt-dom.js`替换固定waitForFunction | delayed-init local HTTP fixture: route/DOM only after init response beyond15s, open-home succeeds once |
| R48 no arbitrary sidebar clicks | section-local controls only | R48 changes retained | existing discovery row/More click markers |
| R38 voice/Project lifecycle | submission queue and direct-only unchanged | no core change | queue/cancel regressions, fresh 4/2, full12/6 and lifecycle E2E |

### R49 TDD and File-Level Change Plan

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 扩展`testProjectHomeDiscoveryUsesLiveSidebar`：HTTP init响应延迟约15.2秒，click handler仅在fetch成功后pushState并创建h1/composer；DOM adapter使用`responseTimeout>delay`。 | 当前固定15秒waitForFunction先于有效init/route事件失败。 | click前注册same-document navigation event，与既有init response共同settle；测试约15.2秒green。 | 锁定真实15.487秒边界且不依赖private helper/source/call count。 |
| 2 | 运行R35 Project-home init、R41/R48 discovery/identity、R38 queue/cancel测试。 | R49不能放宽URL/Project fact或恢复任意sidebar click。 | 全部回归green。 | 保留cache/live两producer、trusted click和direct-only。 |
| 3 | 重跑fresh `4 voice + 2 ask`，记录owned page URL/managed pages；随后执行12/6和完整生命周期E2E。 | 只有真实Edge/CDP能证明init事件、SPA route、voice queue和about:blank时序收敛。 | Project/voice/ask全部成功且无该失败路径造成的空白tab残留。 | 覆盖用户观察的慢加载、反复失败和about:blank体验。 |

| File | Add / modify / delete | Exact responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 用same-document navigation event替换固定15秒DOM polling，复用已有init response owner。 | +3/-8 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 在既有Project-home公开seam增加>15秒event-driven delayed-init行为slice。 | +20/-0 |
| `.temp/testing/chatgpt-r42-inspect/project-home-init-delay.json` | add | 保存R49非敏感真实诊断，不进入运行时、CI或发布。 | +35/-0 |

### R49 Decision Surface and Comment Budget

R49把固定DOM predicate convergence decision替换为Puppeteer same-document navigation event；不新增primary、diagnostic或fallback path。R48删除全局文本fallback后的current surface保持`chatgpt-core.js 51/3`、`chatgpt.js 8/1`、`chatgpt-dom.js 25/3`，Combined `84` decisions、`7` diagnostics、`7 / 84 = 8.33%`。实现审计必须核对event replacement没有引入catch-and-success或第二click。

以R48 `E≈1800/C≥270`为基线，R49 production/event test增加约20行有效修改，计划估算`E≈1820`、`C≥273`（`ceil(1820 * 0.15)=273`）。证据JSON、plan、README和临时日志不计入E；最终implementation audit必须按完整实际diff重算。新增中文注释必须解释route/init双事件属于同一次导航合同、固定DOM polling为何删除，以及delayed fixture为何晚于15秒。

### R49 Risks and Rejected Speculation

- Confirmed risk: 正确click后的init可超过15秒；固定DOM gate会产生false failure并触发client disconnect、voice cancellation和about:blank可见副作用。
- Confirmed safety boundary: route event和init response均必须成功；后续URL/Project fact验证不变，不能把任一事件单独当作Project identity。
- Rejected speculation: 不抬高15秒常量、不增加轮询、retry、第二click、硬编码Project URL、替代endpoint、全局blank-page清理或错误转成功。
- No user decision is required;现有Puppeteer page event和init seam足以承载本修复。

## R54 Current Revision Delta: page creation exclusion与deadline收敛

R50独立审计证明“双rAF代表React handler已hydrate”没有真实接口证据，因此该方案整体废弃且从未实施。R51继续用不增加click前page round的原位诊断定位真实first divergence；R52又在首个vertical slice排除把allocation整体放进`submissionQueue`的过宽owner，改为既有`pageCreateQueue`临界区与cold Project initializer共享私有exclusion。R52三项slice和完整55项nested suite均已green。首个无instrumentation fresh4/2随后产生新的精确first-expiring owner：第一voice、cold Project和第二voice均成功，但R57当时从请求入队算起的60秒core deadline在第三voice刚开始后到期。R54保留R52全部owner，并把当前唯一core业务默认deadline定义为80秒；它仍早于TUI 90秒、CLI 120秒和harness 130秒，不重置排队时钟、不扩其它timeout。

### R54 Evidence and Reachability

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| R50 auditor verdict B-01 | 额外page turn只证明时序改变，不能证明第二rAF或handler hydration；R50未批准。 | independent audit |
| `/private/tmp/chatgpt-cold-overlap-r52/daemon.log:13-21` | voice认领official spare page，147ms内稳定完成；唯一direct约15.0秒后报`signal is aborted without reason`，源码短音频page timer正是15秒。 | observed |
| `chatgpt-dom.js:773-850`、`chatgpt-core.js:1667-1725` | R52实施前DOM按音频大小另建15至45秒timer，core当时拥有从入队开始的60秒绝对deadline、取消settle和page隔离owner；R54当前合同统一为80秒并传remaining。 | observed |
| `/private/tmp/chatgpt-cold-overlap-r53/daemon.log:5-17`与失败现场CDP | first ask在root做Project discovery，second ask创建`about:blank`；button已有React props/onClick，但原位bubble probe的event保持null，60秒后仍为root+blank。 | observed |
| `/private/tmp/chatgpt-cold-overlap-r54/daemon.log:11-19` | 临时将new-session allocation归入submission owner后，两个ask page在前项结束后创建，Project trusted event被React接受；未改selector/click算法。 | observed |
| `/private/tmp/chatgpt-ask-overlap-r55/daemon.log:5-23` | 两个并发new ask中Project event立即可信接受；Project init可慢至约55秒，第二target仅在Project完成后创建，不再与click重叠。 | observed |
| `/private/tmp/chatgpt-ask-overlap-sessions-r55/sessions.json:3-13`与同一daemon-owned page只读事实 | session在可信click后因10秒`Waiting failed`被记lost；同页随后有严格MCP `/c/...` URL、1 user turn和1 assistant turn，证明远端真实接受而非route-only。 | observed |
| R51 slice 1 red/green命令 | allocation barrier在当前实现观察到initializer overlap；临时submission wrapper使该test green，但`testVoiceAndAskSerializeRemoteSubmission`由green变成fixture timeout。 | observed |
| `chatgpt-core.js:1418-1435,1474-1488,1510-1540` | voice/page target认领已共用`pageCreateQueue`；cold Project initializer是需要排除creation的另一方，且自身仍由submissionQueue排序。 | reachable / observed |
| `/private/tmp/chatgpt-cold-overlap-r57/daemon.log:5-21` | 第一voice direct 27.430秒成功；Project约27.5秒成功；第二voice 3.523秒成功；第三voice开始约1.4秒后触达从入队起算的60秒deadline。 | observed |
| `chatgpt-core.js:81-87`、`prompt-voice-input.ts:5-7`、`chatgpt.js:55-60`、`test-voice-robustness.js:56-65` | R57运行时core默认为60秒；R54当前合同改为80秒，TUI 90秒、CLI HTTP 120秒、E2E child 130秒保持外层边界。 | observed / contracted |

所有`DEBUG-R51/R52`、`__r51`、45秒测量值和临时allocation/submission wrapper均已删除；它们只建立诊断事实，不属于批准实现。R54诊断run的`Failed to fetch`证明放宽内部timer不能把真实transport错误包装成成功，因此当前R54仍保持一次POST、无重试和原样失败。

### R54 Required Invariants and First Divergence

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-26 | target creation只需与cold Project initializer互斥；它不得被全局放入submissionQueue而改变已确认的voice/ask接受顺序。 | `pageFor()`与Project initializer分属`pageCreateQueue`/`submissionQueue`；R53重叠时trusted event为null。R51 wrapper又让既有2 voice/1 ask timeout。 | `chatgpt-core.js:createDaemonRuntime()`把已有page-creation临界区抽为私有exclusion，Project在自身submission transaction内取得同一exclusion。 | allocation barrier test在当前实现red；候选submission wrapper造成既有回归，证明更宽owner不可接受。 |
| INV-27 | page fetch abort只能消费当前voice剩余绝对deadline，不能按短音频大小提前中止。 | ready official page的short direct被15秒内部timer终止，外层请求仍有约45秒。 | core request context拥有`remaining()`；DOM只拥有页面controller和唯一wire。 | R52时间线与源码常量精确一致；R54 37秒真实transport失败仍失败，证明该修复不构造成功。 |
| INV-28 | send后的接受事实仍是新增user turn，但其安全窗口必须与既有20秒conversation acceptance边界一致。 | `clickSend()`固定10秒先失败，`rememberCurrentSessionUrl()`的既有20秒阶段根本未执行；同一页面随后已有user/assistant turn与严格URL。 | DOM拥有user-turn事实；core继续拥有URL/Project identity和lost/pending registry。 | R55 registry、daemon log和page事实来自同一session，不是推测或任意历史会话。 |
| INV-29 | voice绝对deadline从入队开始，但默认必须容纳已观察到的cold 4/2先行事务，并早于TUI/CLI外层。 | R57前置成功步骤累计约58.6秒，第三voice只获约1.4秒即被60秒core预算中止。 | `chatgpt-core.js` request context拥有业务deadline；TUI/CLI只拥有外层进程/HTTP预算。 | 真实反馈环精确在60秒red；80秒仍低于现有90/120秒外层。 |

### R54 Single Approved Primary Path

```text
new ask missing-session page allocation
→ existing page-creation exclusion
→ cold Project: existing submissionQueue + same page-creation exclusion
→ existing one trusted Project click + R49 route/init
→ existing one trusted send click
→ user-turn event within min(responseTimeout, existing 20s acceptance bound)
→ strict Project conversation URL recording

voice queue ownership
→ stable lease
→ 80s default absolute request budget, still counted from queue entry
→ remaining absolute request budget passed to page AbortController
→ one direct POST
→ complete response or existing diagnostic failure/settle/isolation
```

1. 将`claimVoicePage()`与`pageFor()`已经重复的`pageCreateQueue`获取/release抽为私有`withPageCreationExclusion(task)`；它仍完成容量检查、spare唯一认领和`newPage()`的原子边界。
2. `ensureProject()`仍先通过existing `withSubmission()`建立remote transaction，再在执行唯一initializer时取得`withPageCreationExclusion()`；正在创建的target先完成，Project开始后后续target等待。page allocation本身不进入submissionQueue，保留R38/R19顺序。
3. `runVoiceTranscribe()`在唯一POST前读取现有`shouldCancel.remaining()`并作为internal DOM option传入；`transcribeAudioFileDirect()`页面timer使用该剩余预算。R53 core默认绝对deadline为80秒；requestID、AbortController、取消、lease release/discard和一次POST不变。
4. `clickSend()`不改变trusted click与user-turn predicate，只把10秒上限替换为`Math.min(responseTimeout, 20_000)`；随后core仍按严格Project policy在既有20秒内记录URL。URL变化、composer清空或assistant文本都不能替代user turn。
5. R49 route/init、R48 section-local selector、R41 identity、R38 queue/direct、R37长语音合同全部保留。
6. `VOICE_TRANSCRIBE_TIMEOUT_MS`只调整core默认值`60_000 → 80_000`；显式env覆盖、`makeRequestContext`绝对时钟和所有外层timeout不变。

### R54 Responsibility and Traceability

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Target creation / cold Project exclusion | core existing pageCreate + submission queues | creation与cold initializer互斥，同时不改变voice/ask FIFO | 两个真实冲突producer都在同一runtime，pageCreateQueue已经拥有creation原子性 | DOM不创建target；submissionQueue不能吸收整个allocation |
| Direct request deadline | core request context → DOM page controller | 页面timer不早于当前请求剩余预算 | core拥有绝对deadline，DOM拥有fetch abort | TUI不应扩deadline；DOM不自行推导audio时长deadline |
| Trusted send acceptance | DOM user-turn predicate | click后在既有acceptance边界等待真实turn | DOM拥有消息事实 | core只验证URL/Project并维护registry，不能复制DOM |
| Voice total deadline | core request context | 从入队起算80秒默认业务预算 | core拥有queue、lease和direct完整生命周期 | TUI/CLI只负责更宽的进程/HTTP终止边界 |
| Project identity/route/init | existing R41/R49 owners | strict identity + one click + route/init | 已有实现充分 | R54不修改 |

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-26 / no allocation-click overlap | target claim/allocation ↔ cold initializer shared exclusion | `chatgpt-core.js`抽取既有pageCreate临界区并在initializer复用 | 受控newPage barrier期间Project initializer不得开始；既有2 voice/1 ask仍green |
| INV-27 / one absolute voice deadline | context remaining → DOM controller → one POST | `chatgpt-core.js`传剩余值，`chatgpt-dom.js`删除size deadline | local same-origin short WAV response晚于15秒、早于剩余预算；当前AbortError red，修复后一次成功 |
| INV-28 / no false lost after accepted click | trusted click → delayed user turn → strict URL | `chatgpt-dom.js`复用existing 20s bound | trusted fixture在10秒后、20秒前追加turn；当前10秒red，修复后green；route-only仍red |
| INV-29 / cold overlap total budget | queue entry → Project/voice FIFO → direct | `chatgpt-core.js`默认80秒；`README.md`同步 | instrumentation-free R57已在60秒red；同一4/2在80秒green，deadline/cancel fixture不变 |
| full lifecycle | R38/R49 retained + three corrections | no other production change | repeated fresh4/2、12/6、browser/profile/idle/long voice |

### R54 TDD and File-Level Change Plan

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 扩展runtime行为fixture：第二new Session的`newPage()`被barrier保持时并发调用Project initializer，断言initializer在allocation释放前未开始，释放后两者均完成；同轮运行既有2 voice/1 ask。 | 当前两条queue允许overlap；R51 submission wrapper虽使新test green，却让既有提交顺序timeout。 | 抽取并复用既有pageCreate exclusion；allocation不进入submissionQueue。 | Project click不被target creation打断，且第一voice后ask/第二voice顺序不变。 |
| 2 | 扩展direct bootstrap-auth fixture：同源transcribe在约15.2秒后返回，传入20秒预算，要求一次POST和完整文本。 | 当前短音频page timer固定15秒，确定性AbortError。 | core传remaining，DOM page timer使用20秒测试预算。 | 不抬高外层总预算、不重试、慢但有效响应不被误杀。 |
| 3 | 扩展trusted-submit fixture：handler立即可信接受click，但在约10.2秒后才追加user turn；DOM responseTimeout设12秒。route-only case缩短到1秒并继续要求`promptMayHaveBeenSent=true`。 | 当前user-turn固定10秒先失败并留下lost。 | 使用`min(responseTimeout, 20_000)`等待同一predicate。 | 真实迟到acceptance可记录；URL-only不能伪装成功。 |
| 4 | 保留R49 >15秒init、R48 row/More、R41 identity、R38 queue/cancel、R37 long marker测试。 | 新owner不能放宽既有身份、取消、direct-only或event convergence。 | 全部green。 | 完整兼容与安全边界。 |
| 5 | 至少连续两次无instrumentation fresh4/2，再执行12/6和完整生命周期矩阵；每轮结束检查managed pages无`about:blank`、lost=0、submitted精确。 | 单次成功不能覆盖用户报告“一好一坏”。 | 所有门禁green；真实transport错误仍算失败并重新开始独立验收cycle，不在同一请求重试。 | 交替失败、资源泄漏、空白页和重复提交。 |
| 6 | 复用原始无instrumentation fresh4/2：R57已精确60秒red，改默认值后从新隔离state重跑。 | 前置正常事务吃掉绝大部分绝对预算，第三voice无法完成唯一direct。 | 只改core默认80秒；结果仍需4 voice、2 ask、2 accepted、4 submitted和资源收敛。 | 默认deadline与真实cold FIFO匹配，不靠env或同请求重试。 |

| File | Add / modify / delete | Exact responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-core.js` | modify | 抽取既有pageCreate临界区供target claim/allocation和cold Project initializer共享；向唯一direct传剩余deadline；默认总预算80秒。 | +13/-13 |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | page fetch使用传入remaining；send user-turn使用existing 20s acceptance bound。 | +5/-4 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 三项公开seam行为red/green；复用既有fixture，不新增test-only production hook。 | +65/-5 |
| `thirdparty/chatgpt-browser-agent/README.md` | modify | 同步`CHATGPT_VOICE_TRANSCRIBE_TIMEOUT_MS`默认80秒及从入队起算语义。 | +1/-1 |

### R54 Decision Surface and Comment Budget

R54不新增成功路径、retry或diagnostic。pageCreate exclusion只把已有临界区命名并供真实冲突owner复用，不增加decision；user-turn predicate不变；direct options增加一个primary输入归一分支；默认常量变化不增加decision。R49 current surface `84/7`更新为`chatgpt-core.js 51/3`、`chatgpt.js 8/1`、`chatgpt-dom.js 26/3`，Combined `85` decisions、`7` diagnostics、`7 / 85 = 8.24%`。implementation audit必须重新按实际diff计数。

以R49 `E≈1820/C≥273`为基线，R54 production/test预计增加约81行有效修改，计划`E≈1905`、`C≥286`（`ceil(1905 * 0.15)=286`）。证据、plan、README、临时日志不计入E；最终必须按完整实际diff重算。新增中文注释只解释四项非显然owner/invariant，不能用显然流程凑数。

### R54 Risks and Rejected Speculation

- Confirmed risk: target creation与cold Project trusted input当前分属两条不相交queue；共享pageCreate exclusion只覆盖这两个观察到的producer，不串行voice direct、回答等待或已有Session恢复。
- Confirmed risk: 15秒内部timer真实早于请求总deadline；R53默认总预算统一为80秒后，R54的37秒`Failed to fetch`仍应原样失败，禁止用deadline修复包装transport错误。
- Confirmed risk: send已接受但user turn晚于10秒会留下不可恢复lost；等待仍只认user turn，随后strict URL必须成功。
- Confirmed risk: R57历史core 60秒早于已观察cold FIFO完成时间；R54当前80秒合同只修该owner，仍保留TUI 90秒和CLI 120秒外层终止。
- Rejected speculation: 不实现双rAF、毫秒sleep、click retry、第二click、audio重试、endpoint替换、全局blank cleanup、URL硬编码、429 special case或错误转成功。
- No user decision is required;四个现有owner和行为证据足以承载最小修复。

## 21. Audit Contract

独立auditor必须：

- 阅读本文件当前完整revision和本轮原始需求。
- 从当前仓库、当前nested commit和当前日志重新重建voice/browser/TUI调用链，不信任历史方案或builder摘要；R58必须同时核验private marker reconnect、blank→bootstrap、external profile compatibility、graceful close/cold transition、Unicode byte-tail、四attempt、单attempt cleanup、TUI取消与R54既有direct/queue/profile行为，不得只审revision摘要。
- 审计完整原始范围：页面反复跳转、缓存消失、好坏交替、取消/daemon、并发/高压、浏览器关闭后恢复、profile持久化、订阅首屏失败、current bootstrap-auth direct、长语音、5分钟idle、ask兼容和安全ownership。
- 检查R25最小并发producer是否真实传导到伪发送，submission queue是否只覆盖提交窗口并保持ask生成并发，而非重试、fallback或全局串行。
- 检查第一处分歧是否被修复，是否误把voice问题下沉为TUI或DOM workaround。
- 检查direct-only与四attempt是否确实落实用户“不以报错作为fallback”：重试必须重复同一个authenticated direct主路径，而不是新增alternate success path。
- 检查Project cache-first和lazy startup是否维持Project/Session身份安全，不因voice解耦而绕过ask验证。
- 检查每个production concept的forward/reverse traceability、行为测试和责任归属。
- 检查中文注释预算和测试是否行为级、独立expected、非源码/调用次数断言。
- 检查R63完整production有效修改是否不超过600行，且没有用历史净删除、删减/软化有效中文注释或伪造未观察异常输入来满足预算。
- 检查R60三个implementation blockers及R61 plan blocker在其owner处被完整映射：pre-ready provenance cleanup、local daemon 401只reconcile changed usable current state且不retire/unlink、隔离default-private production E2E；不得把fixed-port helper测试或用户profile冒充default-private证据。
- 任一blocking finding都必须让本plan递增revision并进行完整原始范围重审，不得delta-only审计；R63未获独立`No blocking findings`前不得实施。

## 22. Plan Audit Record

本节保存各旧revision的auditor原文和release verdict，属于不可篡改历史；旧TDD、line number、单次不重试和R54/R60批准不得解释为R63实施授权。当前规范来自R63第1至21节，并保留未被本轮明确替换的R60/R54行为；任何旧批准都不授权R63 production或test修改。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01, B-02, B-03, B-04, B-05, B-06 | audit-mode terminology; comment estimate arithmetic accepted | BLOCK — Revision R2 is not approved. | `ses_09dc96855ffeLaJZTstF8RciUr` |
| 2 | R3 | yes | B-01, B-02, B-03, B-04 | diagnostic budget per-owner clarification; stable criteria; E estimate basis | BLOCK — Revision R3 is not approved. | `ses_09dc10f65ffeNqJaCGI3jA2FRn` |
| 3 | R4 | yes | B-01, B-02, B-03, B-04 | file accounting; R3 budget label; comment arithmetic accepted | BLOCK — Revision R4 is not approved. | `ses_09db660d4ffe26lC6Cm2NBClJ2` |
| 4 | R5 | yes | B-01, B-02, B-03 | primary diagram terminology; comment and diff accounting reminders | BLOCK | `ses_09da9f581ffeUPEnQWgyumVceG` |
| 5 | R6 | yes | none | diagnostic denominator text; actual long-voice outcome; effective/net line reconciliation | APPROVE — No blocking findings. | `ses_09da9f581ffeUPEnQWgyumVceG` |
| cycle 2 / 1 | R7 | yes | B-01, B-02 | diagnostic denominator; cache trace ID; comment arithmetic | BLOCK — Revision R7 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 2 / 2 | R8 | yes | B-01 | stale footer/TUI wording; close pre-isolation; comment arithmetic | BLOCK — Revision R8 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 2 / 3 | R9 | yes | B-01 | historical baseline wording; close safety accepted; long success accepted; comment arithmetic | BLOCK — Revision R9 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 2 / 4 | R10 | yes | none | baseline wording; E/C actual recount; diagnostic actual recount | APPROVE — No blocking findings. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 3 / 1 | R11 | yes | B-01, B-02 | reproduction command evidence reminder; production line/comment count; R10/R11 evidence separation | BLOCK — Revision R11 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 3 / 2 | R12 | yes | B-01 | evidence wording; line/comment recount; profile observation preservation | BLOCK — Revision R12 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 3 / 3 | R13 | yes | none | metadata consistency; historical quarantine; actual line/comment recount; implementation evidence | APPROVE — No blocking findings. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 3 / 4 | R14 | pending | pending | pending | audit required | pending |
| cycle 3 / 5 | R15 | pending | pending | pending | audit required | pending |
| cycle 3 / 6 | R16 | pending | pending | pending | audit required | pending |
| cycle 3 / 7 | R17 | pending | pending | pending | audit required | pending |
| cycle 3 / 8 | R18 | pending | pending | pending | audit required | pending |
| cycle 3 / 9 | R19 | pending | pending | pending | audit required | pending |
| cycle 3 / 10 | R20 | yes | none | baseline classification; actual E/C recount; implementation evidence | APPROVE — No blocking findings. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 4 / 1 | R21 | yes | B-01, B-02 | owner、baseline、预算方向认可 | BLOCK — Revision R21 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 4 / 2 | R22 | yes | B-01, B-02 | evidence/source/reload方向认可；comment/line预算认可 | BLOCK — Revision R22 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 4 / 3 | R23 | yes | B-01 | typed contract、evidence、budgets认可 | BLOCK — Revision R23 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 4 / 4 | R24 | yes | none | implementation recount required | APPROVE — No blocking findings. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 5 / 1 | R25 | yes | B-01 | owner、根因、无重试方向认可 | BLOCK — Revision R25 is not approved. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 5 / 2 | R26 | yes | none | historical cookie-only wording; implementation evidence and actual recount pending | APPROVE — No blocking findings. | `ses_09d781578ffeZ9ZwE68ylnBcwp` |
| cycle 6 / 1 | R27 | yes | B-01 decision surface未重算；B-02无voice重叠的generic ask越界 | distinct prompt/accepted计数与可选长WAV证据方向认可 | BLOCK — Revision R27 is not approved. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 6 / 2 | R28 | yes | B-01同一压力同时保留same-Session/2页与independent-Session/7页合同 | decision surface、generic ask排除、CI skip和本地artifact方向认可 | BLOCK — Revision R28 is not approved. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 6 / 3 | R29 | yes | none | producer合同统一；generic ask排除；CI skip与本地artifact；实际E/C待实现审计 | APPROVE — No blocking findings. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 6 / 4 | R30 | no | user随后禁止硬编码conversation URL/token | 未进入审计 | superseded by R31 | N/A |
| cycle 6 / 5 | R31 | yes | none | §22 revision措辞；cache缺MCP时必须live discovery；实际E/C待实施审计 | APPROVE — No blocking findings. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 7 / 1 | R32 | yes | B-01未重算sidebar production decision surface；B-02完整压力仍残留managed page最多2 | root cause、DOM owner、TDD slice与MCP配置方向认可 | BLOCK — Revision R32 is not approved. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 7 / 2 | R33 | yes | none | historical current-chain wording；actual E/C需实现审计重算 | APPROVE — Revision R33 has no blocking findings. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 8 / 1 | R34 | yes | B-01新增init failure/timeout未计入diagnostic decision surface；B-02遗漏cache/currentProject fresh-goto producer | live cold ask根因、network事实和无timeout扩张方向认可 | BLOCK — Revision R34 is not approved. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 8 / 2 | R35 | yes | none | exact 10% decision-surface boundary；actual E/C需实现审计重算 | APPROVE — Revision R35 has no blocking findings. | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |
| cycle 9 / 1 | R36 | yes | B-01五分钟长WAV只断言非空，不能证明末端内容或排除short旧结果 | Project queue owner、完整压力、fallback约束和其它原始范围认可；历史R35措辞漂移 | BLOCK — Revision R36 is not approved. | `ses_0992fbd59ffeP81CnZ7ze2bUAM` |
| cycle 9 / 2 | R37 | yes | none | Darwin本地TTS限制；末端marker合同符合生命周期目标；actual E/C需实现审计重算 | APPROVE — Revision R37 has no blocking findings. | `ses_0992fbd59ffeP81CnZ7ze2bUAM` |
| cycle 10 / 1 | R38 | yes | pending | pending | audit-required | pending |
| cycle 10 / 2 | R38 | yes | none | duplicate slice 24 removed；Darwin TTS限制；actual E/C需实现审计重算 | APPROVE — Revision R38 has no blocking findings. | `ses_0992fbd59ffeP81CnZ7ze2bUAM` |
| cycle 10 / 3 | R39 | yes | B-01 discovery中建立第二套且范围过宽的目标歧义裁决 | 中文注释实际重算；长语音若red需先定位owner；README需跟随最终合同 | BLOCK — Revision R39 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 10 / 4 | R40 | yes | B-01 R40未按删除后的production decision surface重算diagnostic预算；B-02净行数/等量替换未按有效修改行计算E/C | 测试名需同步；长语音red仍需先定位owner | BLOCK — Revision R40 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 10 / 5 | R41 | yes | none | decision-surface/E-C实际值需implementation audit重算；300秒长语音若red需先定位owner | APPROVE — Revision R41 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 11 / 1 | R42 | no | Project discovery click边界尚未定位 | 仅记录diagnosis trigger，未进入审计 | superseded by R43 | N/A |
| cycle 11 / 2 | R43 | yes | B-01 first-divergence证据不可独立复核；B-02设计不在当前规范范围；B-03 decision surface未按selector修改说明；B-04 metadata为draft | 真实owner方向合理；中文预算算术正确 | BLOCK — Revision R43 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 11 / 3 | R44 | yes | B-01 current Audit Contract/Plan Audit Record仍把R43声明为current revision，无法精确放行R44 | R44行为设计、证据、owner、decision surface和E/C均无阻塞 | BLOCK — Revision R44 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 11 / 4 | R45 | yes | none | R45标题保留R44来源字样；E说明可再统一标签；implementation audit需重算实际E/C并确认temp artifact不进入运行时/CI | APPROVE — Revision R45 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 11 / 5 | R46 | yes | B-01 R46未清除R45 approval；B-02 section guard decision surface未计入；B-03无section全局文本兼容缺少consumer合同 | R46真实artifact和跨section first divergence成立 | BLOCK — Revision R46 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 11 / 6 | R47 | yes | B-01 R47错误沿用R45放行状态；当前revision没有精确clean approval | R47行为设计、first divergence、fallback删除和traceability均通过；审计轮次已达上限 | BLOCK — Revision R47 is not approved; open decision required. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 1 | R48 | yes | none | current-revision labels in §21/§22 should be synchronized from R47; E/C remains implementation-audit requirement | APPROVE — Revision R48 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 2 | R49 | yes | none | E summary label still says 1790 while R49 budget is 1820; verification description could name >15s boundary more explicitly | APPROVE — Revision R49 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 3 | R50 | yes | B-01 | watcher-race排除、R49 route/init保留、E汇总标签需同步 | BLOCK — Revision R50 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 4 | R51 | yes | none | E/C historical estimates and actual decision count remain implementation-audit checks | APPROVE — Revision R51 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 5 | R52 | yes | none | actual E/C and exclusion decision count remain implementation-audit checks | APPROVE — Revision R52 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 6 | R53 | yes | B-01, B-02 | E/C actual recount; R52 exclusion direction retained | BLOCK — Revision R53 is not approved. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 12 / 7 | R54 | yes | none | actual E/C, exclusion scope and complete E2E remain implementation-audit checks | APPROVE — Revision R54 has no blocking findings. | `ses_098fdf18dffeVKHyuHpG5dnA3k` |
| cycle 13 / 1 | R55 | yes | B-01 recoverability边界缺失；B-02 TUI漏算7秒退避；B-03 cold直接URL路径被已有失败证据反证 | metadata audit mode、E/C比例和600行预算无阻塞 | BLOCK — Revision R55 is not approved. | `ses_004a71659ffedZDO1rc67xRB6q` |
| cycle 13 / 2 | R56 | yes | B-01 VOICE_ENDPOINT混入确定性认证/响应错误；B-02 BROWSER_STARTUP混入browser配置错误 | 文件数/DOM记录与decision surface需实现审计重算 | BLOCK — Revision R56 is not approved. | `ses_00498d488ffebtPmyn3yquJn6b` |
| cycle 13 / 3 | R57 | yes | B-01取消unlocked external profile既有受控launch合同并阻断长语音E2E | revision标签、blank措辞需同步；E/C满足 | BLOCK — Revision R57 is not approved. | `ses_004902d9dffeYrCIr3FcHWrXlY` |
| cycle 13 / 4 | R58 | yes | B-01公开debug-port-only启动/ownership/stop合同未映射 | 少量revision标签；E/C正确 | BLOCK — Revision R58 is not approved. | `ses_0048955ecffecp9hGRE3P61P71` |
| cycle 13 / 5 | R59 | yes | B-01 debug-port owned browser在daemon崩溃后丢失ownership provenance | metadata、E/C和主要范围无阻塞 | BLOCK — Revision R59 is not approved. | `ses_00481c1d8ffeMxUoaKDTU73AfJ` |
| cycle 13 / 6 | R60 | yes | none | verbatim requirement placement；implementation E/C recount；historical test names；cycle limit reached | APPROVE — Revision R60 has no blocking findings. | `ses_0047c5326ffeqpDMCvZL7VTHXV` |
| cycle 14 / 1 | R61 | yes | B-01 daemon identity 401 recovery cannot retire the live daemon | stale §5 baseline wording；E/C feasible | BLOCK — Revision R61 is not approved. | `ses_003cce40effeiBH6n8p7ekyaKP` |
| cycle 14 / 2 | R62 | yes | B-01 R62仍同时授权会删除当前daemon发现状态的旧401处理 | E/C和600行预算可行；部分历史revision措辞 | BLOCK — Revision R62 is not approved. | `ses_003c6652dffeLP8TppnMZkzYYn` |
| cycle 14 / 3 | R63 | yes | none | §1补充需求由INV/trace完整承载；§27历史401-retire不授权R63；actual E/C/production行数待implementation audit | APPROVE — Revision R63 has no blocking findings. | `ses_003c05c4fffeq6MuyiW5IKrmeV` |

### R63 Independent Verdict (copied from auditor)

## Blocking findings

No blocking findings.

## Non-blocking findings

- §1未逐字收录本次全部补充需求，但INV-03、INV-08、INV-14、INV-15、INV-30至INV-35及正反向追踪已完整承载其行为约束。
- §27保留了R60 implementation audit关于“401后retire”的历史结论；§19、§0.9及§22已明确其不授权R63，当前规范没有歧义。
- 实现审计仍须按实际完整diff重新核算production有效修改行数及E/C。

## Release verdict

**APPROVE — Revision R63 has no blocking findings.**

该结论仅适用于当前磁盘上的canonical plan revision **R63**。任何行为、owner、接口、测试、fallback分类或文件范围的实质变化都需要新revision和完整复审。

### R61 Independent Verdict (copied from auditor)

**B-01 daemon identity 401 recovery cannot retire the live daemon**

- Violated invariant: Lifecycle recovery must settle the failing daemon/browser owner before starting the next attempt; it must not erase a healthy daemon’s discovery state and create competing daemons.
- Evidence class: reachable.
- Producer and execution path: A CLI retains an earlier daemon state while a concurrent lifecycle replaces the daemon on the same port → `/voice` receives 401 from the replacement daemon → planned `DAEMON_IDENTITY_MISMATCH` handling calls `retireDaemon()` with the stale token → `/stop` also receives 401 → `retireDaemon()` suppresses that failure and unconditionally deletes daemon discovery files → the next attempt starts another daemon against the browser/profile still controlled by the live replacement daemon.
- Responsibility owner: Local daemon identity and discovery lifecycle in `chatgpt.js`.
- Minimal correction direction: Make the daemon identity owner prove that the currently live daemon has been retired, or safely reconcile with its current discovery identity, before deleting discovery state or starting another daemon. A failed authenticated stop must not be treated as completed retirement.

Non-blocking findings：§5仍把R60 default path描述为`puppeteer.launch`，属于stale baseline wording；`E≈680/C≥102`算术可行，actual值留给implementation audit。

Release verdict：**BLOCK — Revision R61 is not approved.**

### R60 Independent Verdict (copied from auditor)

## Blocking findings

No blocking findings.

## Non-blocking findings

- §1未逐字收录本次补充需求，但相关约束已由元数据、非目标、INV-03/08/14/15/30–33及正反向追踪完整承载。
- R60预计生产有效修改约390行，低于600行硬上限；实现审计仍须按实际diff重新计数。
- 部分旧测试名称仍反映“单次不重试”历史合同；R60已明确由新的四次attempt测试替换，不构成当前规范冲突。
- 本轮为第六次R55–R60完整计划审计，已达到该审计周期上限。

## Rejected speculation

- 不要求处理损坏CDP帧、未来bootstrap schema、任意进程终止或未知浏览器状态。
- 不要求扫描、附加或关闭普通用户Edge。
- 不要求新增endpoint、DOM听写、不同上传算法或错误后替代成功路径。
- `browser-owner.json`缺失或PID/profile/port不匹配时按shared处理，符合fail-safe边界；无需猜测ownership。
- 429后的同wire重试由明确用户合同授权，不因可能重复POST而否定该要求。

## Requirement and traceability coverage

- 孤儿私有Edge：`DevToolsActivePort → reconnect → bootstrap convergence`直接修复重复launch与profile lock根因。
- debug-port分支：以CDP browser PID、规范化profile和port持久验证跨daemon ownership，并覆盖crash、reconnect、stop及mismatch。
- Unicode日志偏移：字节游标对应Buffer tail读取，能够让具体startup错误提前到达CLI。
- 生命周期自维护：owned browser使用CDP graceful close；超时只disconnect并保留后续重连能力；shared browser始终只disconnect。
- 冷启动：私有browser缺失或已证明退化时沿同一blank→marker→bootstrap主路径恢复。
- 重试：CLI统一执行最多四次完整attempt，429、5xx、transport、page、browser及daemon运行错误进入封闭重试集合；登录、认证、输入、确定性4xx、响应合同错误和取消立即终止。
- TUI预算与取消：1,237,000ms覆盖四次完整预算、退避和清理；voice仅终止CLI父进程，不递归强杀daemon/browser。
- 长语音、五分钟idle、并发压力、Project/Session隔离、WAV清理及后续调用均有对应验证。
- 每项新增production概念均有需求ID、可达或观察证据、owner、文件修改和行为敏感测试。

## Primary-path and fallback verdict

权威路径保持单一：

`TUI WAV → CLI四次attempt编排 → owned/shared browser acquisition → bootstrap收敛 → core voice queue与lease → authenticated direct POST → text或最终错误`

重试仅重复同一authenticated direct事务。没有第二endpoint、UI听写、catch-and-success、配置逃生路径或失败后替代算法。Private、external、debug-port和explicit shared属于同一browser acquisition接口的受支持输入分支，ownership语义明确且互斥。

## Code quality and Chinese-comment verdict

计划限定修改9个既有文件，不新增依赖、公开配置、migration或替代模块；owner边界与仓库风格一致。

计划估算：

- `E ≈ 650`
- `C ≥ 98`
- `98 / 650 ≈ 15.08%`

满足15%实现目标。实现审计须重新计算实际E/C并核验注释邻近性与解释价值。

## Release verdict

**APPROVE — Revision R60 has no blocking findings.**

该结论仅适用于当前磁盘上的canonical plan revision **R60**。任何行为、owner、接口、测试、fallback分类或文件范围的实质变化都需要新revision和完整复审。

### R59 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 debug-port owned browser 在 daemon 崩溃后丢失 ownership provenance

- Violated invariant: `CHATGPT_BROWSER_DEBUG_PORT` 启动的 browser 在 daemon 异常退出后必须按同一端口重连并继续保持 owned；后续正常 stop 应执行 graceful close，不能退化成 shared disconnect 并再次遗留 profile lock。
- Evidence class: reachable
- Producer and execution path: debug port初始不可达 → daemon固定端口spawn并owned → daemon异常终止 → stale `daemon.json`被CLI删除 → 新daemon发现端口可达 → 无跨daemon provenance则按shared → stop只disconnect。
- Source evidence: `chatgpt.js:42,551-566`；`chatgpt-core.js:2230-2247,2404-2411`。
- Canonical-plan evidence: §7 `INV-14`；§10第0.1项；§12路径清单；§16 slice 37；§18 debug-port测试。
- Responsibility owner: core browser lifecycle；CLI stale daemon清理为直接consumer。
- Concrete consequence: 正常stop遗留browser和profile lock，重新形成原始孤儿问题。
- Why this is not speculative: debug-port是公开配置，spawn和daemon异常退出均可达，当前daemon state不保存browser ownership。
- Minimal correction direction: 建立跨daemon仍可验证的同profileownership事实，重连和stop消费它；增加spawn→crash→reconnect→stop测试，不得PID扫描、强杀或默认未知端口owned。

## Non-blocking findings

- R59 metadata一致；§21仍有一个陈旧R58标签。
- production硬上限600，`E≈600/C≥90`满足15%。
- Unicode、private marker、external/shared、retry、TUI取消和长语音范围均完整。

## Rejected speculation

- 不要求扫描/终止普通Edge、损坏marker/CDP帧、future schema、第二endpoint/UI dictation或确定性错误重试。

## Requirement and traceability coverage

除debug-port跨crash ownership外，原始范围完整映射；该缺口直接影响生命周期自维护和profile lock根因闭环。

## Primary-path and fallback verdict

Voice成功路径保持单一；当前阻塞仅是debug-port分支无法跨daemon可靠维持ownership。

## Release verdict

**BLOCK — Revision R59 is not approved.**

### R58 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 显式 `CHATGPT_BROWSER_DEBUG_PORT` 的既有启动合同未映射

- Violated invariant: browser lifecycle 重构必须覆盖公开支持的全部 browser reuse/launch 输入；一个公开配置路径只能有明确且唯一的 ownership 与关闭语义。
- Evidence class: contracted
- Producer and execution path: 用户设置 `CHATGPT_BROWSER_DEBUG_PORT=<port>`，未设置 CDP/WS endpoint → `BROWSER_CDP_URL` 从 debug port 派生 → 当前实现先连接该端口，不可达时使用同一 profile 启动带固定 DevTools port 的受控浏览器 → Puppeteer connect。
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/README.md:67`
  - `thirdparty/chatgpt-browser-agent/README.md:122-131`
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:55-57`
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:125-173`
- Canonical-plan evidence: R58 §10 第0项、错误分类、路径清单和文件计划只分别定义默认 private marker、显式 CDP/WS shared、显式 external profile launch，未定义显式 debug-port-only 分支。
- Responsibility owner: `chatgpt-core.js` browser/profile lifecycle owner。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: R58 将整体替换 `launchBrowser` 与关闭 ownership，但没有规定 debug-port-only 输入应继续执行受控 launch、视为 shared connect，还是进入 private marker。实现无法从当前 canonical revision 确定该公开配置的启动、重连和关闭合同，可能直接删除现有的“端口不可达后受控 launch”能力，或把 daemon 自己启动的浏览器误归为 shared 而在正常 stop 后只 disconnect。
- Why this is not speculative: README 明确公开该环境变量，当前 source 存在完整可执行 producer-to-consumer 路径；R58 正在替换该路径的 owner。
- Minimal correction direction: 在 browser owner 中明确保留或明确替换 debug-port-only 的既有合同，并将其启动、ownership、重连、正常 stop、配置错误分类和行为测试纳入唯一 lifecycle 路径；不得让它隐式落入 private/shared 任一分支。

## Non-blocking findings

- R58 对两个原始根因的定位成立：`stat.size` 字节游标被用于 UTF-16 字符串 `slice`，以及默认 private profile 的可连接孤儿 Edge 未被 daemon marker 重连。
- `E≈565`、`C≥85` 的计划计算正确，`ceil(565×0.15)=85`；production 有效修改估算约330行，承诺硬上限600行。
- 当前章节仍有少量历史 revision 标签，如 `R56`、`R57`，但顶部元数据和R58实施范围可辨识，不构成行为缺口。

## Rejected speculation

- 不要求扫描PID、接管普通Edge、强制结束浏览器、增加第二profile、第二转录端点或DOM听写。
- 不要求支持损坏 marker、未知CDP帧、未来认证schema或其它没有 producer 的浏览器状态。
- 不要求解析 `Retry-After` 或增加配置化退避；固定1/2/4秒重复同一 authenticated direct 路径已覆盖用户要求。
- `about:blank` 作为 cold spawn 到CDP ready之间的内部过渡有观察证据，不构成替代成功路径。

## Requirement and traceability coverage

除 B-01 外，R58已映射：private marker与cold lifecycle、Unicode byte-tail、可恢复四attempt、确定性错误立即失败、TUI预算/取消、external/shared profile、长语音/idle/压力与600行/15%门禁。`CHATGPT_BROWSER_DEBUG_PORT` 是当前唯一缺失的公开输入分支。

## Primary-path and fallback verdict

Voice成功语义保持唯一：`TUI WAV → CLI最多四次相同事务 → daemon/browser acquisition → authenticated page lease → 同一 /backend-api/transcribe wire → 完整text`。Browser生命周期路径因 B-01 尚未形成完整、唯一的输入域分类。

## Release verdict

**BLOCK — Revision R58 is not approved.**

### R57 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 计划取消了现有显式外部 profile 启动合同，并使长语音验收不可执行

- Violated invariant: 显式配置的 `CHATGPT_BROWSER_USER_DATA_DIR` 在 profile 未被占用时仍可作为受控 launch profile；防止接管普通 Edge 只要求拒绝正在占用且无 CDP 入口的 profile。
- Evidence class: contracted
- Producer and execution path: 用户或 E2E 显式设置 `CHATGPT_BROWSER_USER_DATA_DIR`、未设置 CDP/WS endpoint → 当前 owner 检查 profile lock → 未锁定时使用该 profile 启动受控浏览器 → R57 改为无显式 endpoint 一律返回 `BROWSER_CONFIG`。
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/README.md:122-131`
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:175-188`
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:222-230`
- Canonical-plan evidence:
  - `docs/plans/voice-transcription-lifecycle-reliability.md:442`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:450`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:712`
- Responsibility owner: `chatgpt-core.js` browser/profile lifecycle owner。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: R57 会拒绝 README 明确支持的、未被普通 Edge 占用的显式 profile launch。计划自己的五分钟 TUI E2E 设置 `CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile>`，同时隔离 `CHATGPT_STATE_DIR` 且未提供 CDP/WS endpoint，因此会在启动前得到 `BROWSER_CONFIG`，无法验证要求中的五分钟长语音完整链路。
- Why this is not speculative: 该配置是公开接口，当前 source 明确执行 unlocked external-profile launch；R57 的验证命令直接生产这一输入。
- Minimal correction direction: browser owner应保留显式配置、未锁定 external profile 的既有受控 launch 合同；继续拒绝正在被普通浏览器占用且无可连接 endpoint 的 profile，并将默认 `STATE_DIR/profile` marker 重连限定在私有 owner 路径。

## Non-blocking findings

- 当前规范仍有过期 revision 标签：§5 使用“R56目标状态”，§11 将 R57 路径标为“R56 proposed”，§21 要求审计“R55”。顶部元数据和当前设计仍明确指向 R57，属于记录同步问题。
- §13 的 profile lifecycle 描述保留“不再依赖 blank-first”，与 R57 的 `blank → CDP → bootstrap` 合同措辞冲突；§10、INV-31 和 TDD slice 32 已明确权威顺序，建议同步历史措辞。
- 中文解释性注释计划满足门槛：`E≈565`、`C≥85`，计算为 `ceil(565×15%)=85`。实现审计仍须按实际 diff 重算。

## Rejected speculation

- 不要求处理伪造或损坏的 `DevToolsActivePort`、任意 CDP 帧或未来 bootstrap schema。
- 不要求扫描、附加或强杀普通用户 Edge。
- 不要求 429 后切换 endpoint、UI 听写、profile 或上传算法。
- 不因 marker 连接失败本身推断浏览器已经退出；计划要求等待 profile 可启动事实后再 cold spawn，这一方向成立。

## Requirement and traceability coverage

- 孤儿私有 Edge、profile lock、marker 重连、异常 daemon 后复用、优雅关闭及 cold spawn 已映射到 core owner和行为测试。
- Unicode 故障准确定位到 `stat.size` 字节游标被用于 UTF-16 字符串 `slice`；Buffer byte-tail 修复和中文前缀黑盒测试可在旧行为下报红。
- 429、5xx、transport、page、browser/daemon 可恢复错误已映射为四次同 wire attempt；登录、token、确定性 4xx、响应契约和配置错误均计划即时返回。
- TUI 的 `1,237,000ms` 总预算、CLI-only cancellation 和 Windows parent-only kill 有明确 owner 与测试。
- idle、并发压力、Project/Session、300 秒末端 marker 和 profile 持久性均有验证路径，但五分钟整链目前受 B-01 阻断。

## Primary-path and fallback verdict

计划保持一条 voice 成功路径：

`TUI WAV → CLI attempt → browser lifecycle → stable lease → authenticated direct POST → complete text`

四次 attempt 重复同一 direct wire，没有 UI 听写、第二 endpoint、成功合成或另一 profile fallback。当前阻塞来自 browser/profile 输入域被错误收窄，导致既有公开合同和计划验收路径失效。

## Release verdict

**BLOCK — Revision R57 is not approved.**

### R56 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 `VOICE_ENDPOINT`把确定性认证与响应契约错误纳入四次重试

- Violated invariant: 只有可恢复错误可以进入重试；认证事实缺失、确定性响应契约错误应立即返回。
- Evidence class: reachable
- Producer and execution path: voice page通过稳定性检查 → direct adapter再次读取`#client-bootstrap` → token在POST前消失，或服务返回200但缺少合法`text` → adapter统一产生`VOICE_ENDPOINT` → core保留code → CLI按R56封闭集合重试最多四次。
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:777-782`
  - `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:803-813`
  - `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:816-834`
- Canonical-plan evidence:
  - `docs/plans/voice-transcription-lifecycle-reliability.md:447-449`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:469`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:641-642`
- Responsibility owner: DOM adapter拥有认证事实、HTTP状态和响应结构分类；CLI只消费稳定recoverability code。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: token消失和确定性200响应结构错误都会被标为可恢复`VOICE_ENDPOINT`，导致同一个WAV重复执行完整daemon/page事务四次，延迟用户获得真实错误，并违反“只重试可恢复错误”的明确要求。
- Why this is not speculative: token在稳定probe后消失是计划明确列出的生产路径；当前adapter明确把该错误和无效响应统一映射为`VOICE_ENDPOINT`，而R56明确把该code列入重试集合。
- Minimal correction direction: 由DOM adapter在错误首次产生处区分可恢复endpoint运行故障与确定性认证/响应契约拒绝；CLI只能重试前者，不能按message二次推断。

### B-02 `BROWSER_STARTUP`把确定性启动配置错误当作可恢复生命周期错误

- Violated invariant: browser生命周期重试只能处理能够通过重新取得daemon/browser而恢复的运行错误；确定性配置或可执行文件错误必须立即返回。
- Evidence class: reachable
- Producer and execution path: 用户通过公开环境变量配置`CHATGPT_BROWSER_PATH` → private cold spawn遇到不存在或不可执行的路径 → startup owner消费child `error/exit` → R56把private launch/connect/bootstrap统一编码为`BROWSER_STARTUP` → CLI退役并重复完整启动最多四次。
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/README.md:56-57`
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:141-165`
  - `thirdparty/chatgpt-browser-agent/chatgpt.js:564-589`
- Canonical-plan evidence:
  - `docs/plans/voice-transcription-lifecycle-reliability.md:445-449`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:595-598`
  - `docs/plans/voice-transcription-lifecycle-reliability.md:641-642`
- Responsibility owner: browser startup owner掌握spawn/connect失败事实；CLI拥有attempt编排。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 不存在的browser executable不会因1/2/4秒退避或daemon重建而恢复，但当前计划要求将其作为`BROWSER_STARTUP`重试四次，最长可重复消耗完整启动预算并反复执行无效cold-start。
- Why this is not speculative: `CHATGPT_BROWSER_PATH`是公开配置，当前代码已有该启动路径；计划还明确要求消费spawn `error/exit`并把private launch错误编码为可重试`BROWSER_STARTUP`。
- Minimal correction direction: startup owner必须把确定性配置/spawn拒绝与可恢复的private browser运行故障分开编码；CLI仅重试后者。

## Non-blocking findings

- Diff预算记录不一致：文件表实际列出9个修改文件，`docs/plans/voice-transcription-lifecycle-reliability.md:724-727`记录8个，并称“DOM不改”，但`:596`明确计划修改`chatgpt-dom.js`。硬上限600行仍明确，属于记录修正。
- R56新增多种错误结果和生命周期决策，但decision-surface表仍停留在R41的`7/85`。所有新路径已有分类，当前证据不足以证明超过10%硬上限，因此不单独阻塞；实施审计必须重新计算。
- 计划承诺`E≈535`、`C≥81`，`ceil(535×15%)=81`，满足计划阶段中文解释性注释目标。

## Rejected speculation

- 不要求损坏marker、伪造CDP帧、未知bootstrap schema或未来DOM文案的生产处理。
- 不要求429后切换endpoint、UI听写、第二profile或另一上传算法。
- 不要求强杀不可连接browser；当前证据支持private marker重连和CDP graceful close。
- 不因Unix风格E2E命令本身否定方案；计划另有可移植的daemon-crash marker验证和Windows Process测试。

## Requirement and traceability coverage

- 孤儿private Edge、profile lock、marker重连、cold spawn、graceful close和shared-browser边界均已映射到owner、文件和测试。
- Unicode字节游标的第一处分歧定位准确：`fs.statSync().size`产生字节位置，当前consumer却对UTF-16字符串执行`slice`。Buffer-tail修复和中文前缀黑盒测试具有原行为敏感性。
- TUI四次完整预算、1/2/4秒退避、30秒清理余量及parent-only取消均有生产路径和测试映射。
- 429、5xx、transport、page、browser/daemon运行故障的四attempt主路径已覆盖。
- 登录介入、确定性4xx和配置错误的即时失败覆盖仍受B-01、B-02破坏。
- 五分钟idle、300秒末端marker长WAV、并发压力、profile持久化及原始daemon-crash反馈环均有明确验证命令。

## Primary-path and fallback verdict

计划保持一条权威成功路径：

`TUI WAV → CLI attempt事务 → private/shared browser生命周期 → stable page lease → authenticated direct POST → 完整text`

四次attempt重复同一wire，没有引入UI听写、第二endpoint或成功合成。当前阻塞来自recoverability分类过宽：确定性失败会错误进入该迭代。

## Release verdict

**BLOCK — Revision R56 is not approved.**

### R55 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 可恢复错误边界未建立，确定性登录失败也会重复四次

- Violated invariant: 仅 HTTP 429 及其它**可恢复**错误至少重试三次；确定性认证、配置或用户介入状态不得进入自动重试。
- Evidence class: reachable
- Producer and execution path: 登录态过期或 bootstrap 明确 `logged-out` → daemon 等待登录并在超时后退出 → `ensureDaemon()`失败 → `transcribe-file`把该 daemon/runtime 错误视为可重试 → 重新启动浏览器并再次等待登录，最多四轮。
- Source evidence: `thirdparty/chatgpt-browser-agent/chatgpt-core.js:2147-2191`, `thirdparty/chatgpt-browser-agent/chatgpt-core.js:2293-2296`, `thirdparty/chatgpt-browser-agent/chatgpt.js:569-589`
- Canonical-plan evidence: §10 第 0.3 项；§16 slices 34–35
- Responsibility owner: `chatgpt-core.js`单次请求错误归一化，以及`chatgpt.js:transcribe-file`重试策略。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 登录过期时一次 TUI 转录可连续打开、关闭并等待多个 browser lifecycle，最长接近四个启动预算；这既不能自行恢复登录，也延迟了用户可操作的明确错误。当前 route 还把除输入和断连外的大多数错误统一为500，CLI无法证明哪些500可恢复。
- Why this is not speculative: README明确要求已登录账号，core现有代码明确生产`logged-out`和登录等待超时；计划明确把“其它core HTTP/transport/page/endpoint/runtime错误”全部纳入重试。
- Minimal correction direction: 在单次请求错误owner建立稳定的可恢复分类，并让CLI只重试该分类及明确要求的429；登录介入、认证拒绝和其它确定性错误必须立即返回。

### B-02 TUI兜底少计三段退避，仍会抢先终止第四次完整尝试

- Violated invariant: TUI总兜底必须覆盖初次尝试加三次重试的全部 daemon、HTTP、清理和退避预算。
- Evidence class: contracted
- Producer and execution path: `transcribeVoiceFile()`总计时 → 四次各最多`180000 + 120000ms` → 三次`1/2/4s`退避 → 第四次临近终态时，TUI的`1230000ms` AbortSignal先触发。
- Source evidence: `packages/opencode/src/cli/cmd/tui/prompt-voice-input.ts:156-181`; 当前预算owner分别见`thirdparty/chatgpt-browser-agent/chatgpt.js:49-59`
- Canonical-plan evidence: §10 第 0.3–0.4 项；§16 slice 36
- Responsibility owner: `prompt-voice-input.ts:transcribeVoiceFile`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 四轮完整预算为`4 × 300000 + 7000 = 1207000ms`，再加计划声明的30秒清理余量应为`1237000ms`。计划配置的`1230000ms`会提前7秒取消合法的第四次尝试。
- Why this is not speculative: 四个完整预算和固定1/2/4秒退避均由当前R55明确规定；TUI AbortSignal是现有可达生产终止路径。
- Minimal correction direction: 由TUI timeout owner按计划中的全部顺序阶段重新计算兜底，确保它严格晚于第四次尝试及既定清理余量。

### B-03 冷启动选择了已有失败证据的直接URL路径

- Violated invariant: 私有浏览器冷启动必须可靠进入可收敛的ChatGPT bootstrap，不得把已有失败证据的启动顺序设为权威路径。
- Evidence class: observed
- Producer and execution path: 无可连接private marker → spawn Edge并把`https://chatgpt.com`作为首个进程URL → 首屏订阅请求出现`Failed to fetch` → bootstrap或后续voice不可用 → graceful close/cold循环。
- Source evidence: 当前稳定对照由`thirdparty/chatgpt-browser-agent/chatgpt-core.js:141-172`展示spawn/connect能力；现有默认launch路径见`chatgpt-core.js:181-188`
- Canonical-plan evidence: §4 line 92；INV-31；§10 第0项；§16 slice 32
- Responsibility owner: `chatgpt-core.js` private browser lifecycle owner。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 计划把曾产生“无法加载订阅：Failed to fetch”的启动顺序设为唯一cold path，而同一证据表明CDP ready后再由bootstrap owner导航可保持登录且无同源错误。这会把已观察的首屏失败重新引入根本生命周期修复。
- Why this is not speculative: 两种启动顺序及其不同结果已直接记录在当前canonical plan的证据表；R55明确选择其中出现过失败的一种。
- Minimal correction direction: private browser owner必须采用与现有bootstrap收敛接口一致、且通过已记录首屏反馈环的启动顺序；marker重连和生命周期解耦仍应在该owner完成。

## Non-blocking findings

- Metadata使用`Audit mode: full-scope`，handoff指定的是`plan`；当前revision和禁止实施状态仍清晰，因此只需行政性同步。
- R55的中文解释注释承诺为`E≈475`、`C≥72`，比例约`15.16%`，满足计划阶段15%目标。
- production有效修改预计约240行，明确硬上限600行，符合用户的克制修改约束；实现审计仍需按实际diff重算。

## Rejected speculation

- 损坏或恶意伪造的`DevToolsActivePort`没有当前producer，不要求新增修复分支。
- 任意CDP协议帧损坏、未知未来bootstrap schema及未来DOM文案不构成当前阻塞项。
- 普通用户Edge没有显式CDP入口时由daemon扫描、附加或关闭缺少授权；计划拒绝该路径是正确的。
- 不要求429后切换endpoint、DOM听写或上传算法；这些都会形成禁止的alternate success path。

## Requirement and traceability coverage

- 孤儿private Edge重连、profile lock、graceful close、cold transition、Unicode byte offset、四次direct尝试、TUI取消、长语音、idle、压力、Project/Session兼容和shared browser边界均有生产owner、文件计划和测试映射。
- Unicode问题定位到`chatgpt.js`中“字节offset → UTF-16字符串slice”的第一处分歧，修复及确定性红绿测试完整。
- 孤儿浏览器问题定位到default private profile仍使用`puppeteer.launch`且不消费marker，owner定位正确。
- 可恢复错误分类和完整外层预算仍因B-01、B-02缺少可执行的正确合同。
- 冷启动路径被现有对照证据反证，INV-31及其测试设计因B-03不能放行。

## Primary-path and fallback verdict

R55保留单一authenticated direct wire，四次尝试重复同一语义，没有endpoint、DOM听写或不同上传算法fallback。该重试可作为用户明确要求的primary transaction迭代。

当前错误集合过宽：确定性失败也进入该迭代，因此primary-path分类尚未成立。private cold path同时采用已有失败证据的启动顺序。

## Release verdict

**BLOCK — Revision R55 is not approved.**

### R2 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 Five-minute idle recovery is designed as a deterministic first-call failure.** Violated invariant: the daemon must maintain its own page lifecycle, and a voice invocation after a five-minute idle interval must not require an intentional failed invocation before a usable page is created. Minimal correction: keep bounded page renewal after age or pre-upload stability failure inside the authoritative page-acquisition lifecycle; distinguish that safe pre-side-effect branch from forbidden retry after audio submission may have begun.
- **B-02 Transient Project validation can still erase the cache.** Violated invariant: a cached Project identity must not disappear merely because one page validation or sidebar recovery attempt is transiently unavailable. Minimal correction: separate proven identity mismatch/staleness from inability to validate at that moment; preserve the last candidate through transient validation/recovery failure and test that behavior.
- **B-03 Long-voice behavior has no implementation or behavioral-test mapping.** Violated invariant: every confirmed long-voice requirement must map to a production path, exact change decision, and behavioral verification capable of failing on current behavior. Minimal correction: add a reproducible long-WAV behavioral test through the real CLI/daemon boundary and use red evidence to justify timeout/transport changes.
- **B-04 “Multi-round load and high pressure” is reduced to one underspecified concurrency case.** Violated invariant: requested repeated load, concurrency and high-pressure validation must have concrete workload dimensions and pass/fail criteria. Minimal correction: define bounded reproducible workload rounds and observable acceptance criteria including post-load usability and absence of unexpected navigation or duplicate submission.
- **B-05 The proposed direct-response production change is not justified by a first divergence.** Violated invariant: no production concept may be added when current behavior already carries the contracted responsibility and no divergence has been identified. Minimal correction: first add behavior tests for delayed/chunked, malformed and repeated responses; retain production change only if a red test identifies a concrete first divergence.
- **B-06 Diagnostic decision-surface budget is asserted, not estimated.** Violated invariant: the canonical plan must enumerate secondary paths and provide a defensible diagnostic decision-surface ratio not exceeding 10 percent. Minimal correction: estimate changed production decision surface, identify diagnostic decisions, and state the combined numerator, denominator and percentage.

**Non-blocking findings**

- The metadata said `Audit mode: full-scope` rather than `plan`; R3 changes it to `plan`.
- The Chinese-comment estimate was arithmetically correct for the then-stated estimate; R3 keeps the formula and redistributes the planned explanations around stability and long-load decisions.

**Rejected speculation**

- No finding assumed every five-minute recording necessarily exceeds the current timeout; timeout changes must be driven by the long-audio feedback loop.
- No new production handling was justified for future DOM wording, malformed CDP frames or unrelated administrator process kills.
- Parallel direct transcription was not required; load testing should verify queue behavior and isolation rather than invent a parallel success path.
- The direct endpoint did not need foreground activation based on current evidence.

**Requirement and traceability coverage**

- Cold-start Project coupling: covered.
- Repeated navigation/foreground activity: covered.
- No error-triggered success fallback: covered subject to the safe pre-upload lifecycle distinction.
- Alternating success/failure and stability detection: incomplete because aged/preflight failure deliberately required another call.
- Cache unexpectedly disappearing: incomplete because transient validation still authorized deletion.
- Browser close and stale daemon: covered.
- Five-minute idle invocation: incorrect expected behavior under B-01.
- Long voice: unmapped.
- Multi-round load/concurrency/high pressure: incomplete and non-measurable.
- Cancellation cleanup: covered.
- Ask/Session/Project identity: substantially covered, with lazy initialization still requiring implementation verification.
- Direct complete response: existing code already owned it; proposed production change lacked reverse justification.
- Chinese-comment planning: estimate passed.
- Diagnostic budget: failed the ratio gate.

**Primary-path and fallback verdict**

The proposed authoritative success path—voice-specific page acquisition followed by one same-origin direct transcription—was appropriate, and removal of `direct error -> UI dictation` plus post-error same-call audio resubmission was consistent with the user's prohibition on error-triggered fallback.

R2 nevertheless conflated safe pre-side-effect lifecycle acquisition with ambiguous post-submission retry. Only the latter is forbidden. Making the former return an error preserves the alternating-failure experience instead of eliminating it.

**Release verdict**

**BLOCK — Revision R2 is not approved.**

### R3 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 Project-cache preservation is not implementable from the planned interfaces.** Violated invariant: `INV-10` requires transient Project validation or sidebar unavailability to preserve the cached candidate; only proven identity mismatch or confirmed nonexistence may remove it. Minimal correction: define and implement an owning validation result that preserves the distinction between “identity proven stale/nonexistent” and “identity could not currently be validated,” then make cache deletion conditional only on the former and add a cache-retention behavior test.
- **B-02 The planned load/pressure verification cannot observe its stated acceptance criteria.** Violated invariant: `INV-13` requires bounded voice locks/pages after repeated concurrent load, no leakage, final daemon health and a successful subsequent voice call. Minimal correction: make the pressure acceptance criteria observable through one owning runtime seam covering voice queue state and all managed voice/session pages, or revise the test contract to use an existing behavior-level observation; map that seam and tests explicitly.
- **B-03 The long-voice plan does not test the real TUI lifecycle or its governing timeout.** Violated invariant: `INV-12` requires a 5-minute voice input to traverse the supported TUI/core/DOM chain and produce a complete result or explicit timeout while leaving the next voice usable. Minimal correction: add a behavioral test through the TUI controller/`transcribeVoiceFile` seam for long-voice deadline and cleanup, or explicitly narrow the requirement; if timeout ownership changes, map the exact owner and package-local command.
- **B-04 Required verification is not specified as reproducible commands.** Violated invariant: every confirmed requirement must have concrete executable verification capable of failing on current behavior. Minimal correction: replace every placeholder and prose loop with exact commands or named harness entry points, including fixture generation, environment variables, workload dimensions, timeouts, observations and pass/fail assertions, and keep the harness within its declared timeout budget.

**Non-blocking findings**

- The diagnostic estimate was understandable as combined `4 / 42 = 9.5%`, but `chatgpt.js` and `chatgpt-dom.js` individually exceeded 10%; R4 states the policy is evaluated over the combined changed responsibility surface and records the combined calculation.
- `INV-04` did not specify the exact number, spacing or accepted facts for consecutive stability; R4 specifies two probes, official origin, execution context, completed document, HTTP 200 session response and one short event-loop yield.
- The stated production/test line estimates differed from the comment-budget `E`; R4 updates the estimate basis and makes the covered files explicit.

**Rejected speculation**

- No blocking concern was raised for arbitrary malformed CDP frames or future DOM selector changes.
- No blocking concern was raised against serializing voice requests.
- No blocking concern was raised against removing direct-error UI dictation or refusing same-call retry after audio submission may have started.

**Requirement and traceability coverage**

- Startup Project navigation, direct no-navigation, no error fallback and ask compatibility were mapped.
- Stable detection was mapped but its exact criteria were underspecified; R4 specifies them.
- Cache retention was not covered because the planned interface collapsed transient errors to `null`; R4 adds the typed validation result at the adapter boundary.
- Browser close and five-minute idle were conceptually mapped but executable verification was underspecified; R4 adds exact harness modes.
- Long voice was not covered through the TUI 90-second boundary; R4 adds the TUI controller test and keeps the real CLI long-WAV test.
- Concurrent/high-pressure verification was not covered because status omitted voice resources and the workload was not executable; R4 adds status counters and exact workload arguments.
- Direct complete-body validation was correctly treated as existing behavior requiring tests rather than a new parser implementation.

**Primary-path and fallback verdict**

The intended primary path remained coherent: `TUI WAV -> daemon/browser lifecycle -> dedicated healthy voice page -> same-origin direct transcription -> text or diagnostic failure`. Removing direct-error UI dictation and post-error same-call voice resubmission remained consistent with the explicit user requirement. Pre-upload page-acquisition renewal may remain a bounded primary lifecycle branch; retry after the audio POST remains forbidden.

**Release verdict**

**BLOCK — Revision R3 is not approved.**

### R4 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 Lazy Project initialization lacks a concurrency-owning path.** Violated invariant: `INV-11` requires lazy Project initialization to preserve existing concurrent ask, Session, pending and identity behavior; one responsibility must have one authoritative semantic path. Minimal correction: define the single Project-owner initialization transition used by every ask before Project-dependent reads, including concurrency and page-ownership boundaries, and add overlapping first asks plus voice behavior coverage.
- **B-02 Cache preservation removes the authoritative stale-cache recovery route.** Violated invariant: `INV-10` requires transient failures to preserve cache while allowing proven stale identity to be replaced through the existing Project owner. Minimal correction: preserve the distinction between transiently unverifiable and proven stale, but retain one authoritative Project-resolution route from proven stale/nonexistent identity to live discovery; specify evidence and test both transient retention and stale cached URL without its old Project ID.
- **B-03 The borrowed Session-page success path is omitted from the primary-path design.** Violated invariant: every success-producing path must be inventoried and subject to the same stability invariant. Minimal correction: explicitly classify the borrowed Session-page path; whichever page-acquisition contract remains must apply the same pre-upload stability facts and ownership rules to every voice-success page, with a behavior regression test.
- **B-04 The owned-browser close verification has no reachable automation seam.** Violated invariant: every browser-close lifecycle requirement must map to a reproducible behavioral test through an existing or justified owner seam. Minimal correction: identify a bounded test seam that deterministically triggers the existing owned-browser disconnect transition, or change the claim to an existing behavior-level observation; do not add a production fallback or general browser-control API solely for the test.

**Non-blocking findings**

- The file accounting was inconsistent: section 15 listed seven implementation files while section 19 reported five; R5 uses seven consistently.
- The diagnostic calculation was labeled R3 inside R4; R5 renames it R5.
- The Chinese-comment planning arithmetic passed: `E ≈ 500`, `C >= ceil(500 * 0.15) = 75`.

**Rejected speculation**

- No blocking concern was raised for future DOM wording, malformed CDP traffic, arbitrary administrator process termination or undocumented audio formats.
- Serial voice execution is not itself a defect.
- Direct endpoint foreground activation is not required.
- No timeout increase is required without red evidence from the real direct-upload chain.
- Cache preservation does not mean every cached identity remains valid forever; the missing transition is transient unavailability versus proven stale replacement.

**Requirement and traceability coverage**

- Cold-start Project coupling, direct no-navigation and no error-triggered fallback were correctly mapped.
- Stable detection was incomplete because borrowed Session-page success bypassed the planned health path.
- Cache retention was incomplete because stale no-ID replacement lacked an authoritative discovery route.
- Concurrent first-ask Project initialization was unmapped.
- Owned-browser close lacked a reproducible seam.
- Long voice, TUI deadline, pressure dimensions, direct complete-body verification and Chinese-comment planning were otherwise mapped.

**Primary-path and fallback verdict**

The intended route remained coherent: `TUI WAV -> daemon/browser lifecycle -> stable pre-upload page acquisition -> one same-origin direct transcription -> text or diagnostic failure`. Removing direct-error UI dictation and same-call audio resubmission remains correct; bounded pre-upload renewal remains a primary lifecycle branch.

**Release verdict**

**BLOCK — Revision R4 is not approved.**

### R5 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 Lazy Project initialization can block valid existing-Session recovery.** Existing Sessions must retain their stored Project identity independently of current default Project discovery. R5 placed `runtime.ensureProject` before every first `runAsk`, so a missing/renamed/transient default could block pending recovery, completed replay and exact continuation. R6 constrains default initialization to new Sessions or legacy entries without valid stored identity and adds first-post-start existing Session coverage.
- **B-02 The pressure test has neither exact pass thresholds nor evidence for duplicate-submission detection.** R5 listed measurements but no required success/timeout/latency/page values, and page counters could not prove one audio submission per input. R6 fixes 12/12 voice, 6/6 ask, zero timeout/failure, p95 <= 120s, per-round resource limits, and a bearer-protected monotonic `voiceSubmitted` delta of exactly 12 plus an offline one-direct-call behavior test.
- **B-03 Long-voice verification splits the TUI and browser paths instead of testing the supported chain.** A mocked TUI timeout plus separate CLI long-WAV run could pass while the real TUI child process, abort delivery or daemon cleanup failed. R6 adds one environment-gated controller test using the real `node chatgpt.js` process, real Edge/profile, about 300 seconds of WAV input, recorder cleanup and a subsequent short voice.

**Non-blocking findings**

- The primary-path diagram said dedicated page while the inventory preserved borrowed Session pages; R6 names the route `borrowed-or-dedicated voice lease`.
- The Chinese-comment estimate was arithmetically correct but must be recomputed from implementation diff; R6 updates the estimate after the integrated E2E additions.
- Per-file deltas and aggregate line estimates use different accounting bases; implementation evidence must reconcile net/effective/comment/import/documentation exclusions.

**Rejected speculation**

- No production handling is required for malformed CDP frames, future DOM wording, undocumented audio formats or unrelated administrator termination.
- Serial voice execution remains valid; the defect was unmeasurable pressure acceptance, not lack of parallel direct requests.
- Direct transcription does not require foreground activation.
- No blanket timeout increase is authorized before the integrated long-chain feedback loop identifies the first failing owner.
- Transient cache preservation does not imply trusting stale Project identity indefinitely; proven stale still enters one live replacement route.
- Bounded renewal before audio POST remains primary acquisition, not error-triggered transcription fallback.

**Requirement and traceability coverage**

- Startup navigation, cache replacement, borrowed/dedicated stable leases, direct-only response, cancel cleanup, idle recovery, browser ownership/close and security boundaries were covered.
- Existing Session/Project compatibility was blocked by unconditional default initialization.
- Pressure dimensions existed but lacked exact thresholds and duplicate-submission evidence.
- Long voice was not covered through one actual TUI-to-browser execution.

**Primary-path and fallback verdict**

The voice route remained coherent: `TUI WAV -> CLI/daemon lifecycle -> stable pre-upload borrowed-or-dedicated lease -> one same-origin direct transcription -> text or diagnostic failure`. Direct-error UI dictation and same-call browser/audio resubmission remain removed; one pre-upload lease renewal remains a primary lifecycle branch.

**Release verdict**

**BLOCK**

### R6 Independent Verdict (copied from auditor)

**Blocking findings**

No blocking findings.

**Non-blocking findings**

- Section 11's diagnostic table records `4 / 45 = 8.9%` while the following historical explanation still says `4 / 42 = 9.524%`; both pass 10%, and implementation audit must use one actual-diff denominator.
- Implementation evidence must record whether the integrated long-voice run returns text or the explicit TUI 90-second timeout and identify the first governing deadline before any timeout change.
- Implementation evidence must reconcile effective changed lines with net production/test deltas and all exclusions.

**Rejected speculation**

- No production handling is justified for hypothetical malformed CDP frames, future DOM wording, undocumented audio formats or unrelated administrator termination.
- Voice requests need not execute direct transcription in parallel; serial lease ownership remains valid.
- Direct transcription does not require foreground activation.
- No blanket TUI/core/direct timeout increase is justified before the integrated long-WAV loop identifies a real first divergence.
- Transient Project cache preservation does not imply indefinite trust; proven stale identity still uses one live replacement route.
- One bounded renewal before audio POST is authoritative page acquisition, not error-triggered transcription fallback.
- The bearer-protected `voiceSubmitted` count exposes no audio, text, token, Project, Session or browser-handle data.

**Requirement and traceability coverage**

The auditor marked every required scope covered: first divergence, navigation/foreground, cache loss and replacement, cold startup, lazy Project and existing Session compatibility, concurrent new asks, borrowed/dedicated stable leases, direct response and no-fallback behavior, cancellation/cleanup, exact pressure and duplicate-submission evidence, integrated long voice, five-minute idle, browser close and ownership, Edge/profile reuse, security, exact commands, forward/reverse traceability, workaround deletion, diff budget and Chinese-comment budget.

**Primary-path and fallback verdict**

R6 has one authoritative route: `TUI WAV -> validated CLI request -> daemon/browser lifecycle -> stable borrowed-or-dedicated lease -> one same-origin direct transcription -> complete text or diagnostic failure`. Every success-capable branch is inventoried; UI dictation and same-call audio resubmission are removed; no alternate success path or fallback state machine is authorized.

**Release verdict**

**APPROVE — No blocking findings.**

R6已经获得完整原始范围独立审计批准。实施只能执行本revision；任何行为、接口、owner、文件或测试seam漂移都必须递增revision并重新审计。

### R7 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 Long-audio acceptance still permits the original failure mode.** 约5分钟WAV必须在真实TUI/process/CLI/daemon/core/DOM链返回非空文本；现有90秒timeout只能作为定位第一处deadline/transport owner的失败证据，不能算通过。
- **B-02 Browser-close verification never demonstrates the required recovery sequence.** callback测试和故意启动失败的stale测试不能证明用户关闭owned Edge、不手工清理环境后，下一独立voice能启动可用daemon并成功转录。

**Non-blocking findings**

- diagnostic比例段落仍保留旧分母；实际实现审计必须用一个实际diff分母。
- reverse traceability中cache-first Project candidate应映射R-10而非仅R-08。
- 中文注释估算算术成立，实际E/C仍由实现diff重算。

**Rejected speculation**

无需为未来session JSON key、任意CDP流量、未支持音频格式、并行direct、前台激活或全局timeout增加生产分支。page-local authenticated布尔不泄露token；POST前一次续租仍属于primary acquisition。

**Primary-path and fallback verdict**

`TUI WAV -> validated CLI -> daemon/browser lifecycle -> stable authenticated lease -> one direct transcription -> complete text or diagnostic failure`方向正确；阻塞只在长音频和browser-close验收未证明原始合同。

**Release verdict**

**BLOCK — Revision R7 is not approved.**

R8保持同一production primary path，只收紧长音频成功条件并补真实owned-browser恢复E2E；未获R8批准前不继续实施。

### R8 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 The stability owner is assigned ChatGPT session-wire parsing that the plan assigns to the DOM adapter.** core应继续拥有lease稳定、退役和续租，但`/api/auth/session` JSON以及`accessToken/access_token`兼容规则已由DOM direct adapter拥有；在core重复解析会形成两个schema authority。最小修正是DOM返回非敏感authenticated事实，core只做稳定决策。

**Non-blocking findings**

- footer仍错误指向R7；TUI文件计划残留“结果/timeout”措辞；owned close场景应先隔离既有daemon；中文注释预算实际值仍待diff重算。

**Rejected speculation**

无需未来token key、全局timeout、前台激活、并行direct、周期刷新或额外重试。唯一owned Edge后代的SIGTERM模拟可接受，广泛进程名匹配或shared browser kill不允许。

**Primary-path and fallback verdict**

primary route和authenticated stability方向正确，唯一阻塞是wire解析owner矛盾；POST前续租仍是primary acquisition，UI dictation和POST后换页/重发仍禁止。

**Release verdict**

**BLOCK — Revision R8 is not approved.**

R9只纠正DOM/core owner，不改变行为合同或文件范围；未获R9批准前不继续实施。

### R9 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 The exact tokenless-session wire behavior is not tested through its new DOM owner.** 下游fake `authenticated:false`只能验证core退役，不能证明DOM把HTTP 200无token解析为false、支持现有两种token key且不把token返回Node。必须通过受控session body的DOM page-context seam测试该事实。

**Non-blocking findings**

- baseline章节描述历史R6前行为，应在实现证据中与当前工作树区分；browser-close安全边界、长语音必须成功和中文注释估算均已接受。

**Rejected speculation**

无需未来token key、周期刷新、并行direct、前台激活、全局timeout或扩大owned browser进程匹配。DOM只需返回非敏感事实。

**Primary-path and fallback verdict**

DOM wire owner和core lease owner划分正确；唯一阻塞是新DOM owner缺少确定性行为测试，未发现fallback或替代成功路径。

**Release verdict**

**BLOCK — Revision R9 is not approved.**

R10只补DOM owner级wire测试映射；未获R10批准前不继续实施。

### R10 Independent Verdict (copied from auditor)

**Blocking findings**

No blocking findings.

**Non-blocking findings**

- baseline章节仍描述R6前缺陷，实施证据需区分历史red与当前工作树。
- effective-line、中文注释和diagnostic decision比例必须按最终diff独立重算，不能沿用估算。

**Rejected speculation**

无需未来token key、token出page、周期刷新、并行direct、前台激活、全局timeout、POST后续租或扩大owned Edge匹配；零个/多个owned候选应fail-closed。

**Requirement and traceability coverage**

auditor确认完整覆盖启动/导航、好坏交替、DOM wire owner和不泄token、core稳定lease、无fallback/无重发、长语音必须成功、真实5分钟idle、精确压力、owned browser关闭恢复、shared安全、Project cache、Session兼容、cleanup、复杂度和全部验证命令。

**Primary-path and fallback verdict**

唯一权威路径为`TUI WAV -> validated CLI -> daemon/browser -> DOM non-sensitive session fact -> core stable lease -> one direct transcription -> complete text or diagnostic failure`；borrowed/dedicated只是同一lease支持域，POST前一次续租不是fallback。

**Release verdict**

**APPROVE — No blocking findings.**

本批准只适用于cycle 2第4轮审计的R10；任何行为、owner、测试、文件或fallback分类变化都必须新revision重审。

### R11 Independent Verdict (copied from auditor)

**Blocking findings**

### B-01 Canonical metadata declares the wrong audit mode

- Violated invariant: The canonical plan must identify the current audit mode exactly; a plan audit requires `Audit mode: plan`, and implementation approval gates must not be evaluated against a different artifact mode.
- Evidence class: contracted
- Producer and execution path: The user supplied `Audit mode: plan` → the auditor evaluates the canonical plan as a plan → the plan metadata currently declares `Audit mode: full-scope`.
- Source evidence: `.opencode/policy/first-principles-engineering.md` requires canonical metadata to include `Audit mode`; the adversarial-audit plan-mode contract requires the plan to identify itself as `plan`. The current canonical header says `Audit mode: full-scope` at `docs/plans/voice-transcription-lifecycle-reliability.md:3-10`.
- Canonical-plan evidence: R11’s metadata at `:9` conflicts with the user-supplied audit mode and with the plan-audit contract. The historical audit record itself previously treated this exact mismatch as a blocking plan metadata issue at `:558`.
- Responsibility owner: Canonical-plan metadata and audit-state owner.
- Behavior-level consequence: A clean verdict could be recorded against a plan declared as a different audit mode, making the approval/implementation transition ambiguous and violating the repository’s canonical revision gate.
- Why this is not speculative: The mismatch is directly present in the current canonical file and concerns a required workflow contract, not naming or formatting.
- Minimal correction direction: Set the current canonical metadata to `Audit mode: plan`; do not alter production scope or reinterpret this full-scope audit as an implementation audit.

### B-02 The plan still authorizes fabricated abnormal direct-response inputs

- Violated invariant: The explicit user requirement forbids fabricating abnormal inputs, and the plan must not add tests or production decisions for malformed/unobserved cases without an observed producer or contract.
- Evidence class: contracted
- Producer and execution path: The planned TDD slice constructs delayed, repeated, non-JSON, and truncated direct responses → `transcribeAudioFileDirect` is tested against those synthetic bodies → the plan permits retaining or changing production behavior based on those results.
- Source evidence: The current repository evidence records the observed cookie-auth direct request returning HTTP 200 with complete JSON at `docs/plans/voice-transcription-lifecycle-reliability.md:76-81` and `:232-244`; it does not provide an observed malformed, truncated, or non-JSON direct response. The current production adapter already has the complete-body boundary in `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:770-782`.
- Canonical-plan evidence: R11 explicitly says not to fabricate abnormal inputs at `docs/plans/voice-transcription-lifecycle-reliability.md:31-37` and rejects fabricated malformed authentication/cookie/DevTools inputs at `:512-513`, but still retains TDD slice 7 requiring “延迟/重复/非JSON” and half-response behavior at `:420`, and maps that synthetic test in forward traceability at `:355`.
- Responsibility owner: The direct DOM wire-test scope owner; production response parsing remains the existing DOM adapter responsibility.
- Behavior-level consequence: The plan violates the user’s no-fabrication constraint and can drive production changes or acceptance decisions from inputs that have no observed producer. It also reopens the previously rejected expansion of direct-response handling despite the plan’s own statement that the existing complete-body implementation is sufficient.
- Why this is not speculative: The contradiction is explicit in the same current canonical revision: fabricated abnormal inputs are prohibited, while the TDD and traceability sections require them.
- Minimal correction direction: Remove the non-JSON, truncated, and otherwise fabricated abnormal-input tests and any production decisions based on them. Retain only behavior tests for the observed cookie-auth direct success, observed HTTP/transport failures, complete-body behavior already supported by the interface, and the required no-fallback/no-resubmission contract. Do not invent malformed fixtures to satisfy coverage.

**Non-blocking findings**

- R11’s evidence table calls the new profile and subscription observations “observed” but does not include the exact reproduction commands or trace artifacts for those observations. The planned `--profile-restart` and browser-close harness commands provide the required forward verification; implementation evidence should preserve the actual logs and process/profile identity proof.
- The production net-change estimate is explicitly below the user’s 800-line ceiling: approximately 245 net production lines against a hard limit below 800. Implementation audit must count substantive non-test production additions independently and verify that comments were not removed or weakened to meet the budget.
- The plan’s historical baseline and current-worktree distinction is substantially improved in R11, but implementation evidence must still identify which observations came from the R10 worktree and which come from the final R11 implementation.

**Rejected speculation**

- No production handling is justified for future session schemas, fabricated malformed cookies, damaged `DevToolsActivePort`, arbitrary malformed CDP frames, or browser states without an observed producer.
- No token parser should remain merely for future compatibility; current evidence shows `/api/auth/session` no longer provides the token and cookie-auth direct succeeds.
- No automatic TUI re-login, core token guessing, UI transcription fallback, same-call retry, post-upload renewal, periodic refresh, or fixed five-minute refresh loop is justified.
- Serial voice execution remains acceptable if the exact pressure and convergence thresholds pass.
- The owned-browser test may terminate only a uniquely proven daemon-owned Edge descendant with the expected profile argument; ambiguous process discovery must fail closed.
- No blanket timeout increase is authorized; long-audio timeout changes require measured first-owner evidence.

**Requirement and traceability coverage**

- Repeated navigation, alternating success/failure, stability rather than cancellation, no fallback/resubmission, long audio, five-minute idle, pressure, browser close/recovery, profile persistence, subscription first-load behavior, current cookie authentication, Project cache, Session compatibility, shared/owned security, production diff budget and new production concept traceability are covered.
- The fabricated abnormal-response test mapping remains a blocking contradiction under B-02.

**Primary-path and fallback verdict**

The intended primary path remains coherent: `TUI WAV → validated CLI → owned/shared Edge lifecycle → DOM login-page fact → core stable borrowed-or-dedicated lease → one same-origin cookie-auth direct POST → complete text or diagnostic failure`.

No alternate success path is authorized. The plan is blocked only by the canonical audit-mode metadata mismatch and the explicit contradiction that forbids fabricated abnormal inputs while still requiring synthetic malformed direct-response tests.

**Release verdict**

**BLOCK — Revision R11 is not approved.**

A new canonical revision is required to correct the audit-mode metadata and remove the fabricated abnormal-input scope, followed by another full-scope plan audit.

### R12 Independent Verdict (copied from auditor)

**Blocking findings**

### B-01 R12 still retains the prohibited fabricated abnormal-response test scope

- Violated invariant: The explicit requirement forbids fabricating abnormal inputs. The canonical plan must not retain tests or production decisions for malformed, truncated, or otherwise unobserved direct-response bodies.
- Evidence class: contracted
- Producer and execution path: The planned direct-response TDD slice supplies delayed, repeated, non-JSON, and truncated response bodies → `transcribeAudioFileDirect` is tested against those synthetic responses → implementation or acceptance can still be driven by behavior with no observed producer.
- Source evidence: Current repository evidence records a normal cookie-auth direct response with HTTP 200 and complete JSON at `docs/plans/voice-transcription-lifecycle-reliability.md:76-81` and `:232-244`; the existing direct adapter already reads the complete response body at `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:770-782`. No current evidence establishes a malformed, truncated, or non-JSON response producer.
- Canonical-plan evidence: R12 explicitly prohibits fabricated abnormal input and says to validate only observed normal cookie-auth success and HTTP/transport failures at `docs/plans/voice-transcription-lifecycle-reliability.md:31-37`. However TDD slice 7 still requires “延迟/重复/非JSON” and half-response testing at `:420`, and forward traceability still maps that behavior at `:355`. R12’s claim that the synthetic tests were deleted is therefore inconsistent with the actual canonical revision.
- Responsibility owner: The direct DOM wire-test scope owner; existing complete-body parsing remains the DOM adapter responsibility and does not require a new malformed-body test.
- Behavior-level consequence: The plan still violates the user’s no-fabrication constraint and can authorize production changes or release decisions based on invented response bodies. It also preserves an unnecessary test/decision surface after the plan explicitly concluded that the existing complete-body boundary is already the correct implementation.
- Why this is not speculative: The contradiction is directly present in R12 itself: the non-goal forbids fabricated abnormal inputs while the TDD and traceability sections still require them.
- Minimal correction direction: Remove the non-JSON, truncated, and other fabricated response cases from TDD, forward traceability, and verification claims. Retain only observed cookie-auth success, observed HTTP/transport failures, one direct submission, no fallback, and no same-call resubmission. Do not add malformed fixtures or production handling for them.

**Non-blocking findings**

- R12’s implementation-evidence section still contains historical R11 wording such as “R12获批并完成精确修正.” This is administrative evidence text rather than a production behavior defect; after approval it should be updated to identify the actual approved revision and final implementation evidence.
- The plan estimates approximately 245 net production lines against the user’s `<800` requirement and explicitly prohibits weakening Chinese comments. Final implementation audit must independently count substantive production additions and qualifying comments.
- Profile and subscription observations are now mapped to a dedicated `--profile-restart` E2E and blank-first ordinary Edge/per-launch-CDP owner. Implementation evidence should retain the actual process/profile ownership proof and startup dialog/request observations.

**Rejected speculation**

- No production handling is justified for future session schemas, fabricated malformed cookies, damaged `DevToolsActivePort`, arbitrary malformed CDP frames, or browser states without an observed producer.
- No token parser should remain for future compatibility; current evidence says `/api/auth/session` no longer provides the token and cookie-auth direct succeeds.
- No automatic TUI re-login, token guessing, UI transcription fallback, same-call retry, post-upload renewal, periodic refresh, or fixed five-minute refresh loop is justified.
- Serial voice execution remains acceptable if the exact pressure and convergence thresholds pass.
- The owned-browser harness may signal only a uniquely proven daemon-owned Edge descendant with the expected profile argument; ambiguous ownership must fail closed.
- No blanket timeout increase is authorized; long-audio timeout changes require measured first-owner evidence.

**Requirement and traceability coverage**

- Repeated navigation and refresh, alternating success/failure, stability rather than cancellation, no fallback/resubmission, long audio, five-minute idle, concurrent/high-pressure behavior, browser close/recovery, profile persistence, subscription first-load failure, current authentication, Project cache, Session compatibility, shared/owned security, production diff/comment budgets and traceability are covered.
- The residual fabricated-response TDD/traceability mapping remains a blocking contradiction.

**Primary-path and fallback verdict**

The intended primary path remains coherent: `TUI WAV → validated CLI → owned/shared Edge lifecycle → DOM login-page fact → core stable borrowed-or-dedicated lease → one same-origin cookie-auth direct POST → complete text or diagnostic failure`.

No alternate success path is authorized. R12 is nevertheless blocked because the canonical test contract still includes fabricated abnormal direct-response inputs that the user explicitly prohibited.

**Release verdict**

**BLOCK — Revision R12 is not approved.**

A new canonical revision must remove the residual synthetic-response TDD and traceability entries, then undergo another full-scope plan audit.

### R13 Independent Verdict (copied from auditor)

**Blocking findings**

No blocking findings.

**Non-blocking findings**

- The current canonical metadata is internally consistent: `Revision: R13`, `Audit mode: plan`, `Approved revision: none`, and `Implementation allowed: no`.
- Section 22 explicitly marks all prior audit text as historical and non-authoritative. Historical mentions of synthetic response tests and old line numbers must not be treated as current R13 requirements.
- The current production estimate is approximately 245 net lines, below the explicit `<800` non-test production-line limit. Implementation audit must independently count substantive production additions and verify that effective Chinese explanatory comments were not removed or weakened.
- The planned comment budget is arithmetically valid: estimated `E ≈ 700`, minimum `C = ceil(700 × 0.15) = 105`. Actual qualifying comments must be recomputed from the final implementation diff.
- The profile/subscription observations are recorded as observed evidence, while the exact process/profile ownership proof and startup observations remain implementation-evidence obligations after execution.

**Rejected speculation**

- Historical §22 references to malformed, truncated, non-JSON, or synthetic response tests are not current R13 scope; the section is explicitly non-normative.
- No current R13 production or TDD path requires fabricated malformed direct bodies. The normative direct-response scope is limited to observed cookie-auth success, observed HTTP/transport failures, complete-body behavior already implemented, one submission, and no fallback.
- No support is justified for future session schemas, fabricated malformed cookies, damaged `DevToolsActivePort`, arbitrary malformed CDP frames, undocumented browser states, or future DOM wording.
- No token parser should remain for compatibility: current evidence says `/api/auth/session` no longer provides the token and cookie-auth direct succeeds.
- No automatic TUI re-login, core token guessing, UI transcription fallback, same-call retry, post-upload renewal, periodic refresh, or fixed five-minute refresh loop is justified.
- Serial voice execution remains acceptable if the specified pressure, latency, submission-count, isolation, and convergence thresholds pass.
- The owned-browser harness may signal only a uniquely proven daemon-owned Edge descendant with the expected profile argument; ambiguous ownership must fail closed.
- No blanket timeout increase is authorized. Long-audio timeout changes require measured first-owner evidence.

**Requirement and traceability coverage**

- Repeated navigation and refresh, alternating success/failure, stability rather than cancellation, no fallback/resubmission, long audio, five-minute idle, concurrent/high-pressure behavior, browser close/recovery, profile persistence, subscription first-load failure, current authentication model, Project cache, Session compatibility, shared/owned security, production diff budget, no fabricated abnormal input, traceability and verification are covered.

**Primary-path and fallback verdict**

The authoritative R13 path is coherent: `TUI WAV → validated CLI → owned/shared Edge lifecycle → DOM login-page fact → core stable borrowed-or-dedicated lease → one same-origin cookie-auth direct POST → complete text or diagnostic failure`.

The DOM adapter owns login-page facts and cookie-auth wire behavior. Core owns browser ownership, two-probe stability, lease retirement, one pre-upload renewal, concurrency, and cleanup. Borrowed and dedicated pages are branches of one lease contract.

No alternate success path is authorized. UI dictation and same-call audio resubmission remain removed. Pre-upload renewal is lifecycle acquisition, not fallback. Historical §22 content does not expand the current R13 design.

**Release verdict**

**APPROVE — No blocking findings.**

This approval applies only to canonical plan revision **R13** as freshly audited from disk in the current plan-audit invocation. Any substantive change to behavior, ownership, tests, file scope, fallback classification, verification, or production-line budget requires a new revision and another full-scope audit.

### R14 Revision Note

R13获批后，真实TDD反馈显示当前默认Puppeteer路径的首个cookie-auth cold voice已经成功；此前“Puppeteer使profile失效”的结论不能继续作为生产改造依据。`--profile-restart`首先在观察Edge主进程时发现一个测试识别缺口：同一主进程的helper也带相同`--user-data-dir`，现有匹配器把它们全部计为owner。R14只收敛该行为级测试观察，并删除尚未证明与默认daemon绑定的blank-first/per-launch-CDP生产方案；cookie-auth direct和DOM登录事实仍是唯一production修复路径。

### R15 Revision Note

R14审计要求把用户报告的订阅失败dialog映射到default owned daemon的可观察验证，并统一E/C计算。R15使用现有owned Puppeteer生成的`DevToolsActivePort`作为测试观察入口：第一次cold voice成功后只读取dialog文本，随后按现有stop/restart验证profile；不新增生产endpoint、启动替代器或未观察异常分支。有效行估算统一为`E≈700`，最低合格中文解释性注释为`C>=105`。

### R16 Revision Note

R15审计确认了E/C arithmetic，但指出dialog观察晚于bootstrap，不能证明首屏间隔没有复现用户错误。R16只把测试observer前移：default daemon启动后marker出现即连接并监听到ready，之后才开始第一次voice；仍不新增生产endpoint或browser启动替代器。另记录一次高频诊断HTTP 429；因同一cookie-auth direct此前200且用户独立成功，R16不改当前direct端点、不退回DOM听写、不增加同请求重发。

### R17 Revision Note

R16审计要求把429映射到当前direct请求shape核验，而不是只记录为generic diagnostic。R17只补同一DOM wire seam的正常成功shape行为断言：`POST /backend-api/transcribe`、multipart `file`、cookie credentials、网页端accept/language、无Authorization；shape与已成功请求一致时保留当前端点，429仍是单次调用的诊断错误。不得新增端点、DOM听写或同请求重发。

### R18 Revision Note

R17审计确认当前生产shape已经存在，新增shape断言不会在当前实现下产生production red；同时429只在高频诊断后出现一次，不能安全重复触发。R18将shape断言明确为非生产契约回归，并把“429不可稳定复现但已有真实成功/失败证据”的责任边界写入方案；不新增429 fixture、不压测账号、不改变当前endpoint、不切DOM、不重发。

### R19 Revision Note

R18审计确认当前source已是cookie-auth direct，但canonical current-behavior和first-divergence仍把旧token路径写成当前。R19把R10/R18 production修复改列为baseline evidence，剩余实现限定为bootstrap期间dialog observer、direct成功shape契约测试、过期注释修正和完整实现审计；不重复token/cookie实现，不改变429的diagnostic边界。

### R20 Revision Note

R19审计确认file-level baseline已正确，但sections 11至14仍把已落地Project/direct/lifecycle修复写成待实现。R20统一将INV-01至INV-13、workaround removal、forward/reverse traceability改为baseline evidence；当前实施授权只覆盖INV-14/INV-15的observer、shape契约、过期注释和验证。

### R20 Independent Verdict (copied from auditor)

**Blocking findings**

No blocking findings.

**Non-blocking findings**

- R20 now consistently classifies R10/R18 production behavior as implemented baseline across the current-behavior, path inventory, workaround, forward-traceability, reverse-traceability, and file-level sections.
- The current worktree still shows the pre-R20 implementation state for the remaining changes: `test-voice-robustness.js` still contains the post-voice subscription-dialog snapshot, `test-mcp.js` still does not assert the complete direct request shape, and `chatgpt-dom.js:741-742` still contains stale bearer-token explanatory wording. These are the explicitly planned R20 implementation changes and must be verified in the later implementation audit.
- R20 handles the observed HTTP 429 without inventing a fallback: the successful request shape is independently recorded, the current endpoint remains authoritative, no 429 fixture or repeated account pressure is introduced, and a real 429 remains a diagnostic with no endpoint switching, DOM dictation, or same-call resubmission.
- The planned comment budget is arithmetically correct: `E ≈ 700`, `C >= ceil(700 × 0.15) = 105`.
- The estimated total production change remains below the `<800` net non-test production-line limit. The implementation audit must independently separate the already-present baseline diff from the R20 delta and recount qualifying Chinese explanatory comments.
- Historical §22 content remains explicitly quarantined. Its old R13 wording is administrative historical text and does not alter current R20 scope.

**Rejected speculation**

- No fabricated HTTP 429 body, artificial rate-limit fixture, malformed response, future authentication schema, malformed cookie, damaged DevTools marker, or invented browser state is justified.
- No endpoint switch, DOM transcription fallback, same-call retry, post-upload renewal, or error-as-success behavior is justified.
- The single observed 429 does not establish that the current endpoint is wrong when an independently successful request uses the same recorded method, endpoint, body shape, credentials, and headers.
- No periodic refresh, fixed five-minute polling loop, parallel voice success path, blanket timeout increase, or TUI re-login is justified.
- Shared/user Edge must remain disconnect-only, and ambiguous owned-process discovery must fail closed.

**Requirement and traceability coverage**

- Repeated navigation/refresh, alternating success/failure, stability rather than cancellation, Project/cache behavior, ask/Session compatibility, direct-only/no fallback/no resubmission, current direct endpoint and 429 handling, concurrent/high-pressure behavior, long audio, five-minute idle, browser close/recovery, Edge/profile persistence, subscription first-load feedback, authentication/security, diff/comment budget and no fabricated abnormal inputs are covered.
- The current R20 implementation obligations are limited to bootstrap-time observer timing, request-shape regression, stale comment correction and full verification.

**Primary-path and fallback verdict**

The authoritative path remains: `TUI WAV → validated CLI → owned/shared Edge lifecycle → DOM login-page fact → core stable borrowed-or-dedicated lease → one same-origin cookie-auth direct POST → complete text or diagnostic failure`.

The baseline production path is internally coherent and has one authoritative voice-success semantic. R20 adds only verification and comment cleanup. No alternate success path is authorized. A pre-upload page renewal remains part of primary lifecycle acquisition, not fallback. HTTP 429 remains diagnostic and cannot activate endpoint switching, DOM transcription, or same-call resubmission.

**Release verdict**

**APPROVE — No blocking findings.**

This approval applies only to canonical plan revision **R20** in this plan-audit invocation. Implementation remains disallowed until R20 is recorded as the approved revision and the required full independent implementation audit passes against the actual diff.

### R21 Revision Note

R20实施期真实E2E在高频窗口之外仍于第一次short voice稳定返回HTTP 429。当前页面最小对照证明旧guest文案启发式把`composer + login button`页面错误归一为logged-in，而同页`client-bootstrap`明确为`authStatus='logged_out'`且没有session/access token。当前已加载ChatGPT frontend source同时证明transcribe使用`safePost('/transcribe', { authOption: SendIfAvailable })`，base为`/backend-api`，并从bootstrap session state取得access token后在可用时附带Bearer。R21因此撤销R20的cookie-only长期contract：同一DOM adapter改用bootstrap会话事实和page-local官方鉴权；core、endpoint、FormData、direct-only、无fallback、无重发、Project/Session、observer和browser owner均不变。当前专用profile没有登录credential，最终真实E2E必须在用户重新登录后执行；修复后的未登录路径必须等待且零POST，不能把429当登录检测。

### R21 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 R21’s new bootstrap/Bearer root cause lacks independently inspectable repository evidence

- Violated invariant: A new production parser, authentication fact, and credential-bearing wire behavior must be justified by directly inspectable observed or contracted evidence. Canonical-plan assertions alone are untrusted.
- Evidence class: contracted
- Producer and execution path: ChatGPT page bootstrap state → DOM adapter parses authentication/session/token → core accepts or rejects the stable lease → DOM adapter optionally adds `Authorization: Bearer` → `/backend-api/transcribe`.
- Source evidence:
  - The current repository implementation still uses the DOM heuristic at `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:792-833` and cookie-only direct request at `:717-789`.
  - The directly inspected daemon log establishes repeated HTTP 429 only at `/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/daemon.log:2659,2668,2677`.
  - Repository-wide searches found no captured `client-bootstrap` payload shape, `authStatus`, `SendIfAvailable`, or frontend bundle excerpt in source, tests, logs, or another evidence artifact outside the canonical plan.
- Canonical-plan evidence: R21 introduces `client-bootstrap.authStatus/session.accessToken` and frontend `SendIfAvailable` behavior at `docs/plans/voice-transcription-lifecycle-reliability.md:81-84`, `:149`, `:162-173`, `:255-273`, and `:312-320`, but provides no exact reproduction command or directly inspectable captured artifact for those claims.
- Responsibility owner: The DOM adapter owns the external bootstrap and wire-format compatibility; the canonical plan owns proving the current producer representation before authorizing that parser.
- Behavior-level consequence: Implementation could hard-code an incorrect bootstrap representation or token location. That can leave logged-in pages permanently classified as logged out, expose a stale token to the wrong request, or preserve the 429 while appearing to repair it. Synthetic tests based only on the plan’s claimed schema would reproduce the assumption rather than independently validate it.
- Why this is not speculative: R21 proposes concrete new production parsing and Authorization behavior absent from the current repository. The only directly reproduced external behavior is HTTP 429; 429 alone does not prove the asserted bootstrap representation or frontend auth algorithm.
- Minimal correction direction: Preserve directly inspectable, non-sensitive evidence of the current bootstrap representation and official request contract—excluding token values—with an exact local reproduction procedure or captured artifact. Then bind the DOM adapter to that observed representation and test through its public seam. Do not infer the schema from 429 or add another authentication fallback.

### B-02 R21 authorizes two bootstrap data sources without proving both are current primary-contract producers

- Violated invariant: One responsibility must have one authoritative semantic source. Sequentially attempting independent representations or preserving speculative compatibility is forbidden.
- Evidence class: reachable
- Producer and execution path: Page authentication fact → adapter reads `#client-bootstrap` or alternatively `window.CLIENT_BOOTSTRAP` → normalizes authentication/token → core stability and direct Authorization.
- Source evidence: The current adapter has no such source yet at `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:792-833`, so R21 would introduce this source-selection behavior.
- Canonical-plan evidence: `docs/plans/voice-transcription-lifecycle-reliability.md:312` authorizes reading `#client-bootstrap` while also accepting `window.CLIENT_BOOTSTRAP` as a synonymous source. R21 does not establish when each source is produced, whether both coexist with identical semantics, or which one is authoritative.
- Responsibility owner: DOM bootstrap wire adapter.
- Behavior-level consequence: Authentication may depend on source order or stale disagreement between two representations. This creates a compatibility/fallback parser family at the security-sensitive lease boundary and can reintroduce alternating login classification.
- Why this is not speculative: Both source paths are explicitly authorized by the current plan and would be reachable whenever either representation is absent or differs.
- Minimal correction direction: Select the one directly observed current bootstrap representation as authoritative. If both names are simultaneously generated views of one current object, prove that producer relationship and define one normalization seam without failure-triggered source switching.

## Non-blocking findings

- R21 correctly identifies the earliest reachable current divergence before audio submission: a guest page is accepted by the existing text heuristic, after which an unauthenticated direct POST receives 429.
- The repair remains at the existing DOM external-wire owner; core continues to consume only `{ origin, readyState, authenticated }`.
- The plan retains the R20 bootstrap-dialog observer and uniquely owned main-process filtering without modifying browser-launch ownership.
- Project/cache behavior and existing Session/pending/completed/exact continuation remain baseline responsibilities and are not reopened by R21.
- The comment estimate is arithmetically correct: `ceil(735 × 0.15) = 111`.
- Estimated production net change remains below 800 lines. Actual baseline/R20/R21 counts and qualifying comments must be independently recomputed during implementation audit.

## Rejected speculation

- No additional guest-page wording, future bootstrap schema, damaged marker, malformed cookie, malformed response body, or arbitrary browser state should be supported.
- No `/api/auth/session` token parser should return.
- HTTP 429 does not authorize endpoint switching, DOM dictation, same-call resubmission, token guessing, or a second upload algorithm.
- No periodic refresh, blanket timeout increase, parallel voice success path, or forced takeover of a normal user Edge profile is justified.
- Shared/user Edge remains disconnect-only; ambiguous ownership must fail closed.

## Requirement and traceability coverage

- **Repeated navigation and alternating failures:** Covered by the baseline Project decoupling, direct-only path, stable lease, and removal of UI fallback/retry.
- **Stability rather than cancellation:** Covered; bootstrap authentication would feed core’s existing two-probe stability owner. Cancellation remains cleanup only.
- **Project/cache and Session compatibility:** Covered by retained baseline behavior and regression commands.
- **Direct-only/no fallback/no resubmission:** Covered. R21 preserves one POST and diagnostic failure.
- **Current endpoint and 429:** Root-cause direction is plausible, but evidence and source authority are incomplete under B-01/B-02.
- **Concurrency/high pressure:** Covered by exact 12-voice/6-ask workload and convergence thresholds.
- **Long audio:** Covered by the real TUI-to-DOM chain requiring non-empty text, cleanup, and subsequent short voice.
- **Five-minute idle:** Covered by accelerated and real five-minute verification.
- **Browser close/recovery:** Covered with unique owned-process proof, no post-close cleanup, and later independent success.
- **Edge/profile persistence and subscription first load:** Covered by the retained bootstrap observer and two-cold-voice profile test, after login is restored.
- **Security:** Intended token confinement is appropriate, but the underlying bootstrap representation must first be proven.
- **Diff/comment budgets:** Planned within bounds, pending actual implementation accounting.
- **No fabricated abnormal inputs:** Stated correctly, but synthetic bootstrap tests cannot substitute for missing producer evidence.

## Primary-path and fallback verdict

The intended route remains coherent:

`TUI WAV → validated CLI → owned/shared Edge lifecycle → DOM bootstrap authentication fact → core stable lease → one same-origin direct POST → complete text or diagnostic failure`.

No error-triggered success fallback is authorized. However, the authentication source is not yet releaseable: its external contract is unsupported by directly inspectable evidence, and the plan authorizes two possible bootstrap sources.

## Release verdict

**BLOCK — Revision R21 is not approved.**

R21 must establish the current bootstrap/wire contract through directly inspectable non-sensitive evidence and reduce authentication parsing to one authoritative observed source, then undergo another full-scope plan audit.

### R22 Revision Note

R22用忽略目录中的`inspect-current-wire.cjs`和`evidence.json`补齐可独立复跑的当前producer：真实logged-in主page、真实无痕guest page、当前部署conversation/shared client公开bundle excerpt/hash，均不输出token/cookie值。认证只读取真实观察到的`#client-bootstrap`，删除`window.CLIENT_BOOTSTRAP`备选。用户随后重新登录，内存bootstrap与磁盘持久cookie均成立；一次不发voice的production graceful stop/restart继续登录。另一次带bootstrap时间线的重启在composer收敛后才ready且无网络/dialog错误，说明正常hydrate只需等待；用户观察到的“登录问候与登录入口并存、刷新后恢复”则新增为持续混合状态，startup最多reload一次。profile harness改为两次auth-only bootstrap通过后才发一个voice，失败不再`finally`关闭现场。

### R22 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 The startup convergence contract lacks the typed DOM-to-core interface required to enforce it

- Violated invariant: A new cross-module production concept must define the owning interface precisely enough to distinguish every behaviorally different state. Core must not infer ChatGPT bootstrap semantics itself.
- Evidence class: reachable
- Producer and execution path: `#client-bootstrap` plus current DOM → DOM adapter classifies page state → core startup chooses manual-login wait, ordinary convergence wait, one reload, ready, or terminal failure → voice lease later consumes authentication state.
- Source evidence:
  - The current public adapter exposes only boolean `isLoggedOut()` and `{ origin, readyState, authenticated }` through `voiceSessionFact()` at `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:76-78,187-189,792-833`.
  - Core currently branches only on the boolean at `thirdparty/chatgpt-browser-agent/chatgpt-core.js:2088-2129`.
- Canonical-plan evidence:
  - R22 requires distinct logged-out, loading, inconsistent, and authenticated behavior at `docs/plans/voice-transcription-lifecycle-reliability.md:169`, `:191`, `:320-323`, and TDD slice 16 at `:443`.
  - The file plan says core will use a “typed convergence” fact at `:416-419`, but never defines the adapter method, result shape, state enumeration, or which fields core may consume.
- Responsibility owner: DOM adapter owns classification of bootstrap and DOM facts; core owns waiting, the one-reload budget, and readiness.
- Behavior-level consequence: A boolean implementation cannot distinguish a genuinely logged-out page—which must wait for login without reload—from temporary hydration or a persistent mixed page—which must wait and may reload once. Implementers could move DOM interpretation into core, reload login pages, prematurely mark mixed pages ready, or change `isLoggedOut()` incompatibly.
- Why this is not speculative: These states have different required transitions and all are explicitly reachable in R22. The current interface cannot represent them.
- Minimal correction direction: Define one internal adapter result contract and its consumer explicitly, for example a single discriminated non-sensitive fact covering authenticated, logged-out, loading, and inconsistent states. Keep bootstrap parsing solely in the DOM adapter and reload policy solely in core; do not add another bootstrap source or compatibility parser.

### B-02 The diagnostic decision-surface estimate is stale and excludes R22’s new production decisions

- Violated invariant: The current canonical revision must estimate the complete modified production decision surface and demonstrate that diagnostic behavior remains at most 10%.
- Evidence class: contracted
- Producer and execution path: R22 adds bootstrap classification, convergence waiting, timeout, one reload, second-convergence failure, token-disappearance rejection, and authenticated request construction → these alter executable branches and diagnostic outcomes → plan release evaluates the diagnostic budget.
- Source evidence: Repository policy requires current plans to enumerate modified executable decisions and diagnostic outcomes and keep the ratio at or below 10%.
- Canonical-plan evidence:
  - R22 introduces new core and DOM production branches at `docs/plans/voice-transcription-lifecycle-reliability.md:320-329` and estimates production changes at `:416-419`.
  - The diagnostic table at `:361-374` is still explicitly the old “R6 diagnostic decision-surface estimate,” counting only 45 decisions and omitting every R22 bootstrap/authentication decision.
- Responsibility owner: Canonical-plan complexity and diagnostic-budget accounting.
- Behavior-level consequence: R22 can be approved without knowing whether its new loading, inconsistency, reload, authentication, and failure outcomes exceed the hard diagnostic budget or introduce excessive decision surface.
- Why this is not speculative: The new executable branches are explicitly authorized by R22, while the only calculation explicitly predates them.
- Minimal correction direction: Re-estimate the combined current baseline plus R22 modified production decision surface, identify which R22 outcomes are primary gates versus diagnostics, and calculate the current numerator, denominator, and percentage. Do not remove required failures or add success fallbacks to manipulate the ratio.

## Non-blocking findings

- R22 now provides directly inspectable non-sensitive evidence:
  - `.temp/testing/chatgpt-voice-auth-evidence/evidence.json`
  - `.temp/testing/chatgpt-voice-auth-evidence/inspect-current-wire.cjs`
  - `.temp/testing/chatgpt-voice-auth-evidence/bootstrap-convergence.json`
- The captured evidence supports one authoritative source: `#client-bootstrap`. R22 correctly removes the proposed `window.CLIENT_BOOTSTRAP` alternative.
- The captured frontend excerpts support the current endpoint, multipart `file`, optional language/duration, `/backend-api` base, `SendIfAvailable`, and Bearer-when-available behavior without persisting token values.
- The one bounded startup reload is evidence-backed by the user-observed mixed page that recovered after manual refresh. It occurs before daemon readiness and before any audio POST, so it is primary acquisition recovery rather than a transcription fallback.
- The evidence reproduction command requires an already running, logged-in owned browser with a connectable `DevToolsActivePort`; the plan should state that prerequisite beside the command. The captured artifact is currently inspectable, so this does not independently block R22.
- The Chinese-comment calculation is correct: `ceil(780 × 0.15) = 117`.
- Estimated production net growth remains below 800 lines. Implementation audit must recompute baseline/R20/R22 totals and qualifying comments.

## Rejected speculation

- No second bootstrap source, `/api/auth/session` parser, extra guest wording, future schema, or malformed bootstrap handling is justified.
- No endpoint switch, DOM dictation fallback, same-call resubmission, token guessing, or post-POST retry is justified.
- No repeated refresh loop is justified; the only supported reload is the one observed, bounded startup recovery before daemon readiness.
- No periodic five-minute refresh, parallel voice success path, blanket timeout increase, or takeover of ordinary user Edge is justified.
- Shared/user Edge remains disconnect-only, and ambiguous process ownership must fail closed.

## Requirement and traceability coverage

- **Repeated navigation/refresh:** Covered by Project-independent voice startup, no direct navigation, and at most one evidence-backed startup reload.
- **Alternating failures:** Covered by single-source bootstrap authentication, DOM consistency, stable lease checks, and official page-local request authentication.
- **Stability rather than cancellation:** Direction is covered, but the typed stability interface is incomplete under B-01.
- **Project/cache:** Covered by the retained lazy/cache-first baseline and transient/stale distinction.
- **Ask/Session compatibility:** Covered for existing Project identity, pending/completed/exact continuation, and new-session single-flight.
- **Direct-only/no fallback/no resubmission:** Covered. HTTP failure remains diagnostic and cannot activate another success path.
- **Current endpoint and 429:** Supported by directly inspected frontend evidence and mapped to the existing DOM wire owner.
- **Concurrency/high pressure:** Covered by exact workload and convergence thresholds.
- **Long audio:** Covered by the real TUI/process/CLI/daemon/core/DOM chain, complete non-empty text, cleanup, and subsequent voice.
- **Five-minute idle:** Covered by accelerated age testing and a real 300000 ms interval.
- **Browser close/recovery:** Covered by unique owned-process proof, no manual cleanup, and later independent success.
- **Edge/profile persistence:** Covered by auth-only restart isolation followed by one voice; failure preserves the diagnostic scene.
- **Subscription first-load feedback:** Covered by the existing bootstrap-to-ready observer and authenticated restart verification.
- **Security:** Token remains page-local and absent from adapter results, Node, status, and logs.
- **Diff/comment budget:** Line and comment estimates pass; the diagnostic decision budget does not under B-02.
- **No fabricated abnormal inputs:** Covered through captured real guest/logged-in producers and current frontend source.

## Primary-path and fallback verdict

The intended path is coherent:

`TUI WAV → validated CLI → owned/shared Edge lifecycle → single-source bootstrap/DOM convergence → core stable lease → one page-local authenticated direct POST → complete text or diagnostic failure`.

The bounded pre-ready reload is not an alternate transcription success path. No UI dictation, endpoint switch, or same-call audio resubmission is authorized.

Release remains blocked because the typed convergence interface is undefined and the current diagnostic decision-surface gate has not been calculated.

## Release verdict

**BLOCK — Revision R22 is not approved.**

R22 requires a new revision defining the non-sensitive DOM-to-core convergence contract and recalculating the complete current diagnostic decision surface, followed by another full-scope plan audit.

### R23 Revision Note

R23定义唯一跨模块接口`CHATGPT_DOM.sessionPageFact(page, { waitForTerminal, timeoutMs })`及`authenticated/logged-out/loading/inconsistent`四态判别联合；DOM adapter独占`#client-bootstrap`、composer/login和Mutation分类，core只能消费`kind/origin/readyState`并拥有login wait、一次reload和ready预算。旧`isLoggedOut/voiceSessionFact`双authority收敛删除。R23另按R6 baseline 45项加本revision 15项完整重算：13个primary gates、2个新增diagnostics；现有4个diagnostics加总为`6/60 = 10.0%`。证据复跑命令补充已登录owned browser和可连接marker前置条件。

### R23 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 Newly created voice pages use immediate snapshots and can reject normal page hydration as instability

- Violated invariant: Stability detection must distinguish ordinary page convergence from an unhealthy page. A newly created or navigated voice page must not consume its bounded renewal attempts before the supported page can reach the authenticated terminal state.
- Evidence class: reachable
- Producer and execution path: Five-minute/page-age retirement or absence of a reusable page → `voicePage()` creates a new page → `goto(..., waitUntil: 'domcontentloaded')` → normal ChatGPT bootstrap and composer hydration → two immediate stability snapshots → page is closed and renewed → second new page follows the same path.
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1525-1549` navigates a new voice page only to `domcontentloaded` and immediately calls `stabilizeVoicePage()`.
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1434-1444` performs two probes separated only by one event-loop turn.
  - The directly inspected normal convergence artifact shows bootstrap authentication at 790 ms, document completion at 986 ms, and the composer/authenticated DOM contract only at 1356 ms: `.temp/testing/chatgpt-voice-auth-evidence/bootstrap-convergence.json:22-64`.
- Canonical-plan evidence:
  - R23 defines normal `loading` and `inconsistent` states during hydration at `docs/plans/voice-transcription-lifecycle-reliability.md:298-311`.
  - It gives bounded terminal waiting only to startup, while requiring voice probes to use immediate snapshots at `:336-337`.
  - The idle invariant requires the same invocation to renew and succeed before POST at `:174`, and the accelerated idle verification explicitly forces page-age renewal.
- Responsibility owner: Core voice-page acquisition owns waiting for a newly created page to become usable; the DOM adapter owns classification and bounded terminal observation.
- Behavior-level consequence: After age retirement, browser recovery, or another path requiring a fresh dedicated page, normal hydration can be classified as unstable twice. The current invocation then fails before POST despite a healthy logged-in profile, preserving the alternating failure and five-minute-idle defect.
- Why this is not speculative: New-page navigation stops at `domcontentloaded`, the normal captured page takes several hundred additional milliseconds to satisfy the authenticated DOM contract, and R23 explicitly mandates immediate snapshot probes.
- Minimal correction direction: At the existing voice-page acquisition boundary, allow a newly created or newly navigated candidate to reach the same bounded terminal authentication fact before applying consecutive reuse/stability probes. Keep classification in `sessionPageFact`, lifecycle policy in core, the bounded pre-upload renewal limit, and the prohibition on any post-POST retry.

## Non-blocking findings

- R23 now defines the cross-module contract precisely as one non-sensitive four-state `sessionPageFact` union and assigns classification to the DOM adapter and reload/readiness policy to core.
- Directly inspectable evidence supports `#client-bootstrap` as the single current source and supports the current endpoint’s `SendIfAvailable` Bearer behavior without persisting token values.
- R23 removes the unsupported `window.CLIENT_BOOTSTRAP` alternative and does not restore `/api/auth/session`.
- The one startup reload is bounded, occurs before daemon readiness, and is supported by the user-observed mixed page that recovered after refresh.
- The updated decision-surface calculation is internally consistent: baseline 45 plus 15 R23 decisions gives 60 total, with 6 diagnostics, exactly 10%.
- The comment estimate is correct: `ceil(790 × 0.15) = 119`.
- Estimated production growth remains below 800 lines. Actual baseline/R20/R23 counts and qualifying comments remain implementation-audit obligations.
- The wire-evidence reproduction command now states its running, logged-in owned-browser prerequisite.

## Rejected speculation

- No second bootstrap source, legacy session endpoint, future authentication schema, extra guest wording, or malformed-bootstrap handling is justified.
- No endpoint switch, DOM dictation fallback, same-call resubmission, token guessing, or post-POST retry is justified.
- No repeated refresh loop is justified; only one evidence-backed startup reload is authorized.
- No periodic five-minute refresh, parallel voice success path, blanket timeout increase, or forced takeover of ordinary user Edge is justified.
- Shared/user Edge must remain disconnect-only, and ambiguous owned-process identification must fail closed.

## Requirement and traceability coverage

- **Repeated navigation/refresh:** Covered by Project-independent startup and one bounded startup reload.
- **Alternating success/failure:** Authentication source and request wire are covered, but fresh voice-page convergence remains defective under B-01.
- **Stability rather than cancellation:** The four-state contract is correct; its voice-page consumption timing is incomplete.
- **Project/cache:** Covered by the retained cache-first, transient-preservation, stale-replacement baseline.
- **Ask/Session compatibility:** Covered for existing identity, pending/completed/exact continuation, and new-session single-flight.
- **Direct-only/no fallback/no resubmission:** Covered; endpoint failures remain diagnostic.
- **Current endpoint and 429:** Covered by current frontend evidence and page-local Bearer alignment.
- **Concurrency/high pressure:** Covered by exact workload, submission count, latency, page, and lock thresholds.
- **Long audio:** Covered by the real TUI-to-DOM chain, complete non-empty text, cleanup, and subsequent voice.
- **Five-minute idle:** **Not fully covered under B-01** because forced fresh-page acquisition can reject normal hydration.
- **Browser close/recovery:** Lifecycle and ownership are covered, but any fresh voice page after recovery is also affected by B-01.
- **Edge/profile persistence:** Covered by auth-only restart isolation followed by one voice.
- **Subscription first-load feedback:** Covered by the bootstrap-to-ready observer and mixed-state startup convergence.
- **Security:** Token remains page-local and absent from adapter results, core, status, and logs.
- **Diff/comment and diagnostic budgets:** Planned calculations pass, subject to recalculation if B-01 changes the production decision surface.
- **No fabricated abnormal inputs:** Covered by real captured guest/logged-in and convergence evidence.

## Primary-path and fallback verdict

The intended path remains singular:

`TUI WAV → validated CLI → owned/shared Edge lifecycle → single-source session-page convergence → core stable lease → one page-local authenticated direct POST → complete text or diagnostic failure`.

No alternate success path is authorized. The blocking defect is within primary pre-upload page acquisition: fresh voice pages do not receive the normal convergence interval already proven necessary by R23’s own evidence.

## Release verdict

**BLOCK — Revision R23 is not approved.**

R23 must incorporate bounded normal convergence for newly created or navigated voice pages at the existing acquisition owner, update affected tests and decision-surface accounting, and then undergo another full-scope plan audit.

### R24 Revision Note

R24在现有core voice acquisition owner补齐fresh/navigated candidate消费时机：`goto(...domcontentloaded)`后先调用同一`sessionPageFact(waitForTerminal=true, timeoutMs=15_000)`，authenticated后再做两次snapshot；已收敛borrowed/persistent page仍直接snapshot。terminal wait失败才消耗既有一次退役/续租预算，POST后行为不变。TDD slice 18用正常loading/inconsistent到authenticated的producer证明不关闭、不续租且只POST一次，并覆盖timeout后一次续租。决策面增加两个primary acquisition branches，合计`6/62 = 9.68%`。

### R24 Independent Verdict (copied from auditor)

## Blocking findings

No blocking findings.

## Non-blocking findings

- R24 closes the fresh-page timing gap: newly created or newly navigated candidates receive bounded terminal convergence before consecutive stability snapshots, while already-converged reused pages remain snapshot-only.
- The four-state `sessionPageFact` contract cleanly separates DOM/bootstrap classification from core lifecycle policy and removes the two previous login authorities.
- The decision-surface calculation is internally consistent: 62 total decisions, 6 diagnostic decisions, `6 / 62 = 9.68%`.
- The Chinese-comment estimate is correct: `ceil(805 × 0.15) = 121`.
- Estimated production growth is approximately 245 net lines, below the 800-line ceiling. Final implementation audit must independently recount baseline/R20/R24 changes and qualifying comments.
- The current worktree still contains the pre-R24 behavior; approval authorizes only the exact changes and verification described by R24.

## Rejected speculation

- No second bootstrap source, legacy session endpoint, future schema, additional guest wording, or malformed-bootstrap handling is justified.
- No endpoint switch, DOM dictation fallback, token guessing, same-call resubmission, or post-POST retry is justified.
- No repeated refresh loop is justified; only one bounded startup reload is authorized.
- No periodic idle refresh, parallel voice success path, blanket timeout increase, or takeover of ordinary user Edge is justified.
- Shared/user Edge remains disconnect-only, and ambiguous owned-process identification must fail closed.

## Requirement and traceability coverage

- **Repeated navigation/refresh:** Covered by Project-independent startup, direct no-navigation behavior, ordinary convergence waiting, and at most one startup reload.
- **Alternating success/failure:** Covered by single-source bootstrap authentication, DOM consistency, fresh-page convergence, consecutive stability snapshots, and page-local Bearer authentication.
- **Stability rather than cancellation:** Covered. Stability uses the four-state page fact and consecutive probes; cancellation remains settlement and cleanup only.
- **Project/cache:** Covered by lazy ask-only initialization, cache-first validation, transient retention, and proven-stale replacement.
- **Ask/Session compatibility:** Covered for existing identity, pending/completed/exact continuation, and new-session single-flight.
- **Direct-only/no fallback/no resubmission:** Covered. HTTP and transport failures remain diagnostics and cannot activate another success path.
- **Current endpoint and 429:** Covered by directly inspectable frontend evidence and the page-local `SendIfAvailable` Bearer contract.
- **Concurrent/high-pressure behavior:** Covered by the exact 12-voice/6-ask workload, latency threshold, submission count, page limits, lock convergence, and final voice.
- **Long audio:** Covered through the real TUI/process/CLI/daemon/core/DOM chain with non-empty complete text, WAV cleanup, and a subsequent short voice.
- **Five-minute idle:** Covered by fresh-page terminal convergence, accelerated age testing, and a real 300000 ms interval.
- **Browser close/recovery:** Covered by uniquely proven owned-process termination, no manual state cleanup, stale-index retirement, and later independent success.
- **Edge/profile persistence:** Covered by two auth-only bootstrap checks followed by one short voice, with failure preserving the diagnostic state.
- **Subscription first-load feedback:** Covered by bootstrap-to-ready observation and authenticated restart verification.
- **Security:** Bootstrap tokens remain page-local and absent from adapter results, core, status, and logs.
- **Diff/comment and diagnostic budgets:** All planned calculations pass, subject to actual implementation recount.
- **No fabricated abnormal inputs:** Covered using directly captured logged-in, guest, frontend-wire, and convergence evidence.

## Primary-path and fallback verdict

The authoritative path is coherent:

`TUI WAV → validated CLI → owned/shared Edge lifecycle → single-source session-page convergence → core stable lease → one page-local authenticated direct POST → complete text or diagnostic failure`.

Fresh-page waiting and one startup reload occur before audio submission within primary lifecycle acquisition. Neither is an error-triggered transcription fallback. No alternate success path is authorized.

## Release verdict

**APPROVE — No blocking findings.**

This approval applies only to canonical plan revision **R24**. Implementation remains subject to exact revision recording, complete verification, actual diff/comment accounting, and a full independent implementation audit.

### R25 Revision Note

R24实施后的首个3轮load在第一轮触发真实ask伪发送；缩减到`2 voice + 1 new ask`连续两次red，删去第二个voice后转绿。失败Session已进入lost，但Project composer仍保留完整prompt、send enabled且user turn为0；同daemon随后new Session单独ask完成。低开销CDP成功对照证明pointer/click命中send-button，且只有两次transcribe均结束后才出现conversation POST。R25因此不改DOM click、不重试prompt、不扩大timeout，而是在现有runtime owner增加短`submissionQueue`：voice direct与ask composer submit/acceptance互斥，assistant生成和其它结果等待继续并发。R24已落地代码保留为当前worktree基线；R25未审计前不得继续修改。

### R25 Independent Verdict (copied from auditor)

## Blocking findings

### B-01 The R25 submission queue is assigned to the wrong acceptance seam and therefore does not cover the observed pseudo-send window

- Violated invariant: The new cross-operation submission boundary must cover the complete remote acceptance transaction that prevents a prompt from being marked lost before ChatGPT accepts it, while excluding assistant-generation/result waiting.
- Evidence class: observed
- Producer and execution path: Concurrent voice direct POST → ask `CHATGPT_DOM.submit()` trusted click → `beforeSend` writes the lost tombstone → `submitAsk()` waits for the conversation URL/user-turn acceptance → timeout leaves the composer prompt intact with `userTurns=0` and the Session lost.
- Source evidence:
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1871-1892` shows that `submitAsk()` calls `CHATGPT_DOM.submit()` at `:1876-1883`, then performs the actual acceptance/recovery observation through `rememberCurrentSessionUrl()` at `:1885-1890`.
  - `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1872-1875` states that the click starts the lost/pending protection before a conversation URL is recorded.
  - The current `CHATGPT_DOM.submit()` returns after `clickSend()` and the `beforeSend` callback; it does not itself observe the new user turn or conversation acceptance.
  - The R25 evidence records the exact failure: `composer` retained the full prompt, send remained enabled, `userTurns=0`, and the Session became lost after the concurrent submission window.
- Canonical-plan evidence:
  - R25 assigns the shared queue to the “voice direct / ask composer transaction” at `docs/plans/voice-transcription-lifecycle-reliability.md:320`, `:395`, and `:433`.
  - The implementation direction says `submitAsk` should wrap the existing `runtime.withForeground(() => CHATGPT_DOM.submit(...))` and hold the queue until the DOM adapter observes a new user turn at `:374`.
  - The forward traceability contract says the queue covers “one direct or one trusted click” at `:444`, and the file plan describes the ask side as “composer submit/acceptance” at `:464`.
- Responsibility owner: Core orchestration owns the cross-page submission queue and `rememberCurrentSessionUrl()` acceptance boundary; the DOM adapter owns the single click operation but does not currently own conversation URL/user-turn acceptance.
- Behavior-level consequence: If the queue is released when `CHATGPT_DOM.submit()` returns, it releases immediately after the trusted click and lost-tombstone write—the exact interval in which the observed pseudo-send occurs. A concurrent voice can still overlap `rememberCurrentSessionUrl()`, leaving a lost Session and an unaccepted prompt. If the implementer moves acceptance observation into the DOM adapter without a defined contract, it creates an ownership leak and changes the existing public adapter behavior.
- Why this is not speculative: The observed red run failed specifically during the acceptance wait, and the current source places that wait outside the proposed queued `CHATGPT_DOM.submit()` call.
- Minimal correction direction: Define the queue-owned ask transaction as the core sequence from the final validated click through `rememberCurrentSessionUrl()` success or bounded failure. Keep `CHATGPT_DOM.submit()` as the one click path, keep the lost/pending tombstone semantics, release the queue before `finishAsk()`/assistant generation, and never retry a click or synthesize success. The voice side should remain queued only for its existing direct POST/response operation.

## Non-blocking findings

- R25 correctly identifies a new observed concurrency divergence rather than treating the failure as a selector, Project, login, or permanent composer problem.
- The proposed queue is appropriately owned by `chatgpt-core.js`, not by the DOM adapter, CLI, or MCP wrapper.
- The plan correctly preserves concurrent assistant generation and avoids serializing the entire ask lifecycle.
- The no-retry rule is explicit and important because the lost tombstone means the remote side effect cannot be proven absent after a click attempt.
- The decision-surface estimate is internally consistent as written: 65 total decisions and 6 diagnostics, `6 / 65 = 9.23%`; the corrected acceptance seam may change the executable-decision count and requires recalculation.
- The planned comment estimate is arithmetically correct: `ceil(835 × 0.15) = 126`.
- The original baseline requirements—Project/cache, Session identity, stable fresh-page convergence, direct-only auth, Edge/profile ownership, idle, long audio, browser close, and subscription observation—remain mapped and are not narrowed by R25.
- The current worktree still predates the R25 queue implementation, so final verification must prove the observed two-voice/one-ask red case turns green without weakening the existing lost/pending safeguards.

## Rejected speculation

- No Enter-key fallback, DOM click fallback, second trusted click, same-call prompt retry, or success synthesis is justified.
- No global serialization of assistant generation, all ask work, or all voice result waiting is justified.
- No new public endpoint, configuration switch, session state machine, or external dependency is justified.
- No additional browser refresh, periodic idle refresh, endpoint switch, or DOM voice-transcription fallback is justified.
- Shared/user Edge remains disconnect-only, and ambiguous owned-process discovery must fail closed.

## Requirement and traceability coverage

- **Repeated navigation/refresh:** Covered by the baseline startup/Project separation and bounded bootstrap recovery.
- **Alternating success/failure:** Covered by bootstrap authentication, fresh-page convergence, direct-only behavior, and now the observed voice/ask remote-submission conflict.
- **Stability rather than cancellation:** Covered by the four-state page fact and fresh-page terminal wait; cancellation remains cleanup/settlement behavior.
- **Project/cache:** Covered by the baseline lazy/cache-first identity path.
- **Ask/Session compatibility:** Covered by registry-first existing Session handling, pending/completed/exact continuation, and lost-session protection. The queue must preserve these semantics at B-01’s acceptance seam.
- **Direct-only/no fallback/no resubmission:** Covered. Queue failure must propagate only to its own operation and advance later work without retry.
- **Current endpoint and 429:** Covered by the page-local official Bearer contract and no endpoint switching.
- **Concurrent/high-pressure behavior:** The new minimum producer is mapped, but release is blocked until the queue covers the actual acceptance window.
- **Long audio:** Covered by the real TUI/process/CLI/daemon/core/DOM chain and subsequent short voice requirement.
- **Five-minute idle:** Covered by fresh-page terminal convergence and bounded renewal.
- **Browser close/recovery:** Covered by owned-process safety, no manual cleanup, stale-index retirement, and later independent success.
- **Edge/profile persistence:** Covered by auth-first restart and subsequent short voice.
- **Subscription first-load feedback:** Covered by the bootstrap observer.
- **Security:** Bootstrap token remains page-local; no prompt/token/cookie logging is authorized.
- **Diff/comment and diagnostic budgets:** Planned values are within limits, but the corrected queue seam may require updated decision-surface accounting.
- **No fabricated abnormal inputs:** The concurrency producer and acceptance artifacts are real; no fabricated server or malformed-input cases are required.

## Primary-path and fallback verdict

The primary path remains coherent:

`TUI WAV → validated CLI → owned/shared Edge lifecycle → bootstrap convergence → stable voice lease → shared remote-submission boundary → one direct voice POST or one accepted ask click → independent result waiting`.

The submission queue is a primary concurrency boundary, not a fallback. However, R25 currently places its ask-side boundary around the click helper rather than the actual click-to-acceptance transaction that owns the observed failure.

## Release verdict

**BLOCK — Revision R25 is not approved.**

R25 requires a new revision that makes the shared queue own the complete ask click-to-acceptance sequence through `rememberCurrentSessionUrl()` (without owning assistant generation or adding retries), then undergoes another full-scope plan audit.

### R26 Revision Note

R26把ask侧queue owner从DOM submit调用扩大到core完整`submitAsk`返回：现有DOM单次可信click、新增user turn确认、lost墓碑与`rememberCurrentSessionUrl`成功/有界失败全部位于同一submission transaction；`finishAsk`仍在队列外。voice侧仍只包现有direct POST/response。这个边界不新增decision branch，decision surface保持`6/65 = 9.23%`；不移动URL identity到DOM、不重试click、不改变Session registry语义。

### R26 Independent Verdict (copied from auditor)

No blocking findings.

## Non-blocking findings

- R26 still contains historical/current-behavior wording that describes the worktree as cookie-only direct transcription in §5, while the current source and R26 primary design use page-local `#client-bootstrap` Bearer authentication. This does not block the plan because §10, §14, §15, and TDD slice 17 clearly define the authoritative R24/R26 behavior, but implementation evidence should explicitly separate historical baseline text from the current implementation.
- The R26 implementation-evidence fields remain intentionally pending. This is correct for `Audit mode: plan`; they must be completed before implementation release and independently audited afterward.
- The planned `E ≈ 835` and `C >= 126` figures are estimates, not implementation evidence. The final implementation must recount the actual diff and qualifying Chinese explanatory comments.
- The long-audio timeout plan correctly requires the real integrated chain to identify the first failing deadline owner before changing a timeout. No blanket timeout increase is authorized.

## Rejected speculation

- No additional blocker is inferred from the existing 60-second core or 90-second TUI deadlines alone. The repository contains prior evidence of long-WAV completion, and the plan requires measured first-owner evidence before changing any budget.
- No second authentication producer, legacy `/api/auth/session` parser, malformed bootstrap handling, endpoint switch, UI dictation fallback, same-call retry, or post-upload renewal is justified.
- No global serialization of all ask work, assistant-generation waiting, or voice result waiting is required. The observed conflict is limited to remote submission acceptance.
- No periodic refresh, five-minute polling loop, parallel voice success path, or broad process-name browser termination is justified.
- No change to shared/user Edge ownership is required; shared CDP remains disconnect-only and ambiguous owned-process discovery must fail closed.

## Requirement coverage

- **Repeated navigation/refresh:** Covered by Project-independent daemon startup, bounded bootstrap convergence, and at most one pre-ready reload.
- **Alternating success/failure:** Covered by one bootstrap authentication authority, four-state DOM facts, fresh-page terminal convergence, consecutive stability probes, page-local Bearer authentication, and the new shared submission boundary.
- **Stability rather than cancellation:** Covered. Stability determines readiness and lease reuse; cancellation only settles the direct request and cleans resources.
- **Lifecycle ownership:** Covered by core-owned browser/page lifecycle, borrowed/dedicated voice leases, stale-page retirement, and next-call recovery after browser disconnect.
- **Project/cache:** Covered by lazy ask-only Project initialization, cache-first identity validation, transient cache retention, proven-stale replacement, and no voice dependency on Project startup.
- **Ask/Session compatibility:** Covered by registry-first existing Session handling, pending/completed replay, exact continuation identity, lost-session tombstones, and new-session single-flight.
- **Direct-only/no fallback/no resubmission:** Covered. Direct errors remain diagnostic failures; no UI dictation fallback, endpoint switch, same-call audio retry, or success synthesis is authorized.
- **Current endpoint and 429 behavior:** Covered by the observed frontend wire, `/backend-api/transcribe`, FormData `file`, credentials, page-local Bearer, and no endpoint switching.
- **Voice/ask concurrency:** Covered by the R26 `submissionQueue`:
  - voice owns only the existing direct POST/response transaction;
  - ask owns the complete trusted-click through user-turn and `rememberCurrentSessionUrl()` acceptance transaction;
  - `finishAsk()` and assistant-generation waiting remain outside the queue;
  - failures advance later queue entries without retries.
- **High-pressure behavior:** Covered by three workload rounds, 12/12 voices, 6/6 asks, zero failures/timeouts, p95 threshold, exact `voiceSubmitted` increment, bounded pages/locks, and a final subsequent short voice.
- **Long audio:** Covered by the real TUI controller → subprocess → CLI → daemon → core → DOM chain, approximately 300-second WAV, non-empty complete text, WAV cleanup, and a subsequent short voice.
- **Five-minute idle:** Covered by accelerated page-age testing and a real 300000 ms interval, with bounded pre-upload renewal only.
- **Browser close/recovery:** Covered by uniquely identifying and terminating only the new daemon-owned Edge descendant, no manual state cleanup afterward, stale-index retirement, and later independent success.
- **Edge/profile persistence:** Covered by auth-first bootstrap checks, graceful stop/restart, persistent login verification, and a final short voice.
- **Subscription first-load feedback:** Covered by waiting for bootstrap/auth/composer convergence and restart verification without treating normal hydration as logged out.
- **Security and ownership:** Tokens remain page-local; they do not enter Node, core, status, logs, or adapter return values. Shared/user Edge is never closed.
- **Diff/comment/diagnostic budgets:** Planned values remain within the stated limits; actual implementation recount is still required.
- **Traceability:** Every R26 production concept has an owner, primary-path mapping, behavior slice, and explicit no-fallback disposition.

## Primary-path verdict

The R26 primary path is coherent:

```text
TUI WAV
→ validated CLI
→ owned/shared Edge lifecycle
→ bootstrap convergence
→ stable voice lease
→ shared remote-submission boundary
→ one page-local authenticated direct POST or one trusted accepted ask click
→ independent result waiting
→ complete text or diagnostic failure
```

The R25 acceptance-seam defect is corrected in the R26 plan. The queue now owns the core ask transaction through `rememberCurrentSessionUrl()` success or bounded failure, while remaining outside `finishAsk()` and assistant generation. This is the correct existing core owner and does not require moving URL identity into the DOM adapter.

## Fallback verdict

No prohibited fallback is authorized.

- No direct-to-UI fallback.
- No endpoint substitution.
- No same-call audio or prompt resubmission.
- No second click or Enter fallback.
- No post-upload page renewal.
- No error-as-success conversion.
- No blanket serialization of result generation.

Pre-upload page acquisition, bounded hydration waiting, one startup reload, and one pre-upload lease renewal remain part of the single primary lifecycle, not fallback success paths.

## Release verdict

**APPROVE — No blocking findings.**

This approval applies only to canonical plan revision **R26** in `Audit mode: plan`. It does not authorize implementation. Before implementation release, the builder must complete the R26 evidence fields, implement only the approved queue boundary, run the complete verification matrix, perform actual diff/comment accounting, and obtain a full independent implementation audit.

## 23. Implementation Evidence

R26已在批准owner和边界内实施：runtime只新增一条短`submissionQueue`；voice持有到唯一direct完整response，ask持有到完整`submitAsk`返回和可信conversation URL记录，`finishAsk`仍在队列外。实施中没有新增endpoint、DOM听写、click/音频重试、第二种认证来源、public API或生产配置。

### Actual Files and Diff

- root：
  - `docs/plans/voice-transcription-lifecycle-reliability.md`：本canonical plan与审计/实施证据，`+1693/-0`。
  - `packages/opencode/test/cli/tui/prompt-voice-input.test.ts`：真实300秒TUI门禁、可变RIFF chunk生成、显式profile/隔离daemon state和精确PID cleanup，`+117/-0`。
- nested `thirdparty/chatgpt-browser-agent`：
  - `chatgpt-core.js`：Project lazy/cache、voice lease/startup convergence、R26 submission queue和排队取消锁存，`+258/-137`。
  - `chatgpt-dom.js`：单一`#client-bootstrap`四态事实、page-local Bearer direct、删除旧双authority与UI voice fallback，`+75/-306`。
  - `chatgpt.js`：daemon/browser lifecycle诊断微调，`+3/-5`。
  - `test-mcp.js`：R10/R24/R26行为级离线回归，`+701/-57`。
  - `test-voice-robustness.js`：profile/load/idle/browser-close真实harness，`+337/-0`。
  - `README.md`：voice认证、fresh-page和短submission transaction契约，`+42/-11`。
- nested共`1416 insertions/516 deletions`；root任务文件共`1810 insertions`，其中plan本身1693行。
- 非测试production净变化：`chatgpt-core.js +121`、`chatgpt-dom.js -231`、`chatgpt.js -2`，合计净`-112`，明显低于用户要求的净增800行上限。
- 未修改dependency、migration、generated文件或public配置面；root其它工作树变化不属于本任务，也不进入后续stage。

### Red-Green Test Evidence

1. `testSessionPageFactUsesBootstrapAuth`：red为`dom.sessionPageFact is not a function`；实现单一四态adapter后green。
2. `testStartupRecoversMixedLoginOnce`：red为`testing.convergeBootstrapPage is not a function`；实现事件收敛和最多一次startup reload后green。
3. `testDirectVoiceUsesBootstrapAuth`：red中实际Authorization为`null`、期望`Bearer page-access-token`；page-local bootstrap Bearer后green，token未离开page。
4. `testFreshVoicePageWaitsForConvergence`：red为`Voice page is not stable ... authenticated=false`；fresh/navigated terminal wait加双snapshot后green。
5. `testVoiceAndAskSerializeRemoteSubmission`：修复前精确red为`Waiting failed: 10000ms exceeded`，堆栈落在`submitAsk -> withForeground -> DOM submit`；加入短submission queue后green，两个voice和一个ask全部成功、URL已记录、无lost、direct各一次，且第二voice在`finishAsk`等待中启动。
6. 扩展`testQueuedVoiceCancelHasZeroSideEffects`后捕获真实red：取消请求返回后旧queued closure仍执行POST，`3 !== 2`；加入请求局部`cancelledBeforeSubmission`锁存后green，排队取消零POST且下一voice成功。
7. 长WAV门禁第一次red为假未登录；证据显示Bun preload把`XDG_DATA_HOME`改到临时空profile，而真实agent profile的bootstrap为`logged_in/token=true/composer=true/loginButton=false`。门禁改为显式真实profile和隔离state。
8. 使用真实profile后长WAV red为HTTP 500；源WAV的`fmt` chunk为18字节、`data`位于offset 38，旧helper硬编码44字节头并损坏`data` chunk。按RIFF chunk和blockAlign生成后，300秒WAV及随后short voice均通过。
9. 长门禁cleanup进一步red为`voice E2E daemon <pid> did not exit after stop`；根因是动态`CHATGPT_STATE_DIR`没有显式传入Bun cleanup子进程。固定隔离state、`env: process.env`和精确PID退出等待后最终green，无Edge/profile holder或`e2e-state-*`残留。
10. R35 slice 22先把`testProjectHomeDiscoveryUsesLiveSidebar`改为delayed init；production未等待时断言red。live、collapsed和hidden-responsive三个可信首页click fixture统一发`POST /backend-api/conversation/init`，DOM network seam完成后green，`initCompleted=true`。
11. R35 slice 23在`testCoreProjectStateMachine`中让fresh Project导航只有经过adapter seam才锁存`initCompleted`；旧core直接`page.goto`时red为`false !== true`，委托`navigateProjectHome`后green。既有Project fake page补同一response事实，没有增加production fallback。
12. R36原始红环使用fresh隔离state执行`4 voice + 2独立ask`，连续三次均在130秒报`CLI timed out: --raw Reply exactly OK. Load request 1-2.`；R36把Project initializer加入queue后离线slice green，但真实复测转为voice direct不入队并在60秒失败，证明voice preflight仍在queue外。无voice cold ask和`2 voice + 1 ask`green。全部`R35-DIAG/DEBUG-R35`日志已删除。
13. R36方案审计重新读取真实TUI整链后阻塞当前长WAV断言：300秒helper只在开头保留short语音并在末端填silence，测试仅检查`inserted[0]`非空；截断、旧short结果或任意非空文本均可通过。R37将此作为test-contract red，production voice路径不变。
14. R37长marker slice先red为旧fixture返回`hello world.`而缺少`purple`，改为Darwin `say -v Samantha` + `afconvert`生成末端marker并更新RIFF helper后green：`1 pass, 21 filtered out, 8 expect()`；evidence仅记录`markersMatched`、长度和cleanup。
15. R38尚未实施；当前production只包含R36 Project queue归属，必须先补voice lease/preflight queue slice并验证queue前取消不创建page，再重跑原始4/2。

### Verification Commands and Results

- nested离线：
  - `TMPDIR=/private/tmp node test-mcp.js ...15项批准窄回归...`：15/15通过。
  - `TMPDIR=/private/tmp npm test`：syntax/dependency检查通过，`SUITE: 54 test(s)`全部通过；最终production改动后重复执行过完整suite。
  - `node --check test-mcp.js && node --check test-voice-robustness.js && node --check chatgpt-core.js && node --check chatgpt-dom.js && node --check chatgpt.js`：通过。
  - nested/root任务文件`git diff --check`：通过。
  - R35最终当前worktree再次运行`TMPDIR=/private/tmp npm test`：syntax/dependency通过，`SUITE: 54 test(s)`全部通过。
- package-local：
  - `bun test test/cli/tui/prompt-voice-input.test.ts`：`21 pass, 1 skip, 0 fail`；在最终RIFF/state cleanup修改后重跑通过。
  - `bun typecheck`：`tsgo --noEmit`通过；在最终TUI修改后重跑通过。
- 真实Edge/profile：
  - 最小原始反馈环`--load --rounds 1 --voice-per-round 2 --ask-every 2`：`PASS load: voice=2 ask=1 p95=11605ms submitted=2`。
  - R26旧完整压力曾输出`PASS load: voice=12 ask=6 p95=14261ms submitted=12`，但实现审计证明其中后五个ask命中completed replay；该结果撤销，不能作为六次远端提交证据。
  - 修正为同Session distinct prompt后，第4次ask在所有voice结束后发生generic composer reset；R27方案审计判定它越出本voice任务。R28改用六个独立new Session producer，批准后必须重跑到`accepted=6`和六个唯一Session。
  - 真实idle `--idle --gap-ms 300000`：`PASS idle: gap=300000ms second call completed in one submission`。
  - R24当前worktree的profile gate：`PASS profile-restart: firstDaemon=61494 firstBrowser=61497 secondDaemon=61716`；两次auth-only restart后唯一short voice成功，无订阅dialog。
  - R24当前worktree的owned close gate：`PASS browser-close: oldDaemon=64649 oldBrowser=64654 newDaemon=65001`；只关闭唯一agent后代，下一独立voice一次提交成功。
  - 最终长音频命令：`CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=/Users/sunbenteng/.local/share/opencode/chatgpt-browser-agent/state/profile TMPDIR=/private/tmp bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "five-minute WAV"`：`1 pass, 21 filtered out, 0 fail, 6 expect()`，11.59秒；覆盖300秒WAV、清理和后续short voice。
  - profile非敏感诊断：同一agent profile为`authStatus=logged_in`、`hasAccessToken=true`、`composer=true`、`loginButton=false`；随后cold short voice输出`Hello, world.`。
  - 最终残留检查：无精确profile holder进程、无`e2e-state-*`目录，默认daemon为not running。
  - R35无cache隔离state cold MCP ask：日志没有`Using cached`，先`Opened ChatGPT Project from live sidebar: MCP`，随后返回`OK / Status: completed / #68b72c7449`。
  - R35 cold之后最小`1 voice + 1 ask`：`PASS load: voice=1 ask=1 sessions=1 accepted=1 p95=5904ms submitted=1`；fresh `2 voice + 1 ask`：`PASS load: voice=2 ask=1 sessions=1 accepted=1 p95=4612ms submitted=2`。
  - R35完整压力red：fresh `4 voice + 2 ask`连续三次卡在Project expander可信click并达到130秒CLI timeout；R36首次修复后同样fresh `4 voice + 2 ask`在voice direct未完成、60秒deadline处red，因此不得沿用此前任何12/6 green作为R38完成证据。
  - R37真实长marker门禁：`1 pass, 21 filtered out, 8 expect(), 0 fail`，长/短WAV与TTS中间文件删除，隔离daemon精确退出。

### Original Feedback-Loop Result

- R24实施后原始3轮load第一轮首ask稳定伪发送：composer保留完整prompt、send enabled、`userTurns=0`、Session进入lost；同daemon单独new ask成功。
- 缩减到`2 voice + 1 new ask`连续两次red，删除第二voice后的`1 voice + 1 ask`green，证明真实触发路径是两个独立远端提交owner的重叠窗口，不是DOM selector或模型回答。
- R26后最小producer green：2/2 voice、1/1 new ask、submitted=2；旧12/6因completed replay无效。same-Session distinct prompt暴露的generic reset不在R29 production范围；R29只把完整压力改成六个独立new ask，仍不提高click timeout、不第二次click、不串行assistant生成。
- 长WAV的登录与HTTP 500均被证明是测试输入/环境首次分歧；真实profile和合法RIFF后产品direct路径一次成功，没有据此修改endpoint或增加fallback。

### Actual Secondary and Replacement Path Inventory

- 唯一voice成功路径仍为：`TUI WAV -> validated CLI -> daemon/browser lifecycle -> stable authenticated lease -> submission queue -> one page-local Bearer POST /backend-api/transcribe -> complete text`。
- `chatgpt-dom.js`不包含UI dictation/fake mic voice success path；HTTP/transport/origin/response错误只返回诊断。
- R36当前已把首次default Project single-flight与ask完整`submitAsk`放入submission queue，但voice lease/preflight仍在queue外；R38批准后才允许将voice lease/preflight与direct合并为同一queue事务。
- `finishAsk`、assistant生成、artifact、文件校验和Session锁仍在queue外；R38不得把整个voice/assistant等待或generic ask串行化。
- queue前取消使用请求局部锁存保证迟到closure零POST；前项失败通过tail catch推进后继，但不重试音频或click。
- ask仍只有现有可信send-button click；lost墓碑和`rememberCurrentSessionUrl`严格身份语义不变。
- startup只允许持续nonterminal消费一次reload；fresh/navigated页只在POST前等待terminal并沿既有一次lease renewal。POST后不换页、不续租、不重发。
- shared CDP仍只disconnect；owned browser只由launch handle或唯一后代证据关闭。测试cleanup固定自己的state/PID，不按进程名扩大范围。
- 本节把历史cookie-only描述明确归为旧baseline：当前权威实现是同一`#client-bootstrap`在page内提供Bearer并同时保留same-origin cookies。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | pending R28 recount | R26 builder曾记1438；独立审计重算1422。R28 harness/evidence完成后按最终实际diff统一重算。 |
| Qualifying Chinese comment lines `C` | pending R28 recount | R26独立审计为226；R28新增测试行后不得沿用旧分子。 |
| Ratio `C / E` | pending | 必须仍大于等于15%。 |
| Required minimum `C` | pending | `ceil(final E * 0.15)`。 |

代表性注释分布于：submission queue为何只覆盖远端接受事务、排队取消为何必须锁存、bootstrap token为何不出page、fresh hydrate为何不消耗renewal、profile helper为何排除`--type=`、长WAV为何解析RIFF chunk、E2E state为何必须和真实profile分离、stop为何还需等待精确PID。

### Remaining Unverified Items

- R38尚未获方案审计批准；不得修改`runVoiceTranscribe`的lease/queue归属。
- R37 late-marker已green；R38批准后先按slice 25完成voice preflight排序与queue前取消red/green，再重跑fresh 4/2、完整12/6、显式本地长WAV和既有lifecycle gates。线上CI继续skip登录测试。
- R35至R38合并实际diff通过full-scope implementation audit前不得提交或标记verified。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| round 1 | R26 | yes | B-01旧压力5/6 ask为completed replay；B-02长WAV缺持久独立证据 | 过时fallback注释/旧internal参数；行政diff统计漂移 | BLOCK | `ses_09a6bac56ffeCBAb0n1KoDGM1I` |

### R28 Revision Note

R27方案审计确认distinct prompt和可信acceptance计数修复了replay假通过，但阻塞generic composer refill越界及decision surface未重算。R28删除全部composer reset/refill production concept、INV、fixture和文件delta；production仍是已批准R26，decision surface保持`6/65=9.23%`。高压producer回到原始缺陷域：六个独立new Session ask与每轮voice并发调度，各自distinct hash、唯一Session和一次可信URL acceptance；累计7个managed page仍低于cap 12。

R28 forward mapping：INV-13/INV-16 -> `test-voice-robustness.js` independent-new-ask producer -> `accepted=6`和唯一Session集合 -> 现有core submission queue。Reverse mapping：R28没有新增production concept；test-only producer修正由R26 audit B-01和R27 generic-scope block共同证明。长WAV证据改为可选`CHATGPT_VOICE_E2E_EVIDENCE`本地路径；线上CI不登录、不持有profile/token、不依赖忽略目录。

### R29 Revision Note

R28方案审计只阻塞旧same-Session/managed<=2合同残留。R29将§7、§10、TDD slice 13/20、file plan和verification统一为一套producer：3轮、12 voice、6个并发调度的独立new Session ask、distinct hash、六个唯一句柄、`accepted=6`、累计managed pages<=7。最小`2 voice + 1 new ask`继续负责原始伪发送敏感度；完整矩阵负责重复queue推进、结果并发和资源上限。没有第二套same-Session压力合同。

### R31 Revision Note

R29已通过full-scope plan audit。用户随后纠正真实E2E应使用名称为`MCP`的Project，并明确禁止硬编码其conversation URL。R30曾短暂把URL中的Project token写入规范，但未审计、未实施；R31删除所有该URL/token，统一通过既有配置`CHATGPT_PROJECT=MCP`和cache-first/live discovery解析当前身份。该变化只收紧test invocation和Project验收，不新增production branch、配置项或fallback。

### R31 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — No blocking findings.**

该批准只适用于当前磁盘R31。实施只允许MCP名称配置、六个独立new Session/distinct prompt/unique handles/`accepted=6`的test-only harness、可选非敏感长WAV本地证据和过时注释收敛；禁止硬编码conversation URL/ID/Project token、恢复R27 composer refill或改变R26 production queue。

### R32 Revision Note

R31 test-only实施期使用`CHATGPT_PROJECT=MCP`首次触发真实fresh-page Project解析失败。两次独立ask均在`discoverProjects -> openProjectHomeFromSidebar`失败；失败页已经`logged_in`、有composer和MCP row，sidebar资源也已返回，但导航容器为`pointer-events:none`且按钮移出视口。现有尺寸型`visible()`和首页按钮点击因此误把隐藏副本当作可交互，实际命中外层surface。触发网页现有`stage-slideover-sidebar` toggle后，同一sidebar变为可命中。R32只允许DOM Project owner在既有live discovery/open-home主路径前恢复该控件并等待交互终态；不改cache/Project identity、URL/token、voice direct、R26 submission queue或generic ask。

### R32 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 R32未重新计算新增Project侧栏恢复逻辑的production decision surface。**
- **B-02 当前canonical sections仍为同一完整压力producer规定互相冲突的managed-page上限。**

**Release verdict**

**BLOCK — Revision R32 is not approved.**

### R33 Revision Note

R33按B-01把sidebar恢复的共享helper、已交互直通、结构化toggle、状态转换、交互终态等待和唯一timeout诊断全部纳入decision surface：既有65项加5项primary和1项diagnostic，最终为`7 / 71 = 9.86%`。按B-02把完整12 voice/6独立new Session ask统一为累计managed pages最多7；2页只保留给最小`2 voice + 1 ask`反馈环。按用户纠正，当前规范删除所有非目标Project名称，真实ask、最小overlap和完整压力唯一使用配置名`MCP`。

### R33 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R33 has no blocking findings.**

该批准只适用于当前磁盘R33；允许按TDD slice 21实现Project sidebar交互终态，并完成R31已批准但尚未通过真实MCP gate的独立new Session压力和本地证据。实现后仍须full-scope implementation audit，审计通过前不得提交或标记verified。

### R34 Revision Note

R33实施后，MCP侧栏和Project身份解析已经成功；首个无cache cold ask却在可信send click后20秒仍停留Project首页并按lost墓碑明确失败，随后同页才出现user/assistant turn和严格Project conversation URL。脱敏CDP对照确认fresh page先完成`POST /backend-api/conversation/init`，再提交`POST /backend-api/f/conversation`并切换`/c/...`。R34把首次分歧归属到DOM Project首页导航过早返回：只对本次真实首页click预先登记并等待同页init成功事件；不延长`rememberCurrentSessionUrl`、不放宽URL身份、不重发prompt。R34在R33的71项decision上新增3项primary，diagnostic仍为7，比例`7 / 74 = 9.46%`。

### R34 Independent Verdict (copied from auditor)

**Blocking findings**

- **B-01 R34将新增的初始化超时/失败分支错误排除在diagnostic decision surface之外。**
- **B-02 R34只覆盖live-sidebar click，遗漏cache/currentProject触发的fresh Project首页导航。**

**Release verdict:** **BLOCK — Revision R34 is not approved.**

### R35 Revision Note

R35按R34审计结果把初始化失败/超时作为新增diagnostic decision，覆盖live sidebar click和cache/currentProject驱动的fresh `page.goto`两类producer，并把它们收敛到同一DOM network-convergence seam。R35保留R33的71项decision，新增8项primary和1项diagnostic，总计`8 / 80 = 10%`；不延长`rememberCurrentSessionUrl`，不放宽Project conversation URL校验，不重发prompt。当前真实ask和压力仍唯一使用`CHATGPT_PROJECT=MCP`，不硬编码任何conversation URL/ID/Project token。

### R35 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R35 has no blocking findings.**

该批准只适用于当前磁盘R35；允许按TDD slice 22/23实现统一Project-home network-convergence seam。实现后必须重新计算实际decision surface、中文注释和生产净增，并完成full-scope implementation audit，审计通过前不得提交或标记verified。

### R36 Revision Note

R35 delayed-init与fresh-goto已经按批准范围实施并通过离线/真实cold ask，但fresh隔离state的`4 voice + 2独立new ask`连续三次达到130秒timeout。定向边界日志把first divergence定位到cold Project expander的唯一可信click与另页voice direct `Runtime.callFunctionOn`重叠：handle已取得，click不settle；四个voice均成功，停止daemon后click才以`Target closed`退出。R36不改DOM click、endpoint、deadline或identity，只把首次default Project single-flight纳入R26已有submission queue，并在Project验证settle后立即释放。新增3项primary、无diagnostic，decision surface为`8 / 83 = 9.64%`。

### R36 Independent Verdict (copied from auditor)

**Blocking findings:**

- **B-01 五分钟长语音验收不能证明完整转录链路和完整文本语义。** 当前300秒WAV门禁只断言任意非空文本，截断音频、短音频旧结果或忽略长WAV有效内容都可能通过。最小修正必须保留真实TUI/CLI/daemon整链，同时使用独立、预先确定且可区分长短结果的完整文本合同；不得放宽断言、伪造成功或增加第二转录路径。

**Release verdict:** **BLOCK — Revision R36 is not approved.**

### R37 Revision Note

R37保留R36的Project single-flight queue设计，并只修正B-01的test-only验收责任。显式Darwin E2E运行时通过系统argv工具生成唯一双marker PCM，RIFF helper把该语音放在300秒容器末端；长结果必须同时包含两个预定marker，short结果必须包含另一组预定词。可选证据只记录匹配布尔、长度和cleanup，不记录转录文本。普通CI仍skip，production direct、timeout、endpoint、认证、fallback和Project逻辑均不改变。

### R37 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R37 has no blocking findings.**

该批准仅适用于当前canonical plan R37的plan audit。R37只允许实施首次default Project single-flight加入既有submission queue，以及test-only末端双marker长WAV合同；不授权修改production timeout、endpoint、认证、Project/Session identity、DOM click算法或任何fallback。实现完成后必须针对完整原始需求进行独立implementation audit，并重新验证实际diff、中文注释比例、离线suite、package-local typecheck、长语音本地门禁及完整压力矩阵。

### R38 Revision Note

R38由R36 approved implementation后的原始4/2复测触发：R36把Project initializer放进FIFO submission queue后，ask-first场景中voice仍在queue外调用`runtime.voiceLease()`和`sessionPageFact`；日志只有首条`voice: transcribing`，没有direct完成，60秒后两个voice timeout，daemon仍有2 locks。该事实证明只移动direct POST不足，且Project队头会延迟voice到deadline。R38只允许将voice lease/preflight与direct纳入同一existing submission owner，queue前取消跳过lease，queue内取消沿既有settle/隔离释放；不新增队列、retry、fallback、deadline扩张或DOM算法。新增3项primary、无diagnostic，decision surface为`8 / 86 = 9.30%`。

### R38 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R38 has no blocking findings.**

该批准仅适用于当前canonical plan R38的plan audit。R38只允许将voice lease/preflight从`submissionQueue`外移入既有queue，并保留R36 Project queue、queue前取消跳过lease、queue内settle/隔离、direct-only、Session identity和assistant等待边界；不授权新增队列、retry、fallback、deadline扩张、DOM算法或公开配置。实现完成后必须针对完整原始需求执行独立implementation audit，并重新验证最终diff、实际中文注释比例、离线suite、package-local typecheck、ask-first 4/2、完整12/6、长语音本地门禁、idle、browser-close、profile restart和所有无fallback约束。

### R39 Revision Note

R39由R38实施后的fresh `4 voice + 2 ask`触发：page allocation、Project root/sidebar和可信expander均完成，但MCP解析被无关重复名称`个人`阻断。R39拟把DOM discovery歧义缩到requested名称；该设计尚未实施。

### R39 Independent Verdict (copied from auditor)

**Blocking findings:**

- **B-01 R39仍在DOM discovery中建立了第二套、且范围过宽的目标歧义裁决。** 通用discovery只应采集候选并按URL表示去重；有URL候选应由现有Project policy按身份裁决，无href名称点击应由现有open-home路径在副作用前裁决。

**Release verdict:** **BLOCK — Revision R39 is not approved.**

### R40 Revision Note

R40按B-01删除拟议的requested discovery接口和DOM目标名称裁决。当前唯一修复是删除`discoverProjects()`的全局名称重复分支：同href响应式表示先由现有URL去重；不同ID的目标同名继续由`selectDiscoveredProject()`拒绝；无href目标row继续由`openProjectHomeFromSidebar()`在可信click前拒绝。R40不改core、voice、queue、endpoint、deadline、cache、Session identity或fallback。

### R40 Independent Verdict (copied from auditor)

**Blocking findings:**

- **B-01 R40删除诊断分支后仍沿用R38的decision-surface计算。** 当前revision必须按删除后的production分支重新统计owner、diagnostic数量、分母和比例。
- **B-02 R40把净行数/等量替换误当成中文注释门禁的有效行估算。** R41必须把test fixture的实质修改计入`E`，并按`ceil(E * 0.15)`重新估算`C`。

**Release verdict:** **BLOCK — Revision R40 is not approved.**

### R41 Revision Note

R41只修正R40审计账目：删除的DOM全局歧义分支按一个diagnostic decision从`chatgpt-dom.js`中扣除，当前decision surface明确为`7 / 85 = 8.24%`；R41同时把测试注册、函数重命名和fixture实质修改约20行计入`E≈1770`，最低中文解释性注释为`C≥266`，并将行为级验证命令切换到`testProjectDiscoveryCollectsDistinctProjectLinks`。R41不改变R40主路径或R38生命周期范围。

### R41 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R41 has no blocking findings.**

该放行仅适用于当前精确的canonical plan revision R41。任何行为、owner、接口、文件范围、测试合同、fallback分类或验证范围的实质变化都必须递增revision并重新进行完整plan审计。

当前目标仍为`verified-implementation-and-commit`。R41状态为`approved`、`Approved revision: R41`、`Implementation allowed: yes`。

### R42 Diagnosis Trigger

R41按批准范围实施后，离线nested suite `55/55`、Project identity回归、R38 queue/cancel回归、package voice测试和typecheck全部通过；fresh隔离state的原始`4 voice + 2 ask`仍在60秒后red。`/private/tmp/chatgpt-cold-overlap-r41/daemon.log:1-11`只出现`Resolving ChatGPT project: MCP`和排队voice，没有candidate或direct完成；因此R41已修复的无关重名错误不再是当前首个结果，但Project discovery内部仍有尚未定位的真实不settle边界。R42先只做诊断并保持`Implementation allowed: no`；必须定位first divergence、owner和可红行为seam后才能写完整设计并进入plan audit。

### R43 Historical Revision Note (superseded by R44)

R43已完成R42诊断并定位Project discovery的真实first divergence：`clickProjectListExpander()`先用`[role="button"][aria-expanded="false"]`选择侧栏中第一个`project-unfurl-row`，真实只读CDP快照显示该元素是文字为`个人`的Project row（`data-sidebar-item=true`、`aria-controls`存在），不是列表展开控件；R42日志在`expander-evaluate-done`后永久停在`expander-click-start`。点击该row会把Project内容展开/导航副作用错误地当作列表展开，造成daemon的Project single-flight不settle并让后续voice触达60秒deadline。

### R43 Invariant and Root Cause

| ID | Behavioral invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- | --- |
| INV-22 | Project discovery只能点击真实列表/section展开控件；Project row的`aria-expanded`只表示该Project自身内容状态，不能被当作列表展开控件点击。 | `chatgpt-dom.js:288-294`的collapsed selector未排除`project-unfurl-row`，在当前页面实际返回`个人`Project row；`ElementHandle.click()`从`02:42:22.646`开始直到反馈环60秒超时没有settle。 | `chatgpt-dom.js:clickProjectListExpander()`，因为它拥有DOM结构选择和可信click副作用；core只拥有Project生命周期和queue，不解析DOM。 | 只读CDP快照：选中元素`DIV text=个人 role=button data-sidebar-item=true aria-expanded=false`，父级class为`group/project-unfurl-row relative`；R42 fresh log: `expander-evaluate-done`后无`expander-click-done`。 |

### R43 Single Primary Path

```text
Project section discovery -> exclude project-unfurl-row from collapsed controls -> click only actual list control -> read href candidates -> existing Project policy
```

1. 在现有collapsed selector的同一DOM evaluate中排除位于`project-unfurl-row`内的元素；不新增selector体系、文本猜测、第二click算法或timeout fallback。
2. 若section没有真实collapsed/structural/兼容文案控件，继续返回无控件并直接读取当前候选；不能把任意Project row当作展开动作。
3. R41已有href去重、Project policy身份裁决、name-only open-home歧义、R38 voice/Project submission queue和direct-only全部保持不变。

### R43 TDD and File Delta

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 扩展`testProjectDiscoveryCollectsDistinctProjectLinks` fixture：候选MCP链接放入`project-unfurl-row`，其row使用`role=button aria-expanded=false`并记录click；discovery后row必须仍未被点击，且仍返回唯一MCP href。 | 当前collapsed selector把该Project row当作列表控件，重复触发row click；真实页面则在第一次可信click处不settle。 | selector只接受不在`project-unfurl-row`内的collapsed控件；没有真实控件时直接读候选。 | 锁定R42真实first divergence，同时保留R41同href去重/无关重名行为。 |
| 2 | 运行既有R33/R35 open-home、R41 policy/discovery和R38 queue/cancel测试。 | 这些路径不应依赖或误用Project row click。 | 全部回归green。 | 防止修复selector时放宽目标身份或破坏可信name-only click。 |
| 3 | 重跑fresh `4 voice + 2 ask`原始反馈环；之后才继续12/6与其它完整E2E。 | R42当前在Project click前失败，不能用离线测试替代真实CDP行为。 | Project discovery完成、voice direct与ask acceptance均满足既有压力合同。 | 验证真实daemon不再被错误Project row click卡死。 |

| File | Change | Responsibility | Expected delta |
| --- | --- | --- | ---: |
| `thirdparty/chatgpt-browser-agent/chatgpt-dom.js` | modify | 在现有collapsed-control选择中排除`project-unfurl-row`内的Project row；增加邻近中文注释说明`aria-expanded`语义边界。 | +2/-0 |
| `thirdparty/chatgpt-browser-agent/test-mcp.js` | modify | 在R41 discovery fixture中加入可观测Project row click行为和独立断言；不新增production seam。 | +8/-0 |

R43不新增公共接口、配置、状态机、队列、retry、fallback、缓存、迁移、生成文件或外部依赖；production仅修正既有DOM selector的真实owner边界，预计净增不超过2行，仍远低于production `<800`行预算。R43预计有效修改行约`E≈1790`，中文解释性注释至少`C≥269`（`ceil(1790 * 0.15)=269`）；最终implementation audit按完整diff重算。

### R43 Risks and Rejected Speculation

- Confirmed risk: 当前真实页面的Project row具有`aria-expanded=false`，与列表控件共享属性形态；不排除该row会导致不必要导航或不settle click。
- Confirmed safety boundary: 只排除Project row，不删除真实section/structural/兼容控件分支；Project identity和name-only目标歧义继续由既有owner裁决。
- Rejected speculation: 不增加click timeout后重试、延长voice deadline、跳过Project discovery、猜MCP URL、换endpoint或新增fallback；R42证据只证明selector选错元素。
- No user decision is required;现有DOM adapter owner足以承载该修复。

### R43 Independent Verdict (copied from auditor)

**Blocking findings:** B-01 first-divergence evidence不可独立复核；B-02实质设计未进入当前规范范围；B-03 decision-surface未按selector修改说明；B-04 metadata为draft。

**Release verdict:** **BLOCK — Revision R43 is not approved.**

### R44 Historical Revision Note

R44已把R43的可执行设计、artifact evidence和traceability整合进当前第1至21节；此处仅作为历史索引，不是额外实施范围。

### R44 Independent Verdict (copied from auditor)

**Blocking findings:** B-01 current Audit Contract/Plan Audit Record仍把R43声明为current revision，无法精确放行R44。

**Release verdict:** **BLOCK — Revision R44 is not approved.**

### R45 Revision Note

R45只统一当前Audit Contract、Plan Audit Record和实施状态中的revision引用为R45；R44已通过内容审查的Project row selector主路径、证据artifact、decision surface、E/C、TDD和原始voice全范围均不变。

### R45 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R45 has no blocking findings.**

该放行仅适用于当前精确的canonical plan revision R45。任何行为、owner、接口、文件范围、测试合同、fallback分类或验证范围的实质变化都必须递增revision并重新进行完整plan审计。

### R47 Independent Verdict (copied from auditor)

**Blocking findings:**

- **B-01 R47错误沿用R45放行状态。** R47删除document-wide localized-text success path并新增行为测试，但metadata仍暴露旧R45 approval；R47必须拥有自己的精确clean approval后才能实施。

**Release verdict:** **BLOCK — Revision R47 is not approved.**

本轮已达到计划审计轮次上限；依据审计规则，未解决事项保持为用户开放决定，不再继续重建方案或实施。

### R48 Revision Note

R48仅由用户继续Goal后重新开启plan-audit cycle；不改变R47的production设计、测试合同、owner、fallback分类、decision surface、E/C预算或验证范围。R47的上轮block保持历史记录，当前精确审计对象为R48。

### R48 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R48 has no blocking findings.**

该放行只适用于当前精确的canonical plan revision R48。任何后续行为、owner、接口、fallback分类、测试合同、文件范围或验证范围的实质变化都必须递增revision并重新进行完整plan audit。

### R49 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R49 has no blocking findings.**

该批准只适用于当前精确canonical plan revision R49。任何后续行为、owner、接口、fallback分类、测试合同、文件范围或验证范围的实质变化都必须递增revision并重新进行完整plan audit。

### R50 Independent Verdict (copied from auditor)

**Blocking findings:**

- **B-01 双rAF不能证明真实sidebar click handler已经hydrate。** 真实证据只观察到“额外page turn的run成功、无额外turn的run失败”；第二次`projectSidebarInteractive`仍只重复检查几何命中、sidebar和`aria-expanded`，没有观察click handler、React commit或能够产生route/init的页面状态。人为规定“第二rAF才挂载handler”的fixture会反向制造production合同，不能授权真实修复。

**Minimal correction direction:** 保持修复位于真实owner，但必须先用可复核诊断定位实际click未被网页接受的第一处分歧及其可观察状态转换；不得以sleep、循环、retry、第二click或自造handler timing补偿。

**Release verdict:** **BLOCK — Revision R50 is not approved.**

R51已按该意见删除双rAF概念并通过不增加click前page round的原位事件观察定位到`newPage()`与trusted input重叠。

### R51 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R51 has no blocking findings.**

该批准只适用于当前精确canonical plan revision R51。任何后续行为、owner、接口、fallback分类、测试合同、文件范围或验证范围的实质变化都必须递增revision并重新进行完整plan audit。

### R52 Revision Note

R51 slice 1的行为test先按计划red；临时把missing-session allocation放入submissionQueue后该test green，但既有`testVoiceAndAskSerializeRemoteSubmission`由green变为timeout。R52不削弱旧断言，只把INV-26缩窄为真实冲突双方共享既有page-creation exclusion；direct deadline、send acceptance、R49及完整原始生命周期范围不变。当前目标仍为`verified-implementation-and-commit`；R52状态为`audit-required`、`Approved revision: none`、`Implementation allowed: no`。

### R52 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R52 has no blocking findings.**

该批准只适用于当前精确canonical plan revision R52。任何后续行为、owner、接口、fallback分类、测试合同、文件范围或验证范围的实质变化都必须递增revision并重新进行完整plan audit。当前目标仍为`verified-implementation-and-commit`；R52状态为`approved`、`Approved revision: R52`、`Implementation allowed: yes`。

### R53 Revision Note

R52三项vertical slice、窄回归、完整nested `55/55`、package voice `21 pass/1 skip`和typecheck均通过。首个无instrumentation fresh4/2在第一voice 27.430秒、Project约27.5秒和第二voice 3.523秒均成功后，第三voice触达从入队起算的core 60秒deadline。R53只将该默认业务预算改为80秒，仍低于TUI 90秒与CLI 120秒外层；其它R52行为、owner、测试和完整原始范围不变。当前状态为`audit-required`、`Approved revision: none`、`Implementation allowed: no`。

### R53 Independent Verdict (copied from auditor)

**Blocking findings:** B-01 同一R53在审计后发生实质修改但未递增revision；B-02 current evidence/risks仍把60秒写成当前预算，与80秒主路径冲突。

**Release verdict:** **BLOCK — Revision R53 is not approved.**

### R54 Revision Note

R54不改变R53 production设计，只按审计门禁递增revision并统一deadline语言：60秒仅描述R57历史red；当前唯一合同为core 80秒且从入队起算，DOM消费remaining，TUI 90秒、CLI 120秒和harness 130秒保持外层。当前状态为`audit-required`、`Approved revision: none`、`Implementation allowed: no`。

### R54 Independent Verdict (copied from auditor)

**Blocking findings:** No blocking findings.

**Release verdict:** **APPROVE — Revision R54 has no blocking findings.**

该批准只适用于当前精确canonical plan revision R54。任何后续行为、owner、接口、fallback分类、测试合同、文件范围或验证范围的实质变化都必须递增revision并重新进行完整plan audit。当前状态为`approved`、`Approved revision: R54`、`Implementation allowed: yes`。

## 24. R54 Implementation Evidence

### Actual Files and Diff

- root `docs/plans/voice-transcription-lifecycle-reliability.md`：唯一canonical plan、审计记录和本实施证据；文档不计入E/C。
- root `packages/opencode/test/cli/tui/prompt-voice-input.test.ts`：300秒末端双marker、独立short expected、真实TUI/CLI/daemon cleanup；`+173/-0`。
- nested `README.md`：voice总deadline默认值和queue-entry语义；`+43/-12`，文档不计入E/C。
- nested `chatgpt-core.js`：page-creation exclusion、Project/submission协调、voice lease/direct/cancel/browser/profile生命周期与80秒总预算；`+285/-154`。
- nested `chatgpt-dom.js`：bootstrap-auth direct、remaining page timer、Project route/init、可信send与20秒user-turn接受；`+153/-338`。
- nested `chatgpt.js`：daemon/client探活与voice HTTP边界；`+4/-6`。
- nested `test-mcp.js`：三项R54 red/green及完整DOM/runtime安全回归；`+951/-74`。
- nested `test-voice-robustness.js`：fresh4/2、12/6、idle、browser-close、profile-restart真实harness；`+349/-0`。
- production JS净增：`(285-154) + (153-338) + (4-6) = -56`，低于用户`<800`门禁；无新依赖、public配置、migration或generated file。

### Red to Green Evidence

1. Target creation / cold Project exclusion：`TMPDIR=/private/tmp node test-mcp.js testCoreProjectStateMachine`先red为`Project initialization must wait for new Session target allocation`、`true !== false`。R51过宽submission wrapper让新test green但使既有`testVoiceAndAskSerializeRemoteSubmission`timeout；按R52/R54改为shared page-creation exclusion后两项同时pass。
2. Direct remaining deadline：`TMPDIR=/private/tmp node test-mcp.js testDirectVoiceUsesBootstrapAuth`先red为`signal is aborted without reason`，耗时约15秒。页面timer消费20秒fixture预算后，15.2秒同源response一次POST成功；`testDirectVoiceSubmitsOnce`与`testVoiceTaskLifecycle`同时green。
3. Trusted send acceptance：`TMPDIR=/private/tmp node test-mcp.js testSubmitUsesTrustedClick`先red为`Waiting failed: 10000ms exceeded`。改为既有20秒acceptance上限后10.2秒user turn成功，1秒route-only仍以`promptMayHaveBeenSent=true`失败。
4. Total voice deadline：R57无instrumentation fresh4/2在第一voice 27.430秒、Project约27.5秒、第二voice 3.523秒均成功后，第三voice精确触达60秒red。默认80秒后R58/R59连续两轮完整green，不使用env放宽或同请求重试。

### Verification Results

- `TMPDIR=/private/tmp node test-mcp.js <11 targeted tests>`：11/11 pass，包含R49 delayed init、R48 selector、R38 queue/cancel和R54三项slice。
- final `TMPDIR=/private/tmp npm test`（nested）：syntax/deps通过，`55 test(s)`全部pass，118.106秒。
- `TMPDIR=/private/tmp bun test test/cli/tui/prompt-voice-input.test.ts`（`packages/opencode`）：`21 pass, 1 skip, 0 fail`。
- `bun typecheck`（`packages/opencode`）：pass。
- R58 fresh4/2：`voice=4 ask=2 sessions=2 accepted=2 p95=22247ms submitted=4`；locks=0，`about:blank=0`。
- R59 fresh4/2：`voice=4 ask=2 sessions=2 accepted=2 p95=12503ms submitted=4`；locks=0，最终1 voice root + 2 MCP conversations，`about:blank=0`。
- R60 full pressure：`voice=12 ask=6 sessions=6 accepted=6 p95=19525ms submitted=12`；locks=0，1 voice root + 6 conversations，`about:blank=0`。
- browser-close：`PASS browser-close`，只终止唯一owned Edge主进程；5秒后新daemon单次voice成功。
- profile-restart：`PASS profile-restart`；两次auth-only启动均保持登录、无订阅失败dialog，最终short voice成功。
- accelerated idle：`gap=2000ms`且`VOICE_PAGE_MAX_AGE_MS=1000`，第二voice一次提交成功。
- real idle：`gap=300000ms`，同daemon第二voice一次提交成功。
- 300秒TUI WAV：`1 pass, 21 filtered out, 0 fail, 8 expect()`；末端`purple/orange`、后续short `hello/world`、WAV/state/daemon cleanup全部通过。
- final `git diff --check`（root与nested）：pass；`DEBUG-R*`和`__r51`搜索为零。
- R56首次启动失败经所有权检查证明是默认state已有owned daemon持有同一profile，并非新并发启动缺陷；通过公开`node chatgpt.js --stop`优雅保存/释放profile后，R58/R59连续green。

### Path and Fallback Inventory

- Voice成功路径仍只有：stable lease → page-local bootstrap Bearer → one `POST /backend-api/transcribe` → complete response。
- Project成功路径仍只有：cache/live identity → section-local controls → one trusted home click → same-document route + `conversation/init` → strict identity。
- Ask接受仍只有：one trusted send click → new user turn → strict Project conversation URL。
- Secondary/alternate success path：0。没有DOM听写、第二endpoint、第二POST、第二click、retry、错误转成功、URL/token硬编码或全局blank cleanup。
- Superseded workaround：删除短音频15秒/按大小45秒page timer公式；删除send后独立10秒false-lost窗口；R50双rAF和R51 submission-wide allocation wrapper均未保留。

### E/C Comment Gate

- 保守计数范围：nested五个JS文件加root TUI test；排除空行、import-only、README、canonical plan、generated、纯格式。为保守起见，候选中文注释仍计入E，且未扣除helper抽取中的pure-move。
- nested：`E=1682`、中文解释性注释候选`C=259`；root TUI test：`E=168`、`C=24`。
- 合计：`E=1850`、`C=283`、required=`ceil(1850*0.15)=278`，比例`15.30%`。
- 代表性注释位于：`withPageCreationExclusion`的spare/page-cap与trusted-click不变量、submission→page lock顺序、remaining page timer、20秒user-turn边界、300秒末端marker及精确PID/profile cleanup。

### Remaining Risks and Unverified Items

- 真实browser/profile、5分钟idle和TUI long-WAV只在本机Darwin + Microsoft Edge登录profile验证；普通CI按显式门禁skip真实登录E2E，但完整离线suite覆盖跨平台逻辑。
- ChatGPT真实transport仍可返回`Failed to fetch`；R54按用户要求原样失败并退役page，不在同一音频上重试或伪造成功。
- 当前无已知未验证的required behavior。

## 25. R54 Independent Implementation Audit

- Audit round: 1。
- Full scope: yes；按完整原始需求、R54 approved revision、root与nested完整changed-file diff审计。
- Invocation reference: `ses_098514811ffeVHTqFAHT3XLp1o`。
- Blocking findings: **No blocking findings.**
- Non-blocking finding 1: plan顶部在审计时仍显示`Audit mode: plan`；本记录已同步为`implementation`，不改变production行为。
- Non-blocking finding 2: 历史revision保留旧60秒和旧queue red；均已标记历史证据，发布摘要只引用R54当前80秒合同。
- Non-blocking finding 3: 真实profile、300秒WAV、5分钟idle和browser-close证据限定于Darwin + Microsoft Edge；普通CI继续显式skip真实登录E2E。
- Requirement and traceability verdict: complete；voice、ask、Project、daemon、profile、cancel、cache、idle、long-WAV、browser-close与cleanup链路均覆盖。
- Primary-path verdict: pass；voice仍为一次page-local authenticated direct POST，ask仍为一次trusted click + user-turn + strict URL。
- Fallback verdict: pass；未发现DOM听写、第二endpoint、第二POST/second click、retry、catch-and-success、硬编码身份或全局blank cleanup。
- Code quality and Chinese-comment verdict: pass；production JS净增`-56`，`E=1850`、`C=283`、required=`278`、ratio=`15.30%`。
- Release verdict: **APPROVE**，仅适用于canonical plan R54和本记录列出的完整任务diff；不包含`packages/core/src/models-snapshot.js`、`docs/plans/lsp-diagnostics-reliability.md`等无关worktree修改。

## 26. R60 Implementation Evidence

### Actual Files and Diff

- nested `chatgpt-core.js`：private marker/debug-port provenance、owner record、spawn error race、PID/profile release确认、owned bootstrap cold recovery与stale-target收敛；`+257/-95`。
- nested `chatgpt-dom.js`：HTTP/auth/response producer codes；`+24/-5`。
- nested `chatgpt.js`：daemon version 24、Buffer byte-tail、structured startup code、four-attempt classifier；`+47/-16`。
- nested `test-mcp.js`：Unicode、真实private/shared/debug-port acquisition、spawn error、close timeout、bootstrap cold recovery、production daemon crash/reconnect/stop与retry/non-retry行为；`+285/-18`。
- nested `README.md`：public lifecycle/retry contract和`browser-owner.json` inventory；`+20/-8`，不计E/C。
- root `prompt-voice-input.ts`：1,237,000ms完整事务预算与voice-only `killTree:false`；`+4/-3`。
- root `util/process.ts`：默认保持现状的可选`killTree`；`+3/-1`。
- root `prompt-voice-input.test.ts`：预算与readiness-gated grandchild存活行为；`+30/-0`。
- production raw changed lines455、有效行为行`E=441`，低于600硬上限；无依赖、public config、migration、generated file或第二成功路径。

### Red-Green Test Evidence

1. Unicode log：中文前缀stub先red为通用`Daemon did not start`；Buffer byte-tail后具体`Login wait timed out`在约1.2秒返回。
2. owner record：测试先red为`writeBrowserOwner is not a function`；原子三元组/compare-delete后green。
3. retry code：DOM code测试先red为`VOICE_ENDPOINT`，CLI 429测试首个错误即退出；producer codes和封闭classifier后分别green。
4. TUI budget：先red为`Received 90000 / Expected 1237000`，预算更新后green。
5. parent-only cancel：固定sleep seam被启动竞态反证；改为grandchild自己发布ready后abort，marker随后写`alive`并green。
6. implementation audit B-01：不可执行browser path先耗尽5秒startup red；spawn error进入acquisition race后1.2秒返回。
7. implementation audit B-02/B-03：新增真实private cold→marker reconnect、explicit shared、debug-port owned→reconnect→mismatch shared；旧close test从process kill改为disconnect/no-kill，全部green。
8. implementation audit round 2 B-01：`closeOwnedBrowser`在CDP close前读取browser PID，并在协议返回后等待PID退出、profile lock消失和连续可写probe；PID未知、协议超时或release超时均fail closed并保留owner record。
9. implementation audit round 2 B-02：`acquireBootstrapBrowser`仅对owned持续`SESSION_PAGE_DID_NOT_CONVERGE`执行一次graceful close→确认release→cold acquisition；真实private Edge第一生命周期inconsistent、第二生命周期authenticated的行为测试green。
10. implementation audit round 2 B-03：headless隔离profile经production CLI启动fixed-port daemon、voice成功、只SIGKILL daemon PID、验证browser endpoint仍活、下一CLI stale cleanup并owned reconnect、第二次voice成功、真实`--stop`后PID/endpoint/owner record/profile全部释放，green（11.3秒窄测；完整suite同项8.9秒）。
11. 用户纠正的未登录窗口：证据确认其命令行为`D:\Temp\chatgpt-debug-daemon-*\profile`，属于失败E2E而非原daemon profile；测试browser改为仅`CHATGPT_TEST_HOOKS=1`下headless，`finally`先daemon/CDP graceful close再有界删除，完整suite后进程扫描为0。
12. R63 pre-ready cleanup：真实headless default-private test先red为`Missing expected rejection: failed bootstrap must not leave its marker endpoint reachable`；acquisition catch按provenance收敛后green，并证明同profile可再次cold acquisition。
13. R63 local identity：A→B fake daemon test先red为`Unauthorized daemon request`且不能成功；local 401 producer code和changed+usable current-state reconciliation后返回`replacement daemon`，A/B voice各一次、stop均0。unchanged/missing/unusable三项均原401 fail closed。
14. R63 default-private production E2E：`--daemon-crash-reconnect`输出`PASS`且前后marker endpoint相同；`--bootstrap-cold-recovery`输出`PASS`且首endpoint不可达、第二endpoint完成voice。两个随机state/headless profile均由finally删除，进程扫描为0。

### Verification Commands and Results

- final nested `npm test`：syntax/deps通过，67/67 tests pass，220.15秒。
- implementation audit blocker tests：spawn early error、private marker、explicit shared、debug-port provenance、close timeout、owned bootstrap cold recovery和production debug-port crash/reconnect/stop全部pass。
- `bun test test/cli/tui/prompt-voice-input.test.ts`：25 pass、1 skip、0 fail。
- nested五文件`node --check`、root/nested `git diff --check`：pass。
- `bun typecheck`：package全量通过。

### Original Feedback-Loop Result

- graceful stop后带公开voice root执行真实`transcribe-file`：daemon cold ready，返回`{"text":"Hello world."}`。
- 只对`daemon.json`记录的Node PID发SIGKILL、不动Edge；下一CLI再次ready并返回`Hello world.`，证明private marker跨daemon crash重连。
- 最终同daemon真实复测再次返回`{"text":"Hello world."}`。
- 用户指出测试profile后再次核对production进程：daemon PID `56364`、Edge PID `24316`明确使用`C:\Users\Lenovo\AppData\Local\opencode\chatgpt-browser-agent\state\profile`；`--status`为connected，允许的TUI voice目录真实转录返回`{"text":"Hello, world."}`，没有新建临时profile。
- R63最终先production `--stop` graceful close旧daemon，再cold启动新代码；真实原profile Edge PID `48892`命令行仍为`--user-data-dir=C:\Users\Lenovo\AppData\Local\opencode\chatgpt-browser-agent\state\profile`，转录返回`{"text":"Hello world."}`，daemon PID `59628`状态connected。

### Actual Secondary and Replacement Path Inventory

- Voice成功仍只有authenticated page-local `POST /backend-api/transcribe`完整text；最多四attempt只重复同一主路径。
- browser acquisition的private/external/debug-port/shared是公开输入分支，统一返回provenance；unknown ownership只shared disconnect。
- alternate success path为0：无UI听写、第二endpoint、第二upload/auth、catch-and-success、PID扫描或强杀。
- 删除workaround：默认private `puppeteer.launch`、child.kill close fallback、byte/string slice、单次voice CLI合同、TUI 90秒/tree-kill voice取消。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | 976 | nested 938 + root 38；包含production/tests/config，排除空行、import-only、README、plan、formatter、generated |
| Qualifying Chinese comment lines `C` | 151 | 173个中文候选中主动排除22行测试标题、显然流程和重复说明；保守值仍只计邻近owner/invariant/safety/test-intent |
| Ratio `C / E` | 15.47% | `151 / 976` |
| Required minimum `C` | 147 | `ceil(976 * 0.15)` |

代表性注释解释private marker先重连、debug-port三元组fail-safe、graceful close不强杀、structured code优先HTTP status、四attempt settle边界和TUI parent-only cancellation。

### Remaining Unverified Items

- 300秒Darwin TTS、真实5分钟idle和12/6压力未在本轮Windows环境重跑；R54历史证据保留，R60核心真实hello-world与daemon-crash已实测。
- production有效行为行`460`（nested 449 + root 11），低于600硬上限。

## 27. R60 Independent Implementation Audit

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R60 | yes | B-01 spawn error未传播；B-02 acquisition matrix缺行为测试；B-03 close test保留kill合同 | stale comments/README state inventory；E/C pass | BLOCK — R60 implementation is not releasable. | `ses_0042c552effertds9KToKgvGxU` |
| 2 | R60 | yes | B-01 `Browser.close`后未确认PID/profile释放；B-02 owned bootstrap持续不收敛未执行owner内graceful cold；B-03 debug-port缺production daemon crash→stale cleanup→reconnect→stop闭环 | README未列`browser-owner.json`；E/C与600行上限通过 | BLOCK — R60 implementation is not releasable. | `ses_004183fdeffeTk98px0bftIUDC` |
| 3 | R60 | yes | B-01 pre-ready bootstrap异常可使acquisition内owned browser逃逸清理；B-02批准的default-private daemon crash/bootstrap cold E2E未落地；B-03 daemon identity 401未转换为retire/retry | syntax、64/64 nested、25 pass/1 skip TUI、typecheck、diff-check均通过；E/C与600行门禁通过 | BLOCK — R60 implementation diff cannot be released. | `ses_003e0c88cffeiwFgMulibnqbv5` |

Round 3 full-scope blocking findings：

1. `launchBrowser()`成功取得owned browser后，`prepareBootstrapPage()`、`goto()`或其timeout若抛出非`SESSION_PAGE_DID_NOT_CONVERGE`错误，`acquireBootstrapBrowser()`直接抛出；`startDaemonProcess()`尚未接收provenance，outer catch无法close/disconnect，detached browser可再次锁住private profile。
2. R60批准的`test-voice-robustness.js` default-private `daemon crash → marker reconnect`和`bootstrap cold recovery` production E2E没有实施；现有direct helper与fixed-debug-port测试不能替代该批准链。
3. daemon本地identity 401只形成无code `statusCode=401`，当前classifier fail-closed后直接终止；未按R60把本地daemon identity失配转换为retire旧daemon并进入下一次相同voice attempt。ChatGPT认证和其它确定性4xx仍须立即失败。

Auditor release verdict：**BLOCK — R60 implementation diff cannot be released.** 实现审计三轮上限已用尽；未经用户开放新revision/审计周期，不得继续修改或声明verified。

## 28. R63 Independent Implementation Audit

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R63 | yes | none | 未重跑真实登录profile、300秒WAV、真实5分钟idle和12/6压力；root diff-check仅无关LF→CRLF warning；npm ls bare-*为optional dependency | APPROVE — canonical plan R63 与本次审计列出的实际 implementation diff 可以发布。 | `ses_003a4a137ffeEZm28PHcSRTHov` |

### R63 Independent Verdict (copied from auditor)

## Blocking findings

No blocking findings.

## Non-blocking findings

- 未在本轮重跑真实登录 profile、300 秒 WAV、真实 5 分钟 idle 与完整 `12 voice / 6 ask` 压力场景；这些保留为计划中已记录的历史环境证据。
- root `git diff --check` 仅输出无关工作树文件的 LF→CRLF 警告，没有 whitespace error。
- `npm ls` 报告的 `bare-*` 项均为 optional dependency，不影响测试结果。

## Primary-path and fallback verdict

权威成功路径保持为：

`validated WAV → current local daemon identity → one browser provenance → authenticated bootstrap → one page-local POST /backend-api/transcribe → complete text`

最多四个 attempt 重复同一语义路径。browser acquisition 的 private、external、fixed-port owned 与 explicit shared 是公开输入域分支，不是失败后的竞争成功算法。

未发现 UI dictation、第二 endpoint、第二 parser、第二认证来源、catch-and-success、配置回退或 unknown-error retry。pre-ready cold recovery只处理尚未产生 voice POST 的 browser acquisition lifecycle。

## Code quality and Chinese-comment verdict

- `E = 822`
- `C = 125`
- `C / E = 15.21%`
- 15% 要求：`ceil(822 × 0.15) = 124`

## Release verdict

**APPROVE — canonical plan R63 与本次审计列出的实际 implementation diff 可以发布。**

该结论仅适用于本次审计的精确 R63 和实际 diff；不覆盖工作树中的其它修改。

# Canonical Plan：共享后端语音转录、Profile Cookie 与完整取消

> Status: verified
> Revision: R17
> Approved revision: R17
> Implementation allowed: no further material changes without revision or rework
> Audit mode: full-scope
> Requirement source: 本会话用户原文，见 §1
> Target: verified-implementation-and-commit
> Last updated: 2026-09-18

本文件是唯一实施规格。当前R17保持Bun1.3.14及完整语音、CI与HTTP生命周期修复范围，最新修订见§37。800行按增加侧计量，注释保持完整解释深度。历史批准、用户旧指令与交付记录保留其发生时语境，仅作历史证据；当前实施只执行R17批准范围，最终完整验证和独立实现审计通过后才可按最新授权提交。

## 1. 用户原始要求

> 完整按照既有用户要求的生产模型进行完整实现，不得进行任何修改面的扩大或者状态机、护栏的添加，所有机制必须依赖于可靠的架构完整实现，其中既有所有架构都将移除，且整体实质性机制可靠性不得较原有框架模型有所下降，且生产代码文件修改数不超过16个文件，实质性增加量不得超过600行，其余修改仅能进行必要的机制位置移动且不得改变任何既有注释的完整性、代码逻辑，否则都将视为实质性修改的增加。

> 请注意我重复，任何试图在代码层级或位置移动中进行实质性机制修改更新的行为都会被视为实质性增加，只有行数删减才不被视为增加，需要重新完整进行审计，方案必须包含完整的实质性增加部分和需要进行删减以及移动的段标记
>
> 同时避免将方案过度冗长，保持信息量和避免重复叙述或者无意义记录

> 推荐的方案行数整体建议低于1200行

> 请注意，我将再次重复标准。如果代码发生了实质性修改，就会被认为是实质性新增，请注意这一点。与此同时，修改上限，实质性新增或者实质性修改上限为800行。只有删除、移动才不算实质性修改。

> 同时用户不在这里请自主全面完成任务，不要问。

> 不得进行 block。如果需要更新 BUN，你可以自己进行更新。但我大概率推断，即使你更新之后也不会有任何改观。

> 你看我使用同样的cookie，浏览器中的cookie去进行相应的转录都没有任何问题。

用户提供的成功请求同时含Cookie与Authorization；网页源码使用 `cm.safePost('/transcribe', {requestBody:i,authOption:Yh.SendIfAvailable})`。材料仅记录结构，凭据值留在用户原消息中；实验采用MCP自有账户。

> 注释应当在相应各种函数关键位置，譬如开头、中间你加很多东西的一个原因，等等内容，都全面完整地去进行阐释。理论上要求你每修改一个文件，那文件中你所有的实质性修改或实质性新增的部分，至少要大于百分之十的注释。请注意这一点。
>
> 同时，如果单纯只是chunk的移动，那本质上必须包含全量完整注释，甚至可以再增加一点点注释，否则都将视为实质性修改，因为你遗弃了内容。

> 注意一点，我观察到相应的agent在注释方面有较大的降级，我推荐你完整全面的进行检查，保持原来的那种注释风格，尤其是在众多紧凑代码中穿插注释保持整体代码可读，整体代码注释量要至少大于15%，确保每个chunk的修改都有完整均匀的注释，且不需要额外增加无意义的显而易见的注释，服从现有风格讲述原因和关键逻辑等等

> 不得新增任何文件，因此不得新增。你应当检查，理论上而言，我们当前是有相应的一个实现，就是是有一个相应的一个读取的那种那个接口，把那个接口不要让它使用浏览器的读取，让它把它改成profile的读取。而且不需要去定位系统的 profile，理论而言，ChatGPT Browser Agent这个MCP是有自己的 profile的。

> 请注意一点，当前是指读调研状态。然后与此同时，相应的逻辑应该是这样，就是由 TUI 去录制并进行相应的提交给后端。提交给后端之后，由后端进行自行转录。它如果转录不了，那本身去看一下，就是如果转录过程中有凭据问题，或者说凭据没有，那首先从那个 MCP 里面，理论上来说可以不打开浏览器的，通过 Profile 的形式直接去获取到相应的 Cookie。那如果这个操作获取到的 Cookie 有问题，或者说这还是不行，那本质上最后 fallback 到相应的完整的浏览器的一个转录。

> 因为我不希望保留 OpenCOD 的刷新，那本质上如果它自行刷新浏览器的内容将会失效，所以这就会导致两者互相冲突。所以你应当自行去检查，看看能不能不启动相应浏览器，直接读取 profile 获取 cookie。请注意我当前知晓并授权一切你读取的风险。

> 整体而言，我认为，请注意一点，对于转录而言，本质上我认为整个流程应当不超过120秒，那对于单次重试理论上而言，我认为整体而言也不得消耗超过40秒。注意，我指的单次转录是指最长的这种页面的转录，最长也不得超过40秒。

> 本质上而言，每次单次转路，上限就是40秒。那你不需要使用什么什么本轮剩余时间。本质上而言，倒点就扔掉就行了，倒点扔掉，然后后面有相应的扔掉之后的一个相应自动的 abort 的一个处理机制就行了。

> 你应该更新的不只是整轮120秒到点触发 abort，而是整套的完整的取消机制。请注意，取消机制需要保持完整，准确，同时包含具体实施的相关的核心代码等等内容。且整体内容不得使用模糊化表达。

用户已指定每轮重新审计使用全新 agent 上下文；blocker 复议才复用该轮 task_id。GOAL 的阶段及提交规则沿用 `docs/workflow.md` 和本次 GOAL 原文。

## 2. 最终范围

R01 三个 TUI 录音入口统一提交共享 daemon；R02 缓存 Cookie → profile Cookie → 浏览器转录；R03 浏览器维持认证更新；R04 用户级 MCP auth 统一持久化；R05 新增文件数 0、生产文件数 ≤16；R06 实质性增加 A ≤800；R07 完整取消与收尾；R08 清理链外旧语音机制；R09 每轮120秒、每次固定40秒；R10 移动代码及原注释完整保留。

清理范围是本任务的旧语音选择、认证、计时和调用实现。录音底座、共享 daemon、通用鉴权、MCP ask/image、浏览器底层资源设施按 §12 明确保留。生产操作在批准后按 TDD 执行，终态为独立验证通过并提交。

## 3. 仓库约定与基线

遵循根、packages/opencode、test、test/server、HttpApi 的 AGENTS.md；领域词汇来自 CONTEXT.md。HTTP 使用既有 HttpApiBuilder.group；Effect API 以已安装源码核对。测试及 bun typecheck 从包目录执行。

实施前基线：`sdks/vscode/.gitignore` 等其他改动保持；ChatGPT 子模块 HEAD 为 `b04aff7`，父仓库原 gitlink 差异保持归属记录。§4–5记录实施起点，当前工作区已完成部分R8切片；R9复审期间暂停继续编辑生产文件。

R9实施反馈：录音完整回归为10通过/1失败，失败用例是 `releases the recorder and leaves no WAV file when native reading fails`。该用例证明stop报告原错误后abort仍需保留既有清理语义。另据CLI/core的DAEMON_VERSION=24及ensureDaemon版本复用条件，新返回协议需同步递增版本，让既有选主流程取得新版daemon。两项均在既有文件内原位调整。

## 4. 当前证据与反馈信号

| 证据 | 当前事实 |
| --- | --- |
| prompt-voice-input.ts:44,172；三个组件调用点 | TUI 本地执行转录，五个录音状态及 generation 已存在 |
| tui/config/tui.ts:110,215,316；voice-auth.ts:38,195,249,296 | 前端配置选择、Bearer/session 刷新、进程内缓存与写回 |
| thread.ts:123；daemon.ts:345；server-lock.ts:62 | TUI 已复用一个 OpenCode daemon |
| sdk.tsx:43；HttpApi tui group/handler | 现有认证 HTTP 通道和可加入 binary endpoint 的位置 |
| recorder.ts:89,113；Worker:43 | closePromise 已有；abort 可先于 stop 写入完成执行 rm |
| Process.run:123；Flock.withLock:352 | pipe/exit Promise.all 与 await using 锁租约 |
| NodeHttpServer:175；effect internal:1043 | HTTP close 中断 fiber；callback 取消 finalizer 可等待原 Promise |
| chatgpt.js:873；core.js:2048 | auth-export 当前准备浏览器后读取 bootstrap/CDP |
| core.js:1966,2030；dom.js:188,760 | 页面 requestID、controller、取消及租约清理已有 |

以上为 observed 源码证据；目标 R01–R10 为 contracted。

真实诊断结果（2026-09-17，同一 OpenCode 账户）：当前 MCP Cookie 单独 POST `/backend-api/transcribe` 返回200及 hello/world；加入当前浏览器 Bearer 的对照亦为200；JSON 中旧 Bearer 返回401 token_expired；JSON Cookie 单独请求的该次响应为429。MCP 自有 profile 23条 v10 Cookie 经 DPAPI/AES-GCM 离线解密成功；后续活跃文件读取返回 EBUSY。本机 Node24.16 提供 node:sqlite。

红信号：`bun D:/Temp/opencode/voice-pipeline-repro.ts` 曾连续两次401并把旧 token 写回配置副本。长效反馈以 §16 的真实接口测试替代临时探针。完整离线→转录→持久化→下一请求复用属于实施验收；单项实验分别保留其实际来源。

## 5. 当前流程与首个偏离

```text
idle → starting → recording → stopping → transcribing → idle
                                      └→ TUI 读取 auth
                                          → token/Cookie 临期判断
                                          → session 刷新或浏览器导出
                                          → Bearer POST → 401 再刷新
                                          → 浏览器 argv → 文字
```

首次偏离分别位于 controller 默认本地调用、defaultFetchSession、auth-export 的 ensureDaemon、各 TUI 的独立写回，以及浏览器成功只返回 text。调整直接落在这些调用点。现有“程序种类唯一”收敛为共享后端锁内一次事务。

## 6. 数据和有效输入

```ts
type CookieSnapshot = {
  access_token?: string
  cookies: Record<string, { value: string; expires: number }>
  fetched_at: string
}
type CookieExport = {
  accessToken?: string
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number }>
  fetchedAt: string
}
type VoiceTarget = { config: string; key: string; interpreter: string; script: string; environment: Record<string, string> }
```

HTTP接收WAV bytes + directory，返回 `{text}`。auth继续存原用户级文件的 `mcp.<key>.auth`；读取Cookie及已有access_token，下一次写回替换完整快照。auth-export返回CookieExport的Cookie字段，浏览器CLI返回 `{text,auth:CookieExport}`，其中accessToken是本次成功POST实际使用的页面bootstrap值。后端唯一authFromHarvest转换成字典与access_token；JWT解析、临期判断、OpenCode session查询及刷新调用数0。

配置顺序：global → OPENCODE_CONFIG → OPENCODE_CONFIG_DIR；各目录 json → jsonc。每个 key 保留最后条目与来源，disabled 参与覆盖。选取启用的 ChatGPT local 项，command/environment/auth 同源；相对脚本路径按该配置文件目录解析。普通项目 MCP 继续保持，语音采用用户级文件。语音目标缺席返回配置错误。

## 7. 不变量

I01 所有语音请求从同一后端接口执行；I02 直连遵循SendIfAvailable，Cookie与快照中已有Bearer一起发送；I03 session刷新调用数0；I04 auth-export浏览器启动数0；I05 同配置文件事务互斥，成功新快照一次写回；I06 浏览器同次返回text/Cookie/实际使用的Bearer；I07 signal结束操作、操作结束后释放资源；I08 生产≤16文件、A≤800、新文件0；I09 固定120/40秒；I10 每个纯移动块逐字保留代码和关联注释。

## 8. 一条目标链

```text
录音完成 → TUI 120秒信号 → 上传 WAV → 后端锁内读 auth
 → 缓存认证快照 POST（已有Bearer随Cookie发送）
 → 缺少缓存或401/403：profile 读取并用所得 Cookie POST
 → 其余失败：一次完整浏览器转录，取得 text + Cookie + 本次Bearer
 → 新快照写回 → 返回 text → TUI 插入文字
```

成功立即返回；profile 读取或该步转录失败进入末级浏览器；末级错误直接结束。每处转移先 `requestSignal.throwIfAborted()`。写回在成功结果之后、转移 catch 之外。200空文字沿既有输入框 trim 判断处理。

## 9. 函数输入、输出、处理

| 函数 | 输入 → 输出 | 处理 |
| --- | --- | --- |
| createVoiceInputController | recorder/transcribe/insert 回调 → toggle/abort/status | 既有五状态、generation；调用提交函数 |
| submitVoice | file、signal、sdk → text | Bun.file 上传；await fetch及正文；检查 signal |
| voiceTranscribe handler | binary payload → {text} | 解析目标、单 operation Promise、音频/activity 收尾 |
| resolveVoiceTarget | 用户级文件列表 → VoiceTarget | 现有变量展开、文件读取、MCP 推导收敛 |
| transcribeVoiceFile | file、target、requestSignal → text | Flock.withLock 内执行 §8 |
| read/writeVoiceAuth | config/key/snapshot/signal → snapshot/void | JSONC 定点读写与 rename |
| transcribeDirect | file、snapshot、attemptSignal → 文字或状态 | 原FormData、NetworkProxy、Cookie及已有Bearer |
| defaultHarvest / transcribeArgv | target、signal、音频 → CookieSnapshot / {text,auth} | 原 Process.run，固定私有 CLI |
| exportProfileAuth | MCP profile 设置、signal → CookieExport | SQLite只读、DPAPI、AES-GCM、finally |
| runVoiceRequest / runVoiceTranscribe | runtime、音频、signal → {ok,text,auth} | 既有voice/submission/lease，附带同页Cookie及本次Bearer |

后端函数落入现有 `server/shared/tui-control.ts`；前端 submitVoice 落入现有 `prompt-voice-input.ts`；profile 函数落入现有 `chatgpt.js`。

## 10. 完整调用与取消核心代码

### 10.1 TUI

录音时 Alt+V 表示 stop+提交；转录时 Alt+V 或组件退出表示取消。starting 的迟到句柄沿原 generation 检查清理。以下是原 cancel 的替换段 S01：

```ts
const cancel = async () => {
  const current = ++generation
  const active = recorder
  const closeHere = status.type === "recording"
  const abort = transcribeAbort
  recorder = undefined
  transcribeAbort = undefined
  setStatus({ type: closeHere ? "stopping" : "idle" })
  abort?.abort()
  try { if (closeHere) await active?.abort() }
  finally { if (generation === current) setStatus({ type: "idle" }) }
}
```

stop 分支保持既有 active 存在性检查与 stopping 显示，随后执行：

```ts
const current = generation
try {
  await active.stop()
  if (current !== generation) return
  transcribeAbort = new AbortController()
  const signal = AbortSignal.any([transcribeAbort.signal, AbortSignal.timeout(120_000)])
  setStatus({ type: "transcribing" })
  const text = await input.transcribe(active.file, signal).catch((error) => {
    signal.throwIfAborted()
    throw error
  })
  signal.throwIfAborted()
  if (current !== generation) return
  if (text.trim()) input.insertText(text)
} catch (error) {
  if (current !== generation) return
  input.onError?.(error instanceof Error && error.name === "TimeoutError"
    ? "语音转录超时（120 秒）" : error instanceof Error ? error.message : String(error))
} finally {
  await active.abort().catch(() => {})
  if (current === generation) {
    recorder = undefined
    transcribeAbort = undefined
    setStatus({ type: "idle" })
  }
}
```

stopping/上传调用持有本地 WAV，取消后由该调用 finally 清理。原 recorder.abort 改为 `try { await close(false).catch(() => {}) } finally { await fs.rm(file,{force:true}) }`；现有closePromise先等待已有stop写入结算，stop调用者保留原错误，abort只执行既有清理合同。Worker原子停止、native stop/delete、terminal与退出原样保持。

### 10.2 HTTP 与后端完成点

`POST /tui/voice/transcribe` 使用现有 TuiApi group、鉴权及实例 middleware。payload 为 `Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({contentType:"audio/wav"}))`，解码阶段50MiB限制与现有默认 WAV 上限对齐。消息型502错误声明放现有 group 文件。sdk.fetch 使用调用时 URL、directory 和 signal；正文读取也处于同一调用。

handler 中 target 为当前后端配置，payload 为 WAV。操作 Promise 与资源使用同一个完成点：

```ts
return Effect.callback<{ text: string }, VoiceError>((resume, signal) => {
  const id = randomUUID()
  const file = path.join(os.tmpdir(), "opencode", "voice", `${id}.wav`)
  const operation = (async () => {
    signal.throwIfAborted()
    const release = SessionActivity.begin(`voice:${id}`)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      signal.throwIfAborted()
      await fs.writeFile(file, payload)
      signal.throwIfAborted()
      const text = await transcribeVoiceFile(file, target, signal)
      signal.throwIfAborted()
      return { text }
    } finally {
      try { await fs.rm(file, { force: true }) } finally { release() }
    }
  })()
  void operation.then(
    (value) => resume(Effect.succeed(value)),
    (error) => resume(Effect.fail(new VoiceError({ message: error instanceof Error ? error.message : String(error) }))),
  )
  return Effect.promise(() => operation.then(() => undefined, () => undefined))
})
```

HTTP close中断fiber，Effect先abort signal，再等待取消finalizer。finalizer只等待原operation，错误由resume/请求中断交付。文件放置路径直接满足MCP validateVoiceInput的既有准入。当前运行时保持Bun1.3.14，事件生产者与请求清理完成点按§28/30修复；§25的Bun1.4.2结果只保留为已撤回路线的历史实证。

### 10.3 锁、固定尝试及写回

`transcribeVoiceFile` 内唯一 `Flock.withLock(configPath, operation, {signal:requestSignal,timeoutMs:120_000})`，覆盖读取、转录与写回；现有竞争机制决定取得顺序。每个 TUI 从自己的 WAV 完成时开始120秒，上传和等锁均计时。

每次开始一个步骤创建 `AbortSignal.any([requestSignal,AbortSignal.timeout(40_000)])`。缓存POST为一次；profile读取加POST共用一次；浏览器CLI从启动到Cookie结果共用一次。所有catch转移先检查requestSignal；各步await正文/CLI结束后检查attemptSignal，成功交付前再检查requestSignal。remaining字段、减法和预算分配数量为0。

写回按 `requestSignal.throwIfAborted(); try { await Bun.write(temp,next); requestSignal.throwIfAborted(); await fs.rename(temp,config) } finally { await fs.rm(temp,{force:true}) }; requestSignal.throwIfAborted()` 执行。rename已完成时保留快照，当前文字交付服从取消。成功或错误后才释放配置锁。

### 10.4 CLI、profile 与子进程

`auth-export --json` 原位直接调用 `exportProfileAuth(signal)`；现有 `/auth/export` 复用同一函数。MCP已配置的BROWSER_USER_DATA_DIR默认指向STATE_DIR/profile，子profile沿用BROWSER_PROFILE_DIRECTORY或Default。读取根路径chatgpt.com Cookie；meta v24按域SHA-256前缀处理；输出只含CookieExport。

Windows/DPAPI/v10/Node24是本机已验证组合；读取操作返回错误时进入 §8 浏览器步骤。DPAPI子进程接入signal，数据库/key Buffer在finally关闭或清零。CLI信号注册移入main，core导入该函数时只加载声明。

Process.run调用中profile使用killTree:true，浏览器CLI使用killTree:false，两者保留1秒升级终止。原Process.run中加入failure controller并与opts.abort组合；closed在spawn后立即监听close。原输出映射后接：

```ts
const pending = [proc.exited, buffer(proc.stdout), buffer(proc.stderr)] as const
const out = await Promise.all(pending)
  .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
  .catch((error) => {
    failed.abort(error)
    if (!opts.nothrow) throw error
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(errorMessage(error)) }
  })
  .finally(async () => { await Promise.allSettled(pending); await closed })
```

以上补齐既有进程完成合同，原code/nothrow返回规则保留；所有改写计入S11。

### 10.5 浏览器与页面

HTTP语音路由建立disconnect controller，response提前close时abort；与固定40秒timeout组合后传入runVoiceRequest。route finally移除监听。runVoiceRequest调用runtime.withVoice，进入回调先检查signal，再validateVoiceInput和runVoiceTranscribe；保留原 `operation.catch(error => runtime.onFatal?.(error))` 及其完整注释。

原cancelSignal改为一次abort事件，映射VOICE_CANCELLED/VOICE_TIMEOUT，stop移除监听；原makeRequestContext及语音remaining删除。runVoiceTranscribe的direct与cancelSignal组成现有race；withSubmission进入时先检查signal。保留lease/requestID/submitted/queueStarted清理机制，cancelledBeforeSubmission改由signal表示。

两个取消码均执行现有cancelDirectVoice→settle→release/discard；保留500ms取消、500mssettle、1000ms结束检查、3000ms页面关闭及fatal传播。页面fetch固定40秒，保留requestID/controller、提前取消标记及finally删除请求。业务到点触发abort，资源随后完成退出或隔离；共享browser继续运行。

浏览器成功时，在同一submission/lease内把原runAuthExport的CDP Cookie片段移动到文字返回之后，组成 `{text,auth:CookieExport}`。DOM既有bootstrap解析位置保持，成功结果原位增加accessToken；transcribeAudioFile从返回字符串改为返回 `{text,accessToken}`，core直接消费该结果并附入auth。凭据只走私有IPC和用户级配置，公共TUI响应仍为 `{text}`；原耗时日志只记录耗时。CDP detach归入finally。后端唯一authFromHarvest转换并写回，语音外层四次尝试收缩为一次调用。

`chatgpt.js`与`chatgpt-core.js`的既有DAEMON_VERSION同步递增为26；版本差异沿原ensureDaemon退役/启动路径处理。此变更计入S08，保证新CLI消费同次含Bearer的新版auth响应。普通ask/image请求与公开MCP schema保持原接口。

## 11. 路径分类

缓存直连为主步骤；profile与完整浏览器是 §1 用户逐字指定的恢复步骤。取消、最终错误和写回错误结束调用。新增诊断成功路径0，诊断决策面0%。普通ask/image及既有公共浏览器运行保持原用途。

## 12. 删除段 D 与保留设施

| 段标记 | 现有位置/完整语义段 | 处理 |
| --- | --- | --- |
| D01 | voice-auth.ts 的jwtExpiresAt/tokenAlive、6h/48h常量、sessionCredentialUsable、buildSessionRequest/defaultFetchSession、mergeSetCookieCookies | 删除 |
| D02 | 同文件memoryAuth/ensureInflight/authNotices、persistCredential及scope分支 | 删除；保留函数重组后删除原文件 |
| D03 | prompt-voice-input.ts 的direct/argv联合、activeTranscriber、requireTranscriber和本地默认执行 | 删除 |
| D04 | tui.ts/tui-schema.ts 的voice.transcriber、PATH默认、project/env-only语音选择 | 删除；普通MCP保持 |
| D05 | chatgpt.js auth-export的ensureDaemon/HTTP/四次重试、token摘要 | 删除，替换为S07 |
| D06 | chatgpt-core.js runAuthExport的bootstrap/lease；makeRequestContext与remaining；重复语音计时 | 删除，Cookie片段按M03/S08归类 |
| D07 | transcribe-file外层四次尝试；1237/30/80秒等旧语音预算 | 删除，固定120/40秒 |

保留全集：五个UI状态与generation；recorder closePromise/Worker/native停止/terminal/旧音频清理；sdk认证与HTTP close；Effect callback；Flock心跳和租约；Process终止/stdio；JSONC原子写；SessionActivity；browser withVoice/withSubmission/voiceLease/页面稳定与隔离/fatal；页面requestID/controller；共享daemon选主、冷启动、登录及ask/image。全部保留项在 §9–10 有调用位置，§12之外的新增相关设施须先修订审计。

## 13. 原样移动段 M

M是可逐块核对的候选，只有目标代码和完整关联注释与源一致时扣除；编辑过的部分标为S。格式行单列，语义与注释改变均计S。

| 段标记 | 源起止锚点 → 目标 | 关联S |
| --- | --- | --- |
| M01 | voice-auth.ts 中 formatting前解释注释及const formatting；writeVoiceAuth内“定点替换”注释至const next → server/shared/tui-control.ts | S04；函数签名、取消和异常处理计S |
| M02 | prompt-voice-input.ts 的commandExists完整函数；Process.run旁killTree解释及保持原样的调用选项 → tui-control.ts | S04；调用参数/结果形状调整计S |
| M03 | core.js runAuthExport中CDP形状解释与校验、slim映射及完整关联注释 → runVoiceTranscribe同一submission闭包 | S08；try/finally和返回auth计S |
| M04 | tui.ts 中MCP命令数组筛选及mcp-server.js识别、interpreter/script推导的原样子段与注释 → resolveVoiceTarget | S03；来源、路径基准、disabled覆盖、environment计S |

其余跨层级函数整体标为S，内部只有经过上述对应证明的原样子段按M扣除。移出旧文件产生的删除行按D单列。每个M条目实施记录源文件/行段、目标文件/行段、原样非空行数及对应diff锚点。

## 14. 实质增加段 S 与必要性

| 段 | 所有新增/改写内容 | 对应要求 |
| --- | --- | --- |
| S01 | controller取消及120秒、submitVoice、结果与文件完成点 | R01/R07/R09 |
| S02 | 三个组件注入提交函数及提示接线 | R01 |
| S03 | 后端用户配置来源、覆盖、environment；前端删除后的类型接线 | R04/R08 |
| S04 | Cookie及可选Bearer快照读写/解析、文件锁内三步编排、CLI结果解析 | R02/R04/R07 |
| S05 | SendIfAvailable请求、固定attemptSignal、正文消费与状态输出 | R02/R03/R09 |
| S06 | binary endpoint、消息型错误、operation完成点、临时WAV/activity | R01/R07 |
| S07 | 原CLI中的profile SQLite/DPAPI解密、signal、输出及纯导入接线 | R02/R03 |
| S08 | core事件取消、固定40秒、浏览器text+Cookie+Bearer、语音CLI简化、协议版本同步递增 | R02/R07/R09 |
| S09 | DOM固定40秒、成功结果携带实际使用的Bearer及原页面取消语义接线 | R02/R07/R09 |
| S10 | recorder.abort等待已有closePromise再删除 | R07 |
| S11 | Process.run错误时终止并等待全部完成 | R07 |
| S12 | server.ts通过公开IncomingMessage/ServerResponse扩展点保留请求体EOF后的断连通知；响应finish/close归还原生销毁方法，仅补做已延期的正常EOF清理 | R07/R09/I11 |

上述每段包含其新增或修改的注释。跨文件重新组织代码、改函数参数、调整调用时机、改错误处理均归入S。

## 15. 生产文件清单与计数

前12项均位于 `packages/opencode/src/`；操作数16，符合16上限。

| 文件 | 操作 | 段 |
| --- | --- | --- |
| cli/cmd/tui/prompt-voice-input.ts | 修改 | S01/D03/M02 |
| cli/cmd/tui/component/prompt/index.tsx | 修改 | S02 |
| cli/cmd/tui/ui/dialog-prompt.tsx | 修改 | S02 |
| cli/cmd/tui/routes/session/question.tsx | 修改 | S02 |
| cli/cmd/tui/config/tui.ts | 修改 | S03/D04/M04 |
| cli/cmd/tui/config/tui-schema.ts | 删除voice段 | D04/S03 |
| cli/cmd/tui/util/voice-auth.ts | 删除文件 | D01/D02/M01 |
| server/shared/tui-control.ts | 接收移动和更新 | S03/S04/S05/M01/M02/M04 |
| server/routes/instance/httpapi/groups/tui.ts | 修改 | S06 |
| server/routes/instance/httpapi/handlers/tui.ts | 修改 | S06 |
| cli/cmd/tui/prompt-voice-recorder.ts | 修改 | S10 |
| util/process.ts | 修改 | S11 |
| thirdparty/chatgpt-browser-agent/chatgpt.js | 修改 | S07/S08/D05/D07 |
| thirdparty/chatgpt-browser-agent/chatgpt-core.js | 修改 | S08/M03/D06 |
| thirdparty/chatgpt-browser-agent/chatgpt-dom.js | 修改 | S09 |
| server/server.ts | Node HTTP请求销毁完成点与标准socket绑定 | S12 |

总计修改15个、删除1个、新增0个；package.json恢复基线，新增修改位置为既有server/server.ts。测试使用既有文件，生成文件变更0。普通TUI control queue及工作流接线保持。

## 16. TDD 行为切片

按一项RED→最小实现→GREEN推进，测试入口是实际HTTP、CLI、controller、recorder和Process接口。

| 切片 | 既有测试文件 | 可观察结果 |
| --- | --- | --- |
| 认证请求、来源与写回 | test/cli/tui/voice-auth.test.ts | 匿名请求429、浏览器返回快照、第二次发送保存的Bearer及Cookie并成功；profile保持Cookie-only输出 |
| profile导出 | agent test-mcp.js | 独立已知明文SQLite fixture解密一致，浏览器启动0 |
| 三入口及取消 | test/cli/tui/prompt-voice-input.test.ts | HTTP回调收到WAV；迟到文字丢弃；新录音保持 |
| HTTP、等锁、资源完成 | test/server/tui-provider-endpoint-status.test.ts | 两客户端顺序转录；取消后操作先完成再释放WAV/activity/锁 |
| 文件来源 | test/config/tui.test.ts | 用户级覆盖与environment一致，项目文件保持 |
| stop写入期间abort | test/cli/tui/prompt-voice-recorder.test.ts | 先等写入、再删除、上传0；stop错误保持原反馈，随后abort完成清理 |
| 子进程完成 | test/util/process.test.ts | exit/pipe错误和abort后等待close；原nothrow结果保持 |
| 页面及结果 | agent test-mcp.js | 同次text+Cookie；HTTP关闭中止页面；保留fatal回调及下一请求；旧版本经原选主路径切换 |
| 固定计时 | 上述voice/server/agent文件 | 每TUI独立120秒；三次固定40秒；正文计时；早到401立即推进 |
| 运行时断连与连接复用 | 同一HTTP生命周期文件、httpapi-listen.test.ts与最小TCP探针 | Bun1.3.14取消红/绿，以及R13同连接第二次请求超时红/§30修复绿；真实SSE收尾及后继请求保持 |
| rename与取消 | voice-auth.test.ts | 提交前清理临时文件；提交后保留快照并结束文字交付 |

网络fixture验证实际请求；测试用就绪信号控制并发完成点。计时由测试时钟/AbortSignal控制；真实取消使用HTTP断开和CLI退出。生产测试接口新增数0。

## 17. 注释口径

E/C按仓库规则独立计算；总量继续采用 `C >= floor(E*0.15)+1`，E=0时C=0。用户最新要求逐修改文件的新增/改写部分严格超过10%，在函数入口、中段关键决策和收尾处均匀解释原因；每个S段及主要语义chunk保持邻近说明。解释覆盖Cookie-only、profile域摘要、计时、原子提交和完成点。package.json已恢复基线，运行时兼容说明位于实际修改的serverLayer旁。M扣除以原代码和完整关联注释逐块一致为前提，新增说明本身计A；改写、缺失注释的相关移动块归S。测试/配置的E/C单列，生产800行限额按§19。

## 18. 验证与真实验收

| 命令 | 目录 |
| --- | --- |
| bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/config/tui.test.ts | packages/opencode |
| bun test test/server/tui-provider-endpoint-status.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/util/process.test.ts | packages/opencode |
| bun typecheck | packages/opencode |
| npm test | thirdparty/chatgpt-browser-agent |
| git diff --check；逐段S/D/M核对 | 根与子模块 |

真实验收依次完成：profile关闭落盘时原auth-export读取，匿名结果按服务端响应推进；浏览器末级text+Cookie+Bearer写回；后继账户认证直连hello/world且浏览器提交增量保持1；两TUI共用后端及缓存复用；录音/等锁/上传/页面期间取消和新请求成功。session刷新请求0。测试失败保留真实错误，按批准范围修复。

## 19. 统一800行实质增加口径

`A = 生产diff中新增或改写后的非空行 − 经逐段证明的原样移动行`。新增/修改注释计A；改变参数、机制、执行时机或层级绑定的行计A。删除行D独立统计，A采用增加侧计数。格式整理单列并保持最小。原样移动须同时满足代码和关联注释完整；匹配失败即计S，移动名义本身提供的扣减为0。

| S段 | A预算上限 |
| --- | ---: |
| S01 controller与提交 | 70 |
| S02 三处UI接线 | 15 |
| S03 用户配置解析与类型接线 | 45 |
| S04 快照、事务、CLI及写回 | 105 |
| S05 Cookie请求与尝试 | 40 |
| S06 HTTP接口及完成点 | 80 |
| S07 profile与原CLI导出 | 110 |
| S08 core浏览器结果与取消 | 75 |
| S09 DOM | 8 |
| S10 recorder | 6 |
| S11 Process | 24 |
| 语义接线余量 | 22 |
| 既有分段预算合计 | 600 |
| S12 原版本HTTP完成点及说明 | 45 |
| R12已批准认证传递改写预算 | 40 |
| 用户调整的剩余额度，使用仍须归属批准机制 | 115 |
| 合计上限 | 800 |

R12生产diff增加侧非空行484、删除侧非空行840，包含父仓库与子模块；此数包含imports且M扣减采用0，作为A的保守上界。M01–M04候选全部按S计入额度，本次主计量M=0；完整保留的移动块仅在独立E/C核算时按规则排除。删除侧独立展示，增加侧484保持原值。

## 20. 已知事实与验收项

profile离线解密已实测成功。早先Cookie-only HTTP200只证明当时端点接受请求；R12同账户对照确定账户身份由Bearer承载，详见§26。文件占用返回错误后进入指定浏览器步骤。固定业务计时触发abort，清理随后结束。用户级配置与公共浏览器设施已列明，其他语音恢复路径新增数0。

## 21. 双向映射与审计合同

R01→S01/S02/S06→HTTP与三入口测试；R02/R03→S04/S05/S07/S08→Cookie/profile/browser测试；R04→S03/S04→文件与双客户端测试；R05/R06/R10→§13/15/19→逐段计量；R07/R09→S01/S06/S08–S12→完整取消测试；R08→D01–D07→旧引用清理。S12修复事件生产者的运行时行为，复用原NodeHttpServer与Effect取消消费者；新增取消协议、状态或替代服务器数0。所有S段的反向理由见 §14，所有保留设施见 §12。

每轮审计新建上下文，仅接收用户原始要求、本文路径、仓库root和audit mode。覆盖全部R01–R10、实际接口、取消代码及S/D/M口径。blocker先核对归属；复议使用该轮task_id提供事实。实质修订递增revision、清空批准并全范围重审。

## 22. 方案审计记录

R17全范围方案审计及同轮复议 `ses_f4b624102ffeeghVd3yZV0yzOA` 最终原文：

> No blocking findings.
>
> **APPROVE — Revision R17 full-scope plan audit.**
>
> This approval applies only to the canonical R17 plan. Implementation remains prohibited until the primary agent records the clean R17 audit result, then implements the approved revision and obtains a separate full-scope implementation audit.

原初B-01（顶部R16摘要残留）与B-02（历史Bun授权引文）均由同轮复议撤销为blocking，作为non-blocking记录一致性事项保留；600/800历史差异同样明确800为现行上限。本次行政记录同步顶部R17摘要，不删除历史原文、不改变设计。

R16全范围独立方案审计 `ses_f4c9cded5ffeOasMVIQT3nrtNn` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R16，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现发布仍须关闭已知失败、完成当前版本验证和实际计量，并取得全范围独立实现审计批准，之后才满足用户要求的提交前提。

Non-blocking findings原文：

> **N-01：最终验证仍未闭环。** 已直接读取 `D:/Temp/opencode/r15-sse-event-order.log:36` 的 SSE 归零失败及 `D:/Temp/opencode/r15-mcp-final.err.log:1` 的 viewport 失败。R16 §35 给出了对应修复和敏感验证；其余已知失败继续按 §34–35 定向复验。本轮方案批准不构成当前实现通过。
>
> **N-02：历史修订文字仍有残留。** `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md:12` 仍要求取得 R15 批准，顶部元数据与 §35 已明确当前为 R16。属于记录一致性问题；执行及后续批准必须绑定 R16。

N-02已在本次行政记录中同步顶部当前修订说明，设计没有改变。

R15全范围独立方案审计 `ses_f4d060118ffeLai8qpg0JCqCSa` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R15，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现完成仍须通过当前版本验证、实际范围与 A/E/C 核算及完整独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

Non-blocking findings原文：

> **N-01：R15 的窗口 fixture 修正仍待执行验证。** 当前测试直接设置 500×400 布局，再断言恢复到宽 >700、高 >500，没有建立真实大窗口前提（`thirdparty/chatgpt-browser-agent/test-mcp.js:3094`）。生产同步函数依据窗口与布局差值决定是否处理（`thirdparty/chatgpt-browser-agent/chatgpt-core.js:434`）。§32 将修正限定在测试准备阶段，保留原始 pin、同步调用和恢复断言，归属正确。
>
> **N-02：实现验收尚未闭环。** Linux 等价执行、PTY upgrade、当前完整 A/E/C 计量、最终测试及独立实现审计仍须完成。本轮仅检查方案、源码和测试，没有执行命令，也没有将历史通过记录当作本轮独立复现。
>
> **N-03：历史交付措辞仍有残留。** 顶部提交目标及历史 Bun 升级记录应继续按历史材料理解；当前执行约束是保持 Bun 原版本、不操作 git 或远端。它们不构成执行授权。

R14全范围独立方案审计 `ses_f4d0f9b8effeql569KRmM6jLZd` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R14，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现完成仍须通过当前版本的行为回归、验证闭环、实际 A/E/C 计量及全范围独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

Non-blocking findings原文：

> **N-01：R14 的运行时验证仍属于实施验收。** 当前 `packages/opencode/src/server/server.ts:218` 仍无条件调用原生 `_destroy`；§30 已明确替换该调用，并安排同一 socket 两次请求的 RED/GREEN、真实 SSE 收尾及原语音取消回归。本轮核对了源码、测试接口和方案敏感性，未执行命令，未将方案记录的探针结果视为本轮独立复现。
>
> **N-02：历史通过记录不能替代当前实现证据。** §29 保留的 Linux fixture 执行域缺口、MCP viewport 波动，以及当前 A/E/C 复算仍须在实现验收中闭环；R12 的测试、构建与计量结果不能直接转用为 R14 通过结论。
>
> **N-03：历史交付措辞存在残留。** 文件顶部及部分历史章节仍含提交目标、Bun 升级与旧状态描述。当前执行边界以最新原始约束和 §28–30 为准：保持 Bun 原版本，不操作 git、远端或提交。

R13全范围方案审计 `ses_f4d548242ffeANhAoSeKDgpkvS` 原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R13，全范围方案审计。
>
> 批准仅适用于该修订。当前实现完成、Bun 1.3.14 等价 CI 验证及最终全量测试尚未由本轮确认；实施完成仍需全范围独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

N-01：R13运行时与CI验证属于实施验收；N-02：历史运行时文字残留由§28当前合同取代，实施仅依R13。此前暂存内容冻结，额外修改保持unstaged；本轮git、远端、提交、暂存操作数0。以下历史审计保留原文。

R12全新上下文全范围审计：`ses_f4dbffd19ffeJIQzh60NX1CL2f`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R12，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须通过回归、包级检查、构建、真实场景验收、实际 S/D/M 与 E/C 计量，以及全新上下文的独立实现审计。本结论不认定当前实现已完成，也不构成提交或推送授权。

**N-01原文：** R12 的实现证据仍待完成。当前后端仍丢弃 Bearer（`packages/opencode/src/server/shared/tui-control.ts:153`），页面成功结果仍未返回本次使用的 accessToken（`thirdparty/chatgpt-browser-agent/chatgpt-dom.js:828`）。R12 §6、§10.5、§16 已明确对应修复及回归路径；这是方案批准后的实施工作，不构成方案缺陷。

本轮仅执行只读源码、测试及git检查，测试、构建及真实账户请求的历史结果保持独立验收责任。R12新增范围为可选Bearer快照、同次DOM成功返回、已有直连header及私有版本递增；全部计S，估算40行以内，计入800行额度。

R11全新上下文全范围审计：`ses_f4dde4f04ffecUiEB8nvgs8NU8`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R11，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须通过新版运行时下的回归、包级检查、现场验收、实际计量及全新上下文的独立实现审计。本结论不构成实现完成或提交授权。

**Non-blocking finding原文：** R11 的运行时修复仍需完成实现验收。当前 `package.json:7` 保持 `bun@1.3.14`，方案明确将其更新为 `1.4.2`。本轮核对了运行时版本的构建入口、HTTP 断连消费者和回归测试源码；未执行测试，也未将方案记录的通过结果视为本轮独立复现。

R9新上下文全范围审计：`ses_f4f69f620ffe7upyapwtwhOWb0`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R9，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须具备 RED/GREEN、包级检查、现场验收、实际计量及独立实现审计证据。本结论不构成提交或推送授权。

R8 全新上下文审计：`ses_f4fb35913ffeSCPLBjLVshpqNC`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R8，全范围独立方案审计。
>
> 批准仅适用于该修订的方案。实现仍须完成RED/GREEN、包级检查、现场验收、实际S/D/M与E/C计量及独立实现审计。本结论不构成提交或推送授权。

**N-01 原文：** E/C 数值估算尚未单列。§17 明确承诺15%中文解释注释目标，§19将新增、改写注释计入600行预算，但没有分别列出预计 E、C。这是估算记录缺口，未授权降低门槛，也没有证据证明预算必然超限。实施审计须按实际 diff 独立计算。

计量记录补充：估算 E 约700行（生产与测试合计，按§17排除项扣减），R9对应 C 至少106行；最终采用实际 E/C。现场实验复核沿§18完成。R7历史批准任务为 `ses_f4fdb3b49ffePi2x6lmtgY0qwL`。提交授权来自用户本次GOAL的目标终态。

## 23. 实施与提交证据

已完成Cookie请求、三来源转录、用户配置、TUI提交、录音写入/取消、Process管道故障的RED→GREEN。旧voice-auth.ts已在用户明确授权删除后移除，旧JWT/session刷新和前端认证调用退出实现。

| 验证命令 | 工作目录 | 当前结果 |
| --- | --- | --- |
| npx --yes --package=bun@1.4.2 bun typecheck | packages/opencode | R12通过 |
| npx --yes --package=bun@1.4.2 bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/config/tui.test.ts test/util/process.test.ts test/cli/cmd/tui/prompt-submit-transport.test.tsx test/server/tui-provider-endpoint-status.test.ts | packages/opencode | R12最终174通过、4个opt-in用例跳过、583断言；包含真实120秒独立预算与完整HTTP取消 |
| bun test test/cli/tui/prompt-voice-recorder.test.ts test/util/process.test.ts | packages/opencode | 最新录音断言加强后24通过、59断言 |
| npm test | thirdparty/chatgpt-browser-agent | R12最终73通过，syntax/deps通过；前轮EPERM单项与完整重跑记录保留 |
| npx --yes --package=bun@1.4.2 bun run script/build.ts --single --skip-install --skip-embed-web-ui | packages/opencode | Windows EXE、版本启动及compiled voice Worker smoke通过；构建自动改写的models-snapshot.js已恢复至构建前干净基线 |
| git diff --check | 根与子模块 | 通过 |

生产文件为15修改、1删除、0新增，总计16。逐文件非空新增侧粗计如下，全部改写及注释纳入，原样移动扣减0；E/C为diff机械候选值，最终由独立审计核验语义与M排除。

| 生产文件（缩写，对应§15） | A上界 | E候选 | C候选 |
| --- | ---: | ---: | ---: |
| prompt-voice-input.ts | 48 | 37 | 10 |
| component/prompt/index.tsx | 3 | 2 | 1 |
| ui/dialog-prompt.tsx | 6 | 3 | 2 |
| routes/session/question.tsx | 3 | 2 | 1 |
| config/tui.ts | 2 | 1 | 1 |
| config/tui-schema.ts | 0 | 0 | 0 |
| util/voice-auth.ts（删除） | 0 | 0 | 0 |
| shared/tui-control.ts | 193 | 147 | 33 |
| httpapi/groups/tui.ts | 12 | 9 | 2 |
| httpapi/handlers/tui.ts | 46 | 29 | 8 |
| prompt-voice-recorder.ts | 4 | 2 | 2 |
| util/process.ts | 10 | 7 | 3 |
| chatgpt.js | 84 | 69 | 15 |
| chatgpt-core.js | 59 | 50 | 9 |
| chatgpt-dom.js | 12 | 4 | 8 |
| package.json | 2 | 1 | 1 |
| 合计 | 484 | 363 | 96 |

生产候选C/E为26.45%；含测试的机械候选E=1693、C=330、19.49%，测试逐文件最低13.51%、生产最低18%。解释分布在配置来源、三步编排、认证解析、提交点、临时文件完成点及profile解密关键位置；最终合格C及pure-move排除见§24。审计时提交数量0；verified后按本GOAL路径提交，其他工作区内容保持原状。

R12认证RED/GREEN：新测试 `reuses the browser account snapshot after anonymous dictation is rejected` 原结果第二次仍为browser transcript；修复DOM/core快照及后端消费后，后端完整51项通过。MCP对应DOM/core红测试分别捕获字符串返回和缺accessToken，修改后完整73项通过。

真实验收命令为 `CHATGPT_VOICE_E2E=1 CHATGPT_VOICE_DEFAULT_PROFILE_E2E=1 CHATGPT_VOICE_DIFFERENTIAL_E2E=0 CHATGPT_VOICE_USER_CONFIG=<实际用户配置> npx --yes --package=bun@1.4.2 bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "actual default MCP profile"`（packages/opencode；PowerShell用env变量赋值）：1通过、31断言。原profile关闭落盘后导出28条Cookie且Bearer缺席；profile场景真实状态[429,200]、强制browser场景[503,200]（首次503明确注入），两种场景Bearer发送[false,true]、浏览器提交增量1、两次hello/world均命中，快照复用匹配。用户配置逐字未变，私有fixture及音频删除，MCP版本26、连接正常、pending/locks/voice-active/queued均0。

## 24. 实施审计记录

全新上下文全范围实现审计：`ses_f4d9fbc43ffe4ZVY8OOEKwGxKx`，R12当前全部实际diff。初次完成本地验证后提出B-01验收证据缺口；按同轮复议补充原始构建输出、机器产物与真实账户执行授权，auditor独立重验后撤销B-01。生产行为修订次数0，N-01单行测试说明按审计更正。

最终原文：

> No blocking findings.
>
> 撤销 B-01。本轮通过独立执行真实账户验收、核对编译产物哈希及运行两个 compiled smoke，关闭了此前的验收证据缺口。复议保持 R12 原始要求与全部实际 diff 范围。
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R12，当前实际 diff 的全范围独立实现审计。
>
> 批准包含本次已核对的单行测试注释修正。B-01 已撤销，无剩余阻断项；此结论不替代提交或推送授权。

**N-01已解决，原文：** `packages/opencode/test/cli/tui/voice-auth.test.ts:505` 已正确限定为 profile 的 Cookie-only 输入域；重新运行该文件，51 通过、0 失败、188 断言。

**N-02保留为验证记录，原文：** MCP 首次全套出现子进程 `ETIMEDOUT`，单项复核出现 `EPERM`；随后未修改代码、未调整超时、未跳过用例的完整重跑，73 项全部通过。尚无证据将该启动波动归因于本次生产改动。

最终独立E/C：生产与配置E337/C87（25.82%），测试E1318/C232（17.60%），总E1655/C319（19.27%）。排除空行、文档、import-only、确认的纯移动与仅修改注释的代码行，移动旧注释排除，合格行内解释计入。全部E>0文件超过10%；A采用含imports与注释且M扣减0的保守484行。

独立验收：174通过/4 opt-in跳过、typecheck通过、MCP73通过；实际profile验收1通过/31断言，两场景浏览器各提交一次，后继账户请求200；结束restored/idle/configUnchanged/temporaryRemoved均true。EXE哈希匹配，版本0.0.0-dev-smark-202609180229与voice-worker-probe-ok均独立运行通过。原始RED未重放，当前断言敏感性和GREEN已核对；完整构建生成步骤采用原始执行记录与机器产物复核。提交授权沿用用户GOAL。

## 25. 运行时根因与修复实证

R07/I07要求客户端取消传到后端原操作。生产 `src/server/server.ts:191` 使用node:http与NodeHttpServer；已安装 `@effect/platform-node/src/NodeHttpServer.ts:176` 依赖response.close中断fiber。Windows Bun1.3.14在请求体消费完毕后遇到TCP断开时缺失该通知，因而锁等待、fetch及正文消费持续运行。首个偏离在运行时HTTP事件生产者。

- 最小对照：同一http.createServer + raw net客户端destroy探针，Node24.16收到response.close/socket.close，Bun1.3.14保持静默。
- 直接使用已安装NodeHttpServer.makeHandler的可中断handler：Node触发abort及finalizer，Bun保持原操作；原生Bun.serve + HttpEffect.toWebHandler则触发完整取消。
- 已检查req.close、flushHeaders、100/102/103、响应正文、HttpServerRequest.toWeb及现有WebHandler。req.close表示请求体完成；toWeb的signal需要调用者提供；更换整个listener同时涉及PTY upgrade与shutdown合同。
- `package.json:7`固定bun@1.3.14；构建/test工作流从package.json读取版本，说明此事实涉及产品构建。当前PATH仅发现该Bun可执行文件。
- 用户授权更新Bun后，通过npx安装隔离Bun1.4.2；最小raw TCP探针输出 `response close false`、`{"bun":"1.4.2","closed":true}` 并退出0。
- `npx --yes --package=bun@1.4.2 bun test test/server/tui-provider-endpoint-status.test.ts --test-name-pattern "voice HTTP lifecycle"`（packages/opencode）：6通过、0失败、61断言，覆盖此前三个红用例；测试及生产逻辑保持原内容。
- 真实profile只读探针返回 `ERR_SQLITE_ERROR: unable to open database file`，零Cookie值输出；完整现场链仍按§18验收，现有浏览器恢复步骤保持原合同。

S12直接将标准node:http断连通知恢复的运行时固定为1.4.2，现有NodeHttpServer、Effect、WAV清理及Flock消费链保持原结构。取消映射、私有symbol读取、替代服务器工作流新增数0。先前只读诊断任务：`ses_f4e21a97effevyXHoPU8OiJW78`。新版完整包级回归、构建、现场及独立实现审计继续执行。

## 26. 账户认证根因实证

同一账户、同一音频、28条当前Cookie的六次有界POST：外部Cookie-only、仅加浏览器User-Agent、再加Origin、浏览器页面Cookie-only均为429；浏览器页面及原NetworkProxy外部请求仅增加当前bootstrap Bearer后均为200，hello/world命中。429 JSON的detail为：`You've hit the limit for dictation without an account. Log in or sign up to continue dictating, or try again later.`。

红信号为既有文件中的opt-in实际默认profile验收：两次直连429导致浏览器提交增量2，合同期望1。独立对照排除了本次UA/Origin/代理改变作为修复来源；实际Bearer来自MCP已登录页面，用户粘贴凭据使用数0，session端点调用数0。取值位置就是DOM本次POST已有的accessToken局部量，继续由浏览器维护更新。

profile只读导出Cookie，支持网页SendIfAvailable的匿名输入域；服务端返回401/403/429等结果后沿原三步流程推进。浏览器成功快照提供后续账户直连输入。R12修复S04/S05首个丢失账户授权的边界及S08/S09成功结果生产者，复用原页面解析、文件锁和原子写回，额外刷新机制数0。

## 27. 交付记录

用户在最终权限确认中明确选择“授权本地提交”。MCP提交为 `a317195`（基于实施前已有 `b04aff7`，保留其历史）；主仓库实现与本记录同次提交，标题为 `fix(voice): 将转录归并共享后端并保留浏览器认证所有权`。全部提交保留hooks、普通提交及本地边界。

Windows产物：`packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，版本 `0.0.0-dev-smark-202609180229`，Bun1.4.2构建，SHA-256 `f565feb1868358e757dfca880c0ae6c616b382709e20d62114062af69ea9a668`。构建使用skip-embed-web-ui，已验证CLI与录音Worker。系统PATH原Bun的原位upgrade返回EPERM；本次全部最终回归、验收及编译采用已安装的隔离Bun1.4.2，仓库构建版本固定为1.4.2。

## 28. R13 当前修复合同

最新用户要求：保持Bun原版本；远端及提交撤回，原改动暂存，额外修改只留工作区；后续git、远端、question操作数0；所有增加行逐行对应删除侧超过80%相似原文或计新增，机制变化仍计新增，注释完整保留。计量可采用全部增加行计新增的更保守上界，删除独立统计。当前历史生产上界484，去除package.json升级2行、增加以下监听器修复约35行，预计上界约517，限额800。

已复现：OpenTUI CI原命令在Bun1.3.14为10通过/4失败，起点是DialogPrompt的SDK Provider缺席；HttpApi auth/coverage均157通过/missing1，缺POST /tui/voice/transcribe；静态Puppeteer导入在本地解析成功、模拟干净CI依赖域解析失败。原core代码保持，回退提交的Linux/macOS CI核心门已成功，运行时升级所触发的kill差异随版本恢复退出当前改动范围。

测试修复仅三处：删除已完成诊断的一次性differentialE2E及其私有node_modules静态导入，保留真实profile/browser验收；DialogPrompt测试用真实SDKProvider及原事件清理；exerciser登记真实binary WAV路由并断言401和缺配置502，保留fail-on-missing与fail-on-skip。

HTTP根因：Bun1.3.14的IncomingMessage._destroy在正常body EOF时清掉原handle.onabort；ServerResponse优化绑定还省略socket.close到response.close的标准监听。调用点修复为serverLayer的createServer公开options：

```ts
const server = createServer({
  IncomingMessage: class extends IncomingMessage {
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      if (!error && this.complete && this.readableEnded) { callback(null); return }
      super._destroy(error, callback)
    }
  },
  ServerResponse: class extends ServerResponse {
    assignSocket(socket: Socket) { super.assignSocket(socket) }
  },
})
server.on("request", (request, response) => {
  const finish = () => {
    response.off("finish", finish)
    response.off("close", finish)
    IncomingMessage.prototype._destroy.call(request, null, () => {})
  }
  response.once("finish", finish)
  response.once("close", finish)
})
```

正常EOF只移动原清理时机；响应完成或断开执行原清理，提前上传错误仍走原_destroy。复用NodeHttpServer/Effect取消及原WebSocket/shutdown合同，版本判断、私有symbol读取、新取消registry与新状态数0。内存loopback实证：基线无response.close；上述组合在Bun1.3.14得到aborted=1、cleaned=101（一次取消+100次正常请求）。

行为验证由原voice HTTP集成测试改为调用真实Server.listen，借既有Effect scope管理listener；上游仍是既有独立NodeHttpServer fixture。保留双客户端、等待者取消、原operation完成前资源存活、正文取消、后继请求及50MiB全部断言。集中执行原CI consumer、HttpApi三模式、包级typecheck、相关回归、core原有测试；独立实现审计按全部原需求与当前工作区范围核验。该节为当前修复的具体覆盖，历史R11/R12运行时升级叙述由本节取代。

## 29. R13 定向验证与审计进度

用户最新执行要求：先解决已知失败，逐项最小复现与相关回归；全部修复和审计收敛后才执行最终全量检查。前次600秒全量调用被终端时限中断，后次调用由用户中断；两次均无完整汇总，均不计通过。中断后进程查询未发现对应test-ci或reporter-outfile子进程。后续没有启动新的全量测试。本节只补充证据，不改变R13生产合同或允许增加修改范围。

| 检查与工作目录 | 当前证据 |
| --- | --- |
| `bun typecheck`，packages/opencode | R13通过，Bun1.3.14 |
| `bun run test:ci`，packages/core | 360通过、0失败、658断言、48文件；这是已完成的前轮结果 |
| server/provider/listen/mdns及原OpenTUI四文件组合，packages/opencode | 32通过、7项既有跳过、0失败、143断言；Windows PTY upgrade仍未验证 |
| HttpApi auth、coverage，packages/opencode | 各158通过，fail/skip/missing/extra均0 |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip --progress --trace`，packages/opencode | 完整结果156通过、2失败、skip/missing/extra均0；失败为pty.create与worktree.reset；语音场景通过。原始输出tool_0b2c7840e001PBq5N639ww0V2Q |
| `npm test`，thirdparty/chatgpt-browser-agent | syntax/deps通过；MCP在viewport用例断言500x400失败后退出，不能计为完整73项通过 |
| `node test-mcp.js testViewportResyncClearsStaleLayoutSize`，同上 | 单项通过；随后与testPrivateBrowserDoesNotExposeAutomationFlag组合2项通过。原失败尚未稳定复现，重跑通过不等于修复 |

### 已知失败的窄范围归因

worktree：原命令增加`--include worktree.reset --trace`，10.7秒复现400、`Worktree not found`。environment.ts使用`process.env.TMPDIR ?? "/tmp"`，本机未设置TMPDIR时显示`\tmp\opencode-httpapi-global-<pid>`，Windows路径缺盘符。主工作区在F盘、临时仓库在D盘。只在本次PowerShell子进程设置`$env:TMPDIR = $env:TEMP`，保持源码和断言不变，重新执行同一场景得到200，1通过、0失败。后续Windows本地exerciser使用已有TMPDIR入口提供绝对路径，不引入生产路径补偿。

PTY：设置绝对TMPDIR后仅运行`--include pty.create`仍是正常创建500、非法输入场景通过。dsl.ts的controlledPtyInput固定`/bin/sh -c "sleep 30"`，该门的工作流明确运行在ubuntu-latest。同一生产`src/pty/pty.bun.ts` adapter的有界诊断中，`/bin/sh -c "exit 0"`返回`PTY spawn failed`，`C:\\WINDOWS\\system32\\cmd.exe /d /c "exit 0"`返回exitCode0。这证明当前Windows执行域不满足该Linux fixture，不将本地失败改写为CI通过，也不修改其200断言或新增skip。

两场景通过HttpRouter.toWebHandler调用，未经过R13的serverLayer。尚缺Ubuntu等价执行结果；本机docker命令不可用，先前WSL探针未找到Bun。未安装或更新运行时来掩盖该验证缺口。

### 独立实现审计记录

审计任务：`ses_f4d3d9738ffeSGH2366Gap6fVZ`，R13全范围实现审计；原始需求范围保持。初轮及本轮复议原文均包含：

> No blocking findings.

复议发布结论原文：

> **BLOCK — Revision R13 当前实现。**
>
> 复议结果：**N-02 的“历史原始 diff 不可用”部分关闭；当前精确计量仍待完成。N-01 从 pending 更新为 effect 门禁已观察到两项失败。** 当前应优先处理这两项已知失败的归因与闭环，不启动新的完整测试套件。

上述“No blocking findings”指尚未证明新增行为级缺陷，不构成APPROVE。当前状态保持implementation-audit-required，不能沿用R12批准。审计仍待当前增加侧A、E/C与逐文件比例复算、实际范围完整性、keepalive/流式响应/upgrade证据及最终验证闭环。

历史原始diff已恢复可读：父仓库生产tool_0b260cfd2001QUD64uJuFrfpO6、子模块tool_0b260ce18001FlBp0D5UJxX3pb，位于既有`C:/Users/Lenovo/.local/share/opencode/tool-output/`。这些是R12历史diff，含已撤回的Bun升级，必须与当前R13变化分开核对；历史484行和19.27%不标作当前实测。冻结后未执行Git或远端操作，当前修复和本记录仅保留工作区。

## 30. R14 请求销毁完成点修正

### 证据、范围与首个偏离

本轮读取当前serverLayer、真实Server.listen测试及global SSE handler，根及包级AGENTS约束保持；CONTEXT中的Server/AppRuntime职责保持。docs/adr现有条目为triage标签，无HTTP生命周期专属ADR。R01–R10、16个生产文件清单及原语音链全部保持，不以本次回归缩小审计。

**I11（contracted）：** 本次修复不得降低原共享HTTP listener的连接复用与流式响应可靠性。普通客户端可以在同一TCP连接顺序发送两个GET；请求体结束、响应结束是两个独立完成点，原生请求销毁不得被提前调用。

**Observed RED：** `packages/opencode`中Bun1.3.14内存探针创建隔离XDG目录、内存DB和真实Server.listen；一个net.Socket先发送`GET /global/health`，收到healthy后在原socket再次发送。首个响应200、156字节，第二个无响应，5秒上界报`keepalive timeout; bytes=156; sentSecond=true`。探针finally销毁自有socket、停止listener、关闭DB并删除其专属临时目录。最初探针的HTTP framing亦用CRLF明确构造后复核，故不把探针编码问题作为生产结论。

最小对照同样只用一个net.Socket发送两次GET：原生createServer、仅IncomingMessage子类、仅ServerResponse子类、两个子类均得到responses=2；增加R13的finish清理后responses=1且socket关闭。清理时实际request.complete=false、readableEnded=false、destroyed=false。首次偏离就是server.ts:218无条件调用原生_destroy，原运行时把仍未读完的请求当作中断销毁其连接；调用者重连、客户端重试或替换HTTP栈均不属于修复。

### 同一primary path的修正

owner仍是serverLayer的请求生命周期适配。保留R13构造器扩展及正常body EOF延期；仅在响应finish/close完成点归还原生销毁方法。若请求已经因正常EOF进入destroyed、complete且readableEnded，则补做此前延期的原生清理；尚未销毁或提前错误的请求交回原运行时处理，不主动提前销毁它：

```ts
response.off("finish", finish)
response.off("close", finish)
request._destroy = IncomingMessage.prototype._destroy
if (request.destroyed && request.complete && request.readableEnded)
  IncomingMessage.prototype._destroy.call(request, null, () => {})
```

赋回的是该请求原有方法，判断依赖已有stream生命周期属性；不增加标志、注册表、版本分支、独立超时或恢复状态。响应已完成后新发生的请求EOF沿恢复后的原生_destroy收尾，避免继续延期到已经触发过的finish事件。正常已延期、尚未销毁、提前错误是同一请求合同内的完成时序，不是失败后的备用成功路径。删去R13的无条件手工销毁；原注释保留并补充其适用时序。仅在内存探针尝试该修正，responses=2；当前生产文件仍是RED版本，审批前不实施。

### 映射、文件及验证

| 映射 | 所属与证据 | 变更与行为证明 |
| --- | --- | --- |
| I11 → 请求清理owner | serverLayer同时提供普通HTTP和语音listener；上游业务handler不拥有请求销毁 | 修改既有src/server/server.ts的finish；既有test/server/httpapi-listen.test.ts加入一个socket两个成功响应的敏感测试 |
| R07/I07 → 延期正常EOF | WAV读完仍需response.close中断原operation | 保留tui-provider-endpoint-status中的完整取消/锁/文件完成点六场景；不得以keepalive修复撤掉取消 |
| I11 → 流式收尾 | global.ts的onSseClientCountChange本来就向daemon公开连接计数 | 在既有httpapi-listen.test.ts通过真实/global/event收到server.connected后断开，等待既有计数回零及后继health成功，finally复原该测试注册的回调 |
| 方法归还与既有状态条件 → I11 | 当前无条件清理提前关闭连接；仅删除调用又会遗漏已延期EOF收尾 | 复用原生方法和stream状态，不将业务判断或新状态放入transport |

仅额外修改上述1个既有生产文件和1个既有测试文件，生产总数仍16、新增仓库文件0。S12总预算45行；相对R13预计实质代码E增加约4行、邻近中文解释C增加至少2行。两个测试预计E不超过90、C至少14，分别解释同socket判定、等待真实响应而非sleep、stream完成信号、断开前后资源归属和finally清理；不弱化已有注释。整体当前A/E/C最终仍须独立复算，不能沿用历史值。

TDD顺序：先写同socket两请求测试并运行RED；按本节改finish并运行GREEN；再补真实SSE生命周期验证，最后合并原voice生命周期、listener/shutdown/mdns与typecheck。命令均在packages/opencode：`bun test test/server/httpapi-listen.test.ts --test-name-pattern "keepalive"`；`bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts`；`bun typecheck`。平台已有PTY skip保持并明确未覆盖，不能冒充upgrade通过。最终全量检查继续延后到失败归因与修复收敛后一次执行。

已确认风险是请求与响应完成顺序不同，修复必须同时覆盖正常未消费GET、WAV已读完取消、SSE断开以及普通请求完成。其他假想输入不驱动扩展代码。MCP viewport波动和Linux fixture执行域仍按§29保留，不把它们夹入本次生产修复。本节是材料修订，R13批准失效；R14须按原始完整需求重新独立方案审计，再实施并独立实现审计。

## 31. R14 实施证据（尚未完成最终验收）

R14批准后仅修改既有server.ts与httpapi-listen.test.ts。生产finish先归还请求的原生_destroy，再针对destroyed/complete/readableEnded的正常EOF补做延期清理；原五条相关中文注释保持，新增两条解释请求/响应完成顺序和未消费GET的连接复用边界。新增测试通过一个原始TCP socket顺序发送两个health请求，SSE测试通过真实/global/event首事件、客户端断开、daemon原有连接计数通知回零及后继health响应观察完整收尾。

| 顺序 | 命令（工作目录packages/opencode，Bun1.3.14） | 结果 |
| --- | --- | --- |
| RED，生产finish未修改 | `bun test test/server/httpapi-listen.test.ts --test-name-pattern "keepalive"` | 0通过、1失败、11过滤；`keepalive connection closed before both responses`，约3.4秒 |
| GREEN，按批准R14修改finish | 同上 | 1通过、0失败、11过滤、2断言，约3.2秒 |
| 相关回归 | `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts` | 20通过、7项既有平台跳过、0失败、95断言，约26.6秒；含真实SSE和原语音取消 |
| 类型检查 | `bun typecheck` | tsgo --noEmit退出0 |

未启动全量套件，未修改Bun版本、暂存区或远端。Windows跳过项不作upgrade验证证据；Linux执行域、viewport波动、当前全范围A/E/C与最终独立实现审计仍待闭环。当前结果只证明上述R14定向修复，尚不具备verified或完成声明条件。

## 32. R15 可见浏览器测试前提修正

**Observed：** 当前test-mcp.js:3086的viewport测试在隔离profile内启动真实可见Edge，未指定窗口大小，直接把布局override为500x400后调用syncPageViewportWithWindow，再断言宽>700且高>500。生产函数chatgpt-core.js:434依据窗口与布局差值判断，widthGap<=150且heightGap<=250时保持原状；浏览器launch参数没有最大化或固定尺寸。测试注释的“窗口已最大化”不是fixture实际提供的前提。

本轮只在专属临时profile、about:blank及原testing接口执行内存探针，未连接用户浏览器或ChatGPT：默认窗口1050x1000时布局500x400恢复1028x908；控制窗口600x500时没有触发同步，立即及下一animation frame均为500x400，复现前轮失败值；控制窗口1200x900时恢复1178x809，立即及下一帧一致。探针只改变真实窗口尺寸这一输入，使用同一生产同步函数；最后closeOwnedBrowser返回true，临时profile清理完成。

**不变量与首个偏离：** 测试声称模拟“大窗口内renderer卡在小尺寸”，却只固定renderer而没有固定窗口，使合法的小窗口进入正常差值域后被错误断言为同步失败。owner是既有testViewportResyncClearsStaleLayoutSize的fixture；生产的stale判断与同步方法不承担保证测试窗口尺寸的责任。

**唯一修正：** 在既有测试的page CDP session中取得Browser.getWindowForTarget结果，先通过Browser.setWindowBounds设windowState=normal，再设width=1200、height=900。用有界page.waitForFunction等待实际布局达到宽>700、高>500后才设置500x400 override；原fixture pin断言、sync调用和最终恢复断言完整保持。等待观察布局就绪，不增加固定sleep、断言重试包装、扩大测试超时、skip或生产fallback。5秒上界与同仓测试短时就绪检查一致，仅限制测试准备阶段。

| 双向映射 | 责任与证据 | 修改/验证 |
| --- | --- | --- |
| 既有viewport恢复验证可靠性 → 测试窗口fixture | 小窗口时生产明确保持正常布局差值，原测试阈值不能成立 | 仅修改thirdparty/chatgpt-browser-agent/test-mcp.js既有函数，建立大窗口前提 |
| 固定窗口与就绪谓词 → 保留现有同步断言 | 单独设置500x400 override无法保证与真实窗口存在stale差值 | 保留500宽pin及恢复宽>700/高>500；测试仍调用真实syncPageViewportWithWindow |

TDD反馈沿前轮npm test的500x400失败及上述受控窗口实验；批准后先运行原单测记录当前结果，再修改fixture并执行`node test-mcp.js testViewportResyncClearsStaleLayoutSize`及与`testPrivateBrowserDoesNotExposeAutomationFlag`组合。可在小窗口启动的有界诊断中复验前提恢复，结果不能用重复直到通过代替。全量MCP及仓库全量继续留到定向修复收敛后的最终一轮。

生产修改数、生产A、所有语音路径均不变；新增仓库文件0。预计测试E增加6行、邻近C增加2行，原详细注释完整保留；整体当前A/E/C仍待独立计量。此项属于测试行为材料修订，故递增R15并清空批准；重审仍覆盖原始R01–R10/I01–I11/S01–S12。Linux Bun登录shell探针仍未找到可执行文件，Linux等价验证缺口保留；不将其夹带为runtime升级或生产平台兼容修改。

### R15 实施记录

批准后先执行未修改的`node test-mcp.js testViewportResyncClearsStaleLayoutSize`，本次1通过，约4.3秒；不把这次通过当作消除前轮波动的证据。随后按批准范围仅在原test-mcp.js fixture增加4行窗口准备与就绪代码、2行邻近中文原因说明，原pin、同步、恢复及清理断言完整保留，生产函数零改动。执行`node test-mcp.js testPrivateBrowserDoesNotExposeAutomationFlag testViewportResyncClearsStaleLayoutSize`得到2通过、0失败，约8.3秒；`node --check test-mcp.js`退出0。工作目录均为thirdparty/chatgpt-browser-agent。本轮没有全量重跑、依赖或Bun更新、Git或远端操作，最终完整验证与独立实现计量尚待完成。

## 33. R15 Linux定向验证与独立计量

在临时目录`D:/Temp/opencode/bun-linux-1.3.14`准备npm发布的同版本Linux运行时，WSL中输出1.3.14；Windows Bun、package.json和锁文件未变。此步骤补齐本地等价执行环境，不升级已有运行时。WSL工作目录为`/mnt/f/ML/PythonAIProject/Claude-Code/opencode/packages/opencode`，执行文件为`/mnt/d/Temp/opencode/bun-linux-1.3.14/package/bin/bun`。

| Linux命令 | 结果 |
| --- | --- |
| `bun run script/httpapi-exercise.ts --mode effect --include pty.create --fail-on-missing --fail-on-skip --trace` | 2通过、0失败，正常创建200、非法输入400 |
| `bun run script/httpapi-exercise.ts --mode effect --include worktree.reset --fail-on-missing --fail-on-skip --trace` | 1通过、0失败，reset返回200 |
| `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts` | 默认5秒上界下26通过、1个目录绑定测试超时；其余upgrade、shutdown、取消均完成 |
| `bun test test/server/httpapi-listen.test.ts --test-name-pattern "PTY connect token requires matching directory" --timeout 30000` | 1通过，目标用例约5464毫秒 |
| `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts --timeout 30000` | 27通过、0失败、无skip、126断言，29.81秒 |

30000是仓库script/test-ci.ts既有REPORTER_ARGS，不是修改测试源码或为本次错误新增放宽值。测试使用原有临时fixture仓库；没有操作主/子仓库索引、提交或远端。Linux环境前轮“无可执行Bun”的缺口现已补齐；最终完整套件仍按用户要求留到定向修复收敛之后。

独立实现审计任务`ses_f4cfeb906ffeKW1k0S0qSL5eCa`，完整R15范围，原文结论：

> No blocking findings.
>
> **N-02关闭：四个基线身份已获得独立历史记录支持，当前计量可以正式确认。N-01仍有最终验证缺口。**

N-02由auditor自行读取旧unified diff、恢复删除/移动源文、计算blob身份，并与历史Turbo 2.8.13的opencode#test:ci inputs清单核对。历史清单位于`tool_0ab44e71d001nL6bUGbeMNiow8`，补齐server.ts、dialog-prompt.test.tsx、httpapi-exercise/index.ts和httpapi-listen.test.ts的身份。整个过程没有新Git命令或Git内部读取。

| 当前独立实测 | 数值 |
| --- | ---: |
| 生产操作文件 | 16：15修改、1删除、0新增 |
| 测试文件 | 11 |
| 生产增加侧非空行A₀，含import/注释且不扣移动 | 518 |
| 已核实代码及完整注释原样移动M | 31 |
| 扣除已核实移动的A | 487 |
| 生产E / C | 366 / 93 |
| 测试E / C | 1392 / 246 |
| 总E / C | 1758 / 339 |
| 总C/E | 19.2833% |

auditor确认所有实质增加文件的C/E均超过10%，总量超过15%，增加量低于800；删除行没有抵扣增加量。E排除注释、完整import及已核实纯移动，C排除原样旧注释与无关说明；主交付采用更保守的A₀=518，不依赖相似度扣减。

N-01原文要点：auditor独立运行LinuxBun版本得到1.3.14，核对CI的30000参数；27项结果在该次复议中尚未读取原始执行输出，因此不登记为独立执行确认。其拒绝重跑含git:true的fixture，保留自身不执行Git的边界。最终原文：

> **BLOCK — R15当前实现仍待最终验证闭环。**
>
> 本轮明确关闭N-02，不再保留基线或A/E/C计量缺口。当前剩余事项属于N-01：审查Linux定向执行原始证据，并完成适用的最终验证。当前没有已证明的新增行为级阻断缺陷，但尚不能登记为完整实现发布批准。

上述计量已确认不代表最终APPROVE；状态继续为implementation-audit-required。最终测试须保留可直接读取的原始报告供同轮审计核验，不以父代理摘要替代。

## 34. 最终验证发现的新失败（未关闭）

在定向修复收敛后执行了一轮完整验证，原始日志保存在D:/Temp/opencode：r15-opencode-final.log、r15-httpapi-final.log、r15-core-final.log、r15-mcp-final.out.log及r15-mcp-final.err.log。typecheck退出0。HttpApi coverage/auth/effect各158通过、0失败、0skip/missing/extra；这三个门已在Linux原输入域完成。其余套件未通过，不能将§33计量通过表述为实现完成。

- OpenCode完整core片3648通过、8失败，TUI片766通过、3失败。失败涉及database maintenance CLI三项超时、legacy config不可写、SSE计数收尾、goal progress断言、stale-turn完成、write拒绝、daemon两项生命周期及语音后代就绪。具体名称及堆栈保留在原始日志。
- core包358通过、2失败，均为不可写目录拒绝测试。WSL默认身份实测uid=0；以既有smark普通用户运行两项原断言，2通过、0失败，证据r15-core-permissions-narrow.log。根用户执行与CI身份不等价，原358/2结果不计绿。
- MCP全量再次在viewport断言得到500x400后失败；R15固定窗口前提不足以证明波动已消除。后续同页面10次受控探针均成功，仅说明该探针未再复现，不能撤销完整套件失败。
- SSE已最小化为先运行httpapi-event.test.ts再运行httpapi-listen.test.ts：16通过、1失败，仍为SSE count未归零，日志r15-sse-event-order.log；仅compression前置组合通过。下一步需核对前置in-process流的取消与新测试的全局计数假设，尚未归因或修改生产。
- 语音后代就绪在普通用户下单项仍失败，日志r15-voice-child-narrow.log。挂载盘Bun空启动约4.15秒，原生Linux文件系统空启动约0.029秒，但改用同版本原生运行时后目标单项仍在2.5秒就绪断言失败，日志r15-voice-child-native.log；因此磁盘启动成本不是已证明的完整根因。原生工具位于/home/smark/.cache/opencode-r15-tools，版本保持Bun1.3.14/Node24.16.0；没有放宽就绪断言或业务期限。

本轮最终验证的失败使任务返回定向诊断阶段，不再重复全量长跑。当前独立计量所覆盖代码未因这些诊断改变，后续任何材料修复仍需修订同一plan并全范围审计。目标保持未完成，禁止提交/暂存/远端与Bun升级的边界继续保持。

## 35. R16 测试资源所有权与可观察完成点

最新用户原文：“应当准确全面完整完成相应的任务，并最终解决完所有问题，经过审计之后进行相应的 commit。”“不得工作到一半就直接报告停下，我再次声明一遍。”当前授权完整审计通过后的本地提交及必要的Git检查；仍不推送远端或升级Bun。未通过前保留原暂存内容，修复在工作区。§28–34的禁止commit记录是当时约束，不覆盖本次新授权。

本修订保持全部原需求、生产16文件及800行上限，生产实现不变；只调整两个已证实测试fixture的责任边界。R15只有方案批准，最终套件失败保持真实记录。

### SSE请求所有者

只读诊断任务ses_f4cbddb83ffeEh3PAqda2HfxZN将失败最小化为两个in-process/global/event请求：读取首事件后reader.cancel返回，但GlobalBus listener数不变、计数停在2；再运行新listener测试实际经历2→3→2，其要求1→0因前置资源残留失败。仅abort原两请求后计数依次1→0，新测试原样通过。原global.ts:76明确以Request.signal结束全局PassThrough、heartbeat与订阅，disposeAllInstances没有这些全局请求的所有权。

首个偏离位于test/server/httpapi-event.test.ts的viewer用例：142/145创建请求没有可控signal，185/186只取消reader；Bun1.3.14的raw Response reader取消在此不能替代请求结束。修复该用例，在两个请求之前建立同一个AbortController并传入两次request，finally先abort再保留原两个reader.cancel。两个流均属于该用例，controller无需进入生产；不改全局计数、不改新测试的归零断言、不增加生产清理分支。原双流投影断言和详细注释完整保留。

### viewport完成时序

只读诊断任务ses_f4cbddb06ffekAsYuN23tfZ7Kl在隔离about:blank可见浏览器、1200x900窗口中复现：clearDeviceMetricsOverride于2131.09ms确认，session于2131.53ms detach，2132.43ms读取仍500x400，2135.20ms布局已1178x809、2142ms JS同样恢复。生产与fixture各自保留session均可复现，故不是detach必然故障。一次sync、一次clear、无重试即可最终恢复；省略sync的两个负对照在2秒观察期保持500x400。仅加完成条件观察的12次探针通过，其中三次立即读仍500x400而6–10ms后恢复。

首个偏离是test-mcp.js同步调用后立即读取布局的断言时机；CDP应答并未承诺同tick页面布局已可见。生产helper维持协议调用合同，不添加轮询。仅在原单次sync后使用page.waitForFunction等待现有最终宽>700/高>500条件（5秒上界），然后执行原最终断言；不重试sync、不修改断言阈值、不增加固定sleep、不扩大已有每项60秒期限。新增等待仅观察结果，负对照证明它本身不能修复故障注入。

| 要求/反向映射 | owner与理由 | 文件/敏感验证 |
| --- | --- | --- |
| I07/I11及CI无资源残留 → SSE请求abort | 原fixture持有两个请求；生产已提供正确signal清理入口 | 既有test/server/httpapi-event.test.ts；同一进程先event再listen的17项组合从归零失败转绿 |
| 既有viewport恢复断言 → 可观察布局完成 | renderer异步完成，CDP确认不是布局barrier；测试拥有等待观察的责任 | 既有agent test-mcp.js；保留500pin、单次sync及恢复断言；负对照缺sync仍失败 |

新增生产文件/行/机制0，测试新增文件0。预计SSE E增加4行、C增加2行；viewport E增加1行、C增加2行；原注释完整保留。既有518生产A₀不变；整体E/C实施后重新计量，不直接沿用旧比率。删除/替换仅限SSE缺signal的请求参数与测试即时读取时序，无新备用成功路径，诊断生产决策面0%。

TDD：保留r15-sse-event-order.log的16pass/1fail及r15-mcp-final.err.log原500x400红证据；批准后先修SSE，运行`bun test test/server/httpapi-event.test.ts test/server/httpapi-listen.test.ts --timeout 30000`；再修viewport，执行`node test-mcp.js testViewportResyncClearsStaleLayoutSize testPrivateBrowserDoesNotExposeAutomationFlag`及原负对照。包级typecheck保持。其余全量失败先用普通用户、原生Linux源码与依赖路径复验，避免NTFS模块加载成本：同一原生Bun子进程cwd为挂载包时启动3715ms、/tmp时17ms。修正运行域不能替代未通过结果；DB、daemon和语音子进程失败未闭环前不宣告完成，也不扩大生产范围。

原源码与依赖的Linux原生副本位于/home/smark/.cache/opencode-r16-worktree，准备完成后只执行原失败名称，保持所有超时和断言。其他未证实生产问题不推动修复。R16材料改动须独立全范围方案审计，再实施和独立实现审计；最终所有门禁通过后才可按最新用户授权提交。

## 36. R16 最终实现证据

按批准R16完成两项测试修正，生产文件不新增修改：viewer用例同时拥有两个Request.signal并先abort再cancel reader；viewport保持一次sync，在CDP确认后等待原恢复条件可见。SSE前置组合从16pass/1fail变为17pass/0fail，原始日志r16-sse-green.log；viewport与marker组合2通过。typecheck与父/子仓库diff --check通过。

Linux普通用户smark、Bun1.3.14、Node24.16.0，源码与依赖位于原生文件系统/home/smark/.cache/opencode-r16-worktree。依赖仅从本机现有安装复制，无安装或下载（一次隔离安装请求被策略拒绝后未重试）。完整依赖闭包核对1870包、5060关系、948链接，必需缺失0；源码、测试、脚本逐文件checksum与主工作区一致，.git未复制。记录为r16-snapshot-dependencies.json、r16-import-readiness.json。最初不完整副本产生缺包失败，均保留原始日志；最终结果单列如下，不能把准备期失败删去。

| 最终验证 | 原始证据（D:/Temp/opencode/） | 结果 |
| --- | --- | --- |
| 原生Linux `bun run test:ci`，packages/opencode | r16-native-final-complete.log | core片3656通过/19既有skip/0失败；TUI片769通过/9既有skip/0失败；父runner退出0 |
| Linux普通用户 `bun run test:ci`，packages/core | r16-core-final.log | 360通过、0失败、658断言 |
| Linux `bun run test:httpapi`，packages/opencode | r15-httpapi-final.log | coverage/auth/effect各158通过、0fail/skip/missing/extra；R16仅两个测试fixture修正，没有改变这些路由 |
| Windows `bun typecheck`，packages/opencode | 工具原始退出0记录；r15-typecheck-final.log为前轮同生产版本 | R16修改后tsgo --noEmit退出0 |
| 隔离Linux构建及smoke | r16-build-final.log | 指定channel/version、--single --skip-install --skip-embed-web-ui；编译、Sharp、版本启动、voice Worker全部退出0 |

构建产物为快照packages/opencode/dist/opencode-linux-x64/bin/opencode，版本0.0.0-r16-verification。使用无网络命名空间及现有模型源码，不更新主仓库生成文件。build首次缺显式channel及has-flag依赖，分别通过既有环境入口和本地版本一致链接补齐；没有修改构建逻辑或安装包。

### 最终失败归因与关闭证据

root导致不可写测试假绿的执行域已改普通用户；core完整360通过。DB三项与daemon两项在原生源码/依赖副本按原时限5项全部通过，日志r16-native-remaining.log。语音后代就绪原断言在原生环境通过。Goal测试的四个工具最初因缺tree-sitter资源在执行前失败；补齐本地已装bash/powershell解析器后实际退出分别0/0/0/1、最终断言通过，生产Goal代码未改。完整最终suite再次覆盖并通过这些用例。

### MCP跨平台证据与未验证边界

r16-mcp-final.out.log在Windows记录连续67项PASS（包括修复后的viewport）后停在testVoicePageHealthCheck；无SUITE完成行，不能称Windows单次全套通过。隔离健康用例的独立文件输出r16-health-detached.err.log明确为spawnSync Node EPERM，执行工具在请求20–35秒超时时异常等待约1800秒。重复同机制没有给出有效业务失败，因此停止重复。只读诊断任务ses_f4bf42267ffeTEnwSO3pdcNdeG用WSL普通用户、Node24.16、Linux timeout25秒运行原健康用例：1通过，runtime内部4.5–9秒健康替换断言成立，测试总11.347秒。

余下六项按原命名过滤完整覆盖：健康用例及testTranscribeCancelDoesNotStartAnotherPath/testDirectVoiceSubmitsOnce在Linux分别1+2通过；testVoiceCancelSendSafeOnClosedRes/testEmptyAssistantTurnCompletes/testForegroundPulseInterval8s在Windows3通过，22.326秒。没有新增skip、改断言或改生产health逻辑。合计73个默认测试均有成功执行证据，但单次Windows npm test全套退出0未取得；该平台执行器EPERM属于最终需明确裁决的验证边界，不作隐瞒。syntax/deps阶段已有通过结果。真实账户R12验收保留历史性质，本轮未再次发送账户音频。

### 当前差异及审计

最新用户授权审计后commit后恢复必要的只读Git检查；至此未stage/commit/push。主工作区packages/opencode/config.json仅行尾状态、sdks/vscode/.gitignore及既有未跟踪目录均不属于本任务，不纳入提交。R16相对R15新增测试httpapi-event.test.ts及test-mcp.js等待注释；生产A₀仍518，最终E/C由新全范围实现审计对当前diff重新确认。当前任务未verified，须由auditor审查全部当前diff、最终日志及MCP执行域边界后裁决。

## 37. R17 保留既有fatal终止合同

R16全范围实现审计ses_f4b6f187cffejjiqKogFcKIjpI最终原文：

> **BLOCK — R16 当前实际实现差异。**
>
> 本轮完整审查形成一个必要阻断项 **B-01**。应在既有 owner 恢复 fatal 终止合同、补齐敏感回归，并提供 typecheck 原始结果后，进行同一原始完整范围的实现复审。当前不满足“审计通过后 commit”的前提。

**B-01原文标题：删除旧 request context 时丢失了既有 fatal 终止判定。** 已核对归属：基线chatgpt-core.js的request context在运行前检查runtime.fatalError，本次删除context后runVoiceRequest:2019只保留signal检查。runtime.fail:1742、withVoice:1873和runVoiceTranscribe:1992/2005仍形成可达producer/consumer：前项隔离失败设置sticky fatal，Promise队列启动已排队后项，daemon onFatal仅在setImmediate阶段启动退出，不能阻止更早的Promise任务。此遗漏违反R07/I07及§12保留fatal传播的合同，属于本次修改引入，需修复；不扩展无关故障处理。

唯一修正位置是既有runVoiceRequest的withVoice回调开头，在signal检查和validateVoiceInput之前加入`if (runtime.fatalError) throw runtime.fatalError`，恢复基线fatal优先顺序。复用原错误实例和原onFatal，不创建状态、护栏机制、恢复路径、额外重试或新公共接口。正常路径及固定120/40秒合同不变，生产文件仍16。

在既有testVoiceDeadlineAndForeground中强化最后stalled场景：前项已进入挂起的页面准备后，提交后项进入同一withVoice队列；后项使用同一fixture WAV，在前项仍持有队列时删除该文件，再取消前项以触发现有隔离失败。断言后项立即返回同一VOICE_RUNTIME_FATAL实例，不能返回ENOENT或等待自身取消。等待任务进入以fixture newPage就绪信号同步，不用sleep估计。保留已有fatal回调、页面隔离期限及取消后正常请求的断言。测试在缺fatal检查时确定性捕获后项非法继续，修复后绿。

| 双向映射 | 证据与owner | 文件与验证 |
| --- | --- | --- |
| R07/I07 → fatal先于文件读取/排队提交 | 前项取消不能隔离时runtime已产生fatal；旧context消费该事实 | chatgpt-core.js原runVoiceRequest入口恢复判定；test-mcp.js既有deadline用例覆盖排队后继 |
| 既有fatal检查 → 原可靠性不下降 | onFatal的setImmediate退出晚于Promise队列启动，不代替入口判定 | 后项必须传播同一错误且不消费已删除音频 |

预计生产增加侧+2行（1代码、1中文解释），E+1/C+1；测试E约12/C至少3，原注释完整保留。生产A₀预计520，低于800，新增文件0，新增生产诊断/备用路径0。当前实际R16独立计量E1763/C343、19.46%，该数为历史R16，R17实施后重新核算。R16审计已核验73个MCP默认用例跨平台覆盖、HttpApi三门158各通过、完整OpenCode4425通过、core360通过及构建smoke；Windows单次MCP套件的EPERM依然单列执行环境边界，不能推定为本修正对象。

TDD先执行`node test-mcp.js testVoiceDeadlineAndForeground`捕获RED，再修改原入口，执行GREEN及取消/排队相关测试；该mock-only用例可用已装LinuxNode加25秒timeout运行，避免Windows健康用例的执行异常。随后完整独立实现审计按全部原始需求复核当前diff，typecheck输出保留原始文件。当前材料修订递增R17，R16批准不授权本新增修正，必须先全范围方案审计。

R17实施结果：先补既有deadline用例中的真实排队后继场景。挂载盘Linux首次运行触发原fixture的5秒启动上界（r17-fatal-red.log），不将该超时当作目标RED；Windows同命令随后明确断言失败，actual为`Voice file does not exist`，expected为同一`VOICE_RUNTIME_FATAL`实例，约3.579秒。仅恢复入口fatal检查后，`node test-mcp.js testVoiceDeadlineAndForeground testQueuedVoiceCancelHasZeroSideEffects testVoiceTaskLifecycle testTranscribeCancelDoesNotStartAnotherPath testDirectVoiceSubmitsOnce`得到5通过、0失败、6.491秒，原始结果r17-fatal-green.log。未增加fixture期限或修改原生产取消期限。typecheck退出0，命令结果保留r17-typecheck.log及工具输出。所有日志在D:/Temp/opencode。父仓库生产未再改变，最终Linux4425+core360通过及构建证据仍对应同一父仓库生产内容；子模块本轮2行恢复和13行测试增加待完整独立复核。

## 38. R17 最终独立实现批准

全新上下文全范围实现审计及同轮证据复议：`ses_f4b5b9ca0ffe5X5l1RAoGOVDJ8`。最终原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R17，当前实际差异的全范围独立实现审计。**
>
> 同轮复议关闭 N-01、N-02，无剩余阻断项。批准仅适用于本轮核对的 R17 和实际实现差异；N-03 作为明确验证边界保留。

Non-blocking findings最终原文：

> **N-01 已关闭：** 同轮复议已独立执行 `bun typecheck`，成功退出。
>
> **N-02 已关闭：** 本轮通过 `readOnly:true` 数据库连接及 `PRAGMA query_only=ON`，直接核验历史工具记录，确认真实账户验收和目标 RED/GREEN；不再依赖转交文本或历史总结。
>
> **N-03 保留为验证边界：** Windows MCP 单次全套仍未取得成功退出记录；73 个默认用例已有跨平台成功执行证据。Windows 健康用例的 EPERM 不作为生产缺陷，也不表述为 Windows 全套通过。

审计核验的真实账户原始记录：Session `ses_f4d9fbc43ffe4ZVY8OOEKwGxKx` / Part `prt_0b2740d21001iNhDoHqU14unbL`，1通过/31断言/exit0；R17目标RED：Session `ses_f8aefd1efffer9qxMHqUeLpEtq` / Part `prt_0b4a2d47f001P7WD2XZH3atCvZ`，exit1且实际WAV不存在错误；GREEN同Session / Part `prt_0b4a36b02001SxE7SlmfZ8p63h`，5通过/exit0。上述只读原始来源核验不重新访问账户，不输出凭据。

最终独立计量：生产15修改、1删除、0新增；增加侧保守A₀=520、删除侧841独立列出，删除未抵扣。生产E366/C94，测试E1408/C253，合计E1774/C347、19.56%，所有E>0文件超过10%。排除空行、文档、import-only、完整纯移动及仅改注释的原代码行；合格C不包含搬移旧注释与显然说明。父/子diff --check均通过。

全范围路径裁决：共享后端唯一编排、用户指定profile/浏览器恢复、浏览器认证所有权、固定120/40秒、完整取消及原fatal终止合同通过；无新增隐藏重发、替代成功算法、取消状态机。此前R16 B-01生产问题通过R17修复和敏感回归关闭。最终4425个OpenCode、360个core测试、HttpApi三门各158、73个MCP跨平台覆盖、构建/Worker smoke及独立typecheck已核验。真实账户验收保留历史运行时属性，其后listener与fatal差异由当前1.3.14回归覆盖。

状态据本轮原文切为verified；按用户最新明确授权进入本地提交，保留hooks与无关工作区，不push。这次提交不宣称Windows MCP单次全套通过，不宣称已执行远端CI。

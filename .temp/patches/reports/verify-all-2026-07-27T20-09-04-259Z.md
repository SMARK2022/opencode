# Patch Dry Run verify-all-2026-07-27T20-09-04-259Z

- Source: `dev-smark`
- Source tip: `d0ceb469011412b4ac5058a12d5fe4f247bdac79`
- Mode: verify-all
- Target baseline: `4473fc3c9055046183990a965d68df3db7ea6f62`
- Manifest JSON SHA-256: `6f162934b5a1313c0df474a3c73db05bf0453a337d659cce38243b85dcaf2f5e`
- Manifest TSV SHA-256: `788f6cfd9b9b948311c00b7ce96e0c0a94748c56d56db7129daacca7c3325572`
- Patch count: 452
- Passed: 226
- Reused prefix: 0
- Replay base: exact target baseline
- Explicit rebuild: false
- Applied in this run: 226
- Stopped at: 227
- Temporary repo: `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/smark-patch-dry-run-Zli52q/repo`
- Materialized index: none
- State directory: none
- Retained states: none
- Source repository unchanged: false
- Target repository unchanged: true
- Simulation preflight: provenance verified at `4473fc3c9055046183990a965d68df3db7ea6f62`
- Integrity failure: source repository changed during dry-run




| # | SHA | Status | Phase | Reason | Subject |
|---:|---|---|---|---|---|
| 1 | `9f117055c5a8` | passed | apply | applied | feat(session): 添加同ClaudeCode一样的git上下文处理和配置选项逻辑 |
| 2 | `cebacb4b1518` | passed | apply | applied | feat(read): 增强文件读取功能，添加设备文件保护和恶意代码提醒 |
| 3 | `a461c299ff2a` | passed | apply | applied | feat(usage): 优化消息使用情况计算，添加输入和输出流量显示 |
| 4 | `bc7a6f1778b5` | passed | apply | applied | fix(session): 修复获取 git 上下文的调用方式，确保正确执行 |
| 5 | `6c994e2db366` | passed | apply | applied | feat(signal): 添加节流信号创建函数，优化性能和响应速度 feat(subagent-footer): 更新使用情况计算逻辑，添加工具输出字符估算 feat(context): 增强状态计算，支持工具输出字符估算 |
| 6 | `bb430162951a` | passed | apply | applied | feat(usage): 优化使用信息计算，确保在无回复时显示零值 |
| 7 | `984de21dfbca` | passed | apply | applied | feat(version): 添加版本环境加载功能，确保在模块评估时设置 OPENCODE_VERSION |
| 8 | `4d3c3d4e546a` | passed | apply | applied | feat(build): 添加操作系统过滤功能以优化目标构建 |
| 9 | `5b4ab2741b27` | passed | apply | applied | feat(prompt): 优化助手消息处理，包含tool_delta的token计算，确保在无助手消息时显示零值并计算总输入输出 |
| 10 | `fc6394523010` | passed | apply | applied | feat(signal): 添加createTokenFlowPulse函数，优化输入输出流动状态的管理 |
| 11 | `589bb20e905f` | passed | apply | applied | feat(version): 优化版本环境加载逻辑，支持通过--version参数设置OPENCODE_VERSION |
| 12 | `b1bf9c5a50ce` | passed | apply | applied | feat(usage): 添加总输入输出统计，优化助手消息处理逻辑 |
| 13 | `bbbf5f1dd94d` | passed | apply | applied | feat(provider): 添加claudecode提供者支持，集成API密钥和基本URL配置 |
| 14 | `61bcd2aae67c` | passed | apply | applied | feat(prompt): 优化请求助手的输入输出统计逻辑，确保在无助手消息时返回零值 |
| 15 | `d302fa6f05a7` | passed | apply | applied | feat(provider): 更新claudecode提供者以支持动态鉴权模式，优化API密钥和基本URL配置 |
| 16 | `9e14f85c9ad3` | passed | apply | applied | fix: 优化lastStepFinish的计算逻辑，确保在lastSFIdx有效时正确获取step-finish |
| 17 | `59dd32a7c758` | passed | apply | applied | feat: add session request usage tracking and management |
| 18 | `50eeb8a6c44c` | passed | apply | applied | chore: update version to 1.14.21-smark in package.json |
| 19 | `4b7f10eebc35` | passed | apply | applied | chore: set opencode version to 1.14.20-smark |
| 20 | `aa6db0f3264f` | passed | apply | applied | feat: 上下文提示词增强 enhance system prompt with environment details and tool usage guidelines |
| 21 | `b94a79527811` | passed | apply | applied | feat: 添加用户输入和请求开销估算功能，优化上下文管理 |
| 22 | `17b46ab162f5` | passed | apply | applied | feat: 添加 compact 格式化持续时间的功能，优化时间显示 |
| 23 | `b2b12b0abfcd` | passed | apply | applied | feat: 添加 extends 字段以支持从现有提供者类型继承模型和默认值，更新相关逻辑，同时添加claude的header |
| 24 | `5a7f139b02d1` | passed | apply | applied | feat: 优化输入文本处理和系统块合并逻辑，确保正确插入和保留原有字段 |
| 25 | `634fdbefd224` | passed | apply | applied | feat: 优化粘贴文本处理逻辑，确保虚拟占位符正确替换为原始内容，修复坐标系统不匹配问题 |
| 26 | `13fd8ab5dcbe` | passed | apply | applied | fix: 更新完整提示词，以确保工具使用说明的一致性和清晰度，同时增强并行调用 |
| 27 | `7dc9f1ab534a` | passed | apply | applied | refactor: 更新提示词和工具使用说明，增强一致性和清晰度，优化代码执行指导 |
| 28 | `ab8ce2ad4405` | passed | apply | applied | feat: 添加Bash输出压缩功能和相关配置 |
| 29 | `06d4a50185e4` | passed | apply | applied | feat: Enhance OpenCode with new prompt files and improve tool usage guidelines |
| 30 | `98ebae3df2df` | passed | apply | applied | fix: 添加Windows平台兼容性修改以解决管道读取乱码问题 |
| 31 | `6285c0741261` | passed | apply | applied | fix: 更新 Flag 模块导入路径以适配上游架构重构 |
| 32 | `b815a5764d5b` | passed | apply | applied | feat: 添加高熵行压缩和增强的诊断上下文收集功能 |
| 33 | `6dd9afdea412` | passed | apply | applied | feat: 添加交互式和审查代理，增强权限管理和描述 |
| 34 | `90b112f8bbf3` | passed | apply | applied | fix: 修复计算最终令牌时的输入和总输入逻辑 |
| 35 | `0a3cda97c01a` | passed | apply | applied | feat: 更新滚动视图组件，增强可视化和交互性，支持动态展开和收缩 |
| 36 | `1e324d225d2a` | passed | apply | applied | feat: 增强差异视图，添加行统计信息，优化显示逻辑 |
| 37 | `20058ecde936` | passed | apply | applied | feat: 添加 GitHub Actions 工作流以构建和打包 OpenCode CLI 支持 Linux、macOS 和 Windows |
| 38 | `d870520f1284` | passed | apply | applied | feat: add multi-platform build workflow with auto-trigger on dev-smark push |
| 39 | `0e50e973aad3` | passed | apply | applied | fix: add node-gyp dep, setup-node/python/msbuild for Windows build, fix DEB control indent |
| 40 | `8f6444e154d0` | passed | apply | applied | fix: 清理构建脚本中的多余空行，优化 Debian 控制文件格式 |
| 41 | `990ddcb47d35` | passed | apply | applied | feat: 将会话压缩功能的选择处理改为异步，添加加载提示和错误处理 |
| 42 | `16656033a664` | passed | apply | applied | fix: 更新 BashTool 中的配置服务引用，简化代码逻辑 |
| 43 | `630dd666663c` | passed | apply | applied | feat: 增加数据集鲁棒性、自动重试机制添加 OPENCODE_DB_DURABLE 标志，更新数据库配置和工具输入缓冲逻辑 |
| 44 | `d653e1fc1bd1` | passed | apply | applied | feat: enhance tool usage guidance and add context usage tests |
| 45 | `6380ed0b8d91` | passed | apply | applied | feat: 优化文件去重缓存逻辑，添加缓存预热机制和文件读取结果检查 |
| 46 | `f13fd00acfde` | passed | apply | applied | fix: 修正上下文使用统计中的输出计算逻辑，更新测试用例以反映更改 |
| 47 | `e6094d52b0a6` | passed | apply | applied | feat: implement daemon lifecycle management and server lock handling |
| 48 | `f9d2e647d8b2` | passed | apply | applied | feat: 增强工具使用指导，添加 Git 命令安全协议和多工具使用建议 |
| 49 | `90c84e172f41` | passed | apply | applied | fix: 调整工具超时和过期设置，优化工具定义处理逻辑，增强错误处理 |
| 50 | `f40e2d369552` | passed | apply | applied | feat: 更新摘要模板，增强用户目标和约束的描述，优化输出结构和内容要求 |
| 51 | `841752f540b7` | passed | apply | applied | fix: 更新构建账单头块的注释，优化占位符替换机制，调整工具使用部分的输出顺序 |
| 52 | `a6e3b3cdafde` | passed | apply | applied | fix: 修复 TUI 命令的环境变量代理处理逻辑，增强代码可读性 |
| 53 | `e3bbe56b86ac` | passed | apply | applied | fix: 优化会话初始化逻辑，防止异步消息加载和面板重挂导致的模型选择重置 |
| 54 | `d09a5763d22f` | passed | apply | applied | fix: post-merge test and code fixes |
| 55 | `0a0eb2e94edc` | passed | apply | applied | fix: PowerShell UTF-8 output encoding on Windows |
| 56 | `0734b2e81cc3` | passed | apply | applied | fix: 更新版本号至 1.14.29，优化环境变量处理逻辑，增强插件预热功能 |
| 57 | `3a94dd4d0991` | passed | apply | applied | fix: 添加会话状态检查以优化待处理消息逻辑 |
| 58 | `dbfd53e1cd52` | passed | apply | applied | fix: 强制使用 Unicode 宽度表以解决 macOS 上 CJK 字符渲染问题 |
| 59 | `1efc5c8a2a1e` | passed | apply | applied | fix: add sharp as an optional dependency and improve type handling in media.ts |
| 60 | `2e51523e5589` | passed | apply | applied | fix: 强制使用 Unicode 宽度表并优化 macOS 上终端尺寸初始化逻辑 |
| 61 | `145dea7da6ae` | passed | apply | applied | fix: 优化可用缓冲区计算逻辑，确保更合理的默认值处理 |
| 62 | `40e2013bd43e` | passed | apply | applied | fix: 添加守护进程启动和服务器选举超时常量，并更新相关逻辑 |
| 63 | `1f2d2e958b69` | passed | apply | applied | feat: 添加请求使用情况相关的 API 处理逻辑和数据结构 |
| 64 | `b4bf93f8cbcd` | passed | apply | applied | feat: 优化 token 估算逻辑，支持从服务端获取实时输入 token 估算 |
| 65 | `8304c6752cef` | passed | apply | applied | fix: 更新最大字节数限制，从 51200 调整为 24576，以优化内存使用 |
| 66 | `59b83d40cd60` | passed | apply | applied | fix: 将最大行数限制从 2000 调整为 1000，以优化工具输出的处理 |
| 67 | `a6b9a6a56d92` | passed | apply | applied | feat: 添加父代理权限过滤逻辑，以增强任务会话的权限管理 |
| 68 | `43455e508d78` | passed | apply | applied | feat: 优化助手消息组件，添加可展开的推理部分预览功能 |
| 69 | `d34ed37bb4c4` | passed | apply | applied | feat: 增加notebook的IDE运行时功能 |
| 70 | `efae0086f406` | passed | apply | applied | feat: 整个IDE侧插件sdk结构重构，构建tools |
| 71 | `d95dc89b856d` | passed | apply | applied | feat: 引入网络代理功能，优化npm配置和请求处理 |
| 72 | `a09787f293c9` | passed | apply | applied | feat: 通过结合输入字符计数和细分来增强token估计 |
| 73 | `f75419bd78c5` | passed | apply | applied | feat: 增强网络代理功能，安装全局fetch并优化npm配置中的超时设置 |
| 74 | `4d55a2c0f4a3` | passed | apply | applied | feat: 增加工具调用和工具结果的独立分类，优化上下文使用数据计算 |
| 75 | `4141d5e979ff` | passed | apply | applied | feat: 延迟测试，增加API URL的默认配置，优化模型API的获取逻辑 |
| 76 | `c9d477841b7d` | passed | apply | applied | feat: 优化代理路由逻辑，调整TTL常量，增强插件模块的插件导出处理 |
| 77 | `9768471cf3fc` | passed | apply | applied | feat: 增强claudecode配置，支持推断Anthropic思维变体并扩展提供者功能 |
| 78 | `3bab13f27c2f` | passed | apply | applied | feat(notebook): 工具逻辑及schema、summary完整重构 enhance cell identification and output handling |
| 79 | `8812fd3d588b` | passed | apply | applied | feat(notebook): 优化编辑操作文档，增强字符串匹配逻辑及上下文构建 |
| 80 | `0a8361dfa4d3` | passed | apply | applied | feat(notebook): 强化笔记本命令和环境解析，优化错误处理和参数验证 |
| 81 | `85442a1f1e68` | passed | apply | applied | feat(notebook): 优化虚拟文档行范围计算，修正行号处理逻辑，增强源代码渲染效率 |
| 82 | `afccfe84a555` | passed | apply | applied | feat(vscode): 添加VS Code桥接功能，支持笔记本摘要、源代码读取、执行和编辑操作 |
| 83 | `2e8c148edf30` | passed | apply | applied | feat(network-proxy): 引入NetworkProxy以支持插件和提供者的fetch请求，增强代理处理能力 |
| 84 | `7759649fd14d` | passed | apply | applied | feat(vscode): 增强笔记本请求处理，添加文件锁机制以序列化请求，优化运行逻辑 |
| 85 | `66ddc4e2fe6c` | passed | apply | applied | feat(token-estimate): 优化字符与token计算，考虑附件对输入字符的影响 |
| 86 | `3c72d78b8cb1` | passed | apply | applied | feat(write): 添加文件覆盖时生成diff功能，支持TUI以git diff形式展示变更 |
| 87 | `930624b8faea` | passed | apply | applied | feat(vscode): 更新桥接功能，移除环境变量支持，增强注册表桥接选择逻辑 |
| 88 | `284c6bf1663e` | passed | apply | applied | feat(bash-compress): 添加对PowerShell CLIXML输出的检测与解码功能 |
| 89 | `94eb97b93fad` | passed | apply | applied | feat(vscode): 更新OpenCode VS Code桥接，修改扩展ID并添加许可证文件 |
| 90 | `56bce83a059b` | passed | apply | applied | feat(read): 更新默认读取行数为400，调整输出字节限制至24KB，移除行长度截断逻辑 |
| 91 | `124adc90ec7c` | passed | apply | applied | feat(vscode): 添加重启Jupyter内核功能，支持清除运行状态并记录重启原因 |
| 92 | `2f1ab5812e3b` | passed | apply | applied | feat(vscode): 重构笔记本环境操作，合并内核重启功能，增强操作描述与超时设置 |
| 93 | `3ae1d112f256` | passed | apply | applied | feat(vscode): 更新笔记本环境描述，增强内核选择和配置的诊断信息 |
| 94 | `81efcbb1d8cb` | passed | apply | applied | feat(notebook): 优化单元源代码渲染逻辑，调整字节限制和行数限制处理 |
| 95 | `4dec9d15826f` | passed | apply | applied | feat(tools): 添加工具管理功能，优化权限合并逻辑，更新工具可用性检查 |
| 96 | `254082aeca0d` | passed | apply | applied | feat(docs): 添加 WSL 迁移与跨平台构建指南，记录构建过程及解决方案 |
| 97 | `ace5c5841350` | passed | apply | applied | feat(docs): 更新 README 和 package.json，修正扩展名称和描述，添加主页链接 feat(bridge): 修改注释以统一 OpenCode 表述，优化 HTTP 端点描述 feat(extension): 更新注释以统一 OpenCode 表述，调整功能描述 |
| 98 | `f4304858229c` | passed | apply | applied | feat(session): 添加隐藏消息处理逻辑，支持撤销操作并在数据库中保留隐藏消息 |
| 99 | `707d679466ec` | passed | apply | applied | feat(agent): 添加 VSCode 笔记本相关权限选项，更新计划模式描述，优化消息使用统计逻辑 |
| 100 | `06db750ab9a8` | passed | apply | applied | chore: update bunfig.toml to use hoisted linker and remove deprecated dependencies from package.json |
| 101 | `d2a0ec015c74` | passed | apply | applied | feat(vscode): 添加对 VSCode 笔记本的运行和环境选项支持，优化单元格 ID 解析逻辑 |
| 102 | `ad41ba3737b0` | passed | apply | applied | fix: 更新 poe-oauth 版本为 0.0.6，并在 overrides 中添加相应配置 |
| 103 | `74a9ca56ea81` | passed | apply | applied | feat(build): 添加对 Windows 构建的架构支持，优化打包逻辑 |
| 104 | `d00a0ceaca35` | passed | apply | applied | feat(ci): 优化构建流程，添加版本自动提取和资产上传功能 |
| 105 | `e8675ce41599` | passed | apply | applied | feat(vscode): 更新 VSCode 笔记本描述和编辑逻辑，增强单元格 ID 解析和错误处理 |
| 106 | `ed792909b777` | passed | apply | applied | feat(session): 添加 includeHidden 参数以支持隐藏消息的过滤 |
| 107 | `f0f0c3a6ddb3` | passed | apply | applied | feat(prompt): 添加 renderBefore 属性以优化 box 渲染逻辑 |
| 108 | `e863ec34839c` | passed | apply | applied | feat(tui): 优化 macOS 和 Windows 的终端宽度处理逻辑，支持用户覆盖设置 feat(loader): 修复 Windows 平台下的插件加载路径问题 test: 在 Windows 平台下跳过特定的插件加载测试 fix: 更新权限检查逻辑以支持更多错误代码 test: 更新 shell 和 bash 测试以适应 Windows 环境 |
| 109 | `14d55305badb` | passed | apply | applied | feat: 更新版本号至 1.14.32-smark，并优化滚动条渲染逻辑 |
| 110 | `b6690c2cc860` | passed | apply | applied | feat: 更新版本号至 1.14.32，并优化 VSIX 打包逻辑以避免 Windows 环境中的 npm 路径问题 |
| 111 | `a6a79e01fb18` | passed | apply | applied | feat: 优化 BlockTool 组件的可折叠逻辑，使用 createMemo 和 createSignal 提升性能 |
| 112 | `c3c396034afb` | passed | apply | applied | feat(dialog): 添加预览行支持至 DialogSelect 组件，优化选项展示逻辑 |
| 113 | `c48d9fa920c3` | passed | apply | applied | feat(session): 重构会话标题逻辑，添加默认标题创建和验证功能 |
| 114 | `51a0d39deb33` | passed | apply | applied | feat(provider): 添加别名支持，允许多个提供者独立管理身份验证和模型继承 |
| 115 | `6e38594c33fc` | passed | apply | applied | feat(dialog-session-list): 增加会话列表预览行数至 2 |
| 116 | `9ab94ccbe257` | passed | apply | applied | feat(shell): 添加输出压缩选项以优化重复输出处理 feat(session): 重构会话信息命令以使用效果处理 fix(stats): 更新导入路径以适应新结构 fix(editor): 优化连接变量命名以提高可读性 fix(context-usage): 更新 Bash 描述文件路径以反映新位置 fix(worker): 修复实例处置逻辑以确保正确关闭 |
| 117 | `5cc79572420d` | passed | apply | applied | fix(tests): 更新提供者实例引用为 WithInstance，以确保测试一致性 |
| 118 | `31b18c9638b2` | passed | apply | applied | chore: 更新版本号至 1.14.39，确保一致性并反映最新更改 |
| 119 | `5a7024df0d07` | passed | apply | applied | fix(husky): 修复 Windows 上 Bun 命令路径问题，确保脚本正常执行 |
| 120 | `ca04b07955c0` | passed | apply | applied | fix: 对话列表显示更新，更新版本号至 1.14.39.0，并修复 ESLint 配置中的警告规则 |
| 121 | `fdb0447556ad` | passed | apply | applied | feat(search): 添加搜索条件功能，支持通过标题或消息内容过滤会话 |
| 122 | `1ca386e353ce` | passed | apply | applied | feat: token估计流重构。implement token accounting for precise token statistics and breakdown |
| 123 | `f3dd3027163e` | passed | apply | applied | fix(session): 确保在首次渲染前保持 local 可用，避免 Bun 的 TDZ 检查抛出错误 |
| 124 | `5959a791ff08` | passed | apply | applied | feat(token-accounting): 增强输入字符统计，支持在流式处理期间从 step-start 提供 breakdown 信息 |
| 125 | `0cd54998e45f` | passed | apply | applied | feat(prompt): 重构提示框，添加流式处理期间的时间显示功能 feat(editor): 添加 bridgeUriToPath 函数以处理不同 URI 格式 fix(context-usage): 优化上下文使用面板，添加输入信号节流以提高性能 |
| 126 | `f5f094895bf7` | passed | apply | applied | feat(text-decoding): 添加自动文本解码器，支持UTF-8和UTF-16LE编码的检测与解码 |
| 127 | `2b4a23f05567` | passed | apply | applied | feat(token-accounting): 增强输入字符统计，添加请求体字符数和估算token信息 |
| 128 | `831d4846313a` | passed | apply | applied | feat(text-decoding): 添加对多种文本编码的支持，包括自动检测和显式编码策略 |
| 129 | `3ff2620ec160` | passed | apply | applied | feat(powerShell): 添加对PowerShell CLIXML输出的解码和规范化功能，确保输出为纯文本 |
| 130 | `43948adfded9` | passed | apply | applied | feat(shell): 更新PowerShell输出处理，确保原生stderr字节保持不变并进行规范化 |
| 131 | `5baa17d8044d` | passed | apply | applied | feat(line-ending): 添加行结束符处理功能，确保补丁应用时保留原始行结束符 |
| 132 | `afbe5289aa45` | passed | apply | applied | feat(session-path): 添加会话路径处理功能，支持Windows全局会话路径的规范化和兼容性 |
| 133 | `9897db4108a7` | passed | apply | applied | feat(version): 更新所有相关包的版本号至1.14.40 |
| 134 | `a5ea69d8ea80` | passed | apply | applied | feat(directory-normalization): 添加目录规范化功能，优化Windows路径比较 |
| 135 | `3bed2cfd5377` | passed | apply | applied | feat(session): 添加流式消息处理，优化助手消息和推理部分的渲染 |
| 136 | `95a96c38e940` | passed | apply | applied | feat(context-usage): 添加指令和技能的处理逻辑，优化上下文数据计算 |
| 137 | `daf41ca522c4` | passed | apply | applied | feat(session): 添加工具完成状态更新和手动压缩功能，优化会话管理 feat(text-part): 优化文本部分的渲染逻辑，支持动态内容更新和流式处理 |
| 138 | `563ac8f18e67` | passed | apply | applied | feat(ripgrep): 添加最大文件和结果限制，优化搜索功能并处理过于广泛的搜索错误 |
| 139 | `b5b29eabb82f` | passed | apply | applied | feat: 增强TUI中的会话处理和错误恢复 |
| 140 | `8acb3fecbfe7` | passed | apply | applied | feat(session): 添加输入字符和令牌估算功能，优化会话压缩逻辑 |
| 141 | `190d962e1dd8` | passed | apply | applied | feat: 更新所有包的版本号至1.14.41，确保一致性和兼容性 |
| 142 | `17b9d5b4f3ed` | passed | apply | applied | feat(read): 完整重构read工具、通过元数据处理和存根逻辑增强读取工具，提高上下文管理健壮性 enhance read tool with metadata handling and stub logic |
| 143 | `238079f024c9` | passed | apply | applied | feat: 更新所有相关包的版本号至1.14.41，session路径管理增强会话管理和路径处理功能 |
| 144 | `f019cdd5688a` | passed | apply | applied | feat(session): 增强会话组件，添加内容预览功能和自定义边框处理 |
| 145 | `0277deba5044` | passed | apply | applied | feat(read): 保留XML敏感内容，优化输出结构，确保内容一致性 |
| 146 | `77ec24d3c406` | passed | apply | applied | chore: update package.json to add overrides for @opentui/core and @opentui/solid |
| 147 | `f0cc012dbc26` | passed | apply | applied | feat(provider): 添加版本覆盖选项，支持自定义提供者的客户端版本 |
| 148 | `8e4a9b2768ca` | passed | apply | applied | feat: 更新所有相关包的版本号至1.14.42 |
| 149 | `36b84e5de2ce` | passed | apply | applied | feat: 1.14.42 对macOS完整进行test问题修正 更新测试用例以增强跨平台路径解析和工具执行的中断处理 |
| 150 | `7636c268c285` | passed | apply | applied | feat(test): 添加网络代理测试用例，确保全局fetch被mock时仍能正确路由 feat(provider): 移除HttpClient依赖，优化模型服务层 feat(test): 增加任务工具取消传播的测试，确保子会话状态正确 |
| 151 | `10f01867e270` | passed | apply | applied | feat(interrupt): 添加中断处理功能，支持会话中断计数和确认时间 |
| 152 | `a79689db16e7` | passed | apply | applied | feat: 增强会话和活动管理，优化心跳机制和守护进程处理 |
| 153 | `188cbee1b73a` | passed | apply | applied | feat: 一堆Bug修改 Enhance session handling and event publishing |
| 154 | `5231d218989e` | passed | apply | applied | feat: 添加预览差异功能和会话助手状态管理，优化diff显示和状态刷新逻辑 |
| 155 | `69f32338dd55` | passed | apply | applied | feat: 添加文本清理功能，确保终端输出中的控制字符被正确转义 |
| 156 | `dacb88948bac` | passed | apply | applied | feat: 更新安装脚本，支持版本指定和环境变量配置，增强错误处理和输出信息 |
| 157 | `3fc69fb245af` | passed | apply | applied | feat: 增强上下文使用快照功能，支持流式工具输入增量跟踪 |
| 158 | `232979d4fecf` | passed | apply | applied | feat: 增强shell兼容性，支持在远程ssh和本地wsl命令中使用Unix命令，添加相应的错误处理和测试用例 |
| 159 | `1ce61c81d52f` | passed | apply | applied | feat: 添加决策模式代理，更新相关数据库迁移和测试用例，确保代理状态和权限正确 |
| 160 | `589d2624d7cc` | passed | apply | applied | feat: 增强字符串截断功能，避免分割代理对，添加相关单元测试 |
| 161 | `7508670afb77` | passed | apply | applied | feat: 更新版本号至 1.15.3，修改相关文档和配置文件 |
| 162 | `350a442717d5` | passed | apply | applied | Refactor tests and add new functionality |
| 163 | `fce16528f4e5` | passed | apply | applied | Refine tool usage policy in anthropic.txt for clarity and specificity |
| 164 | `970ee408ae8c` | passed | apply | applied | feat: enhance event handling and add tests for streaming semantics |
| 165 | `2e65029d4e34` | passed | apply | applied | feat: 更新 TUI 架构，禁用 RPC-thread，优化事件处理与测试 |
| 166 | `442fd61eabf4` | passed | apply | applied | feat: 修复剩余 typecheck 错误，迁移 TUI keymap/API，扩展 daemon lock 接口 |
| 167 | `f2d3d0d44b8a` | passed | apply | applied | feat(install): enhance installation script with new options and profile handling |
| 168 | `2c720138d339` | passed | apply | applied | feat(provider): add support for custom HTTP headers and User-Agent handling |
| 169 | `704fe8025779` | passed | apply | applied | feat(codex): 添加支持自定义 HTTP 头和 User-Agent 处理，更新相关测试 |
| 170 | `a686ccf720d6` | passed | apply | applied | feat: 更新 Windows 构建流程，使用新的 Bun 安装方式并添加依赖安装步骤 |
| 171 | `49650e2f95ff` | passed | apply | applied | feat: 重构TUI以使用IDE网桥注册表进行活动文件发现(移除port推送) Refactor TUI to use IDE bridge registry for active file discovery |
| 172 | `595b0e8f3ede` | passed | apply | applied | feat(text-decoding): buffer short ASCII prefixes to improve UTF-16LE detection |
| 173 | `59aeb3d239f3` | passed | apply | applied | feat: 支持通过环境变量配置守护进程的空闲超时时间，并添加相应的测试 |
| 174 | `57eecce76b03` | passed | apply | applied | feat: stats入口构建，增加统计图表 Refactor stats command structure and enhance rendering capabilities |
| 175 | `f0a47a144866` | passed | apply | applied | feat: 引入附件令牌估算，增强媒体处理能力并更新相关逻辑 |
| 176 | `1a88ba6a6e8c` | passed | apply | applied | feat: stats端点信息丰富与重构 add insights and rendering for stats analysis |
| 177 | `9a6cfa492fb9` | passed | apply | applied | feat: 更新统计功能，调整排序逻辑并引入工具使用数据 |
| 178 | `595de9b00543` | passed | apply | applied | feat: 调整输出字节限制至16 KB，更新相关文档与描述 |
| 179 | `6283df82e6f6` | passed | apply | applied | feat: 增强守护进程启动逻辑，处理退出状态并更新错误消息；改进测试用例以验证守护进程行为 |
| 180 | `201e910402a2` | passed | apply | applied | feat: 重构会话获取逻辑，优化工具事件处理，增强统计数据的准确性 |
| 181 | `27a7a17c5972` | passed | apply | applied | feat: 添加响应式仪表板活动的测试，确保折叠的顶部表格正确显示 |
| 182 | `aa18b74b8186` | passed | apply | applied | feat: enhance dashboard rendering with new responsive layout and improved visualizations |
| 183 | `8facd64e2708` | passed | apply | applied | feat: 添加人性化的日期标签和图表刻度，优化统计数据的可读性 |
| 184 | `d7b11daa5ef7` | passed | apply | applied | feat: 添加会话布局相关功能，优化消息内容宽度计算及测试用例 |
| 185 | `a505b9721c87` | passed | apply | applied | feat: 更新 AssistantMessage 和 InlineTool 组件的消息间距逻辑，增强消息渲染效果 |
| 186 | `89c4f7d15a48` | passed | apply | applied | feat: 优化消息增量的性能，增强同步功能，添加部分增量合并逻辑和相关测试用例 |
| 187 | `7f397680e3f4` | passed | apply | applied | feat: 增加删改行数实时显示；添加待处理工具输入解析器和相关统计功能，优化编辑和补丁工具的消息显示 |
| 188 | `0e387c9920b2` | passed | apply | applied | feat: 更新 read.txt，添加成功编辑后跳过重新读取文件的说明 |
| 189 | `ff399b61bde1` | passed | apply | applied | feat: 工具写入节流阈值、信息配置修改 Increase pending tool input progress interval from 200ms to 50ms for improved responsivenessRefactor prompt width handling and adjust pending tool input stats display |
| 190 | `8d2352918cad` | passed | apply | applied | feat: 新增 TDD 实现指南，明确代码修改和测试要求 |
| 191 | `a8478caff8aa` | passed | apply | applied | feat: 增强错误处理，添加对特定超时和连接错误的重试逻辑 |
| 192 | `b47dd66b83c5` | passed | apply | applied | fix: 修复重连与提交失败恢复边界 |
| 193 | `cac74b551de1` | passed | apply | applied | refactor: move token helpers into token domain |
| 194 | `454703956a2b` | passed | apply | applied | fix: align upload token estimates with confirmed usage |
| 195 | `bb5a2b41f258` | passed | apply | applied | feat: models-snapshot.js更新 |
| 196 | `998d3ca0f789` | passed | apply | applied | feat(permission): add auto review config schema |
| 197 | `38863f98f871` | passed | apply | applied | feat(permission): add deterministic shell precheck |
| 198 | `09fcecbcdcc7` | passed | apply | applied | feat(permission): add reviewer auto decision service |
| 199 | `7e2a92c8e5f4` | passed | apply | applied | feat(permission): wire auto review into permission flow |
| 200 | `d4f24d4434a4` | passed | apply | applied | feat(permission): isolate hidden reviewer protocol |
| 201 | `eb266f39a9e4` | passed | apply | applied | feat(permission): 增加Auto智能体以应用auto权限路由，add Auto agent with explicit selection and behavior tests |
| 202 | `8ae5a36f9407` | passed | apply | applied | refactor: 权限边界与系统更新update permission schema and tests for precheck levels |
| 203 | `773ad40748fa` | passed | apply | applied | feat: 串联修正auto路由逻辑 Enhance permission handling for shell commands and external directory access |
| 204 | `d7eb5239e44a` | passed | apply | applied | feat(session): 压缩逻辑优化 enhance filterCompacted to handle message ordering |
| 205 | `5f3d18e85b8a` | passed | apply | applied | feat(compaction): 优化compact逻辑，避免虚假tailid导致上下文组装故障；增强消息过滤逻辑以支持隐藏消息作为边界（但不包含） |
| 206 | `4847e716422f` | passed | apply | applied | feat(policy): 更新自动审查策略，调整敏感信息读取风险评估和证据处理逻辑 feat(prompt): 改进用户提示构建，确保只使用可见证据并明确区分用户意图 refactor(transcript): 优化转录处理，增强可见性和上下文保留，确保短缩条目标记 test(transcript): 增加转录测试，验证可见性和授权证据处理 |
| 207 | `d3f25aad5ba7` | passed | apply | applied | feat(shell): 增强WSL和SSH命令的权限处理，确保正确区分主机和远程命令的权限请求 |
| 208 | `d476e71e61d5` | passed | apply | applied | feat(permission): 增强权限审查逻辑，添加reviewID以跟踪审查过程并记录审查开始事件 |
| 209 | `12663b5e09f2` | passed | apply | applied | feat: 增强自动审批系统，enhance permission reviewer functionality and transcript handling |
| 210 | `3bb4262388d1` | passed | apply | applied | feat(permission): 增强外部目录权限处理，支持工具来源证据以优化自动审查决策 |
| 211 | `416bf11aef21` | passed | apply | applied | feat(docs): 移动开发指南，明确TDD流程和实现要求 |
| 212 | `26bf6a4193b6` | passed | apply | applied | feat(session): 增强会话视口处理，确保流式增长时底部内容可见 |
| 213 | `cb7fb80142be` | passed | apply | applied | feat(session): 点击任务工具时打开子代理会话并强制刷新过期会话 |
| 214 | `347a9a0057be` | passed | apply | applied | feat(auto-review): 添加工具自动审查上下文，优化工具部分的审查状态渲染且保持重试机制  Enhance permission review process with auto-review metadata and retry logic |
| 215 | `9e190548fc7a` | passed | apply | applied | feat(terminal): 增强虚拟终端显示，支持部分控制序列缓冲和最大行数/字符限制 |
| 216 | `4e7e1efcbdc8` | passed | apply | applied | feat(auto-review): 增加对工具执行中止的支持，更新状态和错误处理逻辑 |
| 217 | `5aff2e10e3e9` | passed | apply | applied | feat(precheck): 增强命令评估逻辑，添加对文件删除和移动操作的审查，确保安全性 |
| 218 | `39c1c1755bf1` | passed | apply | applied | fix(package): 修正版本号格式，确保与发布一致 |
| 219 | `dddd6516ffad` | passed | apply | applied | feat(vscode-bridge): 增强桥接发现逻辑，处理损坏的注册表条目并优化文件读取 feat(bridge-registry): 改进注册表文件写入逻辑，使用临时文件确保数据完整性 |
| 220 | `0436a82b95aa` | passed | apply | applied | feat: precheck增强，enhance permission precheck tests with new classifications and scenarios |
| 221 | `aa1d0d27c371` | passed | apply | applied | fix(shell): 修改 PowerShell 模块的日志偏好设置为默认静默，避免输出污染 |
| 222 | `8627ea829ffd` | passed | apply | applied | feat(precheck): 增强文件删除和移动命令的审查逻辑，添加对 find 和 Python 删除操作的支持 |
| 223 | `f71acd28f654` | passed | apply | applied | feat(vscode-bridge): 增强 VS Code 桥接插件的权限检查逻辑，确保 notebook 编辑和环境操作的权限管理更精确 |
| 224 | `1b8b8b9dae13` | passed | apply | applied | feat: add notebook editing capabilities and metadata handling |
| 225 | `563ee64fea94` | passed | apply | applied | fix: 统一使用小写的 "auto" 替代 "Auto" 以保持一致性 |
| 226 | `d1d940d70f5a` | passed | apply | applied | feat: add design document for opencode Windows Sandbox migration |
| 227 | `b2cf8c8369d1` | failed | check | conflict | feat(permission-reviewer): 增强自动权限审查逻辑，支持 JSON 文本决策和协议重试机制 |

## Failure Output

### #227 b2cf8c8369d12a33cbc6aae0b4c027ef5a22dec1

```text
Checking patch packages/opencode/src/permission/reviewer/prompt.ts...
error: while searching for:

export const DEFAULT_TENANT_POLICY = DEFAULT_POLICY

// The text contract intentionally describes the exact JSON literals even though
// generateObject also receives a schema. Some providers degrade to prompt-only
// validation, so the prompt and schema both carry the same allow/deny contract.
const OUTPUT_CONTRACT_PROMPT = `\
Decide from the supplied transcript, planned action, and policy. Use transcript only to establish user intent, scope, authorization, and local evidence. Your final message must be strict JSON.

Use this JSON schema for every decision, including low-risk allows:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "user_authorization": "unknown" | "low" | "medium" | "high",

error: patch failed: packages/opencode/src/permission/reviewer/prompt.ts:24
error: packages/opencode/src/permission/reviewer/prompt.ts: patch does not apply
Checking patch packages/opencode/src/permission/reviewer/service.ts...
error: while searching for:
export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionReviewer") {}

const REVIEWER_MESSAGE_FETCH_LIMIT = 120

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

error: patch failed: packages/opencode/src/permission/reviewer/service.ts:51
error: packages/opencode/src/permission/reviewer/service.ts: patch does not apply
Checking patch packages/opencode/src/session/message-v2.ts...
error: while searching for:
export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

// [local-smark] Hidden message support for undo/repair
const Hidden = Schema.Struct({
  time: NonNegativeInt,
  reason: Schema.Literals(["undo", "repair-empty-dangling-assistant"]),
})

// OutputLengthError is re-exported from ./message-error above

error: patch failed: packages/opencode/src/session/message-v2.ts:66
error: packages/opencode/src/session/message-v2.ts: patch does not apply
Checking patch packages/opencode/test/session/prompt.test.ts...
error: while searching for:
  { git: true },
)

it.instance(
  "auto permission reviewer retries transient provider failures before recording the decision",
  () =>

error: patch failed: packages/opencode/test/session/prompt.test.ts:839
error: packages/opencode/test/session/prompt.test.ts: patch does not apply

```




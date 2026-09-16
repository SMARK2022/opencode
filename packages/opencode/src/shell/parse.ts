// Shell 解析事实层：共享工具入口的 grammar，提供参数、重定向和管道的独立记录。
// 本模块只解释语法；权限等级、路径保护及授权政策由 permission/precheck 维护。
// parse 返回的 Tree 由调用者释放，analyze 则在返回普通数据之前自行释放 Tree。
import { Language, type Node } from "web-tree-sitter"
import { fileURLToPath } from "node:url"
import { lazy } from "@/util/lazy"

export type Dialect = "bash" | "powershell" | "cmd"
export type Word = { value: string; start: number; end: number; quoted: boolean; stripped: boolean; dynamic: boolean }
export type Redirect = { operator: string; target?: Word; content?: string }
export type Command = { words: Word[]; redirects: Redirect[]; group: number; pipeTo?: number }

// 解析Bun内嵌资源与开发目录中的同一WASM引用，保持原ShellTool的路径合同。
const resolveWasm = (asset: string) => asset.startsWith("/") || /^[a-z]:/i.test(asset) ? asset : fileURLToPath(new URL(asset, import.meta.url))

// grammar只装载一次；每次解析的语法树独立，解析期间没有异步交错。
const parsers = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: wasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
  await Parser.init({ locateFile: () => resolveWasm(wasm) })
  const { default: bash } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, { with: { type: "wasm" } })
  const { default: ps } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, { with: { type: "wasm" } })
  return Promise.all([bash, ps].map(async (asset) => {
    // 两种方言分别持有parser，调用方只保留自己的Tree。
    const parser = new Parser()
    parser.setLanguage(await Language.load(resolveWasm(asset)))
    return parser
  }))
})

// 返回语法树；兼容变换仅作用于分析文本，工具执行始终使用原命令。
export async function parse(source: string, dialect: Dialect) {
  const tree = (await parsers())[dialect === "powershell" ? 1 : 0].parse(dialect === "powershell" ? normalize(source) : dialect === "cmd" ? normalizeCmd(source) : source)
  if (!tree) throw new Error("Failed to parse shell command")
  return tree
}

// [local-smark] 裸 `--` 词法盲区归一化，迁移自ShellTool。
// tree-sitter-powershell 0.25.10（package.json钉版）对引号外的独立--缺少词法归类，
// 因其前缀预留给自减运算符，command规则会断裂，曾导致三次git commit丢失审批节点。
// 紧邻分隔符时也会丢弃所在命令段。解析输入引号化为"--"后，两种形态均可恢复。
// 这只改变解析表示，实际执行及审计metadata保持原文，沿用inline-python的分离合同。
// 独立Token边界为首尾、空白以及分隔符`;`、`&`、`|`，包括已验证的--;和--&形态。
// --%是PowerShell stop-parsing标志，--flag等带后续字符的形式也保持原文。
// 引号内--属于数据；引用边界不确定时保持原引用状态，不主动拆开数据。
export function normalize(source: string) {
  let result = ""
  let quote = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      // PowerShell反引号和原兼容路径的双引号反斜杠，都可保护关闭引号。
      if (char === quote && source[index - 1] !== "`" && !(quote === '"' && source[index - 1] === "\\")) quote = ""
      result += char
      continue
    }
    if (["'", '"', "`"].includes(char)) quote = char
    if (char === "-" && source[index + 1] === "-" &&
      (index === 0 || /[\s;&|]/.test(source[index - 1])) &&
      (index + 2 === source.length || /[\s;&|]/.test(source[index + 2]))) {
      result += '"--"'
      index++
      continue
    }
    result += char
  }
  return result
}

// cmd复用Bash结构grammar；这里只屏蔽cmd中的字面字符，保留实际连接符。
function normalizeCmd(source: string) {
  let quoted = false
  let result = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    // caret只在引号外保护后一个字符，转成grammar能识别的转义表示。
    if (!quoted && char === "^" && source[index + 1]) { result += "\\" + source[++index]; continue }
    if (char === '"') quoted = !quoted
    if (["\\", "$", "`"].includes(char) || (!quoted && ["'", "#", ";"].includes(char))) result += "\\"
    result += char
  }
  return result
}

// 一个语法参数始终产生一个Word，值解除引用，区间和标记保留原参数证据。
function word(node: Node, dialect: Dialect): Word {
  const parts = children(node).filter((child) => child.type !== "command_argument_sep")
  // 命令名和重定向文件名都可能包住一个literal，片段拼接仍由同一解引用路径处理。
  if (["command_name", "redirected_file_name"].includes(node.type) && parts.length === 1) return word(parts[0], dialect)
  const raw = node.text
  const single = dialect !== "cmd" && raw.startsWith("'") && raw.endsWith("'")
  const double = raw.startsWith('"') && raw.endsWith('"')
  const body = single || double ? raw.slice(1, -1) : raw
  // 相邻引用片段共同组成一个argv；分别解释片段后拼接，避免拆成多个操作数。
  const value = node.type === "concatenation" ? parts.map((part) => word(part, dialect).value).join("")
    : single ? dialect === "powershell" ? body.replaceAll("''", "'") : body
    : dialect === "powershell" ? body.replace(/`(.)/gs, (_, char: string) => ({ n: "\n", r: "\r", t: "\t", "0": "\0" })[char] ?? char)
    : dialect === "cmd" ? body.replace(/\\([\\'"$`#;^&|<> ()])/g, "$1")
    : double ? body.replace(/\\([\\$`"\n])/g, "$1") : body.replace(/\\(.)/gs, "$1")
  const expansion = ["expansion", "simple_expansion", "command_substitution", "sub_expression", "variable"]
  return {
    value, start: node.startIndex, end: node.endIndex, quoted: single || double,
    // stripped沿用Git路径的转义证据，动态属性仅用于既有general下限。
    stripped: dialect === "bash" && !single && raw.includes("\\"),
    dynamic: expansion.includes(node.type) || node.descendantsOfType(expansion).length > 0 || (node.type === "word" && /[*?\[]/.test(raw)),
  }
}

// 提取普通数据快照并释放Tree；语法问题保留为事实，不在这里决定审批等级。
export async function analyze(source: string, dialect: Dialect) {
  const tree = await parse(source, dialect)
  try {
    // 查询接口同样容许空节点；与children的边界一致，进入提取前统一排除。
    const nodes = tree.rootNode.descendantsOfType("command").filter((node) => node !== null)
    const records = new Map<number, Command & { index: number }>()
    const standalone: Command[] = []
    // 原FIFO组合规则在分号和管道处结束；只取grammar操作符，引用中的同字符仍是数据。
    const separators = tree.rootNode.descendantsOfType([";", "|"]).filter((node) => node !== null)
    let group = 0
    for (const node of nodes) {
      // 两个节点序列均按源码排序，游标只前进一次，组合边界的提取保持线性。
      while ((separators[group]?.startIndex ?? Infinity) < node.startIndex) group++
      const elements = children(node).flatMap((child) => child.type === "command_elements" ? children(child) : [child])
      // 赋值与重定向从argv中移出，命令替换仍在自己的command节点单独取得。
      const words = elements.filter((child) => !["command_argument_sep", "command_invokation_operator", "variable_assignment", "file_redirect", "redirection", "heredoc_redirect", "herestring_redirect"].includes(child.type))
        .map((child) => word(child, dialect))
      records.set(node.id, { words, redirects: [], group, index: records.size })
    }
    for (const redirect of tree.rootNode.descendantsOfType(["file_redirect", "redirection", "heredoc_redirect", "herestring_redirect"]).filter((node) => node !== null)) {
      const owner = redirectOwner(redirect)
      const record: Command | undefined = owner ? records.get(owner.id) : { words: [], redirects: [], group: -1 }
      if (!record) continue
      // 无命令名的重定向同样是操作，空argv记录让原专项写入规则看到它。
      if (!owner) standalone.push(record)
      if (["heredoc_redirect", "herestring_redirect"].includes(redirect.type)) {
        const body = redirect.type === "heredoc_redirect" ? children(redirect).find((child) => child.type === "heredoc_body") : children(redirect).at(-1)
        if (body) record.redirects.push({
          operator: redirect.type === "heredoc_redirect" ? "<<" : "<<<",
          content: redirect.type === "heredoc_redirect" ? (redirect.text.includes("<<-") ? body.text.replace(/^\t+/gm, "") : body.text) : word(body, dialect).value + "\n",
        })
        continue
      }
      const target = redirect.childForFieldName("destination") ?? children(redirect).find((child) => child.type === "redirected_file_name")
      record.redirects.push({
        operator: target ? redirect.text.slice(0, target.startIndex - redirect.startIndex).trim() : redirect.text,
        target: target ? word(target, dialect) : undefined,
      })
      // Bash将目标后的argv也放在destination中；仅首个目标归重定向，其余补回参数。
      if (redirect.type === "file_redirect" && target) {
        record.words.push(...children(redirect).filter((child) => child.startIndex > target.startIndex).map((child) => word(child, dialect)))
        record.words.sort((left, right) => left.start - right.start)
      }
    }
    const commands = [...nodes.map((node) => records.get(node.id)).filter((item) => item !== undefined), ...standalone]
    for (const pipeline of tree.rootNode.descendantsOfType("pipeline").filter((node) => node !== null)) {
      // here-doc右侧的管道节点位于redirect内部，左端来自其所属statement.body。
      const owner = pipeline.parent?.type === "heredoc_redirect" ? redirectOwner(pipeline.parent) : undefined
      const members = [...(owner ? [owner] : []), ...topCommands(pipeline)]
      for (let index = 0; index + 1 < members.length; index++) {
        const left = records.get(members[index].id)
        const right = records.get(members[index + 1].id)
        // 命令入表时已确定结果数组中的序号；独立重定向随后追加，不改变该序号。
        if (left && right) left.pipeTo = right.index
      }
    }
    // 后台和换行组成的普通只读序列沿用原general下限；引用内部换行不属于命令间隙。
    const top = topCommands(tree.rootNode)
    const opaque = tree.rootNode.children.some((child) => child?.type === "&") || top.some((node, index) => index > 0 && /[\r\n]/.test(source.slice(top[index - 1].endIndex, node.startIndex)))
    return { commands, incomplete: tree.rootNode.hasError, opaque, environment: tree.rootNode.descendantsOfType("variable_assignment").length > 0 }
  } finally {
    // 导出的记录与树分离，异常退出时也及时释放WASM分配。
    tree.delete()
  }
}

// 返回语句的顶层命令；参数内部的执行子树另行分类，不占用外层管道位置。
const topCommands = (node: Node): Node[] => node.type === "command" ? [node] : ["command_substitution", "sub_expression"].includes(node.type) ? [] : children(node).flatMap(topCommands)

// 按父子关系寻找重定向所属命令，避免把echo的输出误挂到$(pwd)内部命令。
function redirectOwner(node: Node): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "command") return parent
    if (parent.type === "redirected_statement") {
      const body = parent.childForFieldName("body")
      return body ? topCommands(body).at(-1) : undefined
    }
  }
}

// tree-sitter的节点类型容许null，统一滤除后供结构遍历使用。
const children = (node: Node) => node.namedChildren.filter((child) => child !== null)

export * as ShellParse from "./parse"

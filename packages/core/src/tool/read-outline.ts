// #142：源文件大纲提示（非语义索引），限制扫描行数与条目预算
// #142：仅 offset=1 且足够长的源码文件才生成 outline
import { createReadStream } from "fs"
import path from "path"
import { createInterface } from "readline"

// #142：短文件无需 outline
const MIN_LINES = 600
// #142：大纲条目上限
const MAX_ENTRIES = 32
// #142：大纲总字符预算
const MAX_CHARS = 640
// #142：单条 label 截断
const MAX_ITEM_CHARS = 60
// #142：最多扫描前缀行，防止超大文件拖死
const MAX_SCAN_LINES = 3000

// #142：仅源码扩展参与大纲
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".m",
  ".mm",
  ".vue",
  ".svelte",
  ".astro",
  ".dart",
  ".lua",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".clj",
  ".cljs",
  ".fs",
  ".fsx",
])

// #142：单条规则：扩展/正则/格式化/最大缩进
type OutlineRule = {
  exts: string[]
  regex: RegExp
  format: (match: RegExpMatchArray) => string | undefined
  maxIndent?: number
}

// #142：大纲结果：条目 + 是否截断
export type Outline = {
  items: string[]
  truncated: boolean
}

// #142：缩进启发式过滤深层语句
function indentOf(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0
}

// #142：.d.ts 归为 .ts 规则
function basenameExt(filepath: string) {
  const lower = filepath.toLowerCase()
  if (lower.endsWith(".d.ts")) return ".ts"
  return path.extname(lower)
}

// #142：注释/import/控制流不进大纲
function isCommentOrNoise(trimmed: string) {
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("# ") ||
    trimmed.startsWith("<!--") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export {") ||
    trimmed.startsWith("return ") ||
    trimmed.startsWith("if ") ||
    trimmed.startsWith("for ") ||
    trimmed.startsWith("while ") ||
    trimmed.startsWith("switch ") ||
    trimmed.startsWith("catch ") ||
    trimmed.startsWith("else ")
  )
}

// #142：JS/TS 声明提取规则（function/class/interface/type/enum）
const jsRules: OutlineRule[] = [
  {
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    regex: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `function ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    regex: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `class ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx"],
    regex: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `interface ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx"],
    regex: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `type ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    regex: /^(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `enum ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx"],
    regex: /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)\b/,
    format: (match) => `module ${match[1]}`,
  },
  {
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    regex: /^(?:export\s+)?const\s+([A-Z][A-Za-z0-9_$]*|use[A-Z][A-Za-z0-9_$]*)\b/,
    format: (match) => `const ${match[1]}`,
    maxIndent: 0,
  },
]

// #142：多语言规则表：在扩展名集合内才尝试匹配
const outlineRules: OutlineRule[] = [
  ...jsRules,
  { exts: [".py"], regex: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, format: (m) => `function ${m[1]}` },
  { exts: [".py"], regex: /^class\s+([A-Za-z_][\w]*)\b/, format: (m) => `class ${m[1]}` },
  { exts: [".go"], regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, format: (m) => `function ${m[1]}` },
  { exts: [".go"], regex: /^type\s+([A-Za-z_][\w]*)\s+(struct|interface|func)\b/, format: (m) => `${m[2]} ${m[1]}` },
  { exts: [".rs"], regex: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\b/, format: (m) => `function ${m[1]}` },
  { exts: [".rs"], regex: /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|const|static)\s+([A-Za-z_][\w]*)\b/, format: (m) => `${m[1]} ${m[2]}` },
  { exts: [".rs"], regex: /^impl(?:<[^>]+>)?\s+(.+?)\s*(?:\{|where\b)/, format: (m) => `impl ${m[1]?.trim().slice(0, 80)}` },
  { exts: [".rs"], regex: /^macro_rules!\s+([A-Za-z_][\w]*)\b/, format: (m) => `macro ${m[1]}` },
  {
    exts: [".java"],
    regex:
      /^(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp|\s)*\s*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)\b/,
    format: (m) => `${m[1] === "@interface" ? "annotation" : m[1]} ${m[2]}`,
  },
  {
    exts: [".java"],
    regex:
      /^(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|\s)+[A-Za-z_$][\w$<>\[\], ?.&]*\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\b[^{]+)?(?:\{|$)/,
    format: (m) => `method ${m[1]}`,
  },
  {
    exts: [".cs"],
    regex:
      /^(?:public|protected|private|internal|static|abstract|sealed|partial|readonly|unsafe|new|\s)*\s*(class|interface|struct|enum|record)\s+([A-Za-z_][\w]*)\b/,
    format: (m) => `${m[1]} ${m[2]}`,
  },
  {
    exts: [".cs"],
    regex:
      /^(?:public|protected|private|internal|static|virtual|override|async|sealed|partial|unsafe|extern|new|\s)+[A-Za-z_][\w<>\[\], ?.&]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:\{|=>|$)/,
    format: (m) => `method ${m[1]}`,
  },
  {
    exts: [".c", ".cc", ".cpp", ".h", ".hh", ".hpp", ".hxx"],
    regex: /^(?:template\s*<[^>]+>\s*)?(class|struct|union)\s+([A-Za-z_][\w]*)\b/,
    format: (m) => `${m[1]} ${m[2]}`,
  },
  {
    exts: [".c", ".cc", ".cpp", ".h", ".hh", ".hpp", ".hxx"],
    regex: /^(?:enum(?:\s+class)?|namespace)\s+([A-Za-z_][\w]*)\b/,
    format: (m) => `module ${m[1]}`,
  },
  {
    exts: [".c", ".cc", ".cpp"],
    regex:
      /^(?!if\b|for\b|while\b|switch\b|catch\b)(?:[\w:<>,~*&\s]+)\s+([A-Za-z_~][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:\{|$)/,
    format: (m) => `function ${m[1]}`,
  },
  {
    exts: [".kt", ".kts"],
    regex:
      /^(?:public|private|protected|internal|open|sealed|data|abstract|final|\s)*\s*(class|interface|object|enum class)\s+([A-Za-z_][\w]*)\b/,
    format: (m) => `${m[1]} ${m[2]}`,
  },
  { exts: [".kt", ".kts"], regex: /^(?:public|private|protected|internal|suspend|inline|operator|override|\s)*fun\s+([A-Za-z_][\w]*)\s*\(/, format: (m) => `function ${m[1]}` },
  {
    exts: [".swift"],
    regex: /^(?:public|private|internal|open|fileprivate|final|\s)*\s*(class|struct|enum|protocol|extension)\s+([A-Za-z_][\w]*)\b/,
    format: (m) => `${m[1]} ${m[2]}`,
  },
  { exts: [".swift"], regex: /^(?:public|private|internal|open|fileprivate|static|class|mutating|\s)*func\s+([A-Za-z_][\w]*)\s*\(/, format: (m) => `function ${m[1]}` },
  { exts: [".rb"], regex: /^(class|module)\s+([A-Za-z_:][\w:]*)\b/, format: (m) => `${m[1]} ${m[2]}` },
  { exts: [".rb"], regex: /^def\s+(?:self\.)?([A-Za-z_][\w!?=]*)\b/, format: (m) => `function ${m[1]}` },
  { exts: [".php"], regex: /^(?:abstract|final|\s)*\s*(class|interface|trait|enum)\s+([A-Za-z_][\w]*)\b/, format: (m) => `${m[1]} ${m[2]}` },
  { exts: [".php"], regex: /^(?:public|protected|private|static|final|abstract|\s)*function\s+([A-Za-z_][\w]*)\s*\(/, format: (m) => `function ${m[1]}` },
  { exts: [".scala"], regex: /^(?:abstract|final|sealed|case|\s)*\s*(class|object|trait|enum)\s+([A-Za-z_][\w]*)\b/, format: (m) => `${m[1]} ${m[2]}` },
  { exts: [".scala"], regex: /^def\s+([A-Za-z_][\w]*)\b/, format: (m) => `function ${m[1]}` },
]

// #142：单行 → 可选大纲 label；噪声行直接丢弃
function outlineLabel(line: string, filepath: string) {
  const trimmed = line.trim()
  if (isCommentOrNoise(trimmed)) return undefined

  const ext = basenameExt(filepath)
  const indent = indentOf(line)
  for (const rule of outlineRules) {
    if (!rule.exts.includes(ext)) continue
    if (rule.maxIndent !== undefined && indent > rule.maxIndent) continue
    const match = trimmed.match(rule.regex)
    if (!match) continue
    return rule.format(match)?.replace(/\s+/g, " ").trim()
  }
  return undefined
}

// #142：单条过长加省略号
function truncateItem(item: string) {
  if (item.length <= MAX_ITEM_CHARS) return item
  return item.slice(0, MAX_ITEM_CHARS - 3) + "..."
}

// #142：异步流式扫前缀，受 MAX_SCAN_LINES/ENTRIES/CHARS 约束
export async function readOutline(filepath: string, total: number, offset: number, totalExact = true): Promise<Outline | undefined> {
  // #142：非文件头或已知不足 600 行则跳过；计数下界不足时仍需验证真实资格。
  if (offset > 1 || (totalExact && total < MIN_LINES) || !SOURCE_EXTENSIONS.has(basenameExt(filepath))) return undefined
  // #142：条目预算先耗尽也必须确认达到 600 行，不能给短文件误报 outline。
  const pendingEligibility = total < MIN_LINES

  // #142：readline 流，避免整文件读入内存
  const stream = createReadStream(filepath, { encoding: "utf8" })
  // #142：按行迭代
const rl = createInterface({ input: stream, crlfDelay: Infinity })
  // #142：收集 label 行
const items: string[] = []
  // #142：字符预算计数
let chars = 0
  // #142：扫描行计数
let count = 0
  // #142：是否因预算截断
let truncated = false
  // #142：确保 finally 关闭流
try {
    // #142：顺序扫描前缀
for await (const text of rl) {
      count += 1
      if (truncated && pendingEligibility) {
        if (count >= MIN_LINES) break
        continue
      }
      // This is a read-tool hint, not a semantic index; never scan an entire
      // huge file just to discover there are no declarations in the prefix.
      // #142：扫描上限到点即 truncated
      if (count > MAX_SCAN_LINES) {
        truncated = true
        break
      }

      // #142：提取 label
const label = outlineLabel(text, filepath)
      // #142：无 label 跳过
if (!label) continue
      // #142：格式化为 "行号 label"
const item = truncateItem(`${count} ${label}`)
      // #142：计入换行开销
const extra = item.length + (items.length > 0 ? 1 : 0)
      // #142：条目或字符预算耗尽
      if (items.length >= MAX_ENTRIES || chars + extra > MAX_CHARS) {
        truncated = true
        if (pendingEligibility && count < MIN_LINES) continue
        break
      }
      // #142：接受该条目
items.push(item)
      // #142：累加字符
chars += extra
    }
  // #142：关闭 readline/stream
} finally {
    // #142：关闭接口
rl.close()
    // #142：销毁底层流
stream.destroy()
  }
  if (pendingEligibility && count < MIN_LINES) return undefined
  // #142：无声明则不输出 outline 节点
  if (items.length === 0) return undefined
  // #142：返回大纲
return { items, truncated }
}

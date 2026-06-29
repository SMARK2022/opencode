import { createReadStream } from "fs"
import path from "path"
import { createInterface } from "readline"

const MIN_LINES = 600
const MAX_ENTRIES = 32
const MAX_CHARS = 640
const MAX_ITEM_CHARS = 60
const MAX_SCAN_LINES = 3000

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

type OutlineRule = {
  exts: string[]
  regex: RegExp
  format: (match: RegExpMatchArray) => string | undefined
  maxIndent?: number
}

export type Outline = {
  items: string[]
  truncated: boolean
}

function indentOf(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function basenameExt(filepath: string) {
  const lower = filepath.toLowerCase()
  if (lower.endsWith(".d.ts")) return ".ts"
  return path.extname(lower)
}

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

function truncateItem(item: string) {
  if (item.length <= MAX_ITEM_CHARS) return item
  return item.slice(0, MAX_ITEM_CHARS - 3) + "..."
}

export async function readOutline(filepath: string, total: number, offset: number): Promise<Outline | undefined> {
  if (offset > 1 || total < MIN_LINES || !SOURCE_EXTENSIONS.has(basenameExt(filepath))) return undefined

  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const items: string[] = []
  let chars = 0
  let count = 0
  let truncated = false
  try {
    for await (const text of rl) {
      count += 1
      // This is a read-tool hint, not a semantic index; never scan an entire
      // huge file just to discover there are no declarations in the prefix.
      if (count > MAX_SCAN_LINES) {
        truncated = true
        break
      }

      const label = outlineLabel(text, filepath)
      if (!label) continue
      const item = truncateItem(`${count} ${label}`)
      const extra = item.length + (items.length > 0 ? 1 : 0)
      if (items.length >= MAX_ENTRIES || chars + extra > MAX_CHARS) {
        truncated = true
        break
      }
      items.push(item)
      chars += extra
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  if (items.length === 0) return undefined
  return { items, truncated }
}

// [local-smark] outline cache：按 canonicalPath+size+modifiedMs 缓存，
// 文件修改后自动失效。LRU 上限 50 条（每条 ≤640 chars，总内存可控）。
// 避免每次 read 都重新流式扫描文件前 3000 行。
const outlineCache = new Map<string, { outline: Outline | undefined; size: number; modifiedMs: number }>()
const OUTLINE_CACHE_LIMIT = 50

export async function readOutlineCached(
  filepath: string,
  total: number,
  offset: number,
  size: number,
  modifiedMs: number,
): Promise<Outline | undefined> {
  // [local-smark] 仅在 offset<=1 时使用缓存（readOutline 内部也仅在此条件生成 outline）。
  // offset>1 时不查缓存也不生成 outline，保持原有行为。
  if (offset > 1) return undefined
  const canonical = process.platform === "win32"
    ? filepath.replaceAll("\\", "/").toLowerCase()
    : filepath.replaceAll("\\", "/")
  const cached = outlineCache.get(canonical)
  // cache 命中条件：同文件（canonicalPath）+ 同版本（size+modifiedMs）
  if (cached && cached.size === size && cached.modifiedMs === modifiedMs) {
    return cached.outline
  }
  const outline = await readOutline(filepath, total, offset)
  // LRU 淘汰：超限时删最早插入的条目（Map 保持插入顺序）
  if (outlineCache.size >= OUTLINE_CACHE_LIMIT) {
    const firstKey = outlineCache.keys().next().value
    if (firstKey) outlineCache.delete(firstKey)
  }
  outlineCache.set(canonical, { outline, size, modifiedMs })
  return outline
}

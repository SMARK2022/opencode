// 改动规模规则：change-size（单个提交净增）、file-lines（大文件单次增长）、tiny-module（只有一个导入方的小新文件）。
// 与存量规则不同，它们不读基线，只看“这一次改了什么”，所以按提交计算，不与上游比较。
import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { collectImports, git, isSrcFile, pjoin, posix } from "./lib"
import { ALLOW_LARGE_TRAILER, BIG_FILE_GROWTH, BIG_FILE_LINES, CHANGE_BUDGET, TINY_MODULE_LINES } from "./rules"

export type SizeHit = { rule: string; key: string; file: string; count: number; allowed: number; warn?: boolean }

// 一次“改动”：暂存区、范围内的一个提交，或工作区里的一组文件
type Change = { label: string; message?: string; numstat: string; lineCount: (file: string) => number }
// 读取改动后的树：暂存区（:path）、某个提交（sha:path）或工作区
type Tree = { read: (file: string) => string | undefined; grep: (word: string) => string[] }

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx)$/
const GENERATED = /(^|\/)(generated|generated-effect)\/|\.gen\./
const counted = (f: string) => isSrcFile(f) && SOURCE.test(f) && !f.endsWith(".d.ts") && !GENERATED.test(f)
const trailer = new RegExp(`^${ALLOW_LARGE_TRAILER}:\\s*(\\S.*)$`, "m")
const lines = (text: string | undefined) => (text === undefined ? 0 : text.split("\n").length)

// `git diff --numstat -z -M`：重命名记为一行（旧路径、新路径），否则改名会被算成整文件新增
function parseNumstat(out: string) {
  const rows: { file: string; net: number }[] = []
  const t = out.split("\0")
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue
    const [add, del, file] = t[i].split("\t")
    const target = file === "" ? t[(i += 2)] : file
    if (add === "-" || !target) continue
    rows.push({ file: posix(target), net: Number(add) - Number(del) })
  }
  return rows
}

function judge(change: Change, opts: Options, out: SizeHit[], notes: string[]) {
  const rows = parseNumstat(change.numstat).filter((r) => counted(r.file))
  const net = rows.reduce((s, r) => s + r.net, 0)
  const found: SizeHit[] = []
  if (net > CHANGE_BUDGET) {
    const top = [...rows].sort((a, b) => b.net - a.net)[0]
    found.push({ rule: "change-size", key: change.label, file: top.file, count: net, allowed: CHANGE_BUDGET })
  }
  for (const r of rows)
    if (r.net > BIG_FILE_GROWTH && change.lineCount(r.file) > BIG_FILE_LINES)
      found.push({ rule: "file-lines", key: `${r.file}（${change.label}）`, file: r.file, count: r.net, allowed: BIG_FILE_GROWTH })
  if (!found.length) return
  const reason = opts.ignoreTrailer ? undefined : change.message?.match(trailer)?.[1]
  if (opts.allowLarge || reason) {
    notes.push(`${change.label}：超出改动规模，${reason ? `已按 ${ALLOW_LARGE_TRAILER} 放行（${reason.trim()}）` : "已由仓主放行"}`)
    return
  }
  for (const f of found) out.push({ ...f, warn: opts.warnOnly })
}

// 新文件少于 N 行有效代码、恰好一个导入方、且该导入方不是转出它的入口 → 合并回去
function tinyModules(added: string[], tree: Tree, out: SizeHit[]) {
  for (const file of added.filter((f) => counted(f) && !/(^|\/)index\.[cm]?tsx?$/.test(f))) {
    const text = tree.read(file)
    const effective = (text ?? "").split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length
    if (!text || effective >= TINY_MODULE_LINES) continue
    const pkgDir = file.match(/^packages\/(.+?)\/src\//)?.[1]
    if (!pkgDir) continue
    const stem = file.replace(/\.[cm]?[jt]sx?$/, "")
    const inSrc = stem.slice(`packages/${pkgDir}/src/`.length)
    // package.json exports 里登记的是对外入口，不算“只有一个调用方”
    if ((tree.read(`packages/${pkgDir}/package.json`) ?? "").includes(`src/${inSrc}`)) continue
    const importers = new Map<string, boolean>() // 导入方 → 是否只是转出它
    for (const other of tree.grep(path.posix.basename(stem))) {
      if (other === file || !SOURCE.test(other)) continue
      const refs = collectImports(other, tree.read(other) ?? "").filter((ref) => {
        const resolved = ref.spec.startsWith(".") ? pjoin(path.posix.dirname(other), ref.spec).replace(/\.[cm]?[jt]sx?$/, "") : undefined
        return resolved ? resolved === stem : ref.spec.replace(/\.[cm]?[jt]sx?$/, "").endsWith(`/${inSrc}`)
      })
      if (refs.length) importers.set(other, refs.every((r) => r.kind === "export"))
    }
    if (importers.size !== 1) continue
    const [only] = [...importers.keys()]
    // 不算拆碎的情况：唯一导入方只是转出它；导入方是生成的注册表（迁移清单等）；
    // 导入方是按目录登记同类模块的聚合文件（handlers.ts ↔ handlers/*、目录自己的 index.ts），新文件在沿用这个约定
    const dir = path.posix.dirname(stem)
    const aggregator = only.replace(/\.[cm]?[jt]sx?$/, "") === dir || path.posix.dirname(only) === dir && /\/index\.[cm]?[jt]sx?$/.test(only)
    if (!importers.get(only) && !GENERATED.test(only) && !aggregator)
      out.push({ rule: "tiny-module", key: `${file} -> ${only}`, file, count: effective, allowed: TINY_MODULE_LINES })
  }
}

type Options = { allowLarge?: boolean; ignoreTrailer?: boolean; warnOnly?: boolean }

const grepOut = (out: string, prefix = "") =>
  out.split("\n").filter(Boolean).map((l) => posix(prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l))

// 暂存区：commit-msg 阶段调用，message 是即将写入的提交信息
export function stagedSize(repo: string, message: string, opts: Options) {
  const out: SizeHit[] = []
  const notes: string[] = []
  const head = git(repo, "rev-parse", "--verify", "--quiet", "HEAD").ok ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const tree: Tree = {
    read: (f) => (git(repo, "cat-file", "-e", `:${f}`).ok ? git(repo, "show", `:${f}`).out : undefined),
    grep: (w) => grepOut(git(repo, "grep", "--cached", "-l", "-F", "-e", w, "--", "packages").out),
  }
  judge({ label: "暂存区", message, numstat: git(repo, "diff", "--cached", "--numstat", "-z", "-M", head).out, lineCount: (f) => lines(tree.read(f)) }, opts, out, notes)
  tinyModules(grepOut(git(repo, "diff", "--cached", "--name-only", "-M", "--diff-filter=A", head).out), tree, out)
  return { hits: out, notes }
}

// 提交范围：pre-push 与 CI。逐个提交判定规模（合并提交不计），小模块按范围终点的树判定
export function rangeSize(repo: string, since: string, sha: string, opts: Options) {
  const out: SizeHit[] = []
  const notes: string[] = []
  for (const c of git(repo, "rev-list", "--no-merges", "--reverse", `${since}..${sha}`).out.split("\n").filter(Boolean)) {
    const parent = git(repo, "rev-parse", "--verify", "--quiet", `${c}^`).ok ? `${c}^` : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    const subject = git(repo, "log", "-1", "--format=%s", c).out
    judge({
      label: `${c.slice(0, 8)} ${subject.slice(0, 50)}`,
      message: git(repo, "log", "-1", "--format=%B", c).out,
      numstat: git(repo, "diff", "--numstat", "-z", "-M", parent, c).out,
      lineCount: (f) => lines(git(repo, "show", `${c}:${f}`).out),
    }, opts, out, notes)
  }
  const tree: Tree = {
    read: (f) => (git(repo, "cat-file", "-e", `${sha}:${f}`).ok ? git(repo, "show", `${sha}:${f}`).out : undefined),
    grep: (w) => grepOut(git(repo, "grep", "-l", "-F", "-e", w, sha, "--", "packages").out, `${sha}:`),
  }
  tinyModules(grepOut(git(repo, "diff", "--name-only", "-M", "--diff-filter=A", since, sha).out), tree, out)
  return { hits: out, notes }
}

// 工作区里的一组文件（Agent 回合结束）：规模只提示，提交时才需要拆分或放行；小模块直接报错，因为现在就能改
export function worktreeSize(repo: string, files: string[]) {
  const out: SizeHit[] = []
  const notes: string[] = []
  const read = (f: string) => (existsSync(path.join(repo, f)) ? readFileSync(path.join(repo, f), "utf8") : undefined)
  const untracked = new Set(grepOut(git(repo, "ls-files", "--others", "--exclude-standard", "--", ...files).out))
  const numstat = git(repo, "diff", "--numstat", "-z", "-M", "HEAD", "--", ...files).out +
    [...untracked].map((f) => `${lines(read(f))}\t0\t${f}\0`).join("")
  judge({ label: "本会话改动", numstat, lineCount: (f) => lines(read(f)) }, { warnOnly: true }, out, notes)
  const added = [...untracked, ...grepOut(git(repo, "diff", "--name-only", "-M", "--diff-filter=A", "HEAD", "--", ...files).out)]
  const tree: Tree = { read, grep: (w) => grepOut(git(repo, "grep", "--untracked", "-l", "-F", "-e", w, "--", "packages").out) }
  tinyModules(added, tree, out)
  return { hits: out, notes }
}

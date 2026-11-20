// guard 各脚本共用的基础设施：路径规范化、git、包映射、文件枚举、导入收集。
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { Glob } from "bun"
import type { Node } from "typescript"

export const ts: typeof import("typescript") = require(process.env.GUARD_TYPESCRIPT ?? "typescript")

// Windows 上 Glob 与 path.* 返回反斜杠；规则一律按正斜杠书写，所有相对路径先经过这里。
export const posix = (p: string) => p.replaceAll("\\", "/")
export const pjoin = (...parts: string[]) => path.posix.normalize(path.posix.join(...parts.map(posix)))

export function git(repo: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

export function gitPath(repo: string, ...parts: string[]) {
  const result = git(repo, "rev-parse", "--git-path", path.join(...parts))
  if (!result.ok) throw new Error(`Git 工作区路径读取失败：${result.err}`)
  return path.resolve(repo, result.out)
}

// gh 不加 -R 时会优先选 upstream 远端（fork 里它指向官方仓库）；门禁调用 gh 一律指定 origin 对应的仓库
export function originRepo(repo: string) {
  return git(repo, "remote", "get-url", "origin").out.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
}

export function flag(args: string[], name: string) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const IGNORED_DIR = /(^|\/)(node_modules|dist|\.build|\.sst|\.turbo|generated|generated-effect|\.git)(\/|$)/

export async function listFiles(root: string, pattern: string) {
  const out: string[] = []
  for await (const f of new Glob(pattern).scan({ cwd: root, dot: false })) {
    const rel = posix(f)
    if (!IGNORED_DIR.test(rel)) out.push(rel)
  }
  return out.sort()
}

export type Pkg = { name: string; dir: string; json: Record<string, any> }

// 包目录 → 包信息；嵌套包（console/app、sdk/js）按最长前缀归属
export async function loadPackages(root: string) {
  const byDir = new Map<string, Pkg>()
  const byName = new Map<string, Pkg>()
  for (const rel of await listFiles(root, "packages/**/package.json")) {
    const json = await Bun.file(path.join(root, rel)).json()
    if (!json?.name) continue
    const dir = path.posix.dirname(rel).replace(/^packages\//, "")
    const pkg = { name: json.name as string, dir, json }
    byDir.set(dir, pkg)
    byName.set(pkg.name, pkg)
  }
  const dirs = [...byDir.keys()].sort((a, b) => b.length - a.length)
  const dirOf = (file: string) => dirs.find((d) => file.startsWith(`packages/${d}/`))
  return { byDir, byName, dirOf }
}

export type ImportRef = { spec: string; line: number; type: boolean; kind: "import" | "export" | "dynamic" | "require" | "import-type" }

// 用 TypeScript AST 收集全部模块引用。Bun.Transpiler.scanImports 会丢掉 import type 与 import("x").T。
export function collectImports(file: string, text: string): ImportRef[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: ImportRef[] = []
  let checker: import("typescript").TypeChecker | undefined
  const globalRequire = (node: Node) => {
    if (!checker) {
      const options = { noResolve: true, noLib: true, noEmit: true, allowJs: true }
      const host = ts.createCompilerHost(options)
      host.getSourceFile = (name) => name === file ? sf : undefined
      checker = ts.createProgram([file], options, host).getTypeChecker()
    }
    return !checker.getSymbolAtLocation(node)
  }
  const lineOf = (n: Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const lit = (n: Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : undefined)
  const visit = (n: Node) => {
    if (ts.isImportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier)
      const clause = n.importClause
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (spec) out.push({ spec, line: lineOf(n), type: typeOnly, kind: "import" })
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = lit(n.moduleSpecifier)
      const typeOnly = n.isTypeOnly || !!n.exportClause && ts.isNamedExports(n.exportClause) &&
        n.exportClause.elements.length > 0 && n.exportClause.elements.every((entry) => entry.isTypeOnly)
      if (spec) out.push({ spec, line: lineOf(n), type: typeOnly, kind: "export" })
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = lit(n.moduleReference.expression)
      if (spec) out.push({ spec, line: lineOf(n), type: n.isTypeOnly, kind: "require" })
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      const spec = lit(n.argument.literal)
      if (spec) out.push({ spec, line: lineOf(n), type: true, kind: "import-type" })
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression
      const spec = lit(n.arguments[0])
      if (spec && callee.kind === ts.SyntaxKind.ImportKeyword) out.push({ spec, line: lineOf(n), type: false, kind: "dynamic" })
      if (spec && ts.isIdentifier(callee) && callee.text === "require" && globalRequire(callee))
        out.push({ spec, line: lineOf(n), type: false, kind: "require" })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

// 纯转发模块：除注释外只有 `export ... from "..."`
export function isPureForwarder(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  return sf.statements.length > 0 && sf.statements.every((s) => ts.isExportDeclaration(s) && !!s.moduleSpecifier)
}

// 把 git index（即将提交的内容）导出到临时目录；检查对象与提交内容逐字节一致。
// 完整快照保留未改动的消费者，供别名解析、传递依赖和循环检查使用。
export async function exportIndex(repo: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-index-"))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const conflicts = git(repo, "ls-files", "--unmerged")
    if (!conflicts.ok || conflicts.out) throw new Error(`Git 暂存区包含未解决冲突：${conflicts.err || conflicts.out}`)
    const r = git(repo, "checkout-index", "-a", "-f", `--prefix=${posix(dir)}/`)
    if (!r.ok) throw new Error(`git checkout-index 失败：${r.err}`)
    return { dir, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

// 把某个提交的树导出到临时目录（pre-push 检查 HEAD，而不是可能混有其他 Agent 改动的工作区）
export async function exportCommit(repo: string, ref: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-commit-"))
  const archive = Bun.spawnSync(["git", "-C", repo, "archive", "--format=tar", ref], { stdout: "pipe", stderr: "pipe" })
  if (archive.exitCode !== 0) throw new Error(`git archive ${ref} 失败：${archive.stderr.toString()}`)
  const tar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout, stderr: "pipe" })
  if (tar.exitCode !== 0) throw new Error(`tar 解包失败：${tar.stderr.toString()}`)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export const isTestFile = (f: string) =>
  /(^|\/)(test|tests|e2e|test-browser|__tests__|storybook|\.storybook)\//.test(f) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(f)
export const isSrcFile = (f: string) => /^packages\/.+\/src\//.test(f) && !isTestFile(f)

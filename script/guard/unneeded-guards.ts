#!/usr/bin/env bun
// 类型感知的“多余防御”检测：类型已经保证非空，代码却仍然写 ?. / ?? / === undefined。
// 用法: bun unneeded-guards.ts <tsconfig.json> <file...>
// 只检查传入的文件（通常是本次改动的文件），但用完整的 program 做类型推断。
import path from "node:path"
import type * as TS from "typescript"
import { ts, posix } from "./lib"

const [tsconfig, ...targets] = process.argv.slice(2)
const cfg = ts.getParsedCommandLineOfConfigFile(path.resolve(tsconfig), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!
const program = ts.createProgram({ rootNames: targets.map((t) => path.resolve(t)), options: { ...cfg.options, noEmit: true } })
const checker = program.getTypeChecker()
const findings: string[] = []

const nullable = (t: TS.Type): boolean | "unknown" => {
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return "unknown"
  if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return true
  if (t.isUnion()) {
    const parts = t.types.map(nullable)
    return parts.includes(true) ? true : parts.includes("unknown") ? "unknown" : false
  }
  return false
}

// 仓库关闭了 noUncheckedIndexedAccess：下标访问与索引签名读取的类型不含 undefined，但运行时可能为空，跳过
const indexLike = (n: TS.Node): boolean => {
  const e = ts.isParenthesizedExpression(n) ? n.expression : n
  if (ts.isElementAccessExpression(e)) return true
  if (ts.isPropertyAccessExpression(e)) {
    const owner = checker.getTypeAtLocation(e.expression)
    return !!(owner.getStringIndexType() || owner.getNumberIndexType()) && !owner.getProperty(e.name.text)
  }
  return false
}

for (const file of targets) {
  const sf = program.getSourceFile(path.resolve(file))
  if (!sf) continue
  const report = (n: TS.Node, what: string, t: TS.Type) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart())
    findings.push(`${posix(file)}:${line + 1}  ${what}  类型为 ${checker.typeToString(t)}，不可能为空`)
  }
  const visit = (n: TS.Node) => {
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && n.questionDotToken) {
      const t = checker.getTypeAtLocation(n.expression)
      if (!indexLike(n.expression) && nullable(t) === false) report(n, "?.", t)
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const t = checker.getTypeAtLocation(n.left)
      if (!indexLike(n.left) && nullable(t) === false) report(n, "??", t)
    }
    if (ts.isBinaryExpression(n) && /^[!=]==?$/.test(n.operatorToken.getText(sf))) {
      const [probe, other] = n.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n.right) && n.right.text === "undefined") ? [n.left, n.right] : [n.right, n.left]
      if (other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === "undefined")) {
        const t = checker.getTypeAtLocation(probe)
        if (!indexLike(probe) && nullable(t) === false) report(n, n.getText(sf), t)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

for (const f of findings) console.log(f)
console.log(`${findings.length} unneeded guards`)
process.exit(findings.length ? 1 : 0)

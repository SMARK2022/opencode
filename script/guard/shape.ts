// 代码形状度量：把“防御性编程 / 分支膨胀 / 降级路径 / 阻塞调用”变成可计数的数字。
// 每个函数单独计算，按文件汇总后进入棘轮；新文件里任何一个超标函数都会让计数大于 0。
import type * as TS from "typescript"
import { ts } from "./lib"

export const LIMITS = { cc: 10, depth: 3 }

export type Shape = {
  "cc-excess": number
  "depth-excess": number
  "defensive-check": number
  fallback: number
  "sync-blocking": number
  "await-in-loop": number
  "poll-loop": number
}

const SYNC_BLOCKING = /^(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|readdirSync|mkdirSync|rmSync|copyFileSync|renameSync|execSync|execFileSync|spawnSync|realpathSync|accessSync)$/

export function measure(text: string, fileName: string): { counts: Shape; lines: Record<string, number[]> } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const s: Shape = { "cc-excess": 0, "depth-excess": 0, "defensive-check": 0, fallback: 0, "sync-blocking": 0, "await-in-loop": 0, "poll-loop": 0 }
  const lines: Record<string, number[]> = {}
  const at = (rule: keyof Shape, n: TS.Node) => (lines[rule] ??= []).push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)

  const isFn = (n: TS.Node) =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)
  const isLoop = (n: TS.Node) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)
  const isNest = (n: TS.Node) => isLoop(n) || ts.isIfStatement(n) || ts.isTryStatement(n) || ts.isSwitchStatement(n) || ts.isCatchClause(n)

  function fn(root: TS.Node) {
    let cc = 1
    let maxDepth = 0
    const walk = (n: TS.Node, depth: number, loop: boolean) => {
      if (n !== root && isFn(n)) return fn(n)
      if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isCaseClause(n) || ts.isCatchClause(n) || isLoop(n)) cc++
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) cc++
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && n.questionDotToken) {
        cc++
        s["defensive-check"]++
        at("defensive-check", n)
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        s["defensive-check"]++
        at("defensive-check", n)
      }
      if (
        ts.isBinaryExpression(n) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind) &&
        [n.left, n.right].some((x) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === "undefined") || ts.isTypeOfExpression(x))
      ) {
        s["defensive-check"]++
        at("defensive-check", n)
      }
      // 降级路径：catch 分支里产出返回值、Promise.catch 返回值、Effect 的 orElse/catch→succeed
      if (ts.isCatchClause(n) && containsReturnValue(n.block)) {
        s.fallback++
        at("fallback", n)
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf)
        if (/\.catch$/.test(callee) && n.arguments[0] && returnsValue(n.arguments[0])) {
          s.fallback++
          at("fallback", n)
        }
        if (/^Effect\.(orElse\w*|catch\w*)$/.test(callee) && /Effect\.succeed|Effect\.orElseSucceed|=>\s*Effect\.succeed/.test(n.getText(sf))) {
          s.fallback++
          at("fallback", n)
        }
        const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : ""
        if (SYNC_BLOCKING.test(name) || callee === "Bun.spawnSync" || callee === "Atomics.wait") {
          s["sync-blocking"]++
          at("sync-blocking", n)
        }
      }
      if (ts.isAwaitExpression(n) && loop) {
        s["await-in-loop"]++
        at("await-in-loop", n)
        if (/\b(sleep|setTimeout|Bun\.sleep)\b/.test(n.expression.getText(sf))) {
          s["poll-loop"]++
          at("poll-loop", n)
        }
      }
      if (ts.isYieldExpression(n) && loop && n.expression && /Effect\.sleep\(/.test(n.expression.getText(sf))) {
        s["poll-loop"]++
        at("poll-loop", n)
      }
      const d = isNest(n) ? depth + 1 : depth
      if (d > maxDepth) maxDepth = d
      ts.forEachChild(n, (c) => walk(c, d, loop || isLoop(n)))
    }
    ts.forEachChild(root, (c) => walk(c, 0, false))
    const line = root === sf ? 1 : sf.getLineAndCharacterOfPosition(root.getStart(sf)).line + 1
    if (cc > LIMITS.cc) {
      s["cc-excess"] += cc - LIMITS.cc
      ;(lines["cc-excess"] ??= []).push(line)
    }
    if (maxDepth > LIMITS.depth) {
      s["depth-excess"] += maxDepth - LIMITS.depth
      ;(lines["depth-excess"] ??= []).push(line)
    }
  }

  function returnsValue(arg: TS.Node): boolean {
    if (ts.isArrowFunction(arg)) return ts.isBlock(arg.body) ? containsReturnValue(arg.body) : arg.body.kind !== ts.SyntaxKind.VoidExpression
    if (ts.isFunctionExpression(arg)) return containsReturnValue(arg.body)
    return false
  }
  function containsReturnValue(block: TS.Node): boolean {
    let found = false
    const v = (n: TS.Node) => {
      if (found || isFn(n)) return
      if (ts.isReturnStatement(n) && n.expression) found = true
      ts.forEachChild(n, v)
    }
    ts.forEachChild(block, v)
    return found
  }

  fn(sf)
  return { counts: s, lines }
}

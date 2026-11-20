import type { Node, Program, SourceFile, TypeChecker } from "typescript"
import { ts } from "./lib"

export const SYNTAX_RULES = new Set([
  "raw-timer",
  "runtime-create",
  "effect-run-business",
  "tool-cause",
  "schema-any",
  "solid-async-effect",
  "swallow",
  "test-sleep",
])

export function syntax(sources: Map<string, string>, edges: { file: string; spec: string; target?: string }[] = []) {
  const options = {
    noResolve: true,
    noLib: true,
    noEmit: true,
    allowJs: true,
    target: ts.ScriptTarget.Latest,
    moduleDetection: ts.ModuleDetectionKind.Force,
  }
  const contexts = new Map<string, { source: SourceFile; program: Program; checker: TypeChecker }>()
  const owners = new WeakMap<SourceFile, TypeChecker>()
  const targets = new Map(
    edges.filter((edge) => edge.target).map((edge) => [edge.file + "\0" + edge.spec, edge.target!]),
  )

  function context(file: string) {
    const saved = contexts.get(file)
    if (saved) {
      contexts.delete(file)
      contexts.set(file, saved)
      return saved
    }
    if (!sources.has(file)) throw new Error(`未载入源码：${file}`)
    const host = ts.createCompilerHost(options, true)
    host.fileExists = (name) => name === file
    host.readFile = (name) => (name === file ? sources.get(file) : undefined)
    const program = ts.createProgram([file], options, host)
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`未载入源码：${file}`)
    const checker = program.getTypeChecker()
    const value = { source, program, checker }
    contexts.set(file, value)
    owners.set(source, checker)
    if (contexts.size > 32) contexts.delete(contexts.keys().next().value!)
    return value
  }

  function checker(node: Node) {
    const value = owners.get(node.getSourceFile())
    if (!value) throw new Error(`语法节点缺少绑定上下文：${node.getSourceFile().fileName}`)
    return value
  }

  function moduleOrigin(node: Node, spec: string) {
    const target = targets.get(node.getSourceFile().fileName + "\0" + spec)
    return target && sources.has(target) ? ["local", target] : moduleName(spec)
  }

  function member(base: string[] | undefined, name: string, seen: Set<Node>): string[] | undefined {
    if (!base) return
    if (base[0] !== "local") return [...base, name]
    const source = context(base[1]).source
    const previous = [...seen].filter((node) => node.getSourceFile().fileName === source.fileName)
    for (const statement of source.statements) {
      if (seen.has(statement) || previous.some((node) => node.pos === statement.pos && node.kind === statement.kind))
        continue
      const visited = new Set(seen).add(statement)
      if (ts.isExportAssignment(statement) && name === "default") return origin(statement.expression, visited)
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
            return origin(declaration.initializer, visited)
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
      const external =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? moduleOrigin(statement, statement.moduleSpecifier.text)
          : undefined
      if (!statement.exportClause) {
        const value = member(external, name, visited)
        if (value) return value
        continue
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        if (statement.exportClause.name.text === name) return external
        continue
      }
      const entry = statement.exportClause.elements.find((entry) => !entry.isTypeOnly && entry.name.text === name)
      if (!entry) continue
      if (external) return member(external, (entry.propertyName ?? entry.name).text, visited)
      for (const declaration of checker(entry).getExportSpecifierLocalTargetSymbol(entry)?.declarations ?? []) {
        const value = binding(declaration, visited)
        if (value) return value
      }
    }
  }

  function importedOrigin(node: Node): string[] | undefined {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier))
      return moduleOrigin(node, node.moduleSpecifier.text)
    if (node.parent) return importedOrigin(node.parent)
  }

  function binding(declaration: Node, visited: Set<Node>): string[] | undefined {
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly)
      return member(importedOrigin(declaration), (declaration.propertyName ?? declaration.name).text, visited)
    if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly) return importedOrigin(declaration)
    if (ts.isImportClause(declaration) && !declaration.isTypeOnly) {
      const base = importedOrigin(declaration)
      return base?.[0] === "local" ? member(base, "default", visited) : base
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer)
      return origin(declaration.initializer, visited)
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const container = declaration.parent.parent
      if (!ts.isVariableDeclaration(container)) return
      const key = declaration.propertyName ?? declaration.name
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
        return member(origin(container.initializer, visited), key.text, visited)
    }
  }

  function origin(value: Node | undefined, seen = new Set<Node>()): string[] | undefined {
    const node = unwrap(value)
    if (!node || seen.has(node)) return
    const visited = new Set(seen).add(node)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = origin(node.expression, visited)
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined
      if (key) return member(base, key, visited)
      return
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          !checker(node.expression).getSymbolAtLocation(node.expression))
      )
        return moduleOrigin(node, node.arguments[0].text)
    }
    if (!ts.isIdentifier(node)) return
    const declarations = checker(node).getSymbolAtLocation(node)?.declarations ?? []
    if (!declarations.length) {
      if (["globalThis", "window"].includes(node.text)) return ["global"]
      if (node.text === "Bun") return ["bun"]
      if (["Promise", "fetch", "undefined", "sleep"].includes(node.text)) return ["global", node.text]
      if (
        /^(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback)$/.test(
          node.text,
        )
      )
        return ["global", node.text]
    }
    for (const declaration of declarations) {
      const value = binding(declaration, visited)
      if (value) return value
    }
  }

  function asynchronous(value: Node | undefined, seen = new Set<Node>()): boolean {
    const node = unwrap(value)
    if (!node || seen.has(node)) return false
    const visited = new Set(seen).add(node)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return true
      const owner = checker(node)
      const signature = owner.getSignatureFromDeclaration(node)
      if (signature && owner.getPropertyOfType(owner.getReturnTypeOfSignature(signature), "then")) return true
      if (node.body && !ts.isBlock(node.body)) return promised(node.body, visited)
      if (node.body) {
        const returns: Node[] = []
        const scan = (child: Node) => {
          if (ts.isFunctionLike(child)) return
          if (ts.isReturnStatement(child) && child.expression) returns.push(child.expression)
          ts.forEachChild(child, scan)
        }
        scan(node.body)
        if (returns.some((value) => promised(value, visited))) return true
      }
    }
    if (ts.isIdentifier(node))
      return (checker(node).getSymbolAtLocation(node)?.declarations ?? []).some((declaration) =>
        ts.isVariableDeclaration(declaration)
          ? asynchronous(declaration.initializer, visited)
          : ts.isFunctionDeclaration(declaration) && asynchronous(declaration, visited),
      )
    if (ts.isCallExpression(node) && origin(node.expression)?.join("/") === "solid-js/on")
      return asynchronous(node.arguments[1], visited)
    return false
  }

  function promised(value: Node | undefined, seen: Set<Node>): boolean {
    const node = unwrap(value)
    if (!node || seen.has(node)) return false
    const visited = new Set(seen).add(node)
    const owner = checker(node)
    if (owner.getPropertyOfType(owner.getTypeAtLocation(node), "then")) return true
    if (ts.isNewExpression(node)) return origin(node.expression)?.join("/") === "global/Promise"
    if (ts.isCallExpression(node)) {
      const name = origin(node.expression)?.join("/")
      if (/^global\/Promise\/(resolve|reject|all|allSettled|race|any)$/.test(name ?? "") || name === "global/fetch")
        return true
      if (asynchronous(node.expression, visited)) return true
      if (ts.isPropertyAccessExpression(node.expression) && /^(then|catch|finally)$/.test(node.expression.name.text))
        return promised(node.expression.expression, visited)
    }
    if (ts.isIdentifier(node))
      return (checker(node).getSymbolAtLocation(node)?.declarations ?? []).some(
        (declaration) => ts.isVariableDeclaration(declaration) && promised(declaration.initializer, visited),
      )
    if (ts.isConditionalExpression(node)) return promised(node.whenTrue, visited) || promised(node.whenFalse, visited)
    return false
  }

  return (file: string) => {
    const current = context(file)
    const source = current.source
    const diagnostic = current.program.getSyntacticDiagnostics(source)[0]
    if (diagnostic) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)
    const hits = new Map<string, number[]>()
    const hit = (rule: string, node: Node) => {
      const lines = hits.get(rule) ?? []
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
      hits.set(rule, lines)
    }
    const capability = (name: string | undefined, node: Node) => {
      if (!name) return
      if (
        /^(global|timers-promises)\/(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback)$/.test(
          name,
        )
      )
        hit("raw-timer", node)
      if (name === "effect/ManagedRuntime/make") hit("runtime-create", node)
      if (/^effect\/Effect\/run(Promise|Fork|Sync|PromiseExit|SyncExit|Callback)$/.test(name))
        hit("effect-run-business", node)
      if (/^effect\/Effect\/(catchCause|catchCauseIf|catchAllCause|ignoreCause)$/.test(name)) hit("tool-cause", node)
      if (name === "effect/Schema/mutable") hit("schema-any", node)
      if (name === "effect/Effect/ignore") hit("swallow", node)
      if (
        /^(effect\/Effect|bun|global\/Bun|global)\/sleep$|^(global|timers-promises)\/(setTimeout|setInterval)$/.test(
          name,
        )
      )
        hit("test-sleep", node)
    }
    const visit = (node: Node) => {
      if (ts.isCallExpression(node)) {
        const name = origin(node.expression)?.join("/")
        capability(name, node)
        if (/^solid-js\/create(Effect|RenderEffect|Memo|Computed)$/.test(name ?? "") && asynchronous(node.arguments[0]))
          hit("solid-async-effect", node)
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "catch" &&
          emptyCallback(node.arguments[0], origin)
        )
          hit("swallow", node)
        if (/^effect\/Effect\/catch\w*$/.test(name ?? "") && emptyEffectCallback(node.arguments[0], origin))
          hit("swallow", node)
      }
      if (ts.isCatchClause(node) && node.block.statements.length === 0) hit("swallow", node)
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (origin(node)?.join("/") === "effect/Schema/Any") hit("schema-any", node)
      }
      if (
        ts.isIdentifier(node) &&
        !ts.isImportSpecifier(node.parent) &&
        origin(node)?.join("/") === "effect/Schema/Any"
      )
        hit("schema-any", node)
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const base = moduleName(node.moduleSpecifier.text)
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const entry of node.exportClause.elements) {
            if (entry.isTypeOnly) continue
            const name = [...base, (entry.propertyName ?? entry.name).text].join("/")
            capability(name, entry)
            if (name === "effect/Schema/Any") hit("schema-any", entry)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return hits
  }
}

function unwrap(node: Node | undefined): Node | undefined {
  if (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node))
  )
    return unwrap(node.expression)
  return node
}

function moduleName(name: string) {
  if (name === "node:timers" || name === "timers") return ["global"]
  if (name === "node:timers/promises" || name === "timers/promises") return ["timers-promises"]
  return name.split("/")
}

function emptyCallback(node: Node | undefined, origin: (node: Node | undefined) => string[] | undefined) {
  if (!node || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) return false
  if (ts.isBlock(node.body)) return node.body.statements.length === 0
  return (
    node.body.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isVoidExpression(node.body) && ts.isNumericLiteral(node.body.expression)) ||
    (ts.isIdentifier(node.body) && origin(node.body)?.join("/") === "global/undefined")
  )
}

function emptyEffectCallback(node: Node | undefined, origin: (node: Node | undefined) => string[] | undefined) {
  if (!node || !ts.isArrowFunction(node) || node.parameters.length) return false
  const body = ts.isCallExpression(node.body) ? node.body.expression : node.body
  return /^effect\/Effect\/(void|succeed)$/.test(origin(body)?.join("/") ?? "")
}

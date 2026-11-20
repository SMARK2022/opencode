import path from "node:path"
import type { CompilerOptions } from "typescript"
import { collectImports, isSrcFile, loadPackages, pjoin, posix, ts, type ImportRef } from "./lib"

export type Edge = ImportRef & { file: string; target?: string; local: boolean }

// parse 指定时只解析这些文件的导入（暂存区、单文件检查）；其余文件只用于解析目标是否存在。
export function graph(
  root: string,
  packages: Awaited<ReturnType<typeof loadPackages>>,
  sources: Map<string, string>,
  dependencies = root,
  parse?: string[],
) {
  const files = new Set(sources.keys())
  const configurations = new Map<string, CompilerOptions>()
  const cache = ts.createModuleResolutionCache(root, (file) => file)
  const dependencyPath = (file: string) => {
    const name = posix(file)
    const marker = name.lastIndexOf("/node_modules")
    return marker < 0 || !["", "/"].includes(name.slice(marker + 13, marker + 14))
      ? file
      : path.join(dependencies, name.slice(marker + 1))
  }
  const configHost = {
    ...ts.sys,
    fileExists: (file: string) => ts.sys.fileExists(file) || ts.sys.fileExists(dependencyPath(file)),
    directoryExists: (file: string) => ts.sys.directoryExists(file) || ts.sys.directoryExists(dependencyPath(file)),
    readFile: (file: string) => ts.sys.readFile(file) ?? ts.sys.readFile(dependencyPath(file)),
  }
  const options = (file: string) => {
    const config = ts.findConfigFile(path.dirname(path.join(root, file)), ts.sys.fileExists)
    if (!config) return { moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true }
    const saved = configurations.get(config)
    if (saved) return saved
    const read = ts.readConfigFile(config, configHost.readFile)
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, " "))
    const parsed = ts.parseJsonConfigFileContent(read.config, configHost, path.dirname(config), {}, config)
    const error = parsed.errors.find((error) => error.code !== 18003)
    if (error) throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`)
    configurations.set(config, parsed.options)
    return parsed.options
  }
  const existing = (value: string) => {
    const file = posix(value)
    const stem = file.replace(/\.[cm]?jsx?$/, "")
    return [
      file,
      ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((extension) => [
        `${stem}.${extension}`,
        `${file}/index.${extension}`,
      ]),
    ].find((candidate) => files.has(candidate))
  }
  const edges: Edge[] = (parse ?? [...sources.keys()]).flatMap((file) =>
    collectImports(file, sources.get(file) ?? "").map((ref) => {
      const config = options(file)
      const aliases = Object.entries(config.paths ?? {})
        .filter(([key]) => patternValue(key, ref.spec) !== undefined)
        .sort(([a], [b]) => patternOrder(a, b))
      const pkg = [...packages.byName.values()]
        .filter((pkg) => ref.spec === pkg.name || ref.spec.startsWith(`${pkg.name}/`))
        .sort((a, b) => b.name.length - a.name.length)[0]
      const local = ref.spec.startsWith(".") || ref.spec.startsWith("#") || aliases.length > 0 || !!pkg
      const resolve = () => {
        for (const [key, values] of aliases) {
          const base = config.baseUrl ?? (typeof config.pathsBasePath === "string" ? config.pathsBasePath : root)
          for (const value of values) {
            const candidate = posix(
              path.relative(root, path.resolve(base, value.replaceAll("*", patternValue(key, ref.spec)!))),
            )
            const target = existing(candidate)
            if (target) return target
          }
        }
        if (pkg && pkg.json.exports !== undefined) {
          const subpath = ref.spec === pkg.name ? "." : `./${ref.spec.slice(pkg.name.length + 1)}`
          const value = pkg.json.exports
          const nested =
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).some((key) => key.startsWith("."))
          const entries = nested ? Object.entries(value) : [[".", value]]
          const match = entries
            .filter(([key]) => patternValue(key as string, subpath) !== undefined)
            .sort(([a], [b]) => patternOrder(a as string, b as string))[0]
          if (!match) return
          const conditions = new Set([
            ...(ref.type ? ["types"] : []),
            "bun",
            "node",
            ...(config.customConditions ?? []),
            ref.kind === "require" ? "require" : "import",
          ])
          const target = exportTarget(match[1], conditions)
          if (!target) return
          const candidate = pjoin(
            "packages",
            pkg.dir,
            target.replaceAll("*", patternValue(match[0] as string, subpath)!),
          )
          return existing(candidate) ?? candidate
        }
        const found = ts.resolveModuleName(ref.spec, path.join(root, file), config, ts.sys, cache).resolvedModule
        if (found) return posix(path.relative(root, found.resolvedFileName))
        if (ref.spec.startsWith(".")) {
          const candidate = pjoin(path.posix.dirname(file), ref.spec)
          return existing(candidate) ?? candidate
        }
      }
      return { ...ref, file, local, target: resolve() }
    }),
  )
  const transpilers = new Map<string, Bun.Transpiler>()
  let runtime: Edge[] | undefined
  const emitted = () =>
    (runtime ??= [...Map.groupBy(edges, (edge) => edge.file)].flatMap(([file, refs]) => {
      const loader = file.endsWith("x") ? "tsx" : "ts"
      const preserve = options(file).verbatimModuleSyntax === true
      const key = `${loader}:${preserve}`
      const transpiler = transpilers.get(key) ?? new Bun.Transpiler({ loader, trimUnusedImports: !preserve })
      transpilers.set(key, transpiler)
      const imports = new Set(
        transpiler.scanImports(sources.get(file)!.replace(/^#![^\r\n]*/, "")).map((ref) => ref.path),
      )
      return refs.filter((ref) => !ref.type && imports.has(ref.spec))
    }))
  return {
    edges,
    get cycles() {
      return cyclicEdges(emitted(), files)
    },
  }
}

function patternValue(key: string, value: string) {
  if (key === value) return ""
  const parts = key.split("*")
  if (parts.length === 2 && value.startsWith(parts[0]) && value.endsWith(parts[1]))
    return value.slice(parts[0].length, value.length - parts[1].length)
}

function patternOrder(a: string, b: string) {
  if (!a.includes("*")) return -1
  if (!b.includes("*")) return 1
  return b.indexOf("*") - a.indexOf("*") || b.length - a.length
}

function exportTarget(value: unknown, conditions: Set<string>): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) return value.map((entry) => exportTarget(entry, conditions)).find(Boolean)
  const record = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(record))
    if (key === "default" || conditions.has(key)) {
      const result = exportTarget(entry, conditions)
      if (result) return result
    }
}

function cyclicEdges(edges: Edge[], files: Set<string>) {
  const runtime = edges.filter(
    (edge) =>
      !edge.type &&
      edge.kind !== "dynamic" &&
      edge.target &&
      files.has(edge.target) &&
      edge.target !== edge.file &&
      isSrcFile(edge.file) &&
      isSrcFile(edge.target),
  )
  const outgoing = Map.groupBy(runtime, (edge) => edge.file)
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const pending = new Set<string>()
  const component = new Map<string, number>()
  const sizes: number[] = []
  const visit = (file: string) => {
    const index = indices.size
    indices.set(file, index)
    low.set(file, index)
    stack.push(file)
    pending.add(file)
    for (const edge of outgoing.get(file) ?? []) {
      const target = edge.target!
      if (!indices.has(target)) {
        visit(target)
        low.set(file, Math.min(low.get(file)!, low.get(target)!))
      } else if (pending.has(target)) low.set(file, Math.min(low.get(file)!, indices.get(target)!))
    }
    if (low.get(file) !== index) return
    const id = sizes.length
    let size = 0
    for (;;) {
      const member = stack.pop()!
      pending.delete(member)
      component.set(member, id)
      size++
      if (member === file) break
    }
    sizes.push(size)
  }
  for (const file of outgoing.keys()) if (!indices.has(file)) visit(file)
  return runtime.filter(
    (edge) => component.get(edge.file) === component.get(edge.target!) && sizes[component.get(edge.file)!] > 1,
  )
}

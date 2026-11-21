// 测试选择的升级规则。只允许人类在独立 PR 中修改。
import { readFileSync } from "node:fs"
import path from "node:path"

const main = ["core", "opencode", "tui", "server", "cli", "llm", "plugin", "sdk/js"]

// 契约测试每次正常 push 都验证；它们加载的包也算作本次测试的输入。
const contracts = ["schema", "protocol"]

export const RUNTIME = new RegExp("^packages/(" + main.join("|") + ")/")
export const RUNTIME_SOURCE = new RegExp(RUNTIME.source + "src/")

// 预算和冒烟测试始终入选；改到守卫自身时另跑守卫自测。
export const ALWAYS_RUN = [/\/test\/budget\//, /\/test\/smoke\//]

// 某个包的受影响测试超过这个比例，直接跑该包全量（避免挑选本身的开销和遗漏）。
export const FULL_RATIO = 0.5

export function preflightPlatforms(value: string) {
  const names = [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((name) => name.toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (!names.length || names.some((name) => !["linux", "macos", "windows"].includes(name)))
    throw new Error(`未知平台：${value || "（空）"}。可选 linux, macos, windows`)
  return names
}

// 从起点沿边加入所有可达项。Set 迭代会访问新加入的项，每个节点只展开一次。
export function closure(edges: Map<string, Set<string>>, start: string[]) {
  const seen = new Set(start)
  for (const item of seen) {
    for (const next of edges.get(item) ?? []) seen.add(next)
  }
  return seen
}

export function guardPlan(files: string[], repo = process.cwd(), requested?: string) {
  // 根配置不经过 import 图；改动它们时，所有主线测试包都要跑全量。
  const global = files.some((f) =>
    /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig(?:\.[^/]+)?\.json|turbo\.json)$/.test(f),
  )

  const patches = files.filter((f) => f.startsWith("patches/"))
  const affected = new Set<string>()
  if (patches.length) {
    type Meta = {
      dependencies?: object
      optionalDependencies?: object
      peerDependencies?: object
      devDependencies?: object
    }
    type Lock = {
      patchedDependencies: Record<string, string>
      packages: Record<string, [string, ...unknown[]]>
      workspaces: Record<string, Meta & { name: string }>
    }

    const lock = Bun.JSONC.parse(readFileSync(path.join(repo, "bun.lock"), "utf8")) as Lock
    const owners = new Map<string, Set<string>>()
    const add = (name: string, m: Meta, workspace = false) => {
      const dependencies = {
        ...m.dependencies,
        ...m.optionalDependencies,
        ...m.peerDependencies,
        ...(workspace && m.devDependencies),
      }
      for (const dep of Object.keys(dependencies)) {
        const parents = owners.get(dep) ?? new Set<string>()
        parents.add(name)
        owners.set(dep, parents)
      }
    }

    const nameOf = (key: string) => key.slice(0, key.indexOf("@", 1))
    for (const [spec, ...rest] of Object.values(lock.packages))
      add(nameOf(spec), rest.find((v): v is Meta => !!v && typeof v === "object") ?? {})
    for (const [dir, m] of Object.entries(lock.workspaces)) {
      if (dir) add(m.name, m, true)
    }

    for (const file of patches) {
      const keys = Object.keys(lock.patchedDependencies).filter((k) => lock.patchedDependencies[k] === file)
      // 删除或重命名补丁时，当前锁文件可能已没有旧映射；此时只在主线范围内升级。
      if (!keys.length) {
        for (const pkg of main) affected.add(pkg)
        continue
      }
      const seen = closure(owners, keys.map(nameOf))
      for (const p of main) {
        if (seen.has(lock.workspaces["packages/" + p]?.name)) affected.add(p)
      }
    }
  }

  // 包配置、共享测试夹具和迁移都可能影响 import 图无法定位的用例；只升级所属包。
  const full = (pkg: string) => {
    if (!main.includes(pkg)) return false
    if (global || affected.has(pkg)) return true
    return files.some((file) => {
      if (!file.startsWith("packages/" + pkg + "/")) return false
      const relative = path.posix.relative("packages/" + pkg, file)
      return (
        [
          /^(package\.json|bunfig\.toml|tsconfig(?:\.[^/]+)?\.json)$/,
          /^tests?\/(preload\.[cm]?[jt]s$|fixture\/|lib\/|fake\/)/,
          /\.sql\.ts$/,
        ].some((rule) => rule.test(relative)) || /^packages\/core\/(migration|drizzle)\//.test(file)
      )
    })
  }

  // 平台敏感路径决定 preflight 是否需要跨平台，不扩大测试包的范围。
  const sensitive =
    global ||
    affected.size > 0 ||
    files.some(
      (f) =>
        (RUNTIME.test(f) && f.endsWith("/package.json")) ||
        (RUNTIME_SOURCE.test(f) &&
          /shell|pty|process|spawn|win32|windows|flock|which|glob|watcher|clipboard|terminal|editor|fs-util|filesystem|path|encoding|decoding/i.test(
            f,
          )),
    )

  const platforms = preflightPlatforms(
    requested ||
      (sensitive
        ? process.env.GUARD_PREFLIGHT_PLATFORMS || "macos,linux"
        : process.env.GUARD_PREFLIGHT_FULL_PLATFORMS || "linux"),
  )

  return {
    main,
    contracts,
    full,
    sensitive,
    platforms,
    // 主线运行时代码和影响它的依赖补丁触发性能基准。
    bench: affected.size > 0 || files.some((f) => RUNTIME_SOURCE.test(f)),
    suite: (f: string) => RUNTIME.test(f) && !f.includes("/e2e/"),
    stopContracts: contracts.filter((p) =>
      files.some((f) => f.startsWith("script/guard/") || f.startsWith("packages/" + p + "/")),
    ),
  }
}

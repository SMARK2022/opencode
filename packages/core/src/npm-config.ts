// registry 选择也使用 routed transport，探测结果不能与随后下载的网络路径脱节。
export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"
import { NetworkProxy } from "./network-proxy"

const npmPath = fileURLToPath(new URL("..", import.meta.url))
// 官方源优先且保留镜像候选，配置缺省时才进行网络可用性选择。
// 候选顺序是策略而非 RTT 排名，不能把一次 ping 的耗时当成配置优先级。
const defaultRegistry = "https://registry.npmjs.org"
const mirrorRegistry = "https://registry.npmmirror.com"
let selectedRegistry: { expires: number; value: Promise<string> } | undefined

function normalizeRegistry(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

// 显式环境覆盖必须跳过自动选源，企业私有 registry 不能被公共镜像替换。
function envRegistry() {
  return process.env.OPENCODE_NPM_REGISTRY || process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
}

// ping 失败只淘汰候选；它不是实际安装失败，也不能阻止读取已有 npm 配置。
async function pingRegistry(registry: string) {
  try {
    const response = await NetworkProxy.routedFetch(`${normalizeRegistry(registry)}/-/ping?write=false`, {
      purpose: "npm",
      method: "GET",
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

// 先验证官方源再尝试镜像，两者都不可用时仍交给 npm 的正常错误路径报告失败。
async function selectRegistry() {
  const candidates = [defaultRegistry, mirrorRegistry]
  for (const candidate of candidates) {
    if (await pingRegistry(candidate)) return candidate
  }
  return defaultRegistry
}

// 共享选源 Promise 可合并并发安装的探测，而过期后必须允许网络切换重新选择。
// 缓存只针对缺省源；私有或显式配置的 registry 不受这一分钟策略影响。
function defaultRegistryForNetwork() {
  if (!selectedRegistry || selectedRegistry.expires < Date.now()) {
    selectedRegistry = { expires: Date.now() + 60_000, value: selectRegistry() }
  }
  return selectedRegistry.value
}

export const load = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const config = new Config({
        npmPath,
        cwd: dir,
        env: { ...process.env },
        argv: [process.execPath, process.execPath],
        execPath: process.execPath,
        platform: process.platform,
        definitions,
        flatten,
        nerfDarts,
        shorthands,
        warn: false,
      })
      await config.load()
      const flat = config.flat as Record<string, unknown>
      const registry = envRegistry()
      if (registry) return { ...flat, registry }
      if (typeof flat.registry !== "string" || normalizeRegistry(flat.registry) === defaultRegistry) {
        return { ...flat, registry: await defaultRegistryForNetwork() }
      }
      return flat
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : defaultRegistry
      return normalizeRegistry(registry)
    }),
  )

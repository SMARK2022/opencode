export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"
import { NetworkProxy } from "./network-proxy"

const npmPath = fileURLToPath(new URL("..", import.meta.url))
const defaultRegistry = "https://registry.npmjs.org"
const mirrorRegistry = "https://registry.npmmirror.com"
let selectedRegistry: { expires: number; value: Promise<string> } | undefined

function normalizeRegistry(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function envRegistry() {
  return process.env.OPENCODE_NPM_REGISTRY || process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
}

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

async function selectRegistry() {
  const candidates = [defaultRegistry, mirrorRegistry]
  for (const candidate of candidates) {
    if (await pingRegistry(candidate)) return candidate
  }
  return defaultRegistry
}

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

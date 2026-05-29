#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

// 只在构建脚本中导入既有生成 owner，避免 CLI argv/bootstrap 副作用，不增加 SDK runtime 依赖。
// 继续写同一 OpenAPI 输入文件，后续官方插件与修补流程完整保留，生成失败直接阻止构建。
const { generateOpenApiJson } = await import(path.join(opencode, "src/cli/cmd/generate.ts"))
await Bun.write(path.join(dir, "openapi.json"), await generateOpenApiJson())

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// cancel() 返回 Promise，同步 try/catch 接不到原生 fetch 取消响应体后的拒绝。
// 修补生成入口，避免下次 SDK 再生成时丢失清理责任。
const ssePath = "./src/v2/gen/core/serverSentEvents.gen.ts"
const sseSource = await Bun.file(ssePath).text()
const ssePatched = sseSource.replace(
  /const abortHandler = \(\) => \{\s*try \{\s*reader\.cancel\(\);?\s*\} catch \{\s*\/\/ noop\s*\}\s*\};?/,
  `const abortHandler = () => {
    // 只消化当前请求的取消，真实清理失败仍交给既有 SSE 错误通道。
    void reader.cancel().catch((error: unknown) => {
      if (signal.aborted && error === signal.reason) return
      onSseError?.(error)
    })
  }`,
)
if (ssePatched === sseSource) {
  throw new Error(`SSE cancellation patch did not apply; generated transport may have changed (${ssePath})`)
}
await Bun.write(ssePath, ssePatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
// TypeScript 的 CLI 是 Node 入口：经由 Bun 启动会在 Windows CI 上让 SDK 构建进程悬挂不退（#461）；
// resolveSync 把 tsc 定位到本 workspace 依赖内的绝对路径，避免 PATH 上的同名二进制劫持。
await $`node ${Bun.resolveSync("typescript/bin/tsc", dir)}`
await $`rm openapi.json`

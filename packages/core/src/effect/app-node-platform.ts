import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { NetworkProxy } from "../network-proxy"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({
  service: HttpClient.HttpClient,
  // 独立 Server、embedded 与 V2 共用这个 Fetch transport，不能只依赖 daemon 安装全局代理。
  layer: FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(
    FetchHttpClient.Fetch,
    // 保留原 HttpClient 的 body、headers、signal 与 typed error，只替换最低层运输。
    Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => NetworkProxy.routedFetch(input, init),
      { preconnect: fetch.preconnect },
    ),
  ))),
  deps: [],
})
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient],
})
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"

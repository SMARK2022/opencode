import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import path from "path"
import { Workspace } from "../../src/control-plane/workspace"
import { ServerAuth } from "../../src/server/auth"
import { FileApi, FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { fileHandlers } from "../../src/server/routes/instance/httpapi/handlers/file"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Session } from "../../src/session/session"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// 独立 layer scope 持有内存数据库与服务，不调用会启动全局 AppRuntime 的清理桥。
// 使用仓库的 scoped runner 与真实 HTTP listener，不复用已关闭的全局 handler。
const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

// 只挂载 FileApi，省去旧 HttpApi 全量装配；LocationServiceMap 仍用生产实现。
// 复用已有的无启动副作用 InstanceStore fixture；文件搜索仍走真实 FFF 与 rg。
// 在目录之后构建此层，确保 native 索引与 watcher 先释放，再删除目录。
// 沿用生产 handler 的 API 标识，只装配文件组，避免类型身份与运行时路由键脱节。
const serveFiles = HttpApiBuilder.layer(HttpApi.make("opencode-instance").addHttpApi(FileApi)).pipe(
  Layer.provide(fileHandlers),
  Layer.provide([instanceContextLayer, workspaceRoutingLayer, authorizationLayer, schemaErrorLayer]),
  Layer.provide([ServerAuth.Config.layer, layerWebSocketConstructorGlobal]),
  // 先展开请求期依赖，再由同一服务层同时满足路由构建与请求执行。
  HttpRouter.serve,
  Layer.provide([
    testInstanceStoreLayer,
    AppNodeBuilder.build(LayerNode.group([Workspace.node, Session.node, Ripgrep.node, FSUtil.node])),
  ]),
  Layer.build,
)

function request(route: string, directory: string, query?: Record<string, string>) {
  return HttpClient.get(route, { headers: { "x-opencode-directory": directory }, urlParams: query })
}

describe("file HttpApi", () => {
  it.live("serves read endpoints", () =>
    Effect.gen(function* () {
      // 读取用例继续覆盖 git 项目的目录上下文，不把所有请求缩成普通目录。
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(path.join(dir, "hello.txt"), "hello"))
      yield* serveFiles

      // 保持原有并发请求，验证同目录共享上下文而不是人为串行规避竞争。
      const [list, content, status] = yield* Effect.all(
        [
          request(FilePaths.list, dir, { path: "." }),
          request(FilePaths.content, dir, { path: "hello.txt" }),
          request(FilePaths.status, dir),
        ],
        { concurrency: "unbounded" },
      )

      expect(list.status).toBe(200)
      expect(yield* list.json).toContainEqual(
        expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
      )

      expect(content.status).toBe(200)
      expect(yield* content.json).toMatchObject({ type: "text", content: "hello" })

      expect(status.status).toBe(200)
      expect(yield* status.json).toEqual([])
    }),
  )

  it.live("serves search endpoints", () =>
    Effect.gen(function* () {
      // 文件名和文本搜索不依赖 git 提交，省去此用例的七次 git 准备进程。
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(dir, "hello.txt"), "needle"))
      yield* serveFiles

      const [text, symbols] = yield* Effect.all(
        [
          request(FilePaths.findText, dir, { pattern: "needle" }),
          request(FilePaths.findSymbol, dir, { query: "hello" }),
        ],
        { concurrency: "unbounded" },
      )
      // 先校验字符串数组，错误响应直接失败；只为合法结果尚未入索引保留五秒轮询。
      const files = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* request(FilePaths.findFile, dir, { query: "hello", type: "file" })
          const body = yield* HttpClientResponse.schemaBodyJson(Schema.Array(Schema.String))(response)
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      )

      expect(text.status).toBe(200)
      expect(yield* text.json).toContainEqual(expect.objectContaining({ line_number: 1 }))

      expect(files.response.status).toBe(200)
      expect(files.body).toContain("hello.txt")

      // 保留当前符号端点的空结果契约，不用替身制造预期输出。
      expect(symbols.status).toBe(200)
      expect(yield* symbols.json).toEqual([])
    }),
  )
})

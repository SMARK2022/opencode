/**
 * HTTP 笔记本桥接监听 127.0.0.1:<OS-assigned port>；处理器不持有服务器或请求流。
 * 原生笔记本操作绕过 LM 工具代理，并将二进制输出保留为不可变的导出文件。
 * GET /health 仅提供无需认证的存活检查；笔记本 POST 请求要求本次实例的 Bearer 或查询参数 token。
 * 端点列表：
 *   GET  /health               - 桥接存活状态，不代表内核就绪
 *   POST /notebook/summary     - 结构、规范化单元格 ID 与结构化执行状态
 *   POST /notebook/source      - 按 offset/limit 分页的全局虚拟源码
 *   POST /notebook/run         - 针对明确文档的原生执行与捕获结果
 *   POST /notebook/edit        - 通过 WorkspaceEdit 插入、删除、替换内容或替换结构
 *   POST /notebook/output      - 将已有输出按原始字节导出为文件
 *   POST /notebook/cell-output - /notebook/output 的别名，使用相同认证
 *   POST /notebook/env         - 实际活动内核与保存的元数据分列报告
 * 所有 notebook 端点要求 filePath；路径或 URI 绑定目标文档，不由当前编辑器焦点决定。
 * 导出文件响应同时保留 artifactPath 与 artifactURI，包括远程 scheme 和 authority。
 */
import http from "node:http"
import { randomUUID } from "node:crypto"
import { isRecord, stringProp } from "./util"
import { notebookSummary } from "./notebook/summary"
import { notebookSource } from "./notebook/source"
import { runNotebook } from "./notebook/run"
import { editNotebook } from "./notebook/edit"
import { readNotebookCellOutput } from "./notebook/output"
import { notebookEnv } from "./notebook/env"

const BRIDGE_HOST = "127.0.0.1"
// 桥接服务仅绑定本机回环地址，杜绝网络暴露

// 路由集合先决定是否读取请求体，未知路径不能因无关 JSON 内容从 404 变成 500。
const NOTEBOOK_ROUTES = new Set(["/notebook/summary", "/notebook/source", "/notebook/run", "/notebook/edit", "/notebook/output", "/notebook/cell-output", "/notebook/env"])

export type BridgeInfo = { port: number; token: string }
// 导出的 BridgeInfo 必须同时携带端口与 token，终端模块不能把地址当成访问凭证。

let server: http.Server | undefined
let lifetime: Promise<void> | undefined
let closing = true
// 屏障覆盖 listen 的启动期，取消意图与服务器引用都属于同一个 bridge owner。

export async function closeBridge() {
// bridge 模块持有唯一服务器句柄，外部只调用 closeBridge，不保存可独立关闭的副本。
  // 重复卸载共享同一个关闭屏障，不能在第一个 close 回调前清空 owner 并重新激活。
  if (closing) return lifetime
  closing = true
  const startup = lifetime
  lifetime = (async () => {
    // 先等启动成功、失败或取消结算，避免在 pending listen 上误判 listening=false。
    await startup
    const current = server
    try {
      // Node 的关闭完成发生在回调；未监听的启动失败实例不需要调用 close 制造第二个错误。
      if (current?.listening) await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()))
    } finally {
      // 引用只在关闭结算后释放；标志保持关闭，直到下一次实际激活。
      server = undefined
      lifetime = undefined
    }
  })()
  return lifetime
}

export function activateBridge(output: { appendLine(value: string): void }) {
  // 模块激活边界先检查旧 owner，不能让重入激活取消已经承诺的关闭动作。
  if (lifetime) throw new Error("VS Code bridge activation is already owned")
  closing = false
  const bridge = startBridge(output)
  // 资源屏障只等待启动结算；终端仍持有原 Promise，启动失败不会被转成成功凭证。
  lifetime = bridge.then(() => undefined, () => undefined)
  void bridge.catch((error) => {
    // 卸载取消不向已经退出的日志上下文写入；正常启动失败仍保留原诊断。
    if (!closing) output.appendLine(`[bridge] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
  // 公共启动接口返回可拒绝的凭证 Promise，不能把只表示结算的 lifetime 暴露给终端并吞掉启动失败。
  return bridge
}

async function startBridge(output: { appendLine(value: string): void }): Promise<BridgeInfo> {
  // 工厂不复位关闭意图；关闭后的重启必须经过实际激活入口。
  if (closing) throw new Error("VS Code bridge startup cancelled")
  const token = randomUUID()
  // crypto 已由输出模块静态加载；此处同步生成实例 token，不再引入额外的 import 等待。

  const httpServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`)
      // URL 解析也可能抛错，必须由同一个请求边界结束响应，不能留下未观察的拒绝。
      output.appendLine(`[bridge] ${request.method} ${url.pathname}`)

      if (request.method === "GET" && url.pathname === "/health") {
        // 健康响应只证明桥接进程存活，不能证明某个 notebook 内核就绪。
        return writeJson(response, 200, { ok: true, service: "opencode-vscode-bridge" })
      }

      if (!authorized(request, url, token)) {
        // 先鉴权再读取工具或 notebook 参数，未授权请求不能触发编辑器操作。
        return writeJson(response, 401, { ok: false, error: "Unauthorized" })
      }

      // 保留源未知路由的 404；即使 body 是 null、数组或坏 JSON，也不启动解析器。
      if (request.method !== "POST" || !NOTEBOOK_ROUTES.has(url.pathname)) return writeJson(response, 404, { ok: false, error: "Not found" })
      // 只解析一次请求体；鉴权先完成，语法错误仍由原 500 边界处理。
      const body = await readJson(request)
      // env 也需要提交明确路径，非对象请求与其它 notebook 路由共用既有 400 边界。
      if (!isRecord(body)) {
        return writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
      }
      const result = await routeRequest(request.method ?? "", url.pathname, body, output)
      // notebook 处理器只返回结果，不能自行结束 response；HTTP owner 在此统一决定成功状态与序列化。
      if (result !== undefined) {
        return writeJson(response, 200, result)
      }

      writeJson(response, 404, { ok: false, error: "Not found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[bridge] error: ${message}`)
      writeJson(response, 500, { ok: false, error: message })
    }
  })

  return await new Promise((resolve, reject) => {
    // 创建出的实例在 listen 前就归 owner 持有，卸载不会漏掉尚未触发回调的句柄。
    server = httpServer
    httpServer.once("error", reject)
    // 监听错误须结算凭证 Promise，否则 openTerminal 的 await bridge 会无限等待不可用地址。
    // 回环地址约束监听范围，随机 token 约束能访问本机端口的调用者。
    httpServer.listen(0, BRIDGE_HOST, () => {
      // 系统原子分配端口，避免先挑选或探测空闲端口再 listen 之间的抢占窗口。
      // 迟到的回调只结算取消，不能记录端口/token 或向终端发布 BridgeInfo。
      if (closing) return reject(new Error("VS Code bridge startup cancelled"))
      const address = httpServer.address()
      if (!address || typeof address === "string") {
        // 只有 TCP 地址对象提供可注入的端口，未绑定或 socket 地址不能冒充可用 BridgeInfo。
        reject(new Error("Failed to resolve bridge server port"))
        return
      }

      const base = `http://${BRIDGE_HOST}:${address.port}`
      output.appendLine(`[bridge] listening on ${base}`)
      output.appendLine(`[bridge] token ${token}`)
      for (const ep of ["health", "notebook/summary", "notebook/source", "notebook/run", "notebook/edit", "notebook/output", "notebook/env"]) {
        output.appendLine(`[bridge] ${ep.padEnd(20)} ${base}/${ep}${ep === "health" ? "" : `?token=${token}`}`)
      }
      resolve({ port: address.port, token })
    })
  })
}

async function routeRequest(
// 路由模块负责 HTTP 分发，notebook 模块只接收已解析对象，不持有请求流。
  method: string,
  pathname: string,
  body: unknown,
  output: { appendLine(value: string): void },
) {
  if (method !== "POST" || !NOTEBOOK_ROUTES.has(pathname)) return undefined
  // undefined 是未匹配路由的判别值，不能被 HTTP 层序列化成成功的空结果。

  if (!isRecord(body)) {
    throw new Error("Expected JSON object body")
  }

  const filePath = stringProp(body, "filePath")
  // 已鉴权路由共享必填路径检查，不能用类型断言把缺失路径送入新的严格接口。
  if (!filePath) throw new Error("filePath is required")

  switch (pathname) {
    case "/notebook/env":
      return await notebookEnv(filePath)

    case "/notebook/summary":
      return await notebookSummary(filePath)

    case "/notebook/source":
      return await notebookSource(body)

    case "/notebook/run":
      return await runNotebook(body)

    case "/notebook/edit":
      return await editNotebook(body)

    case "/notebook/output":
    case "/notebook/cell-output": {
      // 输出别名复用前置鉴权路径，70 删除 LM 路由不改变其余 notebook 能力。
      const cellId = typeof body.cellId === "string" ? body.cellId : undefined
      // HTTP 输出契约只传 cellId；数字位置不能覆盖调用方选中的稳定格身份。
      output.appendLine(`[bridge] reading raw notebook output ${filePath} cellId=${cellId ?? "<auto>"}`)
      return await readNotebookCellOutput(filePath, undefined, cellId)
    }

  }

  return undefined
}

function authorized(request: http.IncomingMessage, url: URL, token: string) {
  // 完整 Bearer 比较与源 query-token 契约共用实例凭证；回环监听不能替代认证。
  return request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token
}

function writeJson(response: http.ServerResponse, status: number, value: unknown) {
  // HTTP 状态码表达路由、鉴权或处理失败，不能只在 JSON 内写错误文案。
  // UTF-8 响应保留中文诊断与 notebook 内容，避免依赖系统默认编码。
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  // 一次结束响应并序列化原结构；异常沿请求错误边界传播，不能返回截断的成功 JSON。
  response.end(JSON.stringify(value, null, 2))
}

function readJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = ""
    // setEncoding 保证跨 chunk 的多字节字符由流解码器正确拼接。
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      // 等到 end 才解析完整请求；空体默认对象保留源契约，字段仍由路由校验。
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
    // 流错误与 JSON 语法错误都拒绝 Promise，由路由的错误边界生成响应。
  })
}

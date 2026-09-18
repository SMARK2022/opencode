import { createServer, IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"

export function createNodeHttpServer() {
  const server = createServer({
    IncomingMessage: class extends IncomingMessage {
      override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        // 正常body EOF仍需等待响应，不能提前移除转录期间的断连回调。
        if (!error && this.complete && this.readableEnded) {
          callback(null)
          return
        }
        // 上传中断与读取错误仍走原生销毁，保留aborted及socket清理。
        super._destroy(error, callback)
      }
    },
    ServerResponse: class extends ServerResponse {
      override assignSocket(socket: Socket) {
        // 沿公开绑定路径保留socket.close到response.close的运行时传播。
        super.assignSocket(socket)
      }
    },
  })
  server.on("request", (request, response) => {
    // 成功与断开共用一次完成点，先解绑双方监听再归还原生方法。
    const finish = () => {
      response.off("finish", finish)
      response.off("close", finish)
      // 响应可能早于请求EOF，随后到达的读取完成仍交原生方法清理。
      request._destroy = IncomingMessage.prototype._destroy
      // 只补已延期的正常EOF，不能主动销毁尚未消费的GET及keepalive连接。
      if (request.destroyed && request.complete && request.readableEnded)
        IncomingMessage.prototype._destroy.call(request, null, () => {})
    }
    response.once("finish", finish)
    response.once("close", finish)
  })
  return server
}

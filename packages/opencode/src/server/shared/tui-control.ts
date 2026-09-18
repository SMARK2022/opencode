import { AsyncQueue } from "@/util/queue"
import { Schema } from "effect"

export const TuiRequest = Schema.Struct({
  path: Schema.String,
  body: Schema.Unknown,
})

export type TuiRequest = Schema.Schema.Type<typeof TuiRequest>

const request = new AsyncQueue<TuiRequest>()
const response = new AsyncQueue<unknown>()

export function nextTuiRequest() {
  return request.next()
}

export function submitTuiRequest(body: TuiRequest) {
  request.push(body)
}

export function submitTuiResponse(body: unknown) {
  response.push(body)
}

export function nextTuiResponse() {
  return response.next()
}

// 语音事务归Core所有，旧路由和Native入口消费同一实现及凭据锁。
export * from "@opencode-ai/core/voice"

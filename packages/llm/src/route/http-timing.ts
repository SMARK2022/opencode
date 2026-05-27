export * as FetchTiming from "./http-timing"

import type { HttpClientResponse } from "effect/unstable/http"

let sequence = 0
export const begin = (startedAt: number) => ({ requestID: ++sequence, startedAt })

// 只关联同一物理响应的诊断，不保留响应寿命，也不参与重试或业务选择。
export const responses = new WeakMap<HttpClientResponse.HttpClientResponse, ReturnType<typeof begin>>()

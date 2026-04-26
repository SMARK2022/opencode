import type { HttpRecorder } from "@opencode-ai/http-recorder"
import { Schema } from "effect"
import { defaultMatcher } from "../../http-recorder/src/matching"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

export const matchOpenAIParallelDefaults: HttpRecorder.RequestMatcher = (incoming, recorded) =>
  defaultMatcher(incoming, {
    ...recorded,
    // 只补旧录制期望的服务端默认true；真实请求仍须显式携带，已有false和其他字段严格比较。
    body: JSON.stringify({ parallel_tool_calls: true, ...decode(recorded.body) }),
  })

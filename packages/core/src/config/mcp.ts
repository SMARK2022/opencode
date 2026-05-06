export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))

// 继承服务器可只改启停；必须在配置文档合并后再要求完整连接信息。
export class Toggle extends Schema.Class<Toggle>("ConfigV2.MCP.Toggle")({ disabled: Schema.Boolean }) {}
export const Entry = Schema.Union([Server, Toggle])

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Entry).pipe(Schema.optional),
}) {}

export interface Resolved {
  readonly timeout?: Timeout
  readonly servers?: Readonly<Record<string, typeof Server.Type>>
}

export function resolve(entries: readonly Info[]): Resolved {
  const merged = entries.reduce<Info>((previous, current) => inherit(previous, current), {})
  return {
    timeout: merged.timeout,
    servers: Object.fromEntries(Object.entries(merged.servers ?? {}).flatMap(([name, server]) => "type" in server ? [[name, server] as const] : [])),
  }
}

function inherit<A extends object>(previous: A | undefined, next: A): A {
  const result = { ...previous, ...next }
  Object.entries(next).forEach(([key, value]) => {
    const old = previous ? Reflect.get(previous, key) : undefined
    // 迁移器补出的undefined不是用户清除；false/空串正常覆盖，数组沿V1替换。
    if (value === undefined) {
      Reflect.set(result, key, old)
      return
    }
    // Schema.Class也承载配置字段，不能只递归plain object而丢掉Header/OAuth继承。
    if (value !== null && typeof value === "object" && !Array.isArray(value) && old !== null && typeof old === "object" && !Array.isArray(old))
      Reflect.set(result, key, inherit(old, value))
  })
  return result
}

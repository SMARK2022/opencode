import { JsonPointer, Schema } from "effect"
import type { Definition, JsonSchema, SchemaType } from "./tool.js"

const isEffectSchema = (schema: SchemaType): schema is Schema.Decoder<unknown> & Schema.Top => Schema.isSchema(schema)

const renderLiteral = (value: unknown): string => JSON.stringify(value) ?? "unknown"

/**
 * Bare TypeScript identifier - usable unquoted as an object key (and, in the tool runtime,
 * with dot access as a tool-path segment). Anything else must be quoted/bracketed.
 */
export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Renders a property name as a valid TS object key: bare when an identifier, quoted otherwise. */
const renderKey = (name: string): string => (identifierSegment.test(name) ? name : JSON.stringify(name))

const effectNumberSentinel = (schema: JsonSchema) =>
  schema.type === "string" &&
  Array.isArray(schema.enum) &&
  schema.enum.length === 1 &&
  (schema.enum[0] === "NaN" || schema.enum[0] === "Infinity" || schema.enum[0] === "-Infinity")

const intersection = (members: ReadonlyArray<string>): string => {
  const concrete = members.filter((member) => member !== "unknown")
  if (concrete.length === 0) return "unknown"
  if (concrete.length === 1) return concrete[0] ?? "unknown"
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ")
}

/**
 * Recursion ceiling for schema rendering. Object, array, and union recursion all increment
 * depth, so this bounds every recursion path - pathological or structurally cyclic schemas
 * degrade to `unknown` instead of overflowing the stack (rendering must never throw).
 */
const MAX_RENDER_DEPTH = 8

// 渲染状态只携带引用定义，紧凑签名不再维护第二种 pretty 模式。
type RenderContext = {
  readonly definitions: Readonly<Record<string, JsonSchema>>
}

const hasUnresolvedRef = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  seen: ReadonlySet<string> = new Set(),
  visited: ReadonlySet<JsonSchema> = new Set(),
): boolean => {
  if (visited.has(schema)) return false
  const nextVisited = new Set([...visited, schema])
  if (schema.$ref !== undefined) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
    const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true
    if (hasUnresolvedRef(definitions[name], definitions, new Set([...seen, name]), nextVisited)) return true
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited))
}

// 字段说明供搜索索引使用；这里只保留一套递归类型渲染，不再拼装 JSDoc。
const renderSchema = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string => {
  if (depth > MAX_RENDER_DEPTH) return "unknown"
  const nested =
    schema.definitions === undefined && schema.$defs === undefined
      ? ctx
      : { ...ctx, definitions: { ...ctx.definitions, ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } }
  if (schema.$ref) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
    const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown"
    return intersection([
      renderSchema(nested.definitions[name], nested, depth, new Set([...seen, name])),
      renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
    ])
  }
  if (schema.const !== undefined) return renderLiteral(schema.const)
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ")
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) {
    // Effect's number schema emits `anyOf: [{ type: "number" }, { const: "NaN" },
    // { const: "Infinity" }, { const: "-Infinity" }]`. Collapse only that artifact;
    // real JSON Schema unions such as `string | number` or `number | null` must keep
    // every branch.
    if (
      alternatives.some((item) => item.type === "number") &&
      alternatives.every((item) => item.type === "number" || effectNumberSentinel(item))
    )
      return "number"
    // An empty Schema.Struct({}) emits `anyOf: [{ type: "object" }, { type: "array" }]`
    // (no properties/items); render the bare shape as {} instead of `{} | Array<unknown>`.
    if (
      alternatives.length === 2 &&
      alternatives[0]?.type === "object" &&
      alternatives[0].properties === undefined &&
      alternatives[1]?.type === "array" &&
      alternatives[1].items === undefined
    ) {
      return "{}"
    }
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (members.some((member) => member === "unknown")) return "unknown"
    return intersection([
      members.join(" | "),
      renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
    ])
  }
  if (schema.allOf) {
    const members = schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown"
    return intersection([renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen), ...members])
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ")
  }
  if (schema.type === "string") return "string"
  if (schema.type === "number" || schema.type === "integer") return "number"
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "null") return "null"
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? [])
    const properties = Object.entries(schema.properties ?? {})
    const additional = schema.additionalProperties
    const indexType =
      additional && typeof additional === "object" ? renderSchema(additional, nested, depth + 1, seen) : undefined
    const field = ([name, value]: readonly [string, JsonSchema]) =>
      `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`

    // 所有展示入口共用紧凑类型；字段说明仅用于搜索索引。
    const fields = properties.map(field)
    if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`)
    return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
  }
  return "unknown"
}

export const toTypeScript = (schema: Schema.Top, decoded = false): string => {
  try {
    const visible = decoded ? Schema.toType(schema) : schema
    const document = Schema.toJsonSchemaDocument(visible) as {
      readonly schema: JsonSchema
      readonly definitions?: Readonly<Record<string, JsonSchema>>
    }
    return renderSchema(document.schema, { definitions: document.definitions ?? {} })
  } catch {
    return "unknown"
  }
}

/** Renders a raw JSON Schema document as a TypeScript type string. */
export const jsonSchemaToTypeScript = (schema: JsonSchema): string => {
  try {
    return renderSchema(schema, { definitions: { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } })
  } catch {
    return "unknown"
  }
}

/** One input property of a tool, extracted best-effort from its input schema. */
export type InputProperty = {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
}

/**
 * The property names, descriptions, and required flags of a tool's input schema - the raw
 * material for search text. Best-effort: Effect Schemas go through their
 * JSON Schema document (the same emission signature rendering uses); JSON Schemas are read
 * directly, resolving a trivial top-level `$ref` into `$defs`/`definitions` when present.
 * Anything unresolvable yields `[]` (search falls back to path + description).
 */
// 搜索字段与签名取相同的完整合同；快捷形式不适用也不能丢失真实对象字段。
export const inputProperties = <R>(definition: Definition<R>): Array<InputProperty> => {
  try {
    const document = isEffectSchema(definition.inputContract)
      ? (Schema.toJsonSchemaDocument(definition.inputContract) as {
          readonly schema: JsonSchema
          readonly definitions?: Readonly<Record<string, JsonSchema>>
        })
      : {
          schema: definition.inputContract,
          definitions: { ...(definition.inputContract.definitions ?? {}), ...(definition.inputContract.$defs ?? {}) },
        }
    const definitions = document.definitions ?? {}
    let schema = document.schema
    if (schema.$ref !== undefined) {
      const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]
      const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
      const resolved = name === undefined ? undefined : definitions[name]
      if (resolved === undefined) return []
      schema = resolved
    }
    const required = new Set(schema.required ?? [])
    return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
      name,
      description: typeof value.description === "string" ? value.description : undefined,
      required: required.has(name),
    }))
  } catch {
    return []
  }
}

// 输入展示与实际适配共用描述符，标量根不采信适配器的展示对象。
export const inputTypeScript = <R>(definition: Definition<R>): string => {
  const original = isEffectSchema(definition.inputContract)
    ? toTypeScript(definition.inputContract, false)
    : jsonSchemaToTypeScript(definition.inputContract)
  // 形式说明与执行共用同一实际描述符；显示字段变更不能移走真实参数键。
  const forms = definition.inputForms
  if (!forms) return original
  const scalar = toTypeScript(forms.scalar)
  return forms.kind === "object"
    ? `${original} | ${scalar}`
    : `${scalar} | Record<string, ${scalar}> /* exactly one own enumerable field; undefined values are not unwrapped */`
}

/** 无输出 schema 时保留 unknown，不从样例推断结果。 */
export const outputTypeScript = <R>(definition: Definition<R>): string =>
  definition.output === undefined
    ? "unknown"
    : isEffectSchema(definition.output)
      ? toTypeScript(definition.output, true)
      : jsonSchemaToTypeScript(definition.output)

/**
 * Decodes tool input before `run` is invoked. Effect Schemas validate (throwing on failure);
 * JSON-Schema-described inputs pass through unvalidated (render-only).
 */
export const decodeInput = <R>(definition: Definition<R>, value: unknown): unknown =>
  isEffectSchema(definition.input) ? Schema.decodeUnknownSync(definition.input)(value) : value

/**
 * Decodes a tool result before it is exposed to the program. Effect Schemas validate and
 * transform (throwing on failure); JSON Schema outputs and tools without an output schema pass
 * the host value through unchanged.
 */
export const decodeOutput = <R>(definition: Definition<R>, value: unknown): unknown =>
  definition.output !== undefined && isEffectSchema(definition.output)
    ? Schema.decodeUnknownSync(definition.output)(value)
    : value

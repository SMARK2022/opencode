import { JsonPointer, Schema, SchemaAST } from "effect" // 只静态读取编码结构，不执行 decoder 猜测参数形式。
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

// 字段说明由 search 的完整 schema 交付，渲染状态不再区分第二种格式。
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

// 字段描述、默认值和格式约束由 search 的原 schema 交付，TS 签名只提供类型概览。
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

    // 省略文档仍须保留必填、可选和索引字段，紧凑展示不能改变可见的参数形状。
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

// 只展示原始输入合同；运行时简写仍由同一合同推导，不把宽容形式重复注入每条签名。
export const inputTypeScript = <R>(definition: Definition<R>): string =>
  isEffectSchema(definition.inputContract)
    ? toTypeScript(definition.inputContract, false)
    : jsonSchemaToTypeScript(definition.inputContract)

// 输出按解码后的域展示，例如 NumberFromString 的返回值为 number，而输入仍是 string。
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

export type InputForms = { readonly key: string; readonly types: ReadonlyArray<string> }

// Undefined 保留原 decoder/default 语义，但绝不参与包装或拆包。
const scalarTypes = (node: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  if (["String", "Number", "Boolean", "Null"].includes(node._tag)) return [node._tag.toLowerCase()]
  if (node._tag === "Undefined") return []
  if (node._tag === "Literal")
    return ["string", "number", "boolean"].includes(typeof node.literal) ? [typeof node.literal] : undefined
  // 对象或不透明 union 成员会让原值与包装值都可能合法，无法唯一确定调用形式。
  if (node._tag === "Union") {
    const members = node.types.map(scalarTypes)
    return members.every((member) => member !== undefined) ? members.flat() : undefined
  }
  return undefined
}

export const inputForms = (schema: Schema.Top): InputForms | undefined => {
  // toEncoded 仅查看结构，原始 refinement、transform 和 default 留在唯一 decoder。
  const ast = Schema.toEncoded(schema).ast
  // 索引签名允许未列出的键，不能仅凭已声明字段推断唯一包装目标。
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0) return undefined
  // 符号字段无法经过普通数据参数边界，省略它会把不完整的合同误判为单字段对象。
  if (ast.propertySignatures.some((property) => typeof property.name !== "string")) return undefined
  const required = ast.propertySignatures.filter((property) => !SchemaAST.isOptional(property.type))
  // 唯一必填项可与可选配置并存；全可选对象只有一个声明字段时才无歧义。
  const candidates = required.length ? required : ast.propertySignatures
  if (candidates.length !== 1) return undefined
  const property = candidates[0]
  const types = scalarTypes(property.type)
  if (typeof property.name !== "string" || !types?.length) return undefined
  // 简写只生成普通字段，避免在已校验参数之外重新引入危险键。
  if (["constructor", "__proto__", "prototype"].includes(property.name)) return undefined
  // 保留字段自己的编码类型；例如数字字符串按 string 匹配，不先执行转换猜测参数。
  return { key: property.name, types }
}

export const normalizeInput = (forms: InputForms | undefined, value: unknown): unknown => {
  if (!forms || value === undefined) return value
  // 对象输入原样进入 decoder；任意单键对象不能反向拆成标量。
  // 按类型匹配才能保留 false、0 和 null；具体取值是否合法仍由原 decoder 决定。
  return forms.types.includes(value === null ? "null" : typeof value) ? { [forms.key]: value } : value
}

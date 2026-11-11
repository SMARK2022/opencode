import { Schema, SchemaAST } from "effect"

// 描述符只来自实际编码域；展示 JSON schema 不能授予额外调用形式。
export type InputForms =
  | { readonly kind: "object"; readonly key: string; readonly scalar: Schema.Top }
  | { readonly kind: "scalar"; readonly scalar: Schema.Top }

// Undefined 保留原 decoder/default 语义，但绝不参与包装或拆包。
const scalarTypes = (node: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  if (node._tag === "String") return ["string"]
  if (node._tag === "Number") return ["number"]
  if (node._tag === "Boolean") return ["boolean"]
  if (node._tag === "Null") return ["null"]
  if (node._tag === "Undefined") return []
  if (node._tag === "Literal")
    return ["string", "number", "boolean"].includes(typeof node.literal) ? [typeof node.literal] : undefined
  // 不执行 union 分支；任一不透明或非标量成员都会禁止适配。
  if (node._tag === "Union") {
    const members = node.types.map(scalarTypes)
    return members.every((member) => member !== undefined) ? members.flat() : undefined
  }
  return undefined
}

export const inputForms = (schema: Schema.Top): InputForms | undefined => {
  // toEncoded 仅查看结构，原始 refinement、transform 和 default 留在唯一 decoder。
  const ast = Schema.toEncoded(schema).ast
  if (scalarTypes(ast)?.length) return { kind: "scalar", scalar: Schema.make(ast) }
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0) return undefined
  if (ast.propertySignatures.some((property) => typeof property.name !== "string")) return undefined
  const required = ast.propertySignatures.filter((property) => !SchemaAST.isOptional(property.type))
  // 唯一必填项可与可选配置并存；全可选对象只有一个声明字段时才无歧义。
  const property =
    required.length === 1
      ? required[0]
      : required.length === 0 && ast.propertySignatures.length === 1
        ? ast.propertySignatures[0]
        : undefined
  if (!property || typeof property.name !== "string" || !scalarTypes(property.type)?.length) return undefined
  return { kind: "object", key: property.name, scalar: Schema.make(property.type) }
}

export const normalizeInput = (forms: InputForms | undefined, value: unknown): unknown => {
  if (!forms || value === undefined) return value
  // 此处只决定形状，literal/refinement 的真假由后续原 validator 判定一次。
  const types = scalarTypes(forms.scalar.ast)
  const matches = (item: unknown) => types?.includes(item === null ? "null" : typeof item)
  if (forms.kind === "object") return matches(value) ? { [forms.key]: value } : value
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  // 输入已通过普通数据边界，危险字段不能借拆包消失；数组和多项包装不猜测。
  const entries = Object.entries(value)
  return entries.length === 1 && matches(entries[0]?.[1]) ? entries[0]?.[1] : value
}

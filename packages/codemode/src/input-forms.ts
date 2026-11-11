import { Schema, SchemaAST } from "effect"

// 描述符只来自实际编码域；展示 JSON schema 不能授予额外调用形式。
export type InputForms = { readonly key: string; readonly scalar: Schema.Top }

// Undefined 保留原 decoder/default 语义，但绝不参与包装或拆包。
const scalarTypes = (node: SchemaAST.AST): ReadonlyArray<string> | undefined => {
  if (node._tag === "String") return ["string"]
  if (node._tag === "Number") return ["number"]
  if (node._tag === "Boolean") return ["boolean"]
  if (node._tag === "Null") return ["null"]
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
  const property =
    required.length === 1
      ? required[0]
      : required.length === 0 && ast.propertySignatures.length === 1
        ? ast.propertySignatures[0]
        : undefined
  if (!property || typeof property.name !== "string" || !scalarTypes(property.type)?.length) return undefined
  // 保留字段自己的编码类型；例如数字字符串按 string 匹配，不先执行转换猜测参数。
  return { key: property.name, scalar: Schema.make(property.type) }
}

export const normalizeInput = (forms: InputForms | undefined, value: unknown): unknown => {
  if (!forms || value === undefined) return value
  // 对象输入原样进入 decoder；任意单键对象不能反向拆成标量。
  const types = scalarTypes(forms.scalar.ast)
  const matches = (item: unknown) => types?.includes(item === null ? "null" : typeof item)
  // 按类型匹配才能保留 false、0 和 null；具体取值是否合法仍由原 decoder 决定。
  return matches(value) ? { [forms.key]: value } : value
}

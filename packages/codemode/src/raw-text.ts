// 来源元数据不写入业务对象，避免输出解码器把便利字段当成真实数据。
// 弱引用随值回收，不为 Notebook 或单次执行增加独立生命周期。
const sources = new WeakMap<object, string>()

export const rawText = (value: unknown): string | undefined =>
  value !== null && typeof value === "object" ? sources.get(value) : undefined

export const withRawText = <T>(value: T, text: string | undefined, exposeAlias = false): T => {
  if (text === undefined || value === null || typeof value !== "object") return value
  // 原始快照只能登记一次；后续业务修改不能改写源文本。
  if (!sources.has(value)) sources.set(value, text)
  // 仅解释器内副本暴露只读别名；同名业务字段优先且保留原有可写语义。
  // 不可枚举保证键遍历与 JSON 出口只包含业务数据。
  if (exposeAlias && !Object.hasOwn(value, "text"))
    Object.defineProperty(value, "text", { value: sources.get(value), enumerable: false })
  return value
}

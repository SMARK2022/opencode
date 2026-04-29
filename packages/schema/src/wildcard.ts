export * as Wildcard from "./wildcard"

// 权限 pattern 的共享纯语法；大小写策略由调用方传入，不读取宿主或安装状态。
export function match(input: string, pattern: string, ignoreCase = false) {
  // 路径分隔符先归一，* 与 ? 分别沿用任意子串和单字符的原始语义。
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  // 命令前缀的空格加 * 同时匹配无参数形式，保留 Core 已有权限边界。
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", ignoreCase ? "si" : "s").test(normalized)
}

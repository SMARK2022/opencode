export * as ShellPermission from "./shell-permission"

import type { Node } from "web-tree-sitter"

type Part = { type: string; text: string }

export function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    // 赋值节点不属于命令；数字实参不能随赋值一起漏掉。
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "number" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    )
      continue
    out.push({ type: child.type, text: child.text })
  }
  return out
}

// 两代共用规则键，去掉POSIX赋值前缀时仍完整保留重定向。
export function permissionPattern(node: Node, tokens: string[]) {
  const command = tokens.join(" ")
  const redirect =
    node
      .descendantsOfType("redirection")
      .filter((item): item is Node => Boolean(item))
      .map((item) => item.text.trim())
      .join(" ") || redirectedSuffix(node)
  return redirect ? `${command} ${redirect}` : command
}

export function rawPattern(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function redirectedSuffix(node: Node) {
  if (node.parent?.type !== "redirected_statement") return ""
  return node.parent.text.slice(node.endIndex - node.parent.startIndex).trim()
}

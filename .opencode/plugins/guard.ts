// .opencode/plugins/guard.ts —— 在 Agent 的工具调用链里执行门禁。插件本身从不修改、还原或删除任何文件。
//
// 1. 工具执行前：拒绝绕过 git hook 的命令（直接报错，工具不执行）
// 2. 工具执行后：对刚改的源码文件跑规则检查，违规追加进工具输出；改到门禁文件时在工具输出末尾附一句提醒
// 3. 回合结束（session.idle）：对本会话编辑工具碰过的文件跑 gate stop；未通过时把报告写进会话记录，
//    不触发回复，由人决定是否让 Agent 继续修复
//
// 本会话的改动只认编辑工具的参数，不看 bash，也不判断其他会话：多个会话改同一个文件时，检查的是文件当前内容。
//
// 环境变量（由人在启动 opencode 时设置，Agent 无法修改运行中的插件环境）：
//   GUARD_IDLE=off|static|full   回合结束检查：关闭 / 只静态 / 静态 + 受影响测试（默认 full）
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { PROTECTED_GLOBS, PROTECTED_PATHS } from "../../script/guard/rules"

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const SHELL_TOOLS = new Set(["bash", "shell"])
// 只拦没有正当用途的绕过手段。--no-verify、push --force、带 Guard-Allow-Large 的提交
// 交给 opencode.jsonc 的 permission（ask）由人确认，见 script/guard/README.md。
const BYPASS: [RegExp, string][] = [
  [/\bgit\s+commit\b[^|;&]*\s-n\b/, "请改用完整写法 --no-verify，它会弹出确认交给人决定"],
  [/\bHUSKY=0\b[^|;&]*\bgit\b|\$env:HUSKY\b/i, "不允许关闭 git hook"],
  [/core\.hooksPath/, "不允许改 hook 路径"],
  [/\bgit\s+(update-ref|replace|filter-branch|commit-tree)\b/, "不允许绕过提交流程改写引用或历史"],
  // 变量赋值前缀不进入 permission 匹配串，所以 guard 的开关只能在这里拦；它们由人在启动 OpenCode 前设置
  [/\bGUARD_[A-Z_]+=|\$env:GUARD_/i, "GUARD_* 开关由人设置，Agent 不能在命令里修改"],
]
export const GuardPlugin: Plugin = async ({ $, client, worktree }) => {
  const idleMode = process.env.GUARD_IDLE ?? "full"
  const rel = (p: string) => path.relative(worktree, path.resolve(worktree, p)).replaceAll("\\", "/")
  const isGate = (p: string) =>
    PROTECTED_PATHS.some((x) => p.startsWith(x)) || PROTECTED_GLOBS.some((re) => re.test(p))
  const touched = new Map<string, Set<string>>()
  const targets = (args: Record<string, unknown>) => {
    const out = [args.filePath, args.path, args.file].filter((x): x is string => typeof x === "string").map(rel)
    const patch = String(args.patchText ?? args.patch ?? "")
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(rel(m[1].trim()))
    for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(rel(m[1].trim()))
    return out
  }

  return {
    "tool.execute.before": async (input, output) => {
      const args = (output.args ?? {}) as Record<string, unknown>
      if (EDIT_TOOLS.has(input.tool)) {
        const files = targets(args)
        const set = touched.get(input.sessionID) ?? touched.set(input.sessionID, new Set()).get(input.sessionID)!
        for (const f of files) set.add(f)
      }
      if (SHELL_TOOLS.has(input.tool)) {
        const command = String(args.command ?? "")
        const hit = BYPASS.find(([re]) => re.test(command))
        if (hit) throw new Error(`[guard] 命令被拒绝：${hit[1]}。`)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!EDIT_TOOLS.has(input.tool)) return
      const edited = targets((input.args ?? {}) as Record<string, unknown>)
      const gate = edited.filter(isGate)
      if (gate.length)
        output.output += `\n\n[guard] 提醒：${gate.join("、")} 属于门禁（规则、基线、预算、hook、CI）。只在任务需要时修改；不要为了让检查通过而放宽规则或提高基线。`
      const files = edited.filter((f) => /^packages\/.*\.[cm]?[jt]sx?$/.test(f))
      if (!files.length) return
      const r = await $`bun script/guard/check.ts ${worktree} --files ${files.join(",")}`
        .cwd(worktree)
        .quiet()
        .nothrow()
      const text = `${r.stdout.toString()}\n${r.stderr.toString()}`.trim()
      if (r.exitCode !== 0)
        output.output += `\n\n[guard] ${r.exitCode === 1 ? "这次修改违反了机械规则" : "机械检查执行失败"}，继续之前先修复：\n${text}`
      else if (r.exitCode === 0 && text.includes("△")) output.output += `\n\n[guard] 提示（不阻断）：\n${text}`
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle" || idleMode === "off") return
      const sessionID = event.properties.sessionID
      const files = [...(touched.get(sessionID) ?? [])].filter((f) => f.startsWith("packages/"))
      // 每次检查后清空：之后再有编辑才会重新检查，同样的报告不会重复写入
      touched.delete(sessionID)
      if (!files.length) return
      const env = idleMode === "static" ? { ...process.env, GUARD_TESTS: "off" } : process.env
      const r = await $`bun script/guard/gate.ts stop --files ${files.join(",")}`
        .cwd(worktree)
        .env(env)
        .quiet()
        .nothrow()
      if (r.exitCode === 0) return
      // 沿用这个会话最后一次的 Agent 和模型，写入的记录不会把会话切到默认 Agent
      const messages = await client.session.messages({ path: { id: sessionID } })
      const last = messages.data?.findLast((m) => m.info.role === "user")?.info
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          ...(last?.role === "user" ? { agent: last.agent, model: last.model } : {}),
          parts: [
            {
              type: "text",
              text:
                `[guard] 本会话改动的文件未通过门禁。需要修复时回复“继续”。\n\n` +
                `${r.stdout.toString()}\n${r.stderr.toString()}`.trim(),
            },
          ],
        },
      })
      await client.tui.showToast({
        body: { message: "Guard：本会话改动未通过门禁，详情已写入会话", variant: "warning" },
      })
    },
  }
}

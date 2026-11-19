// .opencode/plugins/guard.ts —— 在 Agent 的工具调用链里执行门禁。插件本身从不修改、还原或删除任何文件。
//
// 1. 工具执行前：拒绝写受保护路径、拒绝绕过 git hook 的命令（直接报错，工具不执行）
// 2. 工具执行后：对刚改的 TS 文件跑规则检查，违规追加进工具输出；受保护路径若在本次调用中变化，只报告不还原
// 3. 回合结束（session.idle）：只针对本会话改过的文件跑 gate stop；失败则把报告作为新消息发回（最多 5 轮）
//
// 环境变量（由人在启动 opencode 时设置，Agent 无法修改运行中的插件环境）：
//   GUARD_UNLOCK=1         允许本次会话修改受保护路径（维护规则时使用）
//   GUARD_IDLE=off|static|full   回合结束检查：关闭 / 只静态 / 静态 + 受影响测试（默认 full）
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { PROTECTED_PATHS, PROTECTED_GLOBS } from "../../script/guard/rules"

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
const MAX_ROUNDS = 5

export const GuardPlugin: Plugin = async ({ $, client, worktree }) => {
  const unlock = process.env.GUARD_UNLOCK === "1"
  const idleMode = process.env.GUARD_IDLE ?? "full"
  const rel = (p: string) => path.relative(worktree, path.resolve(worktree, p)).replaceAll("\\", "/")
  const isProtected = (p: string) => PROTECTED_PATHS.some((x) => p.startsWith(x)) || PROTECTED_GLOBS.some((re) => re.test(p))
  const touched = new Map<string, Set<string>>()
  const rounds = new Map<string, number>()
  const before = new Map<string, string>()

  // 注意只裁掉行尾：porcelain 行首的空格是状态列的一部分
  const status = async () => (await $`git -C ${worktree} status --porcelain --untracked-files=all`.quiet().nothrow().text()).trimEnd()
  const protectedOf = (porcelain: string) =>
    porcelain
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((p) => p && isProtected(p))
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
        const hit = files.find(isProtected)
        if (hit && !unlock)
          throw new Error(`[guard] ${hit} 是受保护路径（规则、基线、预算、hook、CI、工作流规范）。不要修改它；按报错信息修改业务代码。`)
        const set = touched.get(input.sessionID) ?? touched.set(input.sessionID, new Set()).get(input.sessionID)!
        for (const f of files) set.add(f)
      }
      if (SHELL_TOOLS.has(input.tool)) {
        const command = String(args.command ?? "")
        const hit = BYPASS.find(([re]) => re.test(command))
        if (hit) throw new Error(`[guard] 命令被拒绝：${hit[1]}。`)
      }
      before.set(input.callID, await status())
    },

    "tool.execute.after": async (input, output) => {
      const prev = before.get(input.callID) ?? ""
      before.delete(input.callID)
      const now = await status()
      if (now !== prev) {
        const prevSet = new Set(prev.split("\n"))
        const changed = now.split("\n").filter((l) => l && !prevSet.has(l))
        const protectedChanged = protectedOf(changed.join("\n"))
        if (protectedChanged.length && !unlock)
          output.output += `\n\n[guard] 本次工具调用改动了受保护路径：${protectedChanged.join("、")}。插件不会替你还原；请撤销这次改动，并改为修改业务代码。`
        // shell 写文件同样计入本会话改动，结束闸门会检查它们
        if (SHELL_TOOLS.has(input.tool)) {
          const set = touched.get(input.sessionID) ?? touched.set(input.sessionID, new Set()).get(input.sessionID)!
          for (const l of changed) set.add(l.slice(3).trim())
        }
      }
      if (!EDIT_TOOLS.has(input.tool)) return
      const files = targets((input.args ?? {}) as Record<string, unknown>).filter((f) => /^packages\/.*\.tsx?$/.test(f))
      if (!files.length) return
      const r = await $`bun script/guard/check.ts ${worktree} --files ${files.join(",")}`.cwd(worktree).quiet().nothrow()
      const text = r.stdout.toString().trim()
      if (r.exitCode === 1) output.output += `\n\n[guard] 这次修改违反了机械规则，继续之前先修复：\n${text}`
      else if (r.exitCode === 0 && text.includes("△")) output.output += `\n\n[guard] 提示（不阻断）：\n${text}`
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle" || idleMode === "off") return
      const sessionID = event.properties.sessionID
      const files = [...(touched.get(sessionID) ?? [])].filter((f) => f.startsWith("packages/"))
      if (!files.length) return
      const env = idleMode === "static" ? { ...process.env, GUARD_TESTS: "off" } : process.env
      const r = await $`bun script/guard/gate.ts stop --files ${files.join(",")}`.cwd(worktree).env(env).quiet().nothrow()
      if (r.exitCode === 0) {
        touched.delete(sessionID)
        rounds.delete(sessionID)
        return
      }
      const n = (rounds.get(sessionID) ?? 0) + 1
      rounds.set(sessionID, n)
      if (n > MAX_ROUNDS) return
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text",
              text:
                `[guard ${n}/${MAX_ROUNDS}] 本会话改动的文件未通过门禁，任务还没有完成。` +
                `修复下列问题后再结束；不要修改规则、基线或测试预算。\n\n${r.stdout.toString().slice(-12000)}`,
            },
          ],
        },
      })
    },
  }
}

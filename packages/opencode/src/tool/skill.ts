import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      output: Schema.Struct({ path: Schema.String, content: Schema.String }),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          // [local-smark] skill load dedup：若当前 session 上下文中已加载过同名 skill，
          // 返回 stub 而非重新输出完整 content（~7KB）。
          // 通过扫描 ctx.messages 中已完成的 skill tool part 实现，
          // 不需要 InstanceState 或额外状态——与 read.ts collectVisibleReads 同一模式。
          // 补 compacted 守卫对齐 collectVisibleReads：
          // compacted 的 skill part 内容已被 prune 清空，不应视为"已加载"。
          // full compaction 会移除旧消息——此时 alreadyLoaded=false 正确触发重载。
          const alreadyLoaded = ctx.messages.some((msg) =>
            msg.info.role === "assistant" &&
            msg.parts.some((part) => {
              if (part.type !== "tool" || typeof part.metadata?.executeParent === "string") return false
              if (part.state.status !== "completed") return false
              if (part.state.time.compacted !== undefined) return false
              // execute 的完整父输出才是已交付证据，失败或截断父回执不会登记该键。
              if (part.tool === "execute") return Array.isArray(part.state.metadata.skills) && part.state.metadata.skills.includes(params.name)
              if (part.tool !== "skill") return false
              const input = part.state.input as Record<string, unknown> | undefined
              return input?.name === params.name
            }),
          )
          if (alreadyLoaded) {
            return {
              title: `Skill ${params.name} already loaded`,
              output: `Skill '${params.name}' was already loaded in this session. Refer to the prior tool output for instructions.`,
              metadata: { name: params.name, dir: path.dirname(info.location), deduped: true },
              // 宿主只省略重复展示；脚本仍能取得本次请求的真实技能正文。
              program: { value: { path: path.dirname(info.location), content: info.content.trim() } },
            }
          }

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          const output = [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n")
          return {
            title: `Loaded skill: ${info.name}`,
            output,
            program: { value: { path: dir, content: info.content.trim() } },
            // 技能规则属于宿主上下文，脚本 return 不能将它从父回执丢弃。
            ...(ctx.executeParent && { context: [{ kind: "skill" as const, key: info.name, text: output }] }),
            metadata: {
              name: info.name,
              dir,
              deduped: false,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

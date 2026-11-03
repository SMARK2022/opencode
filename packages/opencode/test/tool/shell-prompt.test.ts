import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// 独立预期限定PowerShell本层求值；外部程序的参数处理由各自的原生规则决定。
const quoting = [
  '- PowerShell expands $name and evaluates $(...) inside double quotes; use "..." when you want those local values.',
  "- In single-quoted strings, PowerShell leaves $name and $(...) unevaluated; backslash is ordinary. Write '' for a single quote.",
  '- Inside double quotes, `$name keeps $name as text and `" inserts a double quote; \\$name still expands $name, and \\" does not escape a quote.',
  "- For multiline text without variable substitution, start with @' followed by a newline; close with '@ at the start of a new line.",
  `- To run a Linux program through WSL, use wsl --exec <program> ...; for Bash use wsl --exec bash -lc 'echo "$HOME"'. wsl -- bash -lc adds another shell that can expand variables first.`,
]

test("render preserves the exact PowerShell quoting contract across platforms", () => {
  // 先确认测试字符串真的含反斜杠，防止 JS 的未知转义把反例悄悄变成正例。
  expect(quoting[2]).toContain(String.fromCharCode(92, 36))
  expect(quoting[2]).toContain(String.fromCharCode(92, 34))
  // 反引号与反斜杠代表不同机制；码点断言避免只看编辑器字形作判断。
  expect(quoting[2]).toContain(String.fromCharCode(96, 36))
  expect(quoting[2]).toContain(String.fromCharCode(96, 34))
  for (const platform of ["win32", "linux"] as const) {
    for (const name of ["pwsh", "powershell"]) {
      // 目标 render 需要显式 defaultTimeoutMs；120000 与生产默认一致，以下各处同。
      const prompt = ShellPrompt.render(name, platform, { maxLines: 1000, maxBytes: 16384 }, 120000)
      // 只观察真实调用者取得的文本；连续五行同时锁定优先级与 here-string 换行说明。
      expect(prompt.description).toContain(quoting.join("\n"))
    }
  }
})

test("render explains Windows PowerShell native argument quoting", () => {
  // 5.1把native参数重建成命令行，嵌入引号会在后续拆分时被消费；该说明对应已复现的版本差异。
  const legacy = ShellPrompt.render("powershell", "win32", { maxLines: 1000, maxBytes: 16384 }, 120000)
  expect(legacy.description).toContain("Windows PowerShell 5.1 rebuilds native arguments as a command line")
  expect(legacy.description).toContain("stdin interface for quoted code")
  const modern = ShellPrompt.render("pwsh", "win32", { maxLines: 1000, maxBytes: 16384 }, 120000)
  expect(modern.description).not.toContain("Windows PowerShell 5.1 rebuilds native arguments")
})

// 除必验矩阵外覆盖现有 POSIX 家族，避免非 bash 配置仍被首行称作 bash。
for (const name of ["pwsh", "powershell", "cmd", "bash", "zsh", "sh", "dash", "ksh"]) {
  for (const platform of ["win32", "linux"] as const) {
    test(`render exposes native script and unchanged parameters: ${platform}/${name}`, () => {
      const prompt = ShellPrompt.render(name, platform, { maxLines: 1000, maxBytes: 16384 }, 120000)
      const schema = ToolJsonSchema.fromSchema(prompt.parameters)
      // 描述随真实shell变化，目标既有description仍为可选元数据，不能改成必填或移除。
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        "command",
        "compress_output",
        "description",
        "timeout",
        "workdir",
      ])
      expect(schema.required).toEqual(["command"])
      expect(schema.properties).toMatchObject({
        command: { type: "string" },
        description: { type: "string" },
        timeout: { type: "integer", exclusiveMinimum: 0 },
        workdir: { type: "string" },
        compress_output: { type: "boolean" },
      })
      // 所有可选项仍保持缺省，不允许仅 wire schema 悄悄增加默认值影响模型调用。
      for (const property of Object.values(schema.properties ?? {})) expect(property).not.toHaveProperty("default")
      const command = schema.properties?.command
      if (!command || typeof command !== "object") throw new Error("missing command schema")
      // 解码职责只在 SDK 一层；这里验证说明和接受正文，不模拟执行器或再次解码。
      expect(command.description).toContain(name)
      expect(command.description).toContain("native script")
      expect(command.description).toContain("JSON decoding happens once")
      expect(prompt.description.split(/\r?\n/)[0]).toContain(name)
      // 目标先给共享Shell能力段，再保留profile的原生脚本intro，不能删掉共享指引换取首行。
      expect(prompt.description).toContain(`Executes a native script in ${name} with optional timeout.`)
      expect(prompt.description).toContain("Native multiline scripts are allowed")
      expect(prompt.description).not.toContain("DO NOT use newlines")
      // JSON 换行、字面反斜杠 n 与 CRLF 均可作为普通字符串进入 schema，不能被修复。
      const input = {
        command: "first\nsecond\r\n" + String.raw`$HOME \n \" C:\Temp`,
      }
      expect(Schema.decodeUnknownSync(prompt.parameters)(input)).toEqual(input)
      // 缺省值由原 runner 决定；schema 不应新填 timeout/workdir/compress_output。
      expect(
        Schema.decodeUnknownSync(prompt.parameters)({ ...input, timeout: 1, workdir: ".", compress_output: false }),
      ).toEqual({ ...input, timeout: 1, workdir: ".", compress_output: false })
      for (const invalid of [
        {},
        { timeout: 1 },
        { ...input, command: 1 },
        { ...input, timeout: 0 },
        { ...input, timeout: 1.5 },
        { ...input, timeout: "1" },
        { ...input, workdir: 1 },
        { ...input, compress_output: "false" },
      ]) {
        expect(() => Schema.decodeUnknownSync(prompt.parameters)(invalid)).toThrow()
      }
      // 原 timeout 文案与专用文件工具要求不靠 schema 默认值实现，需在公开文本中继续存在。
      expect(prompt.description).toContain("time out after 120000ms")
      expect(prompt.description).toContain("File search: Use Glob")
      expect(prompt.description).toContain("Read files: Use Read")
      if (name === "pwsh" || name === "powershell") {
        expect(prompt.description).toContain("$env:NAME")
        expect(prompt.description).toContain("$null")
        expect(prompt.description).toContain(name === "powershell" ? "does not support && or ||" : "supports && and ||")
      } else {
        // PowerShell 五行不能污染 cmd/Bash 的原生引用建议。
        expect(prompt.description).not.toContain(quoting[0])
        if (name === "cmd") expect(prompt.description).toContain("NUL")
      }
    })
  }
}

// 目标冻结基线仅增加共享Git标题的100字节，R6的9行/600字节预算不变。
// state640的共享Shell/Git指导已包含在冻结基线，不能用过时数字反向删减有效功能。
for (const [name, lines, bytes] of [
  ["pwsh", 113, 8687],
  ["powershell", 113, 8447],
  ["cmd", 109, 7764],
  ["bash", 102, 7520],
  ["zsh", 102, 7518],
] as const) {
  for (const platform of ["win32", "linux"] as const) {
    test(`render and command description stay within R6 budget: ${platform}/${name}`, () => {
      const prompt = ShellPrompt.render(name, platform, { maxLines: 1000, maxBytes: 16384 }, 120000)
      // 路径属于机器环境，不是提示改动；替换成冻结时路径以免 CI 用户名改变预算。
      const text = prompt.description.replaceAll(Global.Path.tmp, String.raw`D:\Temp\opencode`)
      const command = ToolJsonSchema.fromSchema(prompt.parameters).properties?.command
      if (!command || typeof command !== "object" || typeof command.description !== "string") {
        throw new Error("missing command description")
      }
      // 字段说明也是模型输入；旧说明占一行、22 bytes，不能只计算 tool description。
      expect(text.split("\n").length - lines + command.description.split("\n").length - 1).toBeLessThanOrEqual(9)
      expect(Buffer.byteLength(text) - bytes + Buffer.byteLength(command.description) - 22).toBeLessThanOrEqual(600)
      // 不借用旧 shellGuidance 的删除额度；全系统文本与错误 notice 仍由父任务合算。
      // 此门禁只证明确定性文本预算，不能证明模型能正确生成或执行引用命令。
    })
  }
}

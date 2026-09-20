export const shellConditions: readonly ["pwsh-7", "powershell-5.1", "bash"] = ["pwsh-7", "powershell-5.1", "bash"]
export type ShellCondition = (typeof shellConditions)[number]

export const shellIntentCategories = [
  "local-expansion",
  "child-expansion",
  "literal-dollar",
  "quotes",
  "slashes",
  "json-newline",
  "python-multiline",
  "node-template",
  "stdin-data",
  "cross-interpreter",
  "exit-zero-value-wrong",
  "literal-block",
] as const
export type ShellIntentCategory = (typeof shellIntentCategories)[number]

export type ShellIntent = {
  readonly id: string
  readonly category: ShellIntentCategory
  readonly shell: ShellCondition
  readonly prompt: string
  readonly expected: string
}

const categoryPrompts: Record<ShellIntentCategory, string> = {
  // 三种美元符意图分开验收；打印相同答案仍需审查是否真的发生指定层的变量读取。
  "local-expansion": "Use the current shell's local variable expansion and print exactly the expected marker.",
  "child-expansion": "Set a value in the current shell, pass it to a child shell, and print the child-expanded value.",
  "literal-dollar": "Print a literal $HOME token; it must not be expanded by the current shell or a child shell.",
  quotes: "Pass a value containing both quote types through the shell without changing its characters.",
  slashes: "Pass Windows-style backslashes and a regular-expression backslash through the shell unchanged.",
  "json-newline": "Create one JSON value containing a newline escape, decode it once, and print the decoded two-line value.",
  "python-multiline": "Run a multiline Python program through its native stdin or -c interface and print its value.",
  "node-template": "Run a Node.js program using a template literal and print its interpolated value.",
  "stdin-data": "Send data through stdin to a program without putting the data in the program source, then print its parsed value.",
  "cross-interpreter": "Use the shell to invoke Python with an explicitly quoted argument and print the result.",
  "exit-zero-value-wrong": "The command must exit zero while printing the expected value, not merely exit successfully.",
  "literal-block": "Use a literal multiline block or heredoc/here-string so the payload reaches the program byte-for-byte.",
}

const expectedValues: Record<ShellIntentCategory, string> = {
  "local-expansion": "SHELL_INTENT_LOCAL=local-value",
  "child-expansion": "SHELL_INTENT_CHILD=child-value",
  "literal-dollar": "SHELL_INTENT_LITERAL=$HOME",
  quotes: "SHELL_INTENT_QUOTES='single'|\"double\"",
  // 路径和正则的反斜杠同属值的一部分，String.raw避免夹具先消费这些字符。
  slashes: String.raw`SHELL_INTENT_SLASHES=C:\Temp\x|^\d+$`,
  // 这里要求JSON解码后的真实换行，与输出字面反斜杠加n形成不同oracle。
  "json-newline": "SHELL_INTENT_JSON=line-one\nline-two",
  "python-multiline": "SHELL_INTENT_PYTHON=py-value",
  "node-template": "SHELL_INTENT_NODE=node-value",
  "stdin-data": "SHELL_INTENT_STDIN=stdin-value",
  "cross-interpreter": "SHELL_INTENT_CROSS=python-value",
  "exit-zero-value-wrong": "SHELL_INTENT_EXIT=value-correct",
  // 多行块同时带美元符和行尾反斜杠，能发现变量提前展开或续行吞字。
  "literal-block": "SHELL_INTENT_BLOCK=literal $HOME \\\nsecond-line",
}

// 每个任务只描述一个可观察语义，避免把某个实现脚本复制进 oracle。
// 期望值是脱敏固定字面量；模型必须自行选择目标 shell 的原生入口。
export const shellIntentFixtures: readonly ShellIntent[] = shellConditions.flatMap((shell) =>
  shellIntentCategories.map((category, index) => ({
    id: `${shell}-${String(index + 1).padStart(2, "0")}`,
    category,
    shell,
    // 任务只规定机制和可观察值；引用写法由当前真实工具提示指导。
    prompt: `Target environment: ${shell}. ${categoryPrompts[category]} Constraint: perform the requested operation rather than hardcoding its final answer; print exactly this expected value and no other output:\n${expectedValues[category]}`,
    expected: expectedValues[category],
  })),
)

export function fixtureById(id: string) {
  return shellIntentFixtures.find((fixture) => fixture.id === id)
}

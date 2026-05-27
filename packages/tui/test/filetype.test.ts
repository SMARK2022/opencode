import { expect, test } from "bun:test"
import { filetype } from "../src/util/filetype"
import parsersConfig from "../src/parsers-config"

test("shellscript extensions resolve to the shellscript language id", () => {
  // #245：.sh 家族在 LSP 语义上保持 shellscript 语言 id，TUI 高亮由 bash parser
  // 的 aliases 承接；锁定扩展名→语言 id 映射，防止被改成 bash 而破坏 LSP 兼容
  expect(filetype("scripts/install.sh")).toBe("shellscript")
  expect(filetype("scripts/build.zsh")).toBe("shellscript")
  expect(filetype("scripts/run.ksh")).toBe("shellscript")
})

test("toml extension resolves to the registered toml parser", () => {
  // #245：修复前 .toml 没有扩展名映射，parser 已注册也无法被 edit diff 使用；
  // 该断言锁定扩展名入口，防止未来只保留 parser 配置却丢失映射时测试误通过
  expect(filetype("config/opencode.toml")).toBe("toml")
  const toml = parsersConfig.parsers.find((parser) => parser.filetype === "toml")
  expect(toml).toBeDefined()
})

test("bash parser aliases absorb shellscript family names", () => {
  // #245：aliases 是 TUI info-string/语言名收敛到已有 bash parser 的唯一通道，
  // 缺失任一别名都会让对应 shell 变体的 diff 高亮静默退化为纯文本
  const bash = parsersConfig.parsers.find((parser) => parser.filetype === "bash")
  expect(Boolean(bash && "aliases" in bash)).toBe(true)
  if (!bash || !("aliases" in bash)) return
  expect(bash.aliases).toContain("shellscript")
  expect(bash.aliases).toContain("shell")
  expect(bash.aliases).toContain("sh")
  expect(bash.aliases).toContain("zsh")
  expect(bash.aliases).toContain("ksh")
})

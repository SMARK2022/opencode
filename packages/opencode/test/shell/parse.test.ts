import { describe, expect, test } from "bun:test"
import { ShellParse } from "../../src/shell/parse"

describe("PowerShell analysis facts", () => {
  test("preserves static conda equal options only for Python source entries", async () => {
    // 三个选项原本会让grammar在等号处断裂；公共事实应保留同一个argv值。
    for (const option of ["--name=agent", String.raw`--prefix=C:\envs\agent`, String.raw`--cwd=H:\work`]) {
      const result = await ShellParse.analyze(`conda run ${option} python -c "print(1)"`, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.words.map((word) => word.value)).toEqual(["conda", "run", option, "python", "-c", "print(1)"])
    }
    // 未改执行方式保留原grammar边界，不把修复扩展为所有等号参数的恢复框架。
    for (const suffix of ["node -e '1'", "bash -c 'echo ok'", "python script.py", "python -m json.tool"]) {
      expect(await ShellParse.analyze(`conda run --name=agent ${suffix}`, "powershell")).toMatchObject({ incomplete: true })
    }
    expect(await ShellParse.analyze('conda run --name=$env:NAME python -c "print(1)"', "powershell")).toMatchObject({ incomplete: true })
    // 字符串内即使包含完整conda调用也只是数据，不能被兼容变换改写。
    expect((await ShellParse.analyze(`Write-Output 'conda run --name=agent python -c "print(1)"'`, "powershell")).commands[0]?.words[1]?.value).toBe('conda run --name=agent python -c "print(1)"')
    // 选项值内的同名子串不是另一个选项，兼容扫描必须保持整个环境名。
    expect((await ShellParse.analyze(`conda run --name=foo--cwd=bar python -c 'print(1)'`, "powershell")).commands[0]?.words[2]?.value).toBe("--name=foo--cwd=bar")
  })

  test("keeps native quote boundaries around bare dash arguments", async () => {
    // 反斜杠不能保护关闭引号；反引号只保护紧接的字符，不开启字符串。
    for (const source of [String.raw`python "C:\" -`, 'python "a`" -- b" -', 'python "tail``" -']) {
      const result = await ShellParse.analyze(source, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.words.at(-1)?.value).toBe("-")
    }
    // 引号内的横线与成对引号属于同一参数，不能被分析兼容变换插入新字符。
    for (const [source, value] of [[`python 'it''s -- -' -`, "it's -- -"], ['python "say ""--""" -', 'say "--"']]) {
      const result = await ShellParse.analyze(source, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.words.map((word) => word.value)).toEqual(["python", value, "-"])
    }
    // grammar原本不接受未引用的反引号参数；保留incomplete，不为兼容扫描新增转译。
    expect(await ShellParse.analyze('python `" -', "powershell")).toMatchObject({ incomplete: true })
  })

  test("keeps here-string and comment contents outside dash compatibility", async () => {
    // 块内引号、注释标记及横线全部是数据，只有真正结束后的消费者恢复参数扫描。
    const content = "it's -- -\n\" # <#\npython -"
    const result = await ShellParse.analyze(`@'\n${content}\n'@ | python -`, "powershell")
    expect(result.incomplete).toBe(false)
    expect(result.commands[0]?.stdin).toMatchObject({ value: content, dynamic: false })
    for (const comment of ["# ' -- -", "<# ' -- - #>"]) {
      // 注释中的未配对引号不能吞掉下一行命令或块注释后的参数。
      const result = await ShellParse.analyze(`${comment}\npython -`, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.words.map((word) => word.value)).toEqual(["python", "-"])
    }
    // 嵌套块注释同样保留grammar既有的不完整标记，不伪造可执行命令。
    expect(await ShellParse.analyze("<# outer <# ' - #> -- #>\npython -", "powershell")).toMatchObject({ incomplete: true })
  })

  test("distinguishes invocation arguments from arithmetic and flags", async () => {
    // 调用运算符后的静态路径与裸命令共享参数合同，不能因引号开头漏掉stdin横线。
    const invoked = await ShellParse.analyze("& 'C:\\Python\\python.exe' -", "powershell")
    expect(invoked.incomplete).toBe(false)
    expect(invoked.commands[0]?.words.map((word) => word.value)).toEqual(["C:\\Python\\python.exe", "-"])
    const arithmetic = await ShellParse.analyze("Write-Output (1 - 2); 4 - 3; $x--; python -B --version -- -", "powershell")
    expect(arithmetic.incomplete).toBe(false)
    // 括号内减法仍是原表达式；负数、自减和长选项不进入bare-dash兼容分支。
    expect(arithmetic.commands[0]?.words[1]?.value).toBe("(1 - 2)")
    expect(arithmetic.commands.at(-1)?.words.map((word) => word.value)).toEqual(["python", "-B", "--version", "--", "-"])
    expect((await ShellParse.analyze("Write-Output -2", "powershell")).commands[0]?.words[1]?.value).toBe("-2")
    // --%后的横线由PowerShell原生stop-parsing解释，整个尾部不插入分析引号。
    expect((await ShellParse.analyze("python --% - --", "powershell")).commands[0]?.words[1]?.value).toBe("--% - --")
  })

  test("extracts literal stdin values without evaluating expandable strings", async () => {
    // grammar支持空白正文的块；开闭定界符的换行不属于输入内容。
    for (const source of ["@'\n\n'@ | python -", '@"\r\n\r\n"@ | python -']) {
      const result = await ShellParse.analyze(source, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.stdin).toMatchObject({ value: "", dynamic: false })
    }
    // 紧邻下一行就关闭的块仍是grammar既有边界，不通过插入换行伪造成功。
    expect(await ShellParse.analyze("@'\n'@ | python -", "powershell")).toMatchObject({ incomplete: true })
    for (const [source, value, dynamic] of [
      ["'it''s $HOME --' | python -", "it's $HOME --", false],
      ['"`$HOME --" | python -', "$HOME --", false],
      ['"$HOME --" | python -', "$HOME --", true],
      ["@'\r\n'' $HOME --\r\n'@ | python -", "'' $HOME --", false],
      ['@"\n"" $HOME --\n"@ | python -', '"" $HOME --', true],
    ] as const) {
      // 单引号块保留成对引号与反引号；双引号插值只记录dynamic，分析期间不执行。
      const result = await ShellParse.analyze(source, "powershell")
      expect(result.incomplete).toBe(false)
      expect(result.commands[0]?.stdin).toMatchObject({ value, dynamic })
    }
  })

  test("uses parsed representation offsets for command gaps", async () => {
    // 前一命令的bare-dash增加分析长度；不能用它的offset切原文后把下一参数换行误作命令间隙。
    const result = await ShellParse.analyze('git diff -- --; rg "a\nb" src', "powershell")
    expect(result).toMatchObject({ incomplete: false, opaque: false })
    expect(result.commands[1]?.words[0]).toMatchObject({ value: "rg", start: 20, end: 22 })
    // 真正分隔两个命令的换行仍保留opaque下限，与引用中的换行区分。
    expect(await ShellParse.analyze("git diff -- --\ngit status", "powershell")).toMatchObject({ opaque: true })
  })
})

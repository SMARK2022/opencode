import { describe, expect, test } from "bun:test"
import { compressVisibleOutput, createTerminalDisplay, normalizePowerShellOutput } from "@opencode-ai/core/tool/bash-compress"

// #129：CLIXML 纯块解码与混合块保留
describe("tool.bash-compress", () => {
  test("renders split terminal clear-line sequences without leaking partial escapes", () => {
    const display = createTerminalDisplay()

    expect(display.push("boot\nworking\r\x1b[")).toBe("boot\nworking")
    display.push("2Kdone\n")

    expect(display.value()).toBe("boot\ndone")
  })

  test("bounds large single-line display chunks", () => {
    const display = createTerminalDisplay({ maxChars: 12 })

    expect(display.push("x".repeat(10_000))).toBe("x".repeat(12))
    display.push("y".repeat(10_000))

    expect(display.value()).toBe("y".repeat(12))
  })

  test("preserves display layout and conservative compression boundaries", () => {
    const display = createTerminalDisplay({ maxLines: 3, maxChars: 8 })
    expect(display.push("old\n")).toBe("old")
    expect(display.push("\nend\n")).toBe("old\n\nend")
    expect(display.push("\x1b[2J")).toBe("")
    expect(display.value()).toBe("")
    expect(display.push("a\nb\nc\nd")).toBe("b\nc\nd")
    expect(display.push("\r\x1b[2K")).toBe("b\nc")
    expect(display.push("\x1b[2J")).toBe("")

    const cursor = createTerminalDisplay({ maxLines: 3, maxChars: 20 })
    expect(cursor.push("\x1b[10G")).toBe("")
    expect(cursor.push("ok")).toBe(" ".repeat(9) + "ok")
    // 隐藏光标指令不写入文本列，否则后续覆写ESC后会泄漏控制序列残片。
    const control = createTerminalDisplay()
    expect(control.push("ab\x1b[?25l\x1b[3GX")).toBe("abX")

    const raw = ("working ".repeat(20) + "\r\x1b[2Kdone").repeat(10)
    expect(compressVisibleOutput(raw).stats.carriageReturnGroups).toBe(1)
    expect(compressVisibleOutput(raw, { minSavedBytes: 100_000 }).text).toBe(raw)
    expect(compressVisibleOutput(raw, { enabled: false }).text).toBe(raw)
    // #215：未知/未闭合 CSI 与二维放大均须拒绝渲染候选，不能误报压缩收益。
    for (const suffix of ["\x1b[99qtail", "\x1b["]) {
      expect(compressVisibleOutput(raw + suffix)).toMatchObject({
        text: raw + suffix,
        stats: { carriageReturnGroups: 0, applied: false },
      })
    }
    const expanded = "\x1b[999999999Gx\n".repeat(3) + "\x1b[2Jdone"
    expect(compressVisibleOutput(expanded, { minSavedBytes: 0, minSavingRatio: 0 })).toMatchObject({
      text: expanded,
      stats: { carriageReturnGroups: 0, applied: false },
    })
  })

  // #129：标准 #< CLIXML 头 + Message 节点
  test("decodes PowerShell CLIXML with the standard header", () => {
    const clixml = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '  <Obj RefId="0">',
      "    <MS>",
      '      <S N="Message">Saved b64_raw.txt (2664 chars)</S>',
      '      <S N="Source">Write-Host</S>',
      '      <S N="ForegroundColor">Gray</S>',
      '      <S N="BackgroundColor">Black</S>',
      "    </MS>",
      "  </Obj>",
      "</Objs>",
    ].join("\n")

    const result = compressVisibleOutput(clixml)

    expect(result.text).toContain("Saved b64_raw.txt (2664 chars)")
    expect(result.text).toContain("powershell-clixml")
    expect(result.text).not.toContain("omitted")
  })

  // #129：ToString / Message 信息记录夹在 stdout 分隔线之间
  test("decodes inline PowerShell information records", () => {
    const clixml = [
      "============================================================",
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '<Obj S="information" RefId="1"><TNRef RefId="0" />',
      "<ToString>  1/4  BUILD</ToString>",
      '<Props><S N="Message">  1/4  BUILD</S>',
      '<S N="Source">H:\\FRCheck\\scripts\\deploy.ps1</S>',
      '<S N="ForegroundColor">Gray</S></Props></Obj>',
      "</Objs>",
      "============================================================",
    ].join("\n")

    const result = compressVisibleOutput(clixml)

    expect(result.text).toContain("  1/4  BUILD")
    expect(result.text).toContain("powershell-clixml")
    expect(result.text).not.toContain("ForegroundColor")
    expect(result.text).not.toContain("H:\\FRCheck\\scripts\\deploy.ps1")
    expect(result.text.match(/============================================================/g)?.length).toBeGreaterThanOrEqual(2)
    // XML文本节点允许多行正文，不能被误判为节点外的混合输出。
    const multiline = '<Objs><S S="Output">first\nsecond</S></Objs>'
    expect(compressVisibleOutput(multiline).text).toContain("first\nsecond")
  })

  // #129：未闭合/混合 <Objs> 内夹 stdout 时 pure 判定失败，不得吞路径
  test("preserves raw stdout interleaved inside an incomplete CLIXML block", () => {
    const mixed = [
      // #129：故意不完整：开头有 <Objs 与 TRANSFER，中间夹真实 stdout，末尾才闭合
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="information" RefId="0"><ToString>  3/4  TRANSFER</ToString><Props>',
      "============================================================",
      "  4/4  RUN",
      "============================================================",
      "  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb",
      "  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb/db.script",
      "  DONE",
      "</Props></Obj></Objs>",
    ].join("\n")

    const result = compressVisibleOutput(mixed)

    expect(result.text).toContain("  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb")
    expect(result.text).toContain("  DONE")
    // #129：若 pure 失效会把块收成仅 TRANSFER 的 high-entropy
    expect(result.text).not.toBe("<high-entropy powershell-clixml>  3/4  TRANSFER</high-entropy>")
    expect(result.text).toContain("  4/4  RUN")
  })

  // #129：normalize 把纯 CLIXML 还原为可见文本（非 high-entropy 入参）
  test("normalizes plain PowerShell CLIXML to visible text", () => {
    const raw = `#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">
<Obj S="information" RefId="1"><TNRef RefId="0" />
<ToString>VISIBLE_INFO</ToString>
<Props><S N="Message">VISIBLE_MESSAGE</S></Props></Obj>
</Objs>`

    const clean = normalizePowerShellOutput(raw)

    expect(clean).toContain("VISIBLE_INFO")
    expect(clean).toContain("VISIBLE_MESSAGE")
    expect(clean).not.toContain("<Obj")
    expect(clean).not.toContain("<Objs")
    expect(clean).not.toContain("CLIXML")
  })
})

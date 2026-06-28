import { describe, expect, test } from "bun:test"
import { compressVisibleOutput, createTerminalDisplay, normalizePowerShellOutput, quotePattern } from "../../src/tool/bash-compress"

describe("tool.bash-compress", () => {
  test("renders split terminal clear-line sequences without leaking partial escapes", () => {
    const display = createTerminalDisplay()

    display.push("boot\nworking\r\x1b[")
    display.push("2Kdone\n")

    // Child-process chunks can split CSI bytes anywhere. The display renderer
    // must buffer the partial ESC[ prefix so the default live tool output never
    // shows raw escape fragments while still applying the completed clear-line.
    expect(display.value()).toBe("boot\ndone")
  })

  test("bounds large single-line display chunks", () => {
    const display = createTerminalDisplay({ maxChars: 12 })

    display.push("x".repeat(10_000))
    display.push("y".repeat(10_000))

    // Live shell metadata is a preview surface. Very large plain chunks should
    // stay bounded before and after rendering instead of building an unbounded
    // virtual terminal line that preview() would immediately truncate.
    expect(display.value()).toBe("y".repeat(12))
  })

  test("decodes PowerShell CLIXML with the standard header", () => {
    const clixml = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      "  <Obj RefId=\"0\">",
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

  test("decodes inline PowerShell information records", () => {
    const clixml = [
      "============================================================",
      "============================================================",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="information" RefId="0"><ToString>============================================================</ToString><Props><Obj N="MessageData" RefId="1"><ToString>============================================================</ToString><Props><S N="Message">============================================================</S><B N="NoNewLine">false</B><S N="ForegroundColor">Gray</S><S N="BackgroundColor">Black</S></Props></Obj><S N="Source">H:\\FRCheck\\scripts\\deploy.ps1</S></Props></Obj><Obj S="information" RefId="3"><ToString>  1/4  BUILD</ToString><Props><Obj N="MessageData" RefId="4"><ToString>  1/4  BUILD</ToString><Props><S N="Message">  1/4  BUILD</S><B N="NoNewLine">false</B><S N="ForegroundColor">Gray</S><S N="BackgroundColor">Black</S></Props></Obj><S N="Source">H:\\FRCheck\\scripts\\deploy.ps1</S></Props></Obj><Obj S="information" RefId="6"><ToString>============================================================</ToString><Props><Obj N="MessageData" RefId="7"><ToString>============================================================</ToString><Props><S N="Message">============================================================</S><B N="NoNewLine">false</B><S N="ForegroundColor">Gray</S><S N="BackgroundColor">Black</S></Props></Obj><S N="Source">H:\\FRCheck\\scripts\\deploy.ps1</S></Props></Obj></Objs>',
    ].join("\n")

    const result = compressVisibleOutput(clixml)

    expect(result.text).toContain("  1/4  BUILD")
    expect(result.text).toContain("powershell-clixml")
    expect(result.text).not.toContain("ForegroundColor")
    expect(result.text).not.toContain("H:\\FRCheck\\scripts\\deploy.ps1")
    expect(result.text.match(/============================================================/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test("preserves raw stdout interleaved inside an incomplete CLIXML block", () => {
    const mixed = [
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="information" RefId="0"><ToString>  3/4  TRANSFER</ToString><Props><S N="Message">  3/4  TRANSFER</S>',
      "============================================================",
      "  4/4  RUN",
      "============================================================",
      "  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb",
      "  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb/db.script",
      "  DONE",
      '</Props></Obj></Objs>',
    ].join("\n")

    const result = compressVisibleOutput(mixed)

    expect(result.text).toContain("  /opt/incons/cs-tomcat8-28083/webapps/webroot/WEB-INF/embed/finedb")
    expect(result.text).toContain("  DONE")
    expect(result.text).not.toBe("<high-entropy powershell-clixml>  3/4  TRANSFER</high-entropy>")
  })

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

  test("does not label normal ANSI-decorated repeated lines as terminal progress", () => {
    const text = Array.from({ length: 20 }, () => "\x1b[1Grepeat-me-repeat-me-repeat-me").join("\n")

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("repeat-me-repeat-me-repeat-me")
    expect(result.text).toContain("same line repeated 19 more times")
    expect(result.text).not.toContain("terminal progress collapsed")
  })

  test("compresses oversized single-line repeated patterns without regex scanning the whole line", () => {
    const result = compressVisibleOutput("abc".repeat(6000))

    expect(result.text).toBe('[repeated "abc" ×6000]')
    expect(result.stats.inlinePatternGroups).toBe(1)
  })

  // [local-smark] quotePattern 在 bash 压缩管线内部被调用，PowerShell 输出格式化
  // 的边界情况可能传入 undefined pattern，导致 .replaceAll crash（历史 9 次）。
  // guard 必须返回空字符串而非 throw，保证压缩管线不会因单个 pattern 为空而中断。
  test("quotePattern returns empty string for undefined input instead of crashing", () => {
    // 模拟压缩管线传入 undefined 的边界场景
    expect(quotePattern(undefined as unknown as string)).toBe("")
  })

  test("quotePattern escapes backslashes and quotes in normal input", () => {
    // 正常路径：转义反斜杠和双引号，超长截断
    expect(quotePattern("hello")).toBe('"hello"')
    expect(quotePattern('a"b')).toBe('"a\\"b"')
    expect(quotePattern("a\\b")).toBe('"a\\\\b"')
  })
})

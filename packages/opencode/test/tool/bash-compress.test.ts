import { describe, expect, test } from "bun:test"
import { compressVisibleOutput, normalizePowerShellOutput } from "../../src/tool/bash-compress"

describe("tool.bash-compress", () => {
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
})

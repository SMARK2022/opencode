import { describe, expect, test } from "bun:test"
import { compressVisibleOutput, createTerminalDisplay, normalizePowerShellOutput, quotePattern, renderDiagnosticAppendix } from "../../src/tool/bash-compress"

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
    // 解码后的文本必须与 win32 的 normalizePowerShellOutput 路径完全一致：
    // 纯解码、无包装，否则同一命令输出在不同平台产生不同模型可见文本。
    expect(result.text).toBe(normalizePowerShellOutput(clixml))
    expect(result.text).not.toContain("high-entropy")
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
    expect(result.text).not.toContain("high-entropy")
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
    expect(result.text).not.toContain("high-entropy")
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
    expect(result.text).toContain("[... same line 20x]")
    expect(result.text).not.toContain("[... progress")
  })

  test("compresses oversized single-line repeated patterns without regex scanning the whole line", () => {
    const result = compressVisibleOutput("abc".repeat(6000))

    expect(result.text).toBe('[... repeated "abc" x6000]')
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

  // [INV-01] 压缩启用且过闸时，仅脱敏命中（无压缩分组）不得回退未脱敏原文。
  // 历史缺陷：applied 谓词漏掉 secretsRedacted，导致整段回退、密钥重新暴露。
  // 断言锁定用户可观察行为：密钥消失、键名保留、stats 如实计数。
  test("keeps redaction applied even when no compression group fires", () => {
    const text = [
      "alpha deployment checklist region us-east-1 primary",
      "bravo profile default replica count three nodes",
      "password=SuperSecret99",
      "charlie endpoint https://api.internal.example.com/v1",
      "delta status pending review queue depth two items",
      "echo fingerprint banner version 1.2.3 build 45",
      "foxtrot cache warm timeout 30s retry budget 4",
      "golf shard map primary us-west secondary eu-central",
      "hotel backlog drain rate 40 per second steady",
      "india audit trail rotation daily retention 30",
      "juliet feature flag rollout canary 10 percent",
    ].join("\n")

    const result = compressVisibleOutput(text)

    expect(result.text).not.toContain("SuperSecret99")
    expect(result.text).toContain("password=[redacted]")
    expect(result.stats.secretsRedacted).toBeGreaterThanOrEqual(1)
    expect(result.stats.applied).toBe(true)
  })

  // [INV-02] 纯 CLIXML 解码不再包装、不再跳过脱敏；解码文本进入主管线。
  // 消息须 ≥200 字符（gate-on-decoded）：解码后单行经 length≥80 分支过闸，
 // 脱敏才随主管线执行（R3/B-01：短于闸门的 fixture 在任何读法下都不可绿）。
  test("decodes pure CLIXML without wrapper and redacts secrets in decoded text", () => {
    const clixml = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '  <Obj S="information" RefId="0">',
      "    <MS>",
      '      <S N="Message">deploy failed token=Tok1234567890 check logs runner host alpha-42 region us-east-1 attempt 3 of 5 duration 47s queue depth 12 backlog steady workers busy shards 8 replicas 3 lag low window 30s retries zero buffer</S>',
      "    </MS>",
      "  </Obj>",
      "</Objs>",
    ].join("\n")

    const result = compressVisibleOutput(clixml)

    expect(result.text).not.toContain("high-entropy")
    expect(result.text).not.toContain("Tok1234567890")
    expect(result.text).toContain("token=[redacted]")
    expect(result.stats.highEntropyLines).toBe(0)
    expect(result.stats.secretsRedacted).toBeGreaterThanOrEqual(1)
  })

  // [INV-02 接受边界] 解码后 <200B 不过闸：密钥按用户接受的绑定策略保持
  // 可见（脱敏与压缩绑定，见 canonical plan §1 要素 1）——钉死该边界防回归误判。
  test("keeps short decoded CLIXML unredacted below the compression gate", () => {
    const clixml = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '  <Obj S="information" RefId="0">',
      "    <MS>",
      '      <S N="Message">deploy failed token=Tok1234567890 check logs</S>',
      "    </MS>",
      "  </Obj>",
      "</Objs>",
    ].join("\n")

    const result = compressVisibleOutput(clixml)

    expect(result.text).not.toContain("high-entropy")
    expect(result.text).toContain("token=Tok1234567890")
    expect(result.stats.applied).toBe(false)
  })

  // [INV-03] 方言统一：所有行内省略标记为 ASCII 短格式。
  test("repeated block marker uses compact dialect", () => {
    const block = ["alpha one", "beta two", "gamma three", "delta four", "epsilon five"]
    const text = Array.from({ length: 5 }, () => block.join("\n")).join("\n")

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("[... repeated block 5x, 25L->5L]")
    expect(result.text).toContain("alpha one")
  })

  test("template marker uses compact dialect", () => {
    const text = Array.from(
      { length: 8 },
      (_, i) => `2024-01-0${i + 1}T10:00:00Z request phase completed`,
    ).join("\n")

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("[... template repeated 8x]")
    expect(result.text).toContain("first:")
    expect(result.text).toContain("last:")
  })

  test("terminal progress marker uses compact dialect", () => {
    // 5 段以 CR 连接 = 4 次重绘帧；marker 记录的是帧数而非段数
    const text = ["step-alpha-1111", "step-beta-2222", "step-gamma-3333", "step-delta-4444", "step-epsilon-5555"].join("\r") + "\n" + "x".repeat(190)

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("[... progress 4 frames->final]")
    expect(result.text).toContain("step-epsilon-5555")
  })

  test("high-entropy marker uses compact dialect", () => {
    const blob = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(10)

    const result = compressVisibleOutput(blob)

    // head= 行首 7 字符（R2 可识别性要求）：base64 表以 ABCDEFG 开头
    expect(result.text).toMatch(/^\[\.\.\. high-entropy base64 640B hash=[0-9a-f]{8} head=ABCDEFG\]$/)
  })

  test("long list marker uses compact dialect", () => {
    // 25 项（248B）：fixture 须独立满足 shouldCompressOutput ≥200B 闸门（N-02）
    const items = Array.from({ length: 25 }, (_, i) => `item-${String(i).padStart(3, "0")}`)

    const result = compressVisibleOutput(items.join(", "))

    expect(result.text).toContain("[... 19 more]")
    expect(result.text).toContain("item-000")
    expect(result.text).toContain("item-024")
  })

  test("progress bar marker uses compact dialect", () => {
    // 220B："=".repeat(120) 不过 shouldCompressOutput 的 200B 首判（N-02）
    const result = compressVisibleOutput("=".repeat(220))

    expect(result.text).toBe("[... bar 220x]")
  })

  // [INV-03 #11] 脱敏方言：键值型保留键名（与 compaction 证据表同族），
  // 特定值型内联替换；\b 词边界防 monkey= 类前缀词误伤。
  test("secret redaction keeps key names and avoids false positives", () => {
    const text = [
      "release notes for build 2024-09-06 across regions",
      "monkey=abcdefghij stays intact because word boundary",
      "export token=QuietValue99 here for runtime use",
      "auth header uses sk-abcdefghijklmnopqrstuvwxyz keys",
      "quoted secret password=\"SuperSecretValue123\" in config",
      "long value token=abcdefghijklmnop keeps seven char head",
      "final verification checklist items pending review",
    ].join("\n")

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("monkey=abcdefghij")
    expect(result.text).toContain("token=[redacted]")
    expect(result.text).toContain("sk-abcd…[redacted api-key]")
    expect(result.text).toContain('password="SuperSe…[redacted]')
    expect(result.text).toContain("token=abcdefg…[redacted]")
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(result.text).not.toContain("SuperSecretValue123")
  })

  // [INV-03 #10] 诊断摘录：opencode_excerpt 头行携带结构化属性，
  // 正文优先级标签使用 root_cause/fatal（first 错误即根因候选）。
  test("diagnostic appendix renders opencode_excerpt header with priority labels", () => {
    const line = (no: number, text: string) => ({ no, text })
    const context = (no: number, text: string, priority: "first" | "fatal" | "recent") => ({
      centerLine: no,
      lines: [line(no - 1, "context before"), line(no, text), line(no + 1, "context after")],
      priority,
    })
    const snapshot = {
      totalLines: 12,
      errorLikeLines: 2,
      warningLikeLines: 1,
      fatalLikeLines: 0,
      contexts: [],
      firstErrorContexts: [context(4, "Error: first failure", "first")],
      fatalContexts: [],
      recentErrorContexts: [context(4, "Error: first failure", "first")],
    }

    const output = renderDiagnosticAppendix(snapshot, { durationMs: 3000, exitCode: 1 })

    expect(output).toContain('<opencode_excerpt type="shell_high_signal" exit="1" contexts="1" errors="2" warnings="1" />')
    expect(output).toContain("Error contexts omitted from the visible output:")
    expect(output).toContain("[L3-L5] root_cause")
    expect(output).toContain("> 4 | Error: first failure")
  })
})

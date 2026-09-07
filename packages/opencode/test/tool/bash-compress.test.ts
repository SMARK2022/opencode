import { describe, expect, test } from "bun:test"
import { BashDiagnosticCollector, compressVisibleOutput, createTerminalDisplay, normalizePowerShellOutput, quotePattern, renderDiagnosticAppendix } from "@opencode-ai/core/tool/bash-compress"
import { formatExitNotice } from "@opencode-ai/core/util/output-notice"

// #129：CLIXML 纯块解码与混合块保留
describe("tool.bash-compress", () => {
  test("keeps failed exit status when only diagnostic sampling was omitted", () => {
    const raw = "a".repeat(5_000)
    const collector = new BashDiagnosticCollector()
    collector.push(raw)
    collector.end()
    const snapshot = collector.snapshot()
    const appendix = renderDiagnosticAppendix(snapshot, { durationMs: 3_000, exitCode: 7, visibleOutput: raw, config: { enabled: false } })
    expect(snapshot.errorLikeLines).toBe(0)
    expect(snapshot.discardedChars).toBeGreaterThan(0)
    expect(appendix).toContain("diagnostic sampling omitted")
    // 真实采样说明不含失败证据，仍须交付退出码；取消与超时不得伪造exit。
    expect(formatExitNotice(7, false)).toBe('<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="7" />')
    expect(formatExitNotice(0, true)).toContain('severity="info" reason="exit" exit_code="0"')
    expect(formatExitNotice(42, true)).toContain('severity="error" reason="exit" exit_code="42"')
    expect(formatExitNotice(null, false)).toBeUndefined()
    expect(formatExitNotice(0, false)).toBeUndefined()
    const failure = new BashDiagnosticCollector()
    failure.push("fatal: hidden root cause\n")
    failure.end()
    const diagnosed = renderDiagnosticAppendix(failure.snapshot(), { durationMs: 3_000, exitCode: 9, visibleOutput: "tail" })
    expect(diagnosed).toContain('<opencode_excerpt type="shell_high_signal"')
    expect(formatExitNotice(9, false)).toContain('reason="exit" exit_code="9"')
  })

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
    // 解码后的文本必须与 win32 的 normalizePowerShellOutput 路径完全一致：
    // 纯解码、无包装，否则同一命令输出在不同平台产生不同模型可见文本。
    expect(result.text).toBe(normalizePowerShellOutput(clixml))
    expect(result.text).not.toContain("high-entropy")
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
    expect(result.text).not.toContain("high-entropy")
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
    expect(result.text).not.toContain("high-entropy")
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

  // 过闸后仅脱敏也必须提交applied，不能因无压缩分组而退回原秘密。
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

  // 解码后正文独立满足200B闸门，断言纯解码与后续脱敏都走真实主管线。
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
    // 五段含足够重绘字节以满足目标收益门槛；marker计四次重绘，不降低生产阈值。
    const text = ["step-alpha-1111", "step-beta-2222", "step-gamma-3333", "step-delta-4444", "step-epsilon-5555"].map((line) => line + " detail".repeat(20)).join("\r") + "\n" + "x".repeat(190)

    const result = compressVisibleOutput(text)

    expect(result.text).toContain("[... progress 4 frames->final]")
    expect(result.text).toContain("step-epsilon-5555")
  })

  test("high-entropy marker uses compact dialect", () => {
    // repeat(17)=1088 字符/字节一致，熵 6.0>4.5：阈值 1024 后仍需 ≥1024 才省略
    const blob = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(17)

    const result = compressVisibleOutput(blob)

    // head= 行首 7 字符（R2 可识别性要求）：base64 表以 ABCDEFG 开头
    expect(result.text).toMatch(/^\[\.\.\. high-entropy base64 1088B hash=[0-9a-f]{8} head=ABCDEFG\]$/)
  })

  // 896字符必须原样保留，不能再按旧512阈值整行省略。
  // 确定性伪随机避免被另一条真重复规则正确压缩，保持测试只锁定高熵边界。
  test("keeps 896-char base64 lines below the 1024-char high-entropy threshold", () => {
    // xorshift32（乘法 LCG 在 JS 里会溢出 2^53 退化）
    let s = 123456789
    const blob = Array.from(
      { length: 896 },
      () => {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[(s >>> 0) % 64]
      },
    ).join("")

    const result = compressVisibleOutput(blob)

    expect(result.text).toBe(blob)
  })

  // 用户现场tuple列表的逗号属于记录结构，59.6%唯一项不能折叠丢失12/13条记录。
  // 断言完整原文，防止只保留首尾样例的误压仍通过。
  test("keeps structured tuple-list lines intact under the unique-ratio guard", () => {
    const seq =
      "seq [('AP10', 0.19188188016414642, 0, 1607), ('AP11', 0.18971781432628632, 0, 1607), ('AP12', 0.21857687830924988, 0, 1607), ('AP13', 0.20850607752799988, 0, 1607), ('AP14', 0.18821373581886292, 0, 1607), ('MPM10', 0.2304181307554245, 0, 1571), ('MPM11', 0.22825674712657928, 0, 1571), ('MPM12', 0.26590460538864136, 0, 1571), ('MPM13', 0.17674346268177032, 0, 1571), ('MPM14', 0.1687895655632019, 0, 1571), ('SB11', 0.16373328864574432, 0, 1676), ('SB13', 0.2032642960548401, 0, 1676), ('SM1', 0.1746259480714798, 0, 895)]"

    const result = compressVisibleOutput(seq)

    expect(result.text).toBe(seq)
  })

  test("long list marker uses compact dialect", () => {
    // 60 项真重复（57 ok + 3 err，唯一占比 6.7%<25%）：fixture 须独立满足
    // shouldCompressOutput ≥200B 闸门，且守卫后仅真重复列表可折叠
    const items = [...Array.from({ length: 57 }, () => "ok"), "err1", "err2", "err3"]

    const result = compressVisibleOutput(items.join(", "))

    expect(result.text).toContain("[... 54 more]")
    expect(result.text).toContain("err3")
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
      centerLines: [no],
      lines: [line(no - 1, "context before"), line(no, text), line(no + 1, "context after")],
      priority,
    })
    const snapshot = {
      totalLines: 12,
      discardedChars: 0,
      truncatedFrames: 0,
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

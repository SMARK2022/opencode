export function sanitizeVisibleText(text: string) {
  // 只清理可见投影：保留换行/tab，CRLF归一，移除ANSI并显式转义其余C0/C1。
  return Bun.stripANSI(text.replace(/\r\n/g, "\n")).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
  })
}

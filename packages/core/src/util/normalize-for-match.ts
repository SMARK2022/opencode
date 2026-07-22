// Patch和Edit共享封闭PI归一化集合；不增加缩进或相似度成功规则。
// 只改变匹配视图，插入文本与原始字节坐标仍由各调用方保留。
export function normalizeForMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 智能引号 → ASCII，避免聊天字体替换导致 exact 失败
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各类 dash/minus → 普通连字符
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // 特殊空格 → 普通空格（不含普通 ASCII 空格本身的语义合并之外）
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  )
}

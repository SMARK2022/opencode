// #113：会话默认标题生成与判定（从 session.ts 抽出为服务端事实源）
const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

// #113：父/子会话默认标题 = 前缀 + ISO 时间
export function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

// #113：是否仍为自动生成的默认标题（未人工改名）
// 注意：模板字面量中 \d 必须落到 RegExp 源串为数字类
export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

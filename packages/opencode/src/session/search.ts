import { sql, type SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./session.sql"

/**
 * Build a SQL condition that searches sessions by title or message content.
 *
 * 搜索是 session 列表/TUI quick switch 的“可定位内容”投影，不是持久化
 * JSON 的全文搜索。这里必须只索引用户能用来识别会话的字段：标题、可见
 * 文本、工具名/工具输入、shell command 等。thinking/reasoning、tool result、
 * shell output、metadata、token/snapshot 等字段虽然持久化在同一 JSON 中，
 * 但它们不是 session 搜索的契约，继续搜索会让结果被模型内部思考或大段
 * 工具输出污染。
 *
 * 使用 `instr(lower(...))` 做大小写不敏感的精确子串匹配，避免 SQLite
 * LIKE 把用户输入里的 % / _ 当作通配符。
 *
 * 空白搜索返回 undefined，避免 `instr(text, "")` 把所有行都当作命中。
 */
export function searchCondition(search: string): SQL | undefined {
  const needle = search.trim().toLowerCase()
  if (!needle) return undefined

  return sql`(
    ${textMatches(sql`${SessionTable.title}`, needle)}
    or exists (
      select 1
      from ${PartTable}
      inner join ${MessageTable}
        on ${MessageTable.id} = ${PartTable.message_id}
       and ${MessageTable.session_id} = ${PartTable.session_id}
      where ${PartTable.session_id} = ${SessionTable.id}
        and json_type(${MessageTable.data}, '$.hidden') is null
        and json_type(${PartTable.data}, '$.hidden') is null
        and ${messagePartMatches(needle)}
      limit 1
    )
    or exists (
      select 1
      from ${SessionMessageTable}
      where ${SessionMessageTable.session_id} = ${SessionTable.id}
        and ${sessionMessageMatches(needle)}
      limit 1
    )
  )`
}

function textMatches(value: SQL, needle: string) {
  return sql`instr(lower(coalesce(cast(${value} as text), '')), ${needle}) > 0`
}

function uriMatches(value: SQL, needle: string) {
  // URI 可作为短路径定位字段，但 data: URI 承载的是嵌入内容而不是定位信息。
  // 排除 data: 前缀后再复用 textMatches，避免附件正文重新进入 session 搜索。
  return sql`(
    substr(lower(coalesce(cast(${value} as text), '')), 1, 5) <> 'data:'
    and ${textMatches(value, needle)}
  )`
}

function jsonLeafMatches(data: SQL, path: string, needle: string) {
  // json_tree(...).atom 只返回叶子值，故搜索 `$.state.input` 时不会因为
  // `command`、`path`、`description` 这些 JSON 键名命中；这保持 tool command
  // 值可搜索，同时避免“搜 command 命中所有工具调用”的旧行为。
  return sql`exists (
    select 1
    from json_tree(${data}, ${path}) as search_value
    where search_value.atom is not null
      and ${textMatches(sql`search_value.atom`, needle)}
    limit 1
  )`
}

function messagePartMatches(needle: string) {
  return sql`(
    ${messageTextPartMatches(needle)}
    or ${messageToolPartMatches(needle)}
    or ${messageAttachmentPartMatches(needle)}
    or ${messageSubtaskPartMatches(needle)}
    or ${messagePatchPartMatches(needle)}
  )`
}

function messageTextPartMatches(needle: string) {
  // synthetic/ignored text 是生成出来的辅助材料，不是用户可见的 session
  // 定位内容。hidden message/part 已由外层查询过滤，这里只处理 text 自身
  // 的可见性标记。
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'text'
    and coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
    and coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
    and ${textMatches(sql`json_extract(${PartTable.data}, '$.text')`, needle)}
  )`
}

function messageToolPartMatches(needle: string) {
  // Tool output/error/metadata 可能非常大，也可能包含模型内部材料。这里把
  // 可搜索面限定为可见工具身份和输入值，包括 pending raw JSON，以及
  // completed/error 状态里的 state.input command 对象。
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'tool'
    and (
      ${textMatches(sql`json_extract(${PartTable.data}, '$.tool')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.state.title')`, needle)}
      or ${messageToolRawMatches(needle)}
      or ${jsonLeafMatches(sql`${PartTable.data}`, "$.state.input", needle)}
    )
  )`
}

function messageToolRawMatches(needle: string) {
  // Pending tool input 先落在 state.raw，内容通常是模型正在流式输出的 JSON
  // 字符串。只有 raw 已经是合法 JSON 时才按叶子值搜索；这样 pending command
  // 值仍可被定位，但 `command`/`path` 这类键名不会重新污染 session 搜索。
  return sql`(
    json_valid(json_extract(${PartTable.data}, '$.state.raw'))
    and ${jsonLeafMatches(sql`json_extract(${PartTable.data}, '$.state.raw')`, "$", needle)}
  )`
}

function messageAttachmentPartMatches(needle: string) {
  // 附件定位字段通常是短小的可见标签/路径。raw url 和 source text 刻意不
  // 纳入，因为它们可能是 data URL 或嵌入的文件内容；搜索这些内容会重新变成
  // 旧的宽泛 JSON 搜索。
  return sql`(
    json_extract(${PartTable.data}, '$.type') in ('file', 'agent')
    and (
      ${textMatches(sql`json_extract(${PartTable.data}, '$.filename')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.name')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.source.path')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.source.uri')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.source.name')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.source.clientName')`, needle)}
    )
  )`
}

function messageSubtaskPartMatches(needle: string) {
  // Subtask part 是面向用户的委派请求。prompt/description/command 保持可
  // 搜索，使 session 搜索能按“交给子代理做了什么”定位父会话；子代理结果仍在
  // tool output 中，由 messageToolPartMatches 统一排除。
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'subtask'
    and (
      ${textMatches(sql`json_extract(${PartTable.data}, '$.description')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.prompt')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.agent')`, needle)}
      or ${textMatches(sql`json_extract(${PartTable.data}, '$.command')`, needle)}
    )
  )`
}

function messagePatchPartMatches(needle: string) {
  // Patch part 在 transcript 中暴露变更文件路径。只搜索 files 叶子值，保留
  // 通过路径定位会话的行为，同时不索引 patch hash 等 bookkeeping 字段。
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'patch'
    and ${jsonLeafMatches(sql`${PartTable.data}`, "$.files", needle)}
  )`
}

function sessionMessageMatches(needle: string) {
  return sql`(
    ${sessionUserMessageMatches(needle)}
    or (
      ${SessionMessageTable.type} = 'shell'
      and ${textMatches(sql`json_extract(${SessionMessageTable.data}, '$.command')`, needle)}
    )
    or ${sessionAssistantMessageMatches(needle)}
  )`
}

function sessionUserMessageMatches(needle: string) {
  // v2 user message 的 prompt text 之外，还会携带用户可见的 file/agent/reference
  // 定位字段。只白名单这些短字段，保留按附件/引用找 session 的兼容性，同时不
  // 搜索 mime、source.text 或 data URL 类内容。
  return sql`(
    ${SessionMessageTable.type} = 'user'
    and (
      ${textMatches(sql`json_extract(${SessionMessageTable.data}, '$.text')`, needle)}
      or exists (
        select 1
        from json_each(${SessionMessageTable.data}, '$.files') as file
        where ${textMatches(sql`json_extract(file.value, '$.name')`, needle)}
          or ${textMatches(sql`json_extract(file.value, '$.description')`, needle)}
          or ${uriMatches(sql`json_extract(file.value, '$.uri')`, needle)}
        limit 1
      )
      or exists (
        select 1
        from json_each(${SessionMessageTable.data}, '$.agents') as agent
        where ${textMatches(sql`json_extract(agent.value, '$.name')`, needle)}
        limit 1
      )
      or exists (
        select 1
        from json_each(${SessionMessageTable.data}, '$.references') as ref
        where ${textMatches(sql`json_extract(ref.value, '$.name')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.uri')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.repository')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.branch')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.target')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.targetUri')`, needle)}
          or ${textMatches(sql`json_extract(ref.value, '$.problem')`, needle)}
        limit 1
      )
    )
  )`
}

function sessionAssistantMessageMatches(needle: string) {
  // v2 assistant content 把可见文本、reasoning 和 tool 混在同一个数组里。
  // 这里逐项遍历并只白名单 assistant text、tool identity 和 input values；
  // tool content/structured/provider metadata 属于结果面，不能进入 session list search。
  return sql`(
    ${SessionMessageTable.type} = 'assistant'
    and exists (
      select 1
      from json_each(${SessionMessageTable.data}, '$.content') as content
      where (
        (
          json_extract(content.value, '$.type') = 'text'
          and ${textMatches(sql`json_extract(content.value, '$.text')`, needle)}
        )
        or (
          json_extract(content.value, '$.type') = 'tool'
          and (
            ${textMatches(sql`json_extract(content.value, '$.name')`, needle)}
            or ${jsonLeafMatches(sql`content.value`, "$.state.input", needle)}
          )
        )
      )
      limit 1
    )
  )`
}

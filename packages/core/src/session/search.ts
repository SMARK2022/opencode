import { sql, type SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"

// #265：搜索是 session 列表/TUI quick switch 的“可定位内容”投影，不是持久化 JSON 的全文搜索。
// 只索引用户能用来识别会话的字段：标题、可见文本、工具名/工具输入、shell command 等。
// thinking/reasoning、tool result、shell output、metadata、token/snapshot 等字段不是 session 搜索的契约。
// 使用 instr(lower(...)) 做大小写不敏感的精确子串匹配，避免 SQLite LIKE 把 % / _ 当作通配符。
// 空白搜索返回 undefined，避免 instr(text, "") 把所有行都当作命中。
export function searchCondition(search: string): SQL | undefined {
  const needle = search.trim().toLowerCase()
  // #265：三路 union——标题、v1 part 白名单、v2 session_message 白名单；hidden 门仅存在于 v1 part 侧 exists，
  // #265：v2 侧由 sessionMessageMatches 的类型等值判定承担同等排除（等值不命中即不可搜索）
  // #265：返回 undefined 而非恒真 SQL——上层跳过整个搜索分支，避免空串全表命中
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

// #265：cast text + coalesce——title 列非空但布尔化时仍需字符串化；其余调用点字段可能为 null
function textMatches(value: SQL, needle: string) {
  return sql`instr(lower(coalesce(cast(${value} as text), '')), ${needle}) > 0`
}

// #265：URI 可作为定位字段，但 data: URI 嵌入内容不应被搜索
function uriMatches(value: SQL, needle: string) {
  // #265：substr 取前 5 字符比对 "data:"——sqlite 无 starts_with，且前缀判定在 textMatches 之前短路
  // #265：排除后仍复用 textMatches——file:/// 与 https:/// 等真实定位 URI 保持可搜索
  return sql`(
    substr(lower(coalesce(cast(${value} as text), '')), 1, 5) <> 'data:'
    and ${textMatches(value, needle)}
  )`
}

// #265：json_tree atom 只返回叶子值，避免 JSON 键名被误搜索
function jsonLeafMatches(data: SQL, path: string, needle: string) {
  // #265：atom 对对象/数组行返回 null，where 过滤后仅剩标量叶子——键名与容器节点天然不命中
  // #265：path 参数是编译期常量（如 $.state.input），needle 经参数绑定——无注入面
  return sql`exists (
    select 1
    from json_tree(${data}, ${path}) as search_value
    where search_value.atom is not null
      and ${textMatches(sql`search_value.atom`, needle)}
    limit 1
  )`
}

// #265：v1 part 白名单总入口——tool/text/attachment/subtask/patch 五分支新增时必须显式接入，否则不可搜索
function messagePartMatches(needle: string) {
  // #265：五分支 or 联合——新增 part 类型默认不可搜索，必须显式入白名单才可见
  return sql`(
    ${messageTextPartMatches(needle)}
    or ${messageToolPartMatches(needle)}
    or ${messageAttachmentPartMatches(needle)}
    or ${messageSubtaskPartMatches(needle)}
    or ${messagePatchPartMatches(needle)}
  )`
}

// #265：text part 是用户可见的主要内容——排除 synthetic 和 ignored
function messageTextPartMatches(needle: string) {
  // #265：coalesce(...,0)=0 形式而非 is null——兼容 sqlite 把缺失字段返回 null 的三态语义
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'text'
    and coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
    and coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
    and ${textMatches(sql`json_extract(${PartTable.data}, '$.text')`, needle)}
  )`
}

// #265：工具输出和错误可能很大，只搜索工具名和输入
function messageToolPartMatches(needle: string) {
  // #265：四个命中面——工具名/state.title 身份、pending raw、input 叶子值；输出与错误永不进入
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

// #265：pending raw 是模型正在流式输出的 JSON 字符串，只有合法 JSON 时才按叶子值搜索
function messageToolRawMatches(needle: string) {
  // #265：raw 与 input 同层级但互斥存在——pending 阶段只有 raw，完成后只有 input
  return sql`(
    json_valid(json_extract(${PartTable.data}, '$.state.raw'))
    and ${jsonLeafMatches(sql`json_extract(${PartTable.data}, '$.state.raw')`, "$", needle)}
  )`
}

// #265：附件定位字段是短小标签/路径，不索引 raw url 和 source text
function messageAttachmentPartMatches(needle: string) {
  // #265：source.* 子字段来自多形态附件源（本地路径/远程 URI/客户端名）——非重复设计
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

// #265：subtask 是面向用户的委派请求——prompt/description 保持可搜索
function messageSubtaskPartMatches(needle: string) {
  // #265：agent 字段也在白名单——委派目标名可定位
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

// #265：patch 曝光变更文件路径，只搜索 files 叶子值避免键名污染
function messagePatchPartMatches(needle: string) {
  // #265：files 用 jsonLeafMatches 而非逐字段 textMatches——patch 文件列表长度不定，需数组展开
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'patch'
    and ${jsonLeafMatches(sql`${PartTable.data}`, "$.files", needle)}
  )`
}

// #265：v2 三型分流——user/assistant 的 data 带 content/files 结构，shell 顶层即 command，故 shell 独立成支
function sessionMessageMatches(needle: string) {
  // #265：shell 分支独立于 user/assistant 函数——data 顶层直接是 command，无 content 数组包装
  return sql`(
    ${sessionUserMessageMatches(needle)}
    or (
      ${SessionMessageTable.type} = 'shell'
      and ${textMatches(sql`json_extract(${SessionMessageTable.data}, '$.command')`, needle)}
    )
    or ${sessionAssistantMessageMatches(needle)}
  )`
}

// #265：user 投影的 files/agents/references 三数组结构与 v1 part 平面字段不同——需 json_each 展开后逐字段匹配
function sessionUserMessageMatches(needle: string) {
  // #265：files/agents/references 结构不同（对象数组 vs 纯名）故逐分支展开——uri 走 uriMatches 前缀排除
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

// #265：assistant 投影的 content 混合数组是 v2 特有形状——reasoning/tool/text 混存，必须逐项判型
function sessionAssistantMessageMatches(needle: string) {
  // #265：tool 分支的 input 叶子值复用 jsonLeafMatches——与 v1 侧同一键名排除语义
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

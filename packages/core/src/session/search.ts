import { sql, type SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"

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
  return sql`(
    substr(lower(coalesce(cast(${value} as text), '')), 1, 5) <> 'data:'
    and ${textMatches(value, needle)}
  )`
}

function jsonLeafMatches(data: SQL, path: string, needle: string) {
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
  return sql`(
    json_extract(${PartTable.data}, '$.type') = 'text'
    and coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
    and coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
    and ${textMatches(sql`json_extract(${PartTable.data}, '$.text')`, needle)}
  )`
}

function messageToolPartMatches(needle: string) {
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
  return sql`(
    json_valid(json_extract(${PartTable.data}, '$.state.raw'))
    and ${jsonLeafMatches(sql`json_extract(${PartTable.data}, '$.state.raw')`, "$", needle)}
  )`
}

function messageAttachmentPartMatches(needle: string) {
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

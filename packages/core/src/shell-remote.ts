export * as ShellRemote from "./shell-remote"

// #207：原始文本 token 保留源偏移——localCommands 用它过滤解析器恢复的载荷命令，不依赖 tree-sitter 对畸形 WSL/SSH 字符串的恢复形状
type Token = {
  text: string
  start: number
  end: number
}

// #207：远程载荷范围的源偏移区间——localCommands 排除落在远程范围内的命令节点
type Range = {
  start: number
  end: number
}

// #207：命令段是主机 shell 分隔符切分的文本片段——保留源偏移以支持 tokenizeLocalSegment
type Segment = Range & {
  text: string
}

// #207：远程 shell 命令携带另一个文件系统命名空间的内层 shell——本地兼容性检查和 external_directory 扫描需检查包装调用本身，但不应将载荷的 POSIX 命令或客户机路径重新解释为主机 Windows 命令/路径
const REMOTE_SHELL_COMMANDS = new Set(["ssh", "wsl"])
// #207：WSL 消费后续 token 的选项名——显式列表防止 Ubuntu-22.04 或 /tmp 等值被误认为客户机可执行文本
const WSL_OPTIONS_WITH_VALUE = new Set(["-d", "--distribution", "-u", "--user", "--cd"])
// #207：SSH 消费后续 token 的选项名——扫描器只需常见选项/值边界以保持本地 SSH 选项本地化，同时将 host 后文本标记为远程 shell 载荷
const SSH_OPTIONS_WITH_VALUE = new Set(["-b", "-c", "-e", "-F", "-i", "-J", "-l", "-m", "-o", "-p", "-S", "-W"])
// #207：计算远程/alternate-OS 载荷的源范围——PowerShell 恢复可能将引号载荷中的命令暴露为根级命令
export function ranges(command: string, shellName: string) {
  const powershell = shellName !== "cmd"
  return commandSegments(command, powershell).flatMap((segment) => {
    const tokens = tokenizeLocalSegment(segment.text, segment.start, powershell)
    // #207：去除 .exe 后缀并小写化以匹配 REMOTE_SHELL_COMMANDS 集合
    const cmd = (tokens[0]?.text ?? "").toLowerCase().replace(/\.exe$/, "")
    if (!REMOTE_SHELL_COMMANDS.has(cmd)) return []
    // #207：WSL 和 SSH 有不同的载荷边界定位策略——分别委托给专用函数
    if (cmd === "wsl") return wslPayloadRange(tokens, segment.end)
    if (cmd === "ssh") return sshPayloadRange(tokens, segment.end)
    return []
  })
}

// #207：按主机 shell 分隔符切分命令段——保留引号内容，使 wsl ... 'guest | grep' 留在客户机内
function commandSegments(command: string, powershell: boolean) {
  const result: Segment[] = []
  let start = 0
  let quote = ""
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      // #207：引号内反引号转义跳过下一字符——PowerShell 反引号转义不影响段分隔
      if (powershell && quote !== "'" && char === "`") i++
      else if (char === quote) quote = ""
      continue
    }
    // #207：进入引号区域——引号内分隔符不切分段
    if (char === (powershell ? "`" : "^")) {
      i++
      continue
    }
    if ((powershell && char === "'") || char === '"') {
      quote = char
      continue
    }
    // #207：检测成对分隔符 (&&/||)——与单字符 | & 不同，成对分隔符需消费两个字符否则会残留多余分隔符污染下一段起点
    const paired = (char === "&" || char === "|") && command[i + 1] === char
    // #207：这些分隔符终止当前主机命令段——单 | 和 & 使 WSL 载荷后的本地管道/命令链保持覆盖
    if (char === "|" || char === "&" || char === ";" || char === "\n" || paired) {
      result.push({ start, end: i, text: command.slice(start, i) })
      // #207：成对分隔符 (&&/||) 占两个字符——start 和 i 都需跳过
      start = i + (paired ? 2 : 1)
      if (paired) i++
    }
  }
  // #207：最后一段（无终止分隔符）也需入列
  result.push({ start, end: command.length, text: command.slice(start) })
  return result
}

// #207：偏移保留的简易词法分析器——只理解空格、简单引号和 PowerShell 反引号转义
function tokenizeLocalSegment(command: string, offset: number, powershell: boolean) {
  const result: Token[] = []
  for (let i = 0; i < command.length; i++) {
    if (/\s/.test(command[i])) continue
    const start = i
    if ((powershell && command[i] === "'") || command[i] === '"') {
      const quote = command[i]
      let text = ""
      for (i++; i < command.length; i++) {
        // #207：反引号转义——跳过反引号取下一字符作为字面值
        if (powershell && quote !== "'" && command[i] === "`") {
          text += command[i + 1] ?? ""
          i++
          continue
        }
        // #207：闭合引号——结束当前 token
        if (command[i] === quote) break
        text += command[i]
      }
      // #207：偏移保留——token 的 start/end 包含段偏移以映射回原始命令行
      result.push({ text, start: offset + start, end: offset + Math.min(i + 1, command.length) })
      continue
    }
    // #207：非引号 token——连续非空格字符作为一个 token
    while (i + 1 < command.length && !/\s/.test(command[i + 1])) i++
    result.push({ text: command.slice(start, i + 1), start: offset + start, end: offset + i + 1 })
  }
  return result
}

// #207：WSL 选项解析仅用于定位客户机命令边界——载荷不被批准或解释
function wslPayloadRange(tokens: Token[], end: number) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].text.toLowerCase()
    // #207：--/-e/--exec 后的 token 是客户机命令起点
    if (token === "--" || token === "-e" || token === "--exec")
      return tokens[i + 1] ? [{ start: tokens[i + 1].start, end }] : []
    // #207：带值选项——跳过值 token 继续扫描
    if (WSL_OPTIONS_WITH_VALUE.has(token)) {
      i++
      continue
    }
    // #207：其他选项——跳过继续扫描
    if (token.startsWith("-")) continue
    // #207：第一个非选项 token 是客户机命令起点
    return [{ start: tokens[i].start, end }]
  }
  return []
}

// #207：SSH 有本地可执行文件和本地选项后跟远程 host——只有 host 后的 token 是远程 shell 文本
function sshPayloadRange(tokens: Token[], end: number) {
  // #207：从第二个 token 开始查找远程 host——跳过带值选项的值和独立选项
  const host = tokens.slice(1).findIndex((item, index, items) => {
    if (items[index - 1] && SSH_OPTIONS_WITH_VALUE.has(items[index - 1].text)) return false
    if (item.text === "--") return false
    // #207：非选项 token 即为远程 host
    return !item.text.startsWith("-")
  })
  if (host < 0) return []
  // #207：host 后的 token 是远程 shell 文本——返回从该位置到段末的范围
  // #207：findIndex 作用于 slice(1) 故 host 是切片内 0 基索引——host 本身在原数组为 host+1，其后的首个远程 token 为 host+2，必须跳过 host 自身避免把主机名计入载荷
  const start = host + 2
  return tokens[start] ? [{ start: tokens[start].start, end }] : []
}

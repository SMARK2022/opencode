# OpenCode 上下文管理方案

## 概述

本文档基于对 `thirdparty/claude-code-rebuilt` 中上下文治理逻辑的完整分析，提出在 `opencode` 项目中构建相应上下文管理机制的完整方案。该方案旨在将 Claude Code 的上下文治理核心思想融入 OpenCode 架构，提供统一、可配置、高性能的上下文管理能力。

## 当前状态分析

### OpenCode 现有的 Git 上下文能力
通过分析 `packages/opencode/src/session/system.ts` 文件，发现 OpenCode 目前仅提供基本的 Git 仓库检测：

```typescript
// system.ts 第 57 行
`Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`
```

**当前提供的 Git 信息**：
- 仅判断目录是否为 Git 仓库（是/否）
- 不包含分支信息、状态信息、提交历史等

**缺失的功能**：
- 当前分支名称
- 主分支名称
- Git 状态（修改、新增、删除的文件）
- 最近提交历史
- Git 用户信息
- 字符限制和截断处理

### 现有上下文注入位置
Git 信息通过 `SystemPrompt.Service` 的 `environment()` 方法注入，作为系统提示的一部分。该信息在每次会话开始时生成，但不包含详细的 Git 状态。

## Claude Code Rebuilt 上下文治理逻辑分析

### 核心文件
- `thirdparty/claude-code-rebuilt/src/context.ts` - 上下文管理核心逻辑
- `thirdparty/claude-code-rebuilt/src/utils/git.ts` - Git 工具函数

### Git 上下文详细内容
Claude Code Rebuilt 通过 `getGitStatus()` 函数获取以下 Git 信息：

#### 1. 基本信息
- **当前分支**：通过 `getBranch()` 获取
- **主分支**：通过 `getDefaultBranch()` 获取（标注为 "you will usually use this for PRs"）
- **Git 用户名**：通过 `git config user.name` 获取

#### 2. 状态信息
- **Git 状态**：`git status --short`（简洁格式）
- **字符限制**：MAX_STATUS_CHARS = 2000
- **截断处理**：超过 2000 字符时截断，并提示用户使用 BashTool 查看完整信息

#### 3. 历史信息
- **最近提交**：`git log --oneline -n 5`（最近5个提交的单行格式）

#### 4. 格式化输出
```text
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: main
Main branch (you will usually use this for PRs): main
Git user: John Doe

Status:
 M package.json
?? new-file.txt

Recent commits:
abc123 Update README
def456 Fix bug in module
ghi789 Add new feature
```

#### 5. 性能优化
- **并行获取**：使用 `Promise.all()` 并行执行多个 Git 命令
- **缓存机制**：使用 `lodash-es/memoize` 缓存结果，生命周期为整个会话
- **错误处理**：捕获异常并返回 `null`，不影响其他上下文

#### 6. 配置控制
- **环境变量**：`CLAUDE_CODE_DISABLE_CLAUDE_MDS`
- **命令行标志**：`--bare` 模式
- **远程会话**：`CLAUDE_CODE_REMOTE` 环境变量下跳过 Git 状态

### 核心思想

1. **上下文分离**
   - **系统上下文**：包含 Git 状态等环境信息
   - **用户上下文**：包含 Claude.md 文件和当前日期

2. **缓存机制**
   - 使用 `lodash-es/memoize` 进行函数级缓存
   - 缓存生命周期为整个会话期间
   - 支持通过 `setSystemPromptInjection()` 进行缓存破坏

3. **配置驱动**
   - 环境变量控制：`CLAUDE_CODE_DISABLE_CLAUDE_MDS`
   - 命令行标志控制：`--bare` 模式
   - 特性标志控制：`BREAK_CACHE_COMMAND`

4. **动态生成**
   - Git 状态通过执行 `git status`、`git log` 等命令实时获取
   - Claude.md 文件通过文件系统扫描发现
   - 支持并行执行提高性能

5. **安全与性能**
   - Git 状态字符数限制（MAX_STATUS_CHARS = 2000）
   - 错误处理与降级策略
   - 诊断日志记录

### 关键函数
- `getSystemContext()`: 返回 Git 状态等系统信息
- `getUserContext()`: 返回 Claude.md 内容和当前日期
- `getGitStatus()`: 获取并格式化 Git 状态
- `setSystemPromptInjection()`: 缓存破坏机制

## OpenCode 现有机制分析

### 指令系统 (Instruction Service)
- 文件：`packages/opencode/src/session/instruction.ts`
- 功能：加载 AGENTS.md、CLAUDE.md、CONTEXT.md 等指令文件
- 支持多级查找：项目级 → 配置目录 → 全局目录
- 支持 HTTP URL 指令源
- 已有缓存和去重机制

### Git 服务 (Git Service)
- 文件：`packages/opencode/src/git/index.ts`
- 功能：提供完整的 Git 操作接口
- 包括分支、状态、差异、统计等操作
- 基于 Effect TS 构建，类型安全
- **关键方法**：
  - `branch(cwd)`: 获取当前分支
  - `defaultBranch(cwd)`: 获取主分支
  - `status(cwd)`: 获取 Git 状态
  - `hasHead(cwd)`: 检查是否有 HEAD

### 会话系统
- 文件：`packages/opencode/src/v2/session.ts`
- 功能：会话管理核心逻辑
- 使用 Effect Schema 进行类型验证

### 配置系统
- 使用 Flag 系统进行特性标志管理
- 环境变量：`OPENCODE_CONFIG_DIR`、`OPENCODE_DISABLE_PROJECT_CONFIG` 等

## 方案设计目标

1. **无缝集成**：在现有 OpenCode 架构上扩展，不破坏现有功能
2. **配置灵活**：支持环境变量、命令行标志、配置文件多种配置方式
3. **性能优化**：合理的缓存策略，避免重复计算
4. **类型安全**：充分利用 TypeScript 和 Effect TS 的类型系统
5. **可测试性**：提供完整的测试覆盖
6. **向后兼容**：确保现有功能不受影响
7. **信息完整**：提供与 Claude Code 相当的 Git 上下文信息

## 架构设计

### 组件关系图
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Context       │    │   Instruction   │    │      Git        │
│   Service       │◄───│   Service       │◄───│   Service       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                         ┌─────────────────┐
                         │   Session       │
                         │   Service       │
                         └─────────────────┘
```

### 核心组件

#### 1. ContextService
**位置**：`packages/opencode/src/context/index.ts`

**接口设计**：
```typescript
export interface Context {
  readonly getSystemContext: (
    sessionId: SessionID,
    options?: ContextOptions
  ) => Effect.Effect<Record<string, string>>
  
  readonly getUserContext: (
    sessionId: SessionID,
    options?: ContextOptions
  ) => Effect.Effect<Record<string, string>>
  
  readonly getCombinedContext: (
    sessionId: SessionID,
    options?: ContextOptions
  ) => Effect.Effect<string>
  
  readonly clearCache: (sessionId: SessionID) => Effect.Effect<void>
  
  readonly getGitContext: (
    sessionId: SessionID,
    options?: GitContextOptions
  ) => Effect.Effect<string | null>
}

export interface ContextOptions {
  readonly disableGit?: boolean
  readonly disableInstructions?: boolean
  readonly maxGitStatusChars?: number
  readonly includeDate?: boolean
  readonly includeGitUser?: boolean
  readonly includeRecentCommits?: boolean
  readonly recentCommitsCount?: number
}

export interface GitContextOptions {
  readonly maxStatusChars?: number
  readonly includeUser?: boolean
  readonly includeRecentCommits?: boolean
  readonly recentCommitsCount?: number
  readonly truncateMessage?: string
}
```

#### 2. 缓存层
**策略**：
- 基于会话 ID 和工作目录的双层缓存
- 使用 Effect 的 memoization 机制
- 支持手动清除和 TTL 过期
- Git 上下文缓存键：`${sessionId}:${cwd}:git`

#### 3. 配置系统
**环境变量**：
- `OPENCODE_DISABLE_GIT_CONTEXT`：禁用 Git 上下文
- `OPENCODE_DISABLE_PROJECT_CONTEXT`：禁用项目指令上下文
- `OPENCODE_MAX_GIT_STATUS_CHARS`：Git 状态最大字符数（默认 2000）
- `OPENCODE_GIT_RECENT_COMMITS_COUNT`：最近提交数量（默认 5）
- `OPENCODE_INCLUDE_GIT_USER`：是否包含 Git 用户信息（默认 true）

**命令行标志**：
- `--bare`：最小化上下文（仅包含必要信息）
- `--no-git-context`：禁用 Git 上下文
- `--no-project-context`：禁用项目指令
- `--git-recent-commits <count>`：设置最近提交数量
- `--no-git-user`：不包含 Git 用户信息

### 详细实现

#### Git 上下文格式化函数
```typescript
const formatGitStatus = (items: Git.Item[]): string => {
  return items.map(item => {
    const status = item.code.trim()
    const file = item.file
    return `${status} ${file}`
  }).join('\n')
}

const formatGitContext = (params: {
  branch?: string
  defaultBranch?: Git.Base
  userName?: string
  status: Git.Item[]
  recentCommits: string[]
  maxChars: number
  truncateMessage: string
}): string => {
  const {
    branch,
    defaultBranch,
    userName,
    status,
    recentCommits,
    maxChars,
    truncateMessage
  } = params
  
  const lines: string[] = [
    `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
    ...(branch ? [`Current branch: ${branch}`] : []),
    ...(defaultBranch ? [`Main branch (you will usually use this for PRs): ${defaultBranch.name}`] : []),
    ...(userName ? [`Git user: ${userName}`] : []),
  ]
  
  const statusText = formatGitStatus(status)
  const truncatedStatus = statusText.length > maxChars
    ? statusText.substring(0, maxChars) + `\n${truncateMessage}`
    : statusText || '(clean)'
  
  lines.push(`Status:\n${truncatedStatus}`)
  
  if (recentCommits.length > 0) {
    lines.push(`Recent commits:\n${recentCommits.join('\n')}`)
  }
  
  return lines.join('\n\n')
}
```

#### 系统上下文生成（Git 部分细化）
```typescript
const getSystemContext = Effect.fn("Context.getSystemContext")(
  function* (sessionId: SessionID, options: ContextOptions = {}) {
    const git = yield* Git.Service
    const ctx = yield* InstanceState.context
    
    const result: Record<string, string> = {}
    
    // Git 上下文（基于 Claude Code 的实现）
    if (!options.disableGit && !Flag.OPENCODE_DISABLE_GIT_CONTEXT) {
      const gitContext = yield* getGitContext(sessionId, {
        maxStatusChars: options.maxGitStatusChars ?? 2000,
        includeUser: options.includeGitUser ?? true,
        includeRecentCommits: options.includeRecentCommits ?? true,
        recentCommitsCount: options.recentCommitsCount ?? 5,
        truncateMessage: "... (truncated because it exceeds character limit. If you need more information, run 'git status' using BashTool)"
      })
      
      if (gitContext) {
        result.gitContext = gitContext
      }
    }
    
    return result
  }
)

const getGitContext = Effect.fn("Context.getGitContext")(
  function* (sessionId: SessionID, options: GitContextOptions = {}) {
    const git = yield* Git.Service
    const ctx = yield* InstanceState.context
    
    // 检查是否为 Git 仓库
    const hasHead = yield* git.hasHead(ctx.directory)
    if (!hasHead) {
      return null
    }
    
    try {
      // 并行获取 Git 信息（类似 Claude Code 的实现）
      const [branch, defaultBranch, status, recentCommits, userName] = yield* Effect.all(
        [
          git.branch(ctx.directory),
          git.defaultBranch(ctx.directory),
          git.status(ctx.directory),
          getRecentCommits(ctx.directory, options.recentCommitsCount ?? 5),
          options.includeUser ? getGitUserName(ctx.directory) : Effect.succeed(undefined)
        ],
        { concurrency: 5 }
      )
      
      return formatGitContext({
        branch,
        defaultBranch,
        userName,
        status,
        recentCommits,
        maxChars: options.maxStatusChars ?? 2000,
        truncateMessage: options.truncateMessage ?? "... (truncated)"
      })
    } catch (error) {
      // 错误处理：返回 null，不影响其他上下文
      Log.warn("Failed to get git context", { error })
      return null
    }
  }
)

const getRecentCommits = Effect.fn("Context.getRecentCommits")(
  function* (cwd: string, count: number) {
    const git = yield* Git.Service
    const result = yield* git.run(
      ["log", "--oneline", "-n", count.toString()],
      { cwd }
    )
    
    if (result.exitCode !== 0) {
      return []
    }
    
    return result.text()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  }
)

const getGitUserName = Effect.fn("Context.getGitUserName")(
  function* (cwd: string) {
    const git = yield* Git.Service
    const result = yield* git.run(
      ["config", "user.name"],
      { cwd }
    )
    
    if (result.exitCode !== 0) {
      return undefined
    }
    
    const name = result.text().trim()
    return name || undefined
  }
)
```

#### 用户上下文生成
```typescript
const getUserContext = Effect.fn("Context.getUserContext")(
  function* (sessionId: SessionID, options: ContextOptions = {}) {
    const instruction = yield* Instruction.Service
    const result: Record<string, string> = {}
    
    // 项目指令
    if (!options.disableInstructions && !Flag.OPENCODE_DISABLE_PROJECT_CONTEXT) {
      const instructions = yield* instruction.system()
      if (instructions.length > 0) {
        result.projectInstructions = instructions.join("\n\n")
      }
    }
    
    // 当前日期
    if (options.includeDate !== false) {
      result.currentDate = `Today's date is ${new Date().toISOString().split('T')[0]}.`
    }
    
    return result
  }
)
```

### 集成方式

#### 1. 会话层集成
修改 `packages/opencode/src/v2/session.ts`，在会话创建时注入上下文：

```typescript
const promptWithContext = Effect.fn("Session.promptWithContext")(
  function* (input: PromptInput) {
    const context = yield* Context.Service
    const sessionCtx = yield* context.getCombinedContext(input.sessionID)
    
    // 将上下文作为系统消息的一部分
    const enhancedInput = {
      ...input,
      systemPrompt: input.systemPrompt 
        ? `${input.systemPrompt}\n\n${sessionCtx}`
        : sessionCtx
    }
    
    return yield* prompt(enhancedInput)
  }
)
```

#### 2. 与现有 SystemPrompt 集成
更新 `packages/opencode/src/session/system.ts`，集成新的上下文服务：

```typescript
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const context = yield* Context.Service

    return Service.of({
      environment(model) {
        const project = Instance.project
        
        // 获取 Git 上下文
        const gitContext = "" // 在实际实现中通过 context.getGitContext() 获取
        
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
            ...(gitContext ? [`\nGit Context:\n${gitContext}`] : [])
          ].join("\n"),
        ]
      },
      // ... 其他方法
    })
  })
)
```

#### 3. 命令行集成
扩展 CLI 选项，支持上下文控制标志：

```typescript
program
  .option('--no-git-context', 'Disable git context injection')
  .option('--no-project-context', 'Disable project instruction context')
  .option('--bare', 'Minimal context (equivalent to both --no-git-context and --no-project-context)')
  .option('--git-recent-commits <count>', 'Number of recent commits to include (default: 5)', '5')
  .option('--no-git-user', 'Exclude git user information')
  .option('--max-git-chars <chars>', 'Maximum characters for git status (default: 2000)', '2000')
```

### 配置优先级
1. 命令行标志（最高优先级）
2. 环境变量
3. 配置文件
4. 默认值（最低优先级）

## 实施步骤

### 阶段一：基础框架
1. 创建 `packages/opencode/src/context/` 目录
2. 实现 `ContextService` 基础接口
3. 实现 Git 上下文获取和格式化
4. 集成 Git 服务和 Instruction 服务
5. 实现基本缓存机制

### 阶段二：集成测试
1. 编写单元测试
2. 集成到 Session 服务
3. 验证缓存行为
4. 测试配置选项
5. 测试 Git 上下文的各种场景（无仓库、干净仓库、大量更改等）

### 阶段三：性能优化
1. 实现智能缓存失效
2. 添加性能监控
3. 优化 Git 状态获取（并行执行）
4. 添加并发控制
5. 实现懒加载策略

### 阶段四：文档与示例
1. 编写 API 文档
2. 创建使用示例
3. 更新配置文档
4. 添加迁移指南
5. 提供性能调优指南

## 测试策略

### 单元测试
- ContextService 各方法的功能测试
- Git 上下文格式化测试
- 缓存机制的测试
- 错误处理测试
- 字符截断测试

### 集成测试
- 与 Git 服务的集成测试
- 与 Instruction 服务的集成测试
- 会话层集成测试
- 配置系统集成测试

### 性能测试
- 缓存命中率测试
- 并发访问测试
- 内存使用测试
- Git 命令执行时间测试
- 大量文件状态的性能测试

### E2E 测试
- 完整会话流程测试
- 配置选项测试
- 命令行标志测试
- 不同 Git 场景测试（干净仓库、冲突状态、大量更改等）

## 迁移计划

### 向后兼容性
1. 默认启用所有上下文功能
2. 提供禁用选项
3. 保持现有 API 不变
4. 现有 `SystemPrompt.Service` 继续工作，新增 Git 上下文作为补充

### 渐进式迁移
1. 第一阶段作为可选功能（通过特性标志控制）
2. 收集用户反馈
3. 根据反馈调整默认配置
4. 逐步优化性能
5. 最终作为默认功能启用

## 风险与缓解

### 技术风险
1. **性能影响**：Git 状态获取可能较慢，尤其是大型仓库
   - 缓解：缓存策略，异步获取，超时控制，字符限制
   
2. **兼容性问题**：与现有插件或自定义系统提示冲突
   - 缓解：特性标志控制，逐步发布，配置选项

3. **配置复杂性**：多种配置方式可能混淆用户
   - 缓解：清晰的文档，配置验证，合理的默认值

4. **Git 命令失败**：Git 仓库损坏或权限问题
   - 缓解：错误处理，降级策略，友好错误信息

### 运维风险
1. **缓存失效**：可能导致陈旧上下文
   - 缓解：基于工作目录的缓存键，手动清除接口，TTL 设置

2. **资源泄漏**：缓存可能累积，占用内存
   - 缓解：LRU 缓存，定期清理，会话结束时清理

3. **安全风险**：Git 信息可能包含敏感数据
   - 缓解：字符限制，截断处理，用户可控

## 总结

本方案基于 Claude Code Rebuilt 的上下文治理最佳实践，结合 OpenCode 现有架构，设计了一套完整、可配置、高性能的上下文管理系统。通过详细的 Git 上下文实现，填补了 OpenCode 当前在 Git 信息提供方面的不足，同时保持了向后兼容性和配置灵活性。

### 关键改进
1. **完整的 Git 上下文**：提供分支、状态、提交历史等完整信息
2. **性能优化**：并行获取、缓存机制、字符限制
3. **配置灵活**：支持多级配置和精细控制
4. **无缝集成**：与现有系统提示和服务集成
5. **错误恢复**：完善的错误处理和降级策略

通过合理的架构设计和渐进式实施策略，可以在保持向后兼容的同时，显著提升 OpenCode 的上下文管理能力，为用户提供更丰富的开发环境信息。

## 附录

### 代码位置引用

#### Claude Code Rebuilt
- 上下文核心逻辑：`thirdparty/claude-code-rebuilt/src/context.ts:1-189`
- Git 状态获取：`thirdparty/claude-code-rebuilt/src/context.ts:36-111`
- Git 工具函数：`thirdparty/claude-code-rebuilt/src/utils/git.ts:212-265`
- 缓存机制：`thirdparty/claude-code-rebuilt/src/context.ts:25-34`

#### OpenCode 现有组件
- 指令服务：`packages/opencode/src/session/instruction.ts:1-244`
- Git 服务：`packages/opencode/src/git/index.ts:1-260`
- 会话服务：`packages/opencode/src/v2/session.ts:1-69`
- 系统提示服务：`packages/opencode/src/session/system.ts:1-84`
- 环境信息注入：`packages/opencode/src/session/system.ts:48-62`

### 配置示例

#### 环境变量配置
```bash
# 禁用 Git 上下文
export OPENCODE_DISABLE_GIT_CONTEXT=true

# 禁用项目指令上下文
export OPENCODE_DISABLE_PROJECT_CONTEXT=true

# 设置 Git 状态最大字符数
export OPENCODE_MAX_GIT_STATUS_CHARS=1000

# 设置最近提交数量
export OPENCODE_GIT_RECENT_COMMITS_COUNT=3

# 不包含 Git 用户信息
export OPENCODE_INCLUDE_GIT_USER=false
```

#### 命令行使用
```bash
# 最小化上下文
opencode --bare "分析这个项目"

# 仅禁用 Git 上下文
opencode --no-git-context "查看项目结构"

# 自定义 Git 上下文
opencode --git-recent-commits 10 --max-git-chars 5000 "分析大型项目"

# 完全控制
opencode --no-git-context --no-project-context --no-git-user "简单问题"
```

#### 配置文件示例
```json
{
  "context": {
    "git": {
      "enabled": true,
      "maxChars": 2000,
      "includeUser": true,
      "includeRecentCommits": true,
      "recentCommitsCount": 5,
      "truncateMessage": "... (truncated. Use BashTool for full output)"
    },
    "instructions": {
      "enabled": true,
      "sources": ["AGENTS.md", "CLAUDE.md"]
    },
    "cache": {
      "ttl": 300,
      "maxSize": 100,
      "strategy": "lru"
    }
  }
}
```

#### Git 上下文输出示例
```text
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: feature/new-api
Main branch (you will usually use this for PRs): main
Git user: Jane Developer

Status:
 M src/api/client.ts
?? src/api/new-endpoint.ts
 D src/api/old-endpoint.ts

Recent commits:
abc123fe Add new API client implementation
def456ab Fix authentication bug
ghi789cd Update dependencies
```

### 性能指标
- **Git 命令执行时间**：目标 < 500ms（小型仓库）
- **缓存命中率**：目标 > 90%
- **内存使用**：每会话 < 10KB
- **并发支持**：支持 10+ 并发会话
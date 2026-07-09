# OpenCode 上下文管理方案

## 概述

本文档基于对 `thirdparty/claude-code-rebuilt` 中上下文治理逻辑的完整分析，提出在 `opencode` 项目中构建相应上下文管理机制的完整方案。该方案旨在将 Claude Code 的上下文治理核心思想融入 OpenCode 架构，提供统一、可配置、高性能的上下文管理能力。

## Claude Code Rebuilt 上下文治理逻辑分析

### 核心文件
- `thirdparty/claude-code-rebuilt/src/context.ts` - 上下文管理核心逻辑

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
}

export interface ContextOptions {
  readonly disableGit?: boolean
  readonly disableInstructions?: boolean
  readonly maxGitStatusChars?: number
  readonly includeDate?: boolean
}
```

#### 2. 缓存层
**策略**：
- 基于会话 ID 和工作目录的双层缓存
- 使用 Effect 的 memoization 机制
- 支持手动清除和 TTL 过期

#### 3. 配置系统
**环境变量**：
- `OPENCODE_DISABLE_GIT_CONTEXT`：禁用 Git 上下文
- `OPENCODE_DISABLE_PROJECT_CONTEXT`：禁用项目指令上下文
- `OPENCODE_MAX_GIT_STATUS_CHARS`：Git 状态最大字符数（默认 2000）

**命令行标志**：
- `--bare`：最小化上下文（仅包含必要信息）
- `--no-git-context`：禁用 Git 上下文
- `--no-project-context`：禁用项目指令

### 详细实现

#### 系统上下文生成
```typescript
const getSystemContext = Effect.fn("Context.getSystemContext")(
  function* (sessionId: SessionID, options: ContextOptions = {}) {
    const git = yield* Git.Service
    const ctx = yield* InstanceState.context
    
    const result: Record<string, string> = {}
    
    // Git 状态
    if (!options.disableGit && !Flag.OPENCODE_DISABLE_GIT_CONTEXT) {
      const branch = yield* git.branch(ctx.directory)
      const defaultBranch = yield* git.defaultBranch(ctx.directory)
      const status = yield* git.status(ctx.directory)
      
      if (branch && status.length > 0) {
        const maxChars = options.maxGitStatusChars ?? 2000
        let statusText = formatGitStatus(status)
        if (statusText.length > maxChars) {
          statusText = statusText.substring(0, maxChars) + 
            "\n... (truncated. Run 'git status' using BashTool for full output)"
        }
        
        result.gitStatus = [
          "This is the git status at the start of the conversation.",
          "Note that this status is a snapshot in time and will not update during the conversation.",
          `Current branch: ${branch}`,
          `Main branch: ${defaultBranch?.name || 'unknown'}`,
          `Status:\n${statusText || '(clean)'}`
        ].join("\n\n")
      }
    }
    
    return result
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

#### 2. 命令行集成
扩展 CLI 选项，支持上下文控制标志：

```typescript
program
  .option('--no-git-context', 'Disable git context injection')
  .option('--no-project-context', 'Disable project instruction context')
  .option('--bare', 'Minimal context (equivalent to both --no-git-context and --no-project-context)')
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
3. 集成 Git 服务和 Instruction 服务
4. 实现基本缓存机制

### 阶段二：集成测试
1. 编写单元测试
2. 集成到 Session 服务
3. 验证缓存行为
4. 测试配置选项

### 阶段三：性能优化
1. 实现智能缓存失效
2. 添加性能监控
3. 优化 Git 状态获取
4. 添加并发控制

### 阶段四：文档与示例
1. 编写 API 文档
2. 创建使用示例
3. 更新配置文档
4. 添加迁移指南

## 测试策略

### 单元测试
- ContextService 各方法的功能测试
- 缓存机制的测试
- 错误处理测试

### 集成测试
- 与 Git 服务的集成测试
- 与 Instruction 服务的集成测试
- 会话层集成测试

### 性能测试
- 缓存命中率测试
- 并发访问测试
- 内存使用测试

### E2E 测试
- 完整会话流程测试
- 配置选项测试
- 命令行标志测试

## 迁移计划

### 向后兼容性
1. 默认启用所有上下文功能
2. 提供禁用选项
3. 保持现有 API 不变

### 渐进式迁移
1. 第一阶段作为可选功能
2. 收集用户反馈
3. 逐步优化
4. 最终作为默认功能

## 风险与缓解

### 技术风险
1. **性能影响**：Git 状态获取可能较慢
   - 缓解：缓存策略，异步获取，超时控制
   
2. **兼容性问题**：与现有插件冲突
   - 缓解：特性标志控制，逐步发布

3. **配置复杂性**：多种配置方式可能混淆
   - 缓解：清晰的文档，配置验证

### 运维风险
1. **缓存失效**：可能导致陈旧上下文
   - 缓解：缓存失效策略，手动清除接口

2. **资源泄漏**：缓存可能累积
   - 缓解：LRU 缓存，定期清理

## 总结

本方案基于 Claude Code Rebuilt 的上下文治理最佳实践，结合 OpenCode 现有架构，设计了一套完整、可配置、高性能的上下文管理系统。通过合理的架构设计和渐进式实施策略，可以在保持向后兼容的同时，显著提升 OpenCode 的上下文管理能力。

## 附录

### 代码位置引用

#### Claude Code Rebuilt
- 上下文核心逻辑：`thirdparty/claude-code-rebuilt/src/context.ts:1-189`
- Git 状态获取：`thirdparty/claude-code-rebuilt/src/context.ts:36-111`
- 缓存机制：`thirdparty/claude-code-rebuilt/src/context.ts:25-34`

#### OpenCode 现有组件
- 指令服务：`packages/opencode/src/session/instruction.ts:1-244`
- Git 服务：`packages/opencode/src/git/index.ts:1-260`
- 会话服务：`packages/opencode/src/v2/session.ts:1-69`

### 配置示例

#### 环境变量配置
```bash
# 禁用 Git 上下文
export OPENCODE_DISABLE_GIT_CONTEXT=true

# 禁用项目指令上下文
export OPENCODE_DISABLE_PROJECT_CONTEXT=true

# 设置 Git 状态最大字符数
export OPENCODE_MAX_GIT_STATUS_CHARS=1000
```

#### 命令行使用
```bash
# 最小化上下文
opencode --bare "分析这个项目"

# 仅禁用 Git 上下文
opencode --no-git-context "查看项目结构"

# 完全控制
opencode --no-git-context --no-project-context "简单问题"
```

#### 配置文件示例
```json
{
  "context": {
    "git": {
      "enabled": true,
      "maxChars": 2000
    },
    "instructions": {
      "enabled": true,
      "sources": ["AGENTS.md", "CLAUDE.md"]
    },
    "cache": {
      "ttl": 300,
      "maxSize": 100
    }
  }
}
```
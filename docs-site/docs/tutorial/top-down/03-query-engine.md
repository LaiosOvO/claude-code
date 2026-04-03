# 第三章：对话引擎 QueryEngine

> QueryEngine 是 Claude Code 的心脏。理解它，就理解了 AI Agent 的核心运作原理。

## 3.1 QueryEngine 在架构中的位置

```
用户界面 (REPL / headless)
        │
        │  用户输入 prompt
        ▼
   ┌─────────┐
   │  query() │  ← src/query.ts - 高层接口
   └────┬─────┘
        │
        ▼
   ┌─────────────┐
   │ QueryEngine  │  ← src/QueryEngine.ts - 核心引擎
   │              │
   │ ┌──────────┐ │
   │ │ 系统提示词 │ │
   │ ├──────────┤ │
   │ │ 消息历史  │ │
   │ ├──────────┤ │
   │ │ 工具池    │ │
   │ ├──────────┤ │
   │ │ 权限检查  │ │
   │ └──────────┘ │
   └──────┬───────┘
          │
     ┌────┴────┐
     ▼         ▼
 Claude API   工具执行
 (流式调用)   (Bash/Read/...)
```

## 3.2 核心循环：Agent Loop

这是所有 AI Agent 的核心模式——**循环调用 LLM + 执行工具**：

```
开始
  │
  ▼
组装消息 [system prompt + history + user message]
  │
  ▼
┌─► 调用 Claude API (流式) ──────────────────┐
│   │                                         │
│   ▼                                         │
│ 解析响应                                     │
│   │                                         │
│   ├── stop_reason = "end_turn"              │
│   │   └── 对话结束 ✓                         │
│   │                                         │
│   └── stop_reason = "tool_use"              │
│       │                                     │
│       ▼                                     │
│   提取 tool_use 块                           │
│       │                                     │
│       ▼                                     │
│   权限检查 (allow/deny/ask)                  │
│       │                                     │
│       ▼                                     │
│   执行工具 (可并行)                           │
│       │                                     │
│       ▼                                     │
│   收集 tool_result                           │
│       │                                     │
│       ▼                                     │
│   追加到消息历史                              │
│       │                                     │
└───────┘  继续循环                             │
                                              │
```

## 3.3 QueryEngine 配置

```typescript
// QueryEngine 需要的所有配置
type QueryEngineConfig = {
  // === 基础配置 ===
  cwd: string                    // 工作目录
  tools: Tools                   // 可用工具集合
  commands: Command[]            // 可用命令
  mcpClients: MCPConnection[]    // MCP 服务器连接

  // === 权限 ===
  canUseTool: CanUseToolFn       // 权限检查函数
  // 这个函数在每次工具调用前被调用
  // 返回 { behavior: 'allow' | 'deny' | 'ask', ... }

  // === 状态 ===
  getAppState: () => AppState    // 读取全局状态
  setAppState: (fn) => void      // 更新全局状态
  initialMessages?: Message[]    // 初始消息（恢复会话时）

  // === 模型配置 ===
  userSpecifiedModel?: string    // 用户指定的模型
  fallbackModel?: string         // 降级模型
  thinkingConfig?: ThinkingConfig // 思考模式配置

  // === 预算控制 ===
  maxTurns?: number              // 最大对话轮次
  maxBudgetUsd?: number          // 最大花费（美元）
  taskBudget?: { total: number } // Token 预算

  // === 提示词 ===
  customSystemPrompt?: string    // 自定义系统提示
  appendSystemPrompt?: string    // 追加系统提示

  // === 文件缓存 ===
  readFileCache: FileStateCache  // 文件状态缓存
}
```

## 3.4 系统提示词的构成

系统提示词是 Claude 的「操作手册」，由多个部分拼接而成：

```
系统提示词 = 
  ┌─ 核心提示词 ─────────────────────────┐
  │ "你是 Claude Code，Anthropic 的 CLI..."  │
  │ 包含：身份定义、行为准则、输出规范       │
  └──────────────────────────────────────┘
  +
  ┌─ 工具描述 ───────────────────────────┐
  │ 每个工具的名称、用途、参数说明          │
  │ 由 tool.prompt() 生成                 │
  └──────────────────────────────────────┘
  +
  ┌─ 用户上下文 ─────────────────────────┐
  │ CLAUDE.md 文件内容（项目指南）          │
  │ 当前日期                              │
  └──────────────────────────────────────┘
  +
  ┌─ 系统上下文 ─────────────────────────┐
  │ Git 状态（分支、最近提交、修改文件）     │
  │ 工作目录信息                           │
  └──────────────────────────────────────┘
  +
  ┌─ 自定义提示词（可选）────────────────┐
  │ 用户通过 --system-prompt 指定         │
  │ 或 appendSystemPrompt 追加            │
  └──────────────────────────────────────┘
```

## 3.5 消息数组的结构

发送给 Claude API 的消息数组：

```typescript
const messages = [
  // 系统消息（不在数组中，通过 system 参数传）
  // system: "你是 Claude Code..."

  // 对话历史
  { role: "user", content: "帮我写一个排序函数" },
  { role: "assistant", content: [
    { type: "text", text: "我来帮你写..." },
    { type: "tool_use", id: "tool_1", name: "FileWrite", 
      input: { file_path: "sort.ts", content: "..." } }
  ]},
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tool_1", 
      content: "文件已创建" }
  ]},
  { role: "assistant", content: "排序函数已经写好了..." },

  // 新的用户消息
  { role: "user", content: "能加个单元测试吗" },
]
```

## 3.6 工具调用执行流程

```typescript
// 简化的工具执行逻辑
async function executeToolCalls(toolUseBlocks) {
  // 第一步：分类工具
  const concurrencySafe = []   // 可并行的工具
  const sequential = []         // 必须串行的工具
  
  for (const block of toolUseBlocks) {
    const tool = findTool(block.name)
    if (tool.isConcurrencySafe(block.input)) {
      concurrencySafe.push(block)
    } else {
      sequential.push(block)
    }
  }
  
  // 第二步：权限检查
  for (const block of [...concurrencySafe, ...sequential]) {
    const permission = await canUseTool(block.name, block.input)
    if (permission.behavior === 'deny') {
      results.push({ tool_use_id: block.id, content: "权限被拒绝" })
      continue
    }
    if (permission.behavior === 'ask') {
      const userDecision = await askUser(block)  // 弹出对话框
      if (!userDecision.allowed) continue
    }
  }
  
  // 第三步：执行
  // 并发安全的工具可以同时执行（如多个 Read）
  const parallelResults = await Promise.all(
    concurrencySafe.map(block => executeTool(block))
  )
  
  // 串行工具按顺序执行（如 Bash 命令）
  for (const block of sequential) {
    const result = await executeTool(block)
    results.push(result)
  }
  
  return results
}
```

**关键设计**：
- `isConcurrencySafe` 默认为 `false`（安全优先）
- 只读工具（Read, Glob, Grep）标记为并发安全
- 写入工具（Bash, Edit, Write）必须串行

## 3.7 Token 预算管理

QueryEngine 精细地管理 Token 消耗：

```typescript
// Token 跟踪
type UsageTracking = {
  inputTokens: number      // 输入 Token 数
  outputTokens: number     // 输出 Token 数
  cacheCreation: number    // 缓存创建 Token
  cacheRead: number        // 缓存读取 Token
  totalCostUsd: number     // 总花费（美元）
}

// 预算控制
if (usage.totalCostUsd > maxBudgetUsd) {
  // 超出预算，停止对话
  throw new BudgetExceededError()
}

if (usage.inputTokens > contextWindowLimit) {
  // 上下文窗口不够了，触发压缩
  await compactConversation()
}
```

## 3.8 流式响应处理

Claude API 返回的是流式响应（Server-Sent Events），QueryEngine 实时处理：

```typescript
async function* streamResponse(apiCall) {
  for await (const event of apiCall) {
    switch (event.type) {
      case 'content_block_start':
        // 新的内容块开始（text 或 tool_use）
        yield { type: 'block_start', block: event.content_block }
        break
        
      case 'content_block_delta':
        // 内容增量（文字片段）
        // 这就是你看到文字"打字机效果"的原因
        yield { type: 'text_delta', text: event.delta.text }
        break
        
      case 'content_block_stop':
        // 内容块结束
        break
        
      case 'message_stop':
        // 整个消息结束
        yield { type: 'message_complete', stop_reason: event.stop_reason }
        break
    }
  }
}
```

## 3.9 query() vs QueryEngine

两者的关系：

```
query()       = 高层封装，提供便捷的参数接口
QueryEngine   = 底层引擎，实际执行对话循环

// query() 就是包装了 QueryEngine
export async function* query(params) {
  const engine = new QueryEngine({
    cwd: params.cwd,
    tools: params.tools,
    // ... 从 params 中提取配置
  })
  
  yield* engine.submitMessage(params.prompt)
}
```

**为什么分两层？**
- `query()` 面向外部调用者（SDK、headless 模式），参数是扁平的
- `QueryEngine` 面向内部，可以多次提交消息（REPL 循环）
- 不同入口可以共享同一个 QueryEngine 实例

## 3.10 设计亮点总结

| 设计 | 好处 |
|------|------|
| AsyncGenerator (`yield*`) | 调用者可以逐步处理流式响应，不需要回调 |
| 并发工具执行 | 多个只读操作同时运行，减少等待时间 |
| Token 预算管理 | 防止意外消耗大量 API 额度 |
| 消息数组不可变复制 | 避免工具执行中的竞态条件 |
| 权限检查前置 | 在执行任何操作前确保安全 |
| 工具结果持久化 | 大结果写入磁盘，避免消息膨胀 |

## 3.11 下一章预告

QueryEngine 需要调用各种工具来完成任务。下一章我们深入 **Tool System** — 理解 Claude 的工具是如何定义、注册和执行的。

→ [第四章：工具系统](04-tool-system.md)

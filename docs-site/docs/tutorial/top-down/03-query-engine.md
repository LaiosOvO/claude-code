# 第三章：对话引擎 QueryEngine

> QueryEngine 是 ccb 的心脏。理解它，就理解了 AI Agent 的核心运作原理。

## 3.1 双层架构：query.ts + QueryEngine.ts

ccb 的对话引擎分为两层：

```
用户界面 (REPL / headless / SDK)
        │
        │  用户输入 prompt
        ▼
   ┌──────────────────┐
   │  QueryEngine.ts   │  ← src/QueryEngine.ts (1320行) — 高层编排器
   │  会话级状态管理     │     管理多次 submitMessage 调用
   │  系统提示词构建     │     维护消息历史和配置
   │  命令处理          │
   └────────┬─────────┘
            │  调用
            ▼
   ┌──────────────────┐
   │  query.ts         │  ← src/query.ts (1732行) — AsyncGenerator 主循环
   │  Agent Loop 核心   │     单次对话轮的完整循环
   │  工具执行编排       │     流式响应 + 工具调用 + 重试
   │  Token 预算管理    │
   └────────┬─────────┘
            │
       ┌────┴────┐
       ▼         ▼
   Claude API   工具执行
   (流式调用)   (58+ 工具)
```

**为什么分两层？**
- `QueryEngine` 面向调用者（REPL、SDK），管理整个会话的生命周期
- `query()` 面向单次 API 轮次，是纯函数式的 AsyncGenerator
- REPL 持有一个 QueryEngine 实例，多次调用 `submitMessage()`
- 每次 `submitMessage()` 内部调用一次 `query()` 的完整循环

## 3.2 核心循环：Agent Loop

这是所有 AI Agent 的核心模式 — **循环调用 LLM + 执行工具**。看 `query.ts` 中的 `queryLoop()` 函数：

```
开始
  │
  ▼
构建 QueryConfig（快照环境/门控状态）
  │
  ▼
初始化循环状态 State
  │
  ▼
┌─► buildQueryConfig → 计算 API 参数 ────────────┐
│   │                                              │
│   ▼                                              │
│ 调用 Claude API (流式)                           │
│   │                                              │
│   ▼                                              │
│ 流式解析响应 ← StreamingToolExecutor              │
│   │                                              │
│   ├── stop_reason = "end_turn"                   │
│   │   └── 检查 stopHooks → 对话结束              │
│   │                                              │
│   ├── stop_reason = "tool_use"                   │
│   │   │                                          │
│   │   ▼                                          │
│   │ 提取 tool_use 块                             │
│   │   │                                          │
│   │   ▼                                          │
│   │ runTools() → 权限检查 + 并行/串行执行         │
│   │   │                                          │
│   │   ▼                                          │
│   │ 收集 tool_result                              │
│   │   │                                          │
│   │   ▼                                          │
│   │ 追加到消息历史                                │
│   │   │                                          │
│   │   ▼                                          │
│   │ 检查 Token 预算/自动压缩/轮次限制            │
│   │   │                                          │
│   └───┘  continue                                │
│                                                  │
│   ├── stop_reason = "max_tokens"                 │
│   │   └── 输出长度恢复循环（最多3次）             │
│   │                                              │
│   └── API 错误                                   │
│       ├── prompt_too_long → 反应式压缩            │
│       ├── rate_limit → 重试                      │
│       └── 其他 → FallbackTriggeredError          │
│                                                  │
└──────────────────────────────────────────────────┘
```

## 3.3 QueryParams — query() 的输入

```typescript
// src/query.ts
export type QueryParams = {
  messages: Message[]               // 消息历史
  systemPrompt: SystemPrompt        // 系统提示词（已构建好的）
  userContext: { [k: string]: string }  // 用户上下文（CLAUDE.md 等）
  systemContext: { [k: string]: string } // 系统上下文（Git 状态等）
  canUseTool: CanUseToolFn          // 权限检查函数
  toolUseContext: ToolUseContext     // 工具执行上下文（cwd, tools, 状态等）
  fallbackModel?: string            // 降级模型
  querySource: QuerySource          // 来源标记（repl/sdk/print）
  maxOutputTokensOverride?: number  // 输出 token 上限
  maxTurns?: number                 // 最大对话轮次
  skipCacheWrite?: boolean          // 跳过缓存写入
  taskBudget?: { total: number }    // API 级任务预算
  deps?: QueryDeps                  // 依赖注入（测试用）
}
```

## 3.4 循环状态：State

```typescript
// 可变状态，在循环迭代间传递
type State = {
  messages: Message[]                       // 当前消息历史
  toolUseContext: ToolUseContext             // 工具上下文
  autoCompactTracking: AutoCompactTrackingState  // 自动压缩追踪
  maxOutputTokensRecoveryCount: number      // 输出恢复计数（最多3次）
  hasAttemptedReactiveCompact: boolean      // 是否已尝试反应式压缩
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<...>       // 异步的工具使用摘要
  stopHookActive: boolean | undefined       // stop hook 是否激活
  turnCount: number                         // 当前轮次
  transition: Continue | undefined          // 上一次迭代的过渡原因
}
```

## 3.5 query() 函数签名

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent        // 流式事件（text_delta, tool_use 等）
  | RequestStartEvent  // API 请求开始
  | Message            // 完整消息
  | TombstoneMessage   // 墓碑消息
  | ToolUseSummaryMessage,  // 工具使用摘要
  Terminal             // 返回值：终止状态
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 通知所有消费的命令已完成
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

**关键设计**：使用 `AsyncGenerator`（`async function*`），让调用者可以用 `for await...of` 逐步处理流式响应，不需要回调地狱。

## 3.6 QueryEngine.ts — 高层编排器

QueryEngine 是 1320 行的类，管理整个会话的生命周期：

```typescript
// 简化的 QueryEngine 核心结构
class QueryEngine {
  // === 配置 ===
  private tools: Tools
  private commands: Command[]
  private mcpClients: MCPServerConnection[]
  private canUseTool: CanUseToolFn
  private thinkingConfig: ThinkingConfig

  // === 状态 ===
  private messages: Message[]
  private getAppState: () => AppState
  private setAppState: (f: (prev: AppState) => AppState) => void
  private readFileState: FileStateCache

  // === 模型 ===
  private mainLoopModel: string
  private fallbackModel?: string

  // === 预算 ===
  private maxTurns?: number
  private maxBudgetUsd?: number
  private taskBudget?: { total: number }

  // === 提示词 ===
  private customSystemPrompt?: string
  private appendSystemPrompt?: string

  // 提交用户消息，返回 AsyncGenerator
  async *submitMessage(
    prompt: string,
    options?: SubmitOptions,
  ): AsyncGenerator<StreamEvent | Message> {
    // 1. 处理用户输入（检查 /commands、解析引用等）
    const processed = await processUserInput(prompt, ...);

    // 2. 获取系统提示词
    const systemPrompt = await fetchSystemPromptParts(...);

    // 3. 获取上下文
    const userContext = await getUserContext();
    const systemContext = await getSystemContext();

    // 4. 调用 query() 主循环
    yield* query({
      messages: this.messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: this.canUseTool,
      toolUseContext: this.buildToolUseContext(),
      ...
    });
  }
}
```

## 3.7 系统提示词的构建

系统提示词是 Claude 的「操作手册」，由 `context.ts` (189行) 和相关模块构建：

```
系统提示词 =
  ┌─ 核心提示词 ─────────────────────────────┐
  │ "你是 Claude Code，Anthropic 的 CLI..."    │
  │ 包含：身份定义、行为准则、输出规范          │
  │ 来源：src/constants/prompts.ts              │
  └───────────────────────────────────────────┘
  +
  ┌─ 工具描述 ─────────────────────────────────┐
  │ 每个工具的 prompt() 返回值                   │
  │ 58+ 工具的名称、用途、参数说明               │
  └───────────────────────────────────────────┘
  +
  ┌─ 用户上下文（getUserContext）────────────────┐
  │ CLAUDE.md 文件内容（项目指南）                │
  │ Memory 文件内容                              │
  │ 当前日期                                     │
  │ 来源：src/context.ts → getUserContext()       │
  └───────────────────────────────────────────┘
  +
  ┌─ 系统上下文（getSystemContext）──────────────┐
  │ Git 状态（分支、最近提交、修改文件）           │
  │ 默认分支、用户名                              │
  │ 来源：src/context.ts → getSystemContext()      │
  └───────────────────────────────────────────┘
  +
  ┌─ 协调器上下文（可选）───────────────────────┐
  │ coordinatorMode.ts → getCoordinatorUserContext │
  │ 协调器指令和 scratchpad 路径                   │
  └───────────────────────────────────────────┘
  +
  ┌─ 自定义提示词（可选）──────────────────────┐
  │ --system-prompt / appendSystemPrompt         │
  └───────────────────────────────────────────┘
```

### context.ts 中的 Git 状态获取

```typescript
// src/context.ts — getGitStatus() 的实际逻辑
export const getGitStatus = memoize(async () => {
  const isGit = await getIsGit()
  if (!isGit) return null

  // 5 个 git 命令并行执行
  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFileNoThrow(gitExe(), ['status', '--short']),
    execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5']),
    execFileNoThrow(gitExe(), ['config', 'user.name']),
  ])

  // 状态超过 2000 字符时截断
  const truncatedStatus = status.length > MAX_STATUS_CHARS
    ? status.substring(0, MAX_STATUS_CHARS) + '\n... (truncated)'
    : status

  return [
    `Current branch: ${branch}`,
    `Main branch: ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus}`,
    `Recent commits:\n${log}`,
  ].join('\n')
})
```

## 3.8 工具执行编排

工具执行不在 query.ts 中直接处理，而是委托给 `services/tools/` 下的专门模块：

```
query.ts
  │
  ├── StreamingToolExecutor    ← 流式工具执行器
  │   在 API 流式响应的同时就开始预执行只读工具
  │
  └── runTools()               ← src/services/tools/toolOrchestration.ts
      工具编排器：分类、权限检查、并行/串行执行
```

```typescript
// 简化的 runTools 逻辑
async function runTools(toolUseBlocks, toolUseContext, canUseTool) {
  // 第一步：分类工具
  const concurrencySafe = []   // 可并行的工具（FileRead, Glob, Grep 等）
  const sequential = []         // 必须串行的工具（Bash, FileEdit 等）

  for (const block of toolUseBlocks) {
    const tool = findToolByName(block.name)
    if (tool.isConcurrencySafe(block.input)) {
      concurrencySafe.push(block)
    } else {
      sequential.push(block)
    }
  }

  // 第二步：权限检查
  for (const block of allBlocks) {
    const permission = await canUseTool(block.name, block.input)
    if (permission.behavior === 'deny') {
      results.push({ tool_use_id: block.id, content: "权限被拒绝", is_error: true })
      continue
    }
    if (permission.behavior === 'ask') {
      // 弹出权限对话框，等待用户决定
      const userDecision = await requestPermission(block)
      if (!userDecision.allowed) continue
    }
  }

  // 第三步：并行执行安全工具
  const parallelResults = await Promise.all(
    concurrencySafe.map(block => executeTool(block))
  )

  // 第四步：串行执行不安全工具
  for (const block of sequential) {
    const result = await executeTool(block)
    results.push(result)
  }

  // 第五步：应用工具结果预算
  applyToolResultBudget(results, contentReplacementState)

  return results
}
```

## 3.9 Token 预算与自动压缩

query.ts 精细管理 Token 消耗，有三层机制：

### 层级 1：自动压缩（Auto Compact）
```typescript
// 每次 API 响应后检查
const warningState = calculateTokenWarningState(
  inputTokens,
  contextWindowLimit,
)
// soft: 接近上限，提示用户
// hard: 快要溢出，自动触发压缩
if (warningState === 'hard' && isAutoCompactEnabled()) {
  await compactConversation()
}
```

### 层级 2：反应式压缩（Reactive Compact）
```typescript
// API 返回 prompt_too_long 错误时
if (isPromptTooLongMessage(error) && !hasAttemptedReactiveCompact) {
  hasAttemptedReactiveCompact = true
  const compacted = await reactiveCompact(messages)
  // 用压缩后的消息重新发送请求
  continue
}
```

### 层级 3：输出长度恢复
```typescript
// API 返回 max_output_tokens（输出被截断）
if (stopReason === 'max_tokens') {
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    maxOutputTokensRecoveryCount++
    // 自动继续，让模型完成未完成的输出
    continue
  }
}
```

### 层级 4：Task Budget（API 级）
```typescript
// API 参数中的 task_budget
taskBudget?: { total: number }
// 跨压缩边界追踪：压缩后服务端无法看到完整历史
// 需要手动传递 remaining 告知已消耗的预算
```

## 3.10 流式响应处理

query.ts 通过 AsyncGenerator yield 出各种事件：

```typescript
// query 循环中的 yield 模式
for await (const event of apiStream) {
  switch (event.type) {
    case 'content_block_start':
      yield { type: 'block_start', block: event.content_block }
      break

    case 'content_block_delta':
      // 这就是"打字机效果"的来源
      yield { type: 'text_delta', text: event.delta.text }
      break

    case 'message_stop':
      yield { type: 'message_complete', stop_reason: event.stop_reason }
      break
  }
}

// REPL 中消费这些事件
for await (const event of queryEngine.submitMessage(prompt)) {
  if (event.type === 'text_delta') {
    appendToDisplay(event.text)  // 实时显示
  }
  if (event.type === 'assistant') {
    addToHistory(event)          // 添加到历史
  }
}
```

## 3.11 QueryEngine 与 Coordinator 模式

在 Coordinator 模式下，QueryEngine 的行为有所不同：

```
普通模式:
  用户 → QueryEngine → query() → Claude API → 工具执行 → 循环

Coordinator 模式:
  用户 → QueryEngine → query() → Claude API
                                    │
                            协调器使用 AgentTool
                                    │
                            ┌───────┴───────┐
                            ▼               ▼
                       Worker Agent 1   Worker Agent 2
                       (独立 query())   (独立 query())
                            │               │
                            ▼               ▼
                       TaskUpdate       TaskUpdate
                            │               │
                            └───────┬───────┘
                                    ▼
                            汇总结果给协调器
```

协调器相关逻辑在 `src/coordinator/coordinatorMode.ts`：
- `isCoordinatorMode()` — 检查 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量
- `getCoordinatorUserContext()` — 注入协调器专用的系统提示
- Worker Agent 使用 `ASYNC_AGENT_ALLOWED_TOOLS` 子集

## 3.12 设计亮点总结

| 设计 | 好处 |
|------|------|
| AsyncGenerator (`yield*`) | 调用者逐步处理流式响应，不需要回调 |
| StreamingToolExecutor | API 流式响应的同时预执行只读工具 |
| 并发工具执行 | 多个只读操作同时运行，减少等待时间 |
| 三层 Token 预算管理 | 自动压缩 + 反应式压缩 + 输出恢复 |
| 依赖注入 (QueryDeps) | 测试时可以替换所有外部依赖 |
| 编译时门控 (feature()) | 运行时零开销的功能开关 |
| 循环状态 State 对象 | 集中管理，避免散乱的可变变量 |

## 3.13 下一章预告

QueryEngine 需要调用各种工具来完成任务。下一章我们深入 **Tool System** — 理解 58+ 工具是如何定义、注册和执行的。

[第四章：工具系统](04-tool-system.md)

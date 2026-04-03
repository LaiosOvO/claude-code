# 阅读笔记：src/query.ts

## 文件基本信息
- **路径**: `src/query.ts`
- **行数**: 1729 行
- **角色**: 核心查询循环，负责与 Claude API 交互、处理工具调用、管理上下文压缩，是整个 agentic loop 的引擎

## 核心功能

`query.ts` 实现了 Claude Code 的"心脏"——agentic query loop。这是模型与工具之间反复交互的核心循环：

1. **发送消息到 Claude API** 并流式接收响应
2. **处理工具调用**：从响应中提取 `tool_use` 块，执行对应工具，收集结果
3. **自动压缩**：当上下文超过阈值时触发 auto-compact、reactive compact、snip compact
4. **错误恢复**：prompt-too-long 恢复、max-output-tokens 恢复、模型降级
5. **Stop hooks**：在模型停止时运行后处理钩子

## 关键代码解析

### 1. query() 入口与 queryLoop() 分离

```typescript
export async function* query(params: QueryParams): AsyncGenerator<...> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 只有正常返回时才通知命令完成
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

`query()` 是一个 AsyncGenerator（异步生成器），通过 `yield` 向外发送流式消息。它包装了 `queryLoop()`，在正常完成时通知命令生命周期。

### 2. 查询循环的状态管理

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

`State` 是循环的可变状态，每次循环迭代都会解构读取。`transition` 字段记录了上一次为什么 continue——是 reactive compact、max output tokens recovery、stop hook blocking 还是 token budget continuation。

### 3. 消息预处理管道

```typescript
// 循环体开始
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

// 1. 工具结果预算裁剪
messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)

// 2. Snip compact（如果启用）
const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
messagesForQuery = snipResult.messages

// 3. Microcompact
const microcompactResult = await deps.microcompact(messagesForQuery, ...)
messagesForQuery = microcompactResult.messages

// 4. Context collapse（如果启用）
const collapseResult = await contextCollapse.applyCollapsesIfNeeded(messagesForQuery, ...)
messagesForQuery = collapseResult.messages

// 5. Auto-compact
const { compactionResult } = await deps.autocompact(messagesForQuery, ...)
```

消息在发送到 API 前经过 5 层预处理，每层负责不同维度的上下文管理：
- **工具结果预算**：限制单个工具结果的大小
- **Snip compact**：标记式剪切
- **Microcompact**：细粒度压缩
- **Context collapse**：上下文折叠
- **Auto-compact**：自动摘要压缩

### 4. 流式 API 调用与工具执行

```typescript
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: { model: currentModel, ... },
})) {
  // 处理流式消息
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    const msgToolUseBlocks = message.message.content.filter(
      content => content.type === 'tool_use',
    )
    if (msgToolUseBlocks.length > 0) {
      toolUseBlocks.push(...msgToolUseBlocks)
      needsFollowUp = true  // 标记需要继续循环
    }

    // 流式工具执行器：边流式接收边开始执行
    if (streamingToolExecutor) {
      for (const toolBlock of msgToolUseBlocks) {
        streamingToolExecutor.addTool(toolBlock, message)
      }
    }
  }
}
```

关键设计——**流式工具执行**（`StreamingToolExecutor`）：不等模型响应完全结束，而是边接收边将工具提交给并行执行器。这样读文件、搜索等 IO 密集型工具可以和模型流式输出并行运行。

### 5. 错误恢复机制

```typescript
// Prompt-too-long 恢复链
if (isWithheld413) {
  // 第一步：尝试 context collapse drain
  if (contextCollapse) {
    const drained = contextCollapse.recoverFromOverflow(messagesForQuery, ...)
    if (drained.committed > 0) {
      state = { ...state, messages: drained.messages, transition: { reason: 'collapse_drain_retry' } }
      continue
    }
  }
  // 第二步：尝试 reactive compact
  if (reactiveCompact) {
    const compacted = await reactiveCompact.tryReactiveCompact({ ... })
    if (compacted) {
      state = { ...state, messages: buildPostCompactMessages(compacted), 
                transition: { reason: 'reactive_compact_retry' } }
      continue
    }
  }
  // 无法恢复：暴露错误
  yield lastMessage
  return { reason: 'prompt_too_long' }
}

// Max-output-tokens 恢复（最多 3 次）
if (isWithheldMaxOutputTokens(lastMessage)) {
  // 第一次：尝试升级到 64k tokens
  if (maxOutputTokensOverride === undefined) {
    state = { ...state, maxOutputTokensOverride: ESCALATED_MAX_TOKENS, ... }
    continue
  }
  // 后续：注入恢复消息让模型继续
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const recoveryMessage = createUserMessage({
      content: `Output token limit hit. Resume directly — no apology, no recap...`,
      isMeta: true,
    })
    state = { ...state, messages: [...messagesForQuery, ...assistantMessages, recoveryMessage], ... }
    continue
  }
}
```

恢复机制是分层的：
- **Prompt-too-long**：先 collapse drain，再 reactive compact，都失败则报错
- **Max-output-tokens**：先升级 token 限制（8k -> 64k），再注入恢复消息（最多 3 次）
- **模型降级**：通过 `FallbackTriggeredError` 自动切换到 fallback model

### 6. 错误消息的"扣留"机制

```typescript
// 扣留可恢复的错误消息
let withheld = false
if (contextCollapse?.isWithheldPromptTooLong(message, ...)) withheld = true
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
if (isWithheldMaxOutputTokens(message)) withheld = true

if (!withheld) {
  yield yieldMessage  // 只 yield 非扣留的消息
}
```

关键设计：**可恢复的错误消息不立即 yield 给调用方**。如果直接 yield 一个错误消息，SDK 调用方可能会终止会话。通过扣留，给恢复逻辑一个尝试修复的机会——只有恢复失败时才暴露错误。

### 7. Token Budget 自动继续

```typescript
if (feature('TOKEN_BUDGET')) {
  const decision = checkTokenBudget(budgetTracker!, ...)
  if (decision.action === 'continue') {
    incrementBudgetContinuationCount()
    state = {
      ...state,
      messages: [...messagesForQuery, ...assistantMessages,
        createUserMessage({ content: decision.nudgeMessage, isMeta: true })],
      transition: { reason: 'token_budget_continuation' },
    }
    continue
  }
}
```

当配置了 token budget 且模型还有预算时，自动注入提示消息让模型继续工作。

## 数据流

```
QueryEngine / REPL
  └─> query(params)
       └─> queryLoop(params)
            ├─ while (true) {
            │   ├─ 消息预处理：budget → snip → microcompact → collapse → autocompact
            │   ├─ API 调用：callModel() + StreamingToolExecutor
            │   ├─ 工具执行：runTools() / streamingToolExecutor.getRemainingResults()
            │   ├─ 错误恢复：PTL / max-output / model fallback
            │   ├─ Stop hooks
            │   └─ continue 或 return
            │ }
            └─> Terminal { reason: 'completed' | 'aborted' | 'prompt_too_long' | ... }
```

## 与其他模块的关系
- **上游**: `QueryEngine.ts`（SDK/headless）和 REPL（交互式）调用
- **核心依赖**:
  - `services/api/claude.ts` —— API 调用（通过 `deps.callModel`）
  - `services/tools/toolOrchestration.ts` —— 工具编排（`runTools`）
  - `services/tools/StreamingToolExecutor.ts` —— 流式工具执行器
  - `services/compact/` —— 各种压缩策略
  - `utils/messages.ts` —— 消息处理工具函数
  - `query/config.ts`、`query/deps.ts`、`query/transitions.ts` —— 查询配置与依赖注入
- **被依赖**: `QueryEngine.ts`、REPL 的 query handler

## 设计亮点与思考

1. **AsyncGenerator 流式架构**：使用 `async function*` 让调用方可以实时处理每一条消息，而非等待全部完成。这是构建流式 UI 的基础。
2. **状态机 + continue 模式**：循环状态通过 `State` 对象管理，每个恢复点通过修改 state 并 `continue` 实现。`transition` 字段记录了状态转换的原因，方便调试和测试。
3. **错误扣留机制**：可恢复的错误不立即暴露，给恢复逻辑留出空间。这是对 SDK 消费方（如 Desktop、Cowork）的友好设计。
4. **流式工具执行**：边接收模型响应边执行工具，减少了完整响应接收后才开始执行的等待时间。
5. **依赖注入**：通过 `deps` 参数注入 `callModel`、`autocompact`、`microcompact` 等核心依赖，使查询循环可测试。
6. **5 层消息预处理**：每次 API 调用前都经过完整的预处理管道，确保上下文在限制范围内。

## 要点总结

1. **Agentic loop 的核心引擎**：模型调用 -> 工具执行 -> 结果反馈 -> 继续循环
2. **流式架构**：AsyncGenerator 让每条消息都可以实时 yield 给 UI/SDK
3. **多层恢复机制**：prompt-too-long、max-output-tokens、model fallback 都有对应的恢复策略
4. **5 层消息预处理**：budget -> snip -> microcompact -> collapse -> autocompact
5. **状态机模式**：通过 `State` + `continue` + `transition` 实现清晰的状态管理

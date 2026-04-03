# 阅读笔记：src/QueryEngine.ts

## 文件基本信息
- **路径**: `src/QueryEngine.ts`
- **行数**: 1295 行
- **角色**: 查询引擎封装层，管理会话生命周期和 SDK 交互协议，是 headless/SDK 模式下的核心入口

## 核心功能

`QueryEngine` 是 `query.ts` 的上层封装，为 SDK 和 headless 模式提供了一个完整的会话管理接口。如果说 `query.ts` 是"引擎"，`QueryEngine` 就是"驾驶室"——它负责：

1. **会话生命周期管理**：一个 `QueryEngine` 实例对应一个完整的会话，跨多个 turn 保持状态
2. **用户输入处理**：将用户消息转换为内部格式，处理 slash 命令
3. **SDK 消息协议**：将内部消息格式转换为 SDK 输出格式（`SDKMessage`）
4. **权限跟踪**：记录所有权限拒绝事件
5. **会话持久化**：管理 transcript 录制和 session 存储
6. **结果聚合**：汇总 token 使用量、花费、持续时间等指标

## 关键代码解析

### 1. QueryEngine 类定义

```typescript
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

关键状态：
- `mutableMessages`：会话消息历史，跨 turn 累积
- `totalUsage`：累积的 token 使用量
- `permissionDenials`：权限拒绝记录
- `readFileState`：文件读取缓存，避免重复读取
- `discoveredSkillNames`：已发现的技能名称（遥测用）

### 2. submitMessage()——核心提交方法

```typescript
async *submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown> {
  // 清理发现缓存
  this.discoveredSkillNames.clear()
  setCwd(cwd)
  
  // 包装 canUseTool 以跟踪权限拒绝
  const wrappedCanUseTool: CanUseToolFn = async (tool, input, ...) => {
    const result = await canUseTool(tool, input, ...)
    if (result.behavior !== 'allow') {
      this.permissionDenials.push({
        tool_name: sdkCompatToolName(tool.name),
        tool_use_id: toolUseID,
        tool_input: input,
      })
    }
    return result
  }

  // 获取系统提示词
  const { defaultSystemPrompt, userContext, systemContext } = 
    await fetchSystemPromptParts({ tools, mainLoopModel, ... })
  
  // 处理用户输入（slash 命令等）
  const { messages: messagesFromUserInput, shouldQuery, allowedTools } = 
    await processUserInput({ input: prompt, ... })
  
  this.mutableMessages.push(...messagesFromUserInput)

  // 持久化用户消息
  if (persistSession) {
    await recordTranscript(messages)
  }

  // 如果不需要查询（纯 slash 命令），直接返回结果
  if (!shouldQuery) {
    yield { type: 'result', subtype: 'success', ... }
    return
  }

  // 进入查询循环
  for await (const message of query({ messages, systemPrompt, ... })) {
    // 处理每种消息类型...
  }
}
```

`submitMessage()` 也是一个 AsyncGenerator，它：
1. 处理用户输入（可能是文本或 `ContentBlockParam[]`）
2. 调用 `processUserInput` 处理 slash 命令
3. 持久化消息到 transcript
4. 调用 `query()` 进入 agentic loop
5. 将 `query()` 产出的内部消息转换为 SDK 格式并 yield

### 3. 消息类型转换（内部 -> SDK）

```typescript
for await (const message of query({ ... })) {
  switch (message.type) {
    case 'assistant':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)  // 转换为 SDK 格式
      break
    
    case 'user':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break

    case 'stream_event':
      if (message.event.type === 'message_start') {
        currentMessageUsage = updateUsage(currentMessageUsage, message.event.message.usage)
      }
      if (message.event.type === 'message_stop') {
        this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
      }
      if (includePartialMessages) {
        yield { type: 'stream_event', event: message.event, ... }
      }
      break

    case 'system':
      if (message.subtype === 'compact_boundary') {
        // 释放压缩前的消息以供 GC
        this.mutableMessages.splice(0, mutableBoundaryIdx)
        yield { type: 'system', subtype: 'compact_boundary', ... }
      }
      break

    case 'attachment':
      if (message.attachment.type === 'max_turns_reached') {
        yield { type: 'result', subtype: 'error_max_turns', ... }
        return
      }
      break
  }
}
```

关键细节：
- `stream_event` 中的 `message_start`/`message_stop` 用来追踪每个 API 请求的 token 使用量
- `compact_boundary` 消息触发时，主动释放压缩前的消息以减少内存占用
- `max_turns_reached` 信号来自 `query.ts` 的 attachment 机制

### 4. 结果输出

```typescript
// 成功结果
yield {
  type: 'result',
  subtype: 'success',
  is_error: isApiError,
  duration_ms: Date.now() - startTime,
  duration_api_ms: getTotalAPIDuration(),
  num_turns: turnCount,
  result: textResult,
  stop_reason: lastStopReason,
  session_id: getSessionId(),
  total_cost_usd: getTotalCost(),
  usage: this.totalUsage,
  modelUsage: getModelUsage(),
  permission_denials: this.permissionDenials,
  structured_output: structuredOutputFromTool,
  fast_mode_state: getFastModeState(...),
  uuid: randomUUID(),
}
```

最终 `result` 消息包含了完整的会话统计，是 SDK 消费方判断会话成功/失败的依据。

### 5. Snip 回放机制

```typescript
// setup 中注入
snipReplay?: (yieldedSystemMsg: Message, store: Message[]) => 
  { messages: Message[]; executed: boolean } | undefined

// 使用
const snipResult = this.config.snipReplay?.(message, this.mutableMessages)
if (snipResult !== undefined) {
  if (snipResult.executed) {
    this.mutableMessages.length = 0
    this.mutableMessages.push(...snipResult.messages)
  }
  break
}
```

Snip 回放通过回调注入（而非直接导入），使 feature-gated 字符串不出现在 `QueryEngine.ts` 中——这是 DCE（死代码消除）友好的设计。

### 6. ask() 便捷函数

```typescript
export async function* ask({
  commands, prompt, cwd, tools, mcpClients, ...
}: { ... }): AsyncGenerator<SDKMessage, void, unknown> {
  // 创建 QueryEngine 实例
  const engine = new QueryEngine({ ... })
  
  // 提交消息并转发所有输出
  yield* engine.submitMessage(prompt)
}
```

`ask()` 是 `QueryEngine` 的一次性使用便捷包装——创建引擎、提交一条消息、返回结果。适用于 `--print` 模式和其他一次性查询场景。

## 数据流

```
SDK / headless / --print 模式
  └─> QueryEngine.submitMessage(prompt)
       ├─ processUserInput(prompt)  (处理 slash 命令)
       ├─ recordTranscript(messages)  (持久化)
       ├─ fetchSystemPromptParts()  (系统提示词)
       └─> query({ messages, systemPrompt, ... })
            ├─ yield 内部消息 (assistant, user, system, ...)
            └─> QueryEngine 转换为 SDKMessage
                 └─> yield 给 SDK 调用方
                      └─> 最后 yield result 消息
```

## 与其他模块的关系
- **上游**:
  - `main.tsx` —— headless/print 模式通过 `ask()` 函数使用
  - SDK 入口 —— 通过 `QueryEngine` 类直接使用
- **核心依赖**:
  - `query.ts` —— 调用 `query()` 函数驱动 agentic loop
  - `utils/processUserInput/` —— 用户输入处理
  - `utils/queryContext.ts` —— 系统提示词构建
  - `utils/sessionStorage.ts` —— 会话持久化
  - `utils/messages/mappers.ts` —— 消息格式转换
- **被依赖**: SDK 层、`main.tsx` 的 print 模式

## 设计亮点与思考

1. **会话级状态管理**：一个 `QueryEngine` 实例管理一个完整会话的所有状态（消息、usage、权限拒绝），跨多个 turn 累积。
2. **消息协议转换**：内部丰富的消息类型（assistant、user、progress、attachment、stream_event、tombstone、system、tool_use_summary）被统一转换为 SDK 消费方可以理解的格式。
3. **内存管理**：在 compact boundary 时主动 `splice` 旧消息，防止长会话的内存泄漏。
4. **双层持久化**：用户消息在查询开始前持久化（防止崩溃丢失），assistant 消息 fire-and-forget（性能优先）。
5. **DCE 友好的依赖注入**：snip 回放通过回调注入，避免 feature-gated 代码泄漏到核心模块。

## 要点总结

1. **SDK/headless 模式的入口**：`QueryEngine` 是 `query.ts` 之上的会话管理层
2. **跨 turn 状态累积**：messages、usage、permission denials 在整个会话中持续累积
3. **内部消息 -> SDK 消息转换**：将复杂的内部消息协议翻译为 SDK 标准格式
4. **内存感知**：主动在 compact boundary 释放旧消息
5. **ask() 便捷函数**：一次性查询的简单包装

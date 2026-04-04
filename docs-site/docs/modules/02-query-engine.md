# 模块说明：对话引擎 (QueryEngine)

## 概述

QueryEngine 是 claude-code-best 的核心 -- AI Agent 循环。它负责将用户消息发送给 Claude API，解析响应中的工具调用，执行工具，再将结果反馈给 Claude，如此循环直到 Claude 给出最终回答。整个引擎由三层构成：`query.ts`（1865 行 AsyncGenerator 主循环）、`QueryEngine.ts`（1450 行会话编排器）、以及 `query/` 目录下的配置与策略模块。

---

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/query.ts` | AsyncGenerator 主循环，流式事件处理、工具执行、自动压缩 | 1732 |
| `src/QueryEngine.ts` | 会话管理编排器，多轮对话、消息持久化、上下文组装 | 1320 |
| `src/query/config.ts` | 查询配置（模型、Token 限制等） | 小 |
| `src/query/deps.ts` | 依赖注入容器（解耦测试） | 小 |
| `src/query/stopHooks.ts` | 停止条件钩子（预算耗尽、用户中断等） | 小 |
| `src/query/tokenBudget.ts` | Token 预算管理（精确跟踪消耗） | 小 |
| `src/query/transitions.ts` | 状态转换逻辑（Agent 循环的 FSM） | 小 |
| `src/context.ts` | 上下文提供（Git 状态、CLAUDE.md） | 190 |

---

## 架构设计

```
     用户输入 / SDK 调用 / Bridge 转发
              |
              v
     +--- QueryEngine ---+
     |                    |
     |  submitMessage()   |    <-- 交互模式：多次调用，同一实例
     |       |            |
     |       v            |
     |  +- query() -----+ |    <-- 每次调用创建 AsyncGenerator
     |  |                | |
     |  | 1. 预取上下文   | |    fetchSystemPromptParts()
     |  |    + 记忆      | |    loadMemoryPrompt()
     |  | 2. 组装系统提示 | |    prependUserContext + appendSystemContext
     |  | 3. API 请求    | |    messages.create() 流式
     |  | 4. yield 事件  | |    StreamEvent -> SDKMessage
     |  | 5. 工具执行    | |    findToolByName -> tool.call()
     |  | 6. 收集结果    | |    tool_result -> 消息数组
     |  | 7. 预算检查    | |    tokenBudget + autoCompact
     |  | 8. 循环/结束   | |    stop_reason 判断
     |  +----------------+ |
     +---------------------+
              |
              v
     yield* SDKMessage (流式输出给调用者)
```

---

## query.ts 内部机制

`query.ts` 是 1865 行的 AsyncGenerator 函数，是对话引擎的"心脏"。关键机制包括：

### 流式事件处理

API 返回的流式响应被解析为 `StreamEvent`，包括：

- `request_start` -- API 请求开始
- `content_block_start/delta/stop` -- 文本和工具调用的流式内容
- `message_stop` -- 一次 API 调用完成

### 工具调用分支

```
stop_reason === 'tool_use'
    |
    v
提取所有 ToolUseBlock
    |
    v
并发安全检查 (isConcurrencySafe)
    |
    +---> 只读 & 并发安全 --> Promise.all() 并行执行
    |
    +---> 其他 -----------> 串行执行
    |
    v
收集 tool_result，追加到消息数组
    |
    v
继续循环 --> 下一次 API 调用
```

### 自动压缩（Auto Compact）

当 Token 用量接近窗口上限时，`query.ts` 自动触发压缩：

1. `calculateTokenWarningState()` 检查是否接近预算
2. `buildPostCompactMessages()` 压缩历史消息
3. 可选启用 Reactive Compact（feature gate `REACTIVE_COMPACT`）和 Context Collapse（feature gate `CONTEXT_COLLAPSE`）

### 消息队列管理

`query.ts` 与消息队列 (`messageQueueManager`) 集成：

- 支持斜杠命令优先处理 (`getCommandsByMaxPriority`)
- 支持用户中断 (`createUserInterruptionMessage`)
- 工具执行摘要生成 (`generateToolUseSummary`)

---

## QueryEngine.ts 会话管理

`QueryEngine.ts` 是 1450 行的会话编排器，负责管理完整的对话生命周期：

### 核心职责

| 职责 | 说明 |
|------|------|
| 多轮对话管理 | 同一实例跨多次 `submitMessage()` 维护消息历史 |
| 上下文组装 | 系统提示词 + CLAUDE.md + Git 状态 + 工具描述 |
| 工具池更新 | 每轮开始时根据当前状态重新组装可用工具集 |
| 消息持久化 | 大工具结果写入磁盘，避免内存膨胀 |
| 消耗跟踪 | 精确记录 Token 消耗、API 调用时长、花费 |
| 错误重试 | `categorizeRetryableAPIError()` 分类错误并决定重试策略 |
| 文件历史 | `fileHistoryMakeSnapshot()` 在工具修改文件前保存快照 |
| 插件加载 | `loadAllPluginsCacheOnly()` 加载插件缓存 |

### 生命周期

```
new QueryEngine(config)
    |
    v
submitMessage(prompt, options)   <-- 可调用多次
    |
    v
1. processUserInput()            -- 解析用户输入（命令/文件/图片）
2. fetchSystemPromptParts()      -- 获取系统提示词片段
3. loadMemoryPrompt()            -- 加载自动记忆
4. startRelevantMemoryPrefetch() -- 预取相关记忆
5. query()                       -- 进入 Agent 循环
6. recordTranscript()            -- 记录会话转录
7. flushSessionStorage()         -- 持久化会话状态
```

---

## query/ 子模块

| 模块 | 职责 |
|------|------|
| `config.ts` | 查询配置类型定义（模型、Token 限制、思考模式等） |
| `deps.ts` | 依赖注入容器，解耦 API 调用层以便测试 |
| `stopHooks.ts` | 停止条件钩子：Token 预算耗尽、用户中断、最大轮次 |
| `tokenBudget.ts` | Token 预算管理器：计算剩余预算、判断是否需要压缩 |
| `transitions.ts` | Agent 循环的状态转换逻辑（类 FSM） |

---

## 核心类型

```typescript
// QueryEngine 需要的上下文
interface ToolUseContext {
  cwd: string
  tools: Tools
  canUseTool: CanUseToolFn
  abortController: AbortController
  fileStateCache: FileStateCache
  options: {
    maxTurns?: number
    maxBudgetUsd?: number
    thinkingConfig?: ThinkingConfig
  }
}

// query() 的 AsyncGenerator 签名
async function* query(params): AsyncGenerator<SDKMessage>

// 流式事件类型
type StreamEvent =
  | RequestStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStopEvent
```

---

## 与其他模块的关系

```
services/api/claude.ts  <---  API 调用层
       ^
       |
query.ts  <---  工具执行 (Tool.ts + tools/)
       ^
       |
QueryEngine.ts  <---  上下文 (context.ts + constants/prompts.ts)
       ^
       |
main.tsx / bridge / daemon  <---  调用方
```

---

## 设计模式

- **AsyncGenerator**：`yield*` 让调用者控制消费节奏，天然支持流式 UI 渲染和 SDK 事件推送
- **并发工具执行**：只读且标记为 `isConcurrencySafe` 的工具（Read、Glob、Grep）可以并行执行
- **Token 预算管理**：精确跟踪输入/输出 Token 消耗，接近上限时自动压缩历史
- **消息持久化**：大工具结果通过 `toolResultStorage` 写入磁盘，消息数组中只保留引用
- **Fallback 重试**：`FallbackTriggeredError` 支持在主模型不可用时切换到备选模型
- **Feature Gate 策略**：Reactive Compact、Context Collapse、Skill Search 等高级功能通过 feature gate 控制，构建时 DCE

---

## 常见问题

**Q: query() 和 QueryEngine 为什么分开？**
A: `query()` 是一次性调用的 AsyncGenerator 便捷接口（SDK / headless / Bridge 用）；`QueryEngine` 支持多次 `submitMessage()`（REPL 交互用），同一个引擎实例在整个会话中复用，管理跨轮次的消息历史和状态。

**Q: 工具调用失败怎么办？**
A: 工具执行失败会返回错误信息作为 `tool_result`，Claude 收到后可以选择重试、换方法、或告知用户。错误不会中断 Agent 循环。

**Q: 自动压缩什么时候触发？**
A: 当 `calculateTokenWarningState()` 检测到 Token 消耗接近模型上下文窗口时自动触发。压缩策略是将旧消息摘要化，保留最近的完整消息。

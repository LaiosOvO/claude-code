# 模块说明：对话引擎 (QueryEngine)

## 概述

QueryEngine 是 Claude Code 的核心 — AI Agent 循环。它负责将用户消息发送给 Claude API，解析响应中的工具调用，执行工具，再将结果反馈给 Claude，如此循环直到 Claude 给出最终回答。

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/QueryEngine.ts` | 核心引擎类，管理会话生命周期 | ~1295 |
| `src/query.ts` | 高层查询接口，AsyncGenerator 包装 | ~1729 |
| `src/context.ts` | 上下文提供（Git 状态、CLAUDE.md） | ~190 |

## 架构设计

```
           ┌─────────────────────────────┐
           │         query()             │ ← 高层接口
           │  创建 QueryEngine 实例       │
           └──────────┬──────────────────┘
                      │
           ┌──────────▼──────────────────┐
           │      QueryEngine            │
           │                             │
           │  ┌─── submitMessage() ───┐  │
           │  │                       │  │
           │  │  1. 组装系统提示词     │  │
           │  │  2. 构建消息数组      │  │
           │  │  3. 调用 Claude API   │  │
           │  │  4. 解析工具调用      │  │
           │  │  5. 执行工具          │  │
           │  │  6. 收集结果          │  │
           │  │  7. 循环或结束        │  │
           │  │                       │  │
           │  └───────────────────────┘  │
           └─────────────────────────────┘
```

## 核心类型

```typescript
// 引擎配置
type QueryEngineConfig = {
  cwd: string              // 工作目录
  tools: Tools             // 可用工具集
  canUseTool: Function     // 权限检查函数
  maxTurns?: number        // 最大对话轮次
  maxBudgetUsd?: number    // 花费上限
  thinkingConfig?: {}      // 思考模式配置
}

// AsyncGenerator 模式 — 调用者逐步消费响应
async function* query(params): AsyncGenerator<SDKMessage>
```

## 关键流程

1. 用户发送 prompt
2. `query()` 创建 `QueryEngine` 实例
3. `submitMessage(prompt)` 进入 Agent 循环
4. 组装系统提示词（核心提示 + 工具描述 + CLAUDE.md + Git 状态）
5. 调用 `messages.create()` 流式请求
6. 解析流式响应中的 `content_block`
7. 如果 `stop_reason === 'tool_use'` → 提取工具调用，执行，收集结果，继续循环
8. 如果 `stop_reason === 'end_turn'` → 结束，yield 最终消息
9. Token 预算检查（超出则压缩或停止）

## 设计模式

- **AsyncGenerator**：`yield*` 让调用者控制消费节奏，天然支持流式
- **并发工具执行**：只读工具（Read、Glob、Grep）可以并行
- **Token 预算管理**：精确跟踪消耗，防止超支
- **消息持久化**：大工具结果写入磁盘，避免内存膨胀

## 常见问题

**Q: query() 和 QueryEngine 为什么分开？**
A: `query()` 是一次性调用的便捷接口（SDK/headless 用）；`QueryEngine` 支持多次 `submitMessage()`（REPL 交互用），同一个引擎实例在整个会话中复用。

**Q: 工具调用失败怎么办？**
A: 工具执行失败会返回错误信息作为 `tool_result`，Claude 收到后可以选择重试、换方法、或告知用户。

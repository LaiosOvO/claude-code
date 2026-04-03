# 第一章：基础原语 — 从最小单元开始

> 自底向上，从最基础的工具函数和设计模式开始，逐步构建对整个系统的理解。

## 1.1 为什么要自底向上？

自顶向下让你看到全貌，自底向上让你**理解每块砖是怎么砌的**。当你理解了基础原语，再看上层代码时，一切都变得清晰。

## 1.2 Signal：最小的事件系统

**文件**: `src/utils/signal.ts` (~44行)

这是整个项目中最小但最重要的原语之一：

```typescript
// 一个极简的事件发射器
// 没有存储状态，只负责通知
export class Signal<Args extends any[] = []> {
  private listeners = new Set<(...args: Args) => void>()

  // 订阅事件
  subscribe(fn: (...args: Args) => void): () => void {
    this.listeners.add(fn)
    // 返回取消订阅函数
    return () => this.listeners.delete(fn)
  }

  // 触发事件
  emit(...args: Args): void {
    for (const fn of this.listeners) {
      fn(...args)
    }
  }

  // 清除所有监听器
  clear(): void {
    this.listeners.clear()
  }
}
```

**使用场景**：
```typescript
// 在邮箱中通知新消息到达
const onNewMessage = new Signal<[InboxMessage]>()

// 订阅
const unsubscribe = onNewMessage.subscribe((msg) => {
  console.log('新消息:', msg.text)
})

// 触发
onNewMessage.emit({ text: 'hello' })

// 取消订阅
unsubscribe()
```

**设计亮点**：
- 用 `Set` 而非数组，避免重复订阅
- 返回取消函数，符合 React useEffect 清理模式
- 泛型参数确保类型安全
- 整个项目用了 15+ 次

## 1.3 Mailbox：内存消息队列

**文件**: `src/utils/mailbox.ts` (~74行)

```typescript
// 进程内的消息队列
// 用于 React 组件之间的异步通信
export class Mailbox<T> {
  private queue: T[] = []
  private signal = new Signal<[T]>()

  // 发送消息（入队）
  send(message: T): void {
    this.queue.push(message)
    this.signal.emit(message)
  }

  // 接收消息（出队）
  receive(): T | undefined {
    return this.queue.shift()
  }

  // 轮询所有消息
  poll(): T[] {
    const messages = [...this.queue]
    this.queue = []
    return messages
  }

  // 订阅新消息通知
  subscribe(fn: (msg: T) => void): () => void {
    return this.signal.subscribe(fn)
  }
}
```

**关系图**：
```
Signal (事件通知)
  │
  └──► Mailbox (消息队列)
         │
         └──► React Context (全局可用)
                │
                └──► useMailboxBridge hook (桥接到 UI)
```

## 1.4 LRU Cache：有限容量缓存

项目使用 `lru-cache` 库实现有限容量缓存，这在文件读取、Token 计算等场景大量使用：

```typescript
import { LRUCache } from 'lru-cache'

// 文件内容缓存：最多缓存 100 个文件
const fileCache = new LRUCache<string, string>({
  max: 100,           // 最大条目数
  maxSize: 25_000_000, // 最大总大小 (25MB)
  sizeCalculation: (value) => Buffer.byteLength(value),
})

// 使用
fileCache.set('/path/to/file', fileContent)
const cached = fileCache.get('/path/to/file')
```

## 1.5 BoundedUUIDSet：有界去重集合

**文件**: `src/bridge/bridgeMessaging.ts` 中的实现

这是一个精巧的数据结构，用于消息去重：

```typescript
// 环形缓冲区实现的有界集合
// 用于去重 WebSocket 消息回声
class BoundedUUIDSet {
  private buffer: string[]
  private index = 0
  private set = new Set<string>()

  constructor(private capacity: number) {
    this.buffer = new Array(capacity).fill('')
  }

  add(uuid: string): void {
    // 如果缓冲区已满，移除最老的元素
    const old = this.buffer[this.index]
    if (old) this.set.delete(old)
    
    // 添加新元素
    this.buffer[this.index] = uuid
    this.set.add(uuid)
    this.index = (this.index + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }
}
```

**为什么不直接用 Set？**
- 普通 Set 会无限增长，内存泄漏
- 环形缓冲区保证 O(1) 内存，最多存 capacity 个元素
- 查找仍是 O(1)（底层用 Set）

## 1.6 Memoize：记忆化

项目大量使用 lodash 的 `memoize` 来缓存昂贵的计算：

```typescript
import { memoize } from 'lodash-es'

// 只在第一次调用时执行，后续返回缓存值
export const getGitStatus = memoize(async () => {
  // 这个函数只会执行一次
  const branch = await exec('git branch --show-current')
  const log = await exec('git log --oneline -5')
  const status = await exec('git status --short')
  return { branch, log, status }
})

// 清除缓存（当需要刷新时）
getGitStatus.cache.clear()
```

## 1.7 Zod Schema：类型验证

项目使用 Zod 做运行时类型验证，特别是在工具输入和 API 响应：

```typescript
import { z } from 'zod'

// 定义 Schema
const BashInputSchema = z.strictObject({
  command: z.string().describe('要执行的命令'),
  timeout: z.number().optional().describe('超时时间(ms)'),
  description: z.string().describe('命令描述'),
})

// 验证输入
const result = BashInputSchema.safeParse(rawInput)
if (!result.success) {
  return { error: result.error.message }
}
const validInput = result.data // 类型安全！

// Schema 同时用于：
// 1. 运行时验证
// 2. TypeScript 类型推导
// 3. 生成 JSON Schema（给 Claude API）
// 4. 生成描述文档
```

## 1.8 AsyncGenerator：异步生成器

这是 QueryEngine 和 SDK 的核心模式：

```typescript
// 异步生成器 = 可以暂停和恢复的异步函数
async function* query(prompt: string) {
  // 第一阶段：发送请求
  yield { type: 'sending', prompt }
  
  // 第二阶段：流式响应
  const stream = await callAPI(prompt)
  for await (const chunk of stream) {
    yield { type: 'chunk', text: chunk }
  }
  
  // 第三阶段：工具调用
  for (const toolCall of extractToolCalls(response)) {
    yield { type: 'tool_start', tool: toolCall }
    const result = await executeTool(toolCall)
    yield { type: 'tool_result', result }
  }
}

// 调用者可以逐步消费
for await (const event of query('hello')) {
  switch (event.type) {
    case 'chunk': updateUI(event.text); break
    case 'tool_start': showSpinner(event.tool); break
    case 'tool_result': showResult(event.result); break
  }
}
```

**为什么用 AsyncGenerator 而不是 Callback？**
- 调用者控制消费节奏（背压）
- 可以用 `for await` 循环，代码清晰
- 支持 `yield*` 委托，可组合
- 自动处理错误传播

## 1.9 React + Ink：终端中的 React

Ink 是让 React 在终端中运行的框架：

```tsx
import React from 'react'
import { Text, Box } from '../ink/components'

// 用 React 组件描述终端 UI！
function StatusBar({ model, tokens, cost }) {
  return (
    <Box borderStyle="single" padding={1}>
      <Text color="cyan">模型: {model}</Text>
      <Text color="yellow">Token: {tokens}</Text>
      <Text color="green">花费: ${cost}</Text>
    </Box>
  )
}

// 渲染到终端（不是浏览器 DOM！）
// Ink 把 React 组件树转换为终端 ANSI 转义序列
```

**核心原理**：
```
React 组件树
    │
    ▼ (React Reconciler)
    │
Ink DOM 节点
    │
    ▼ (Yoga Layout)
    │
终端坐标计算
    │
    ▼ (ANSI 转义序列)
    │
终端显示
```

## 1.10 本章总结

这些基础原语是整个系统的砖块：

| 原语 | 用途 | 用到的地方 |
|------|------|-----------|
| Signal | 事件通知 | 邮箱、调度器、传输层 |
| Mailbox | 消息队列 | 组件通信、桥接 |
| BoundedUUIDSet | 去重 | WebSocket 消息去重 |
| Memoize | 计算缓存 | 上下文、Git 状态 |
| Zod | 类型验证 | 工具输入、API 响应 |
| AsyncGenerator | 流式处理 | 对话循环、SDK 接口 |
| React + Ink | 终端 UI | 所有界面组件 |

下一章我们向上一层，看这些原语如何组合成 **核心抽象层**。

→ [第二章：核心抽象 — Tool、Command、Skill](02-core-abstractions.md)

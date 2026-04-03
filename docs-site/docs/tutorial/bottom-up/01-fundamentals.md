# 第一章：基础原语 -- 从最小单元开始

> 自底向上，从最基础的工具函数和设计模式开始，逐步构建对整个系统的理解。

## 1.1 为什么要自底向上？

自顶向下让你看到全貌，自底向上让你**理解每块砖是怎么砌的**。当你理解了基础原语，再看上层代码时，一切都变得清晰。

claude-code-best (`ccb`) 是一个运行在 Bun 之上的终端 AI Agent，由 500+ 源文件、58+ 工具组成。理解它的第一步是理解这些最小构建单元。

## 1.2 createSignal：最小的事件系统

**文件**: `src/utils/signal.ts` (43行)

这是整个项目中最小但最重要的原语之一。注意它是工厂函数而非 class：

```typescript
// src/utils/signal.ts — 纯事件信号原语（无状态存储）
// 将 ~15 处重复的 listeners + subscribe + notify 样板收敛为一行

export type Signal<Args extends unknown[] = []> = {
  /** 订阅监听器。返回取消订阅函数。 */
  subscribe: (listener: (...args: Args) => void) => () => void
  /** 调用所有已订阅的监听器。 */
  emit: (...args: Args) => void
  /** 移除所有监听器。用于 dispose/reset 路径。 */
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
```

**设计亮点**：

- 工厂函数模式，返回普通对象而非 class 实例 -- 更轻量，方便解构导出
- 用 `Set` 而非数组，避免重复订阅
- 返回取消函数，符合 React useEffect 清理模式
- 泛型参数 `Args` 确保类型安全
- 与 AppState store 的区别：Signal 只负责通知 "something happened"，无 getState/snapshot

**使用场景**：
```typescript
// 在 context.ts 中通知系统上下文变化
const changed = createSignal<[SettingSource]>()
export const subscribe = changed.subscribe
// 后续: changed.emit('userSettings')

// 在 Mailbox 中驱动消息通知
private changed = createSignal()
```

## 1.3 Mailbox：进程内消息队列

**文件**: `src/utils/mailbox.ts` (74行)

Mailbox 组合了 Signal 和队列，实现进程内异步消息传递：

```typescript
// src/utils/mailbox.ts — 进程内消息队列
import { createSignal } from './signal.js'

export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

export type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}

type Waiter = {
  fn: (msg: Message) => boolean
  resolve: (msg: Message) => void
}

export class Mailbox {
  private queue: Message[] = []
  private waiters: Waiter[] = []
  private changed = createSignal()
  private _revision = 0

  // 发送消息：优先匹配等待者，否则入队
  send(msg: Message): void {
    this._revision++
    const idx = this.waiters.findIndex(w => w.fn(msg))
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0]
      if (waiter) { waiter.resolve(msg); this.notify(); return }
    }
    this.queue.push(msg)
    this.notify()
  }

  // 同步轮询：按条件取出一条消息
  poll(fn: (msg: Message) => boolean = () => true): Message | undefined {
    const idx = this.queue.findIndex(fn)
    if (idx === -1) return undefined
    return this.queue.splice(idx, 1)[0]
  }

  // 异步接收：有消息立即返回，否则注册等待
  receive(fn: (msg: Message) => boolean = () => true): Promise<Message> {
    const idx = this.queue.findIndex(fn)
    if (idx !== -1) { /* 已有匹配消息 */ }
    return new Promise<Message>(resolve => {
      this.waiters.push({ fn, resolve })
    })
  }

  subscribe = this.changed.subscribe
}
```

**关键设计**：Waiter 模式

Mailbox 不是简单的 push/shift 队列。它有两种消费模式：

1. **poll()** — 同步尝试取一条，适合轮询场景
2. **receive()** — 异步等待匹配消息到达，用 Promise + Waiter 实现

当 `send()` 时先检查有没有等待者在等这条消息，有则直接 resolve（零延迟），无则入队。这避免了"消息先到但消费者还没注册"和"消费者先注册但消息还没来"两种竞态。

**关系图**：
```
createSignal (事件通知)
  |
  +--> Mailbox (消息队列 + 等待者匹配)
         |
         +--> MailboxProvider (React Context)
                |
                +--> useInboxPoller hook (桥接到 UI)
                +--> coordinator/workerAgent (协调器通信)
```

## 1.4 BoundedUUIDSet：有界去重集合

**文件**: `src/bridge/bridgeMessaging.ts` (第430行)

这是一个精巧的数据结构，用于 WebSocket 消息去重：

```typescript
// 环形缓冲区实现的有界集合
export class BoundedUUIDSet {
  private readonly capacity: number
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Array<string | undefined>(capacity)
  }

  add(uuid: string): void {
    if (this.set.has(uuid)) return
    // 驱逐当前写位置的旧条目
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) {
      this.set.delete(evicted)
    }
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }
}
```

**为什么不直接用 Set？**

- 普通 Set 会无限增长，造成内存泄漏
- 环形缓冲区保证 O(1) 内存，最多存 capacity 个元素
- 查找仍是 O(1)（底层用 Set 加速）
- 在 Bridge 场景中用于过滤 WebSocket 消息回声

## 1.5 Memoize：记忆化与缓存清除

项目大量使用 lodash-es 的 `memoize` 来缓存昂贵的计算：

```typescript
// src/context.ts — 真实代码
import memoize from 'lodash-es/memoize.js'

export const getGitStatus = memoize(async (): Promise<string | null> => {
  const isGit = await getIsGit()
  if (!isGit) return null

  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], ...)
      .then(({ stdout }) => stdout.trim()),
    execFileNoThrow(gitExe(), ['--no-optional-locks', 'log', '--oneline', '-n', '5'], ...)
      .then(({ stdout }) => stdout.trim()),
    execFileNoThrow(gitExe(), ['config', 'user.name'], ...)
      .then(({ stdout }) => stdout.trim()),
  ])
  // ... 拼装 git 状态文本
})

// 当系统提示词注入变化时，清除缓存
export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}
```

**要点**：memoize 只在第一次调用时执行，后续返回缓存值。当需要刷新时显式 `.cache.clear()`。

## 1.6 Zod Schema：运行时类型验证

项目使用 `zod/v4` 做运行时类型验证，特别是在工具输入和 API 响应：

```typescript
import { z } from 'zod/v4'

// BashTool 的输入 Schema（简化示意）
const BashInputSchema = z.strictObject({
  command: z.string().describe('要执行的命令'),
  timeout: z.number().optional().describe('超时时间(ms)'),
  description: z.string().describe('命令描述'),
})

// Schema 同时用于：
// 1. 运行时验证 — safeParse(rawInput)
// 2. TypeScript 类型推导 — z.infer<typeof BashInputSchema>
// 3. 生成 JSON Schema（给 Claude API 的 tools 参数）
// 4. 生成参数描述文档
```

**为什么是 `z.strictObject` 而非 `z.object`？**

strictObject 会拒绝未声明的字段。当 Claude API 返回意外字段时，严格模式能及时报错。

## 1.7 AsyncGenerator：异步生成器

这是 `query.ts` (1732行) 和 QueryEngine 的核心模式：

```typescript
// src/query.ts 的核心签名
async function* query(prompt: string): AsyncGenerator<StreamEvent> {
  // 第一阶段：发送请求
  yield { type: 'request_start', ... }

  // 第二阶段：流式响应
  const stream = await callAPI(prompt)
  for await (const chunk of stream) {
    yield { type: 'content_block_delta', text: chunk }
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
    case 'content_block_delta': updateUI(event.text); break
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
- 原生 JavaScript 语法，无需 RxJS 等外部库

## 1.8 feature() 宏：编译时特性开关

这是 ccb 独有的原语，由 Bun bundler 在构建时求值：

```typescript
import { feature } from 'bun:bundle'

// 构建时求值为 true/false
// 结合死代码消除（DCE），未启用的特性代码完全不会进入 dist/
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null

const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
  : null
```

**工作原理**：

```
源码:  feature('KAIROS')
           |
           v  (bun run build.ts 时)
构建配置:  FEATURE_KAIROS=true → feature('KAIROS') 被替换为 true
           FEATURE_KAIROS 未设置 → 被替换为 false
           |
           v  (Bun DCE)
最终:  false 分支的代码被完全移除
```

这让 ccb 可以为不同用户类型（ant 内部 vs 外部）构建不同的二进制包，只包含需要的功能。

## 1.9 React + Ink：终端中的 React

Ink 是让 React 在终端中运行的框架：

```tsx
import React from 'react'
import { Text, Box } from '../ink/components'

// 用 React 组件描述终端 UI
function StatusBar({ model, tokens, cost }) {
  return (
    <Box borderStyle="single" padding={1}>
      <Text color="cyan">模型: {model}</Text>
      <Text color="yellow">Token: {tokens}</Text>
      <Text color="green">花费: ${cost}</Text>
    </Box>
  )
}
```

**核心原理**：
```
React 组件树
    |
    v  (React Reconciler)
Ink DOM 节点
    |
    v  (Yoga Layout)
终端坐标计算
    |
    v  (ANSI 转义序列)
终端显示
```

ccb 用 React Compiler (`react/compiler-runtime`) 进一步优化渲染性能。看 `src/state/AppState.tsx` 的开头：

```typescript
import { c as _c } from "react/compiler-runtime";
```

## 1.10 本章总结

这些基础原语是整个系统的砖块：

| 原语 | 文件 | 用途 | 用到的地方 |
|------|------|------|-----------|
| createSignal | `src/utils/signal.ts` | 事件通知 | Mailbox、设置变更、传输层 |
| Mailbox | `src/utils/mailbox.ts` | 消息队列 | 组件通信、协调器、Bridge |
| BoundedUUIDSet | `src/bridge/bridgeMessaging.ts` | 去重 | WebSocket 消息回声过滤 |
| memoize | lodash-es | 计算缓存 | getGitStatus、context.ts |
| Zod v4 | `zod/v4` | 类型验证 | 工具输入、API 响应 |
| AsyncGenerator | 原生 | 流式处理 | query.ts、QueryEngine |
| feature() | `bun:bundle` | 编译时特性开关 | tools.ts、commands.ts 等 |
| React + Ink | `react/compiler-runtime` | 终端 UI | 所有界面组件 |

下一章我们向上一层，看这些原语如何组合成 **核心抽象层**。

-> [第二章：核心抽象 -- Tool、Command、Skill](02-core-abstractions.md)

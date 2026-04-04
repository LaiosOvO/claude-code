# context 目录阅读笔记

## 文件列表

```
src/context/
├── fpsMetrics.tsx          # FPS 性能指标上下文
├── mailbox.tsx             # 消息邮箱上下文
├── modalContext.tsx         # 模态弹窗上下文
├── notifications.tsx        # 通知队列系统
├── overlayContext.tsx        # 覆盖层（Overlay）注册
├── promptOverlayContext.tsx  # 提示浮层上下文
├── QueuedMessageContext.tsx  # 排队消息上下文
├── stats.tsx                # 统计指标收集
├── voice.tsx                # 语音状态上下文
└── src/                     # 子目录（state）
```

## 核心功能

context 目录是 React UI 层的**全局状态分发中心**，使用 Context + Provider 模式为 Ink TUI 提供跨组件状态共享。每个文件独立管理一个关注点。

关键上下文：
- **notifications**：带优先级的通知队列，支持 fold 合并、invalidates 失效、immediate 插队
- **overlayContext**：Escape 键协调——追踪活跃覆盖层，防止误取消运行中请求
- **stats**：Reservoir Sampling 直方图统计（p50/p95/p99），进程退出时持久化
- **voice**：语音状态机（idle/recording/processing），基于 `useSyncExternalStore`

## 关键代码片段

通知系统的优先级调度：

```typescript
const PRIORITIES: Record<Priority, number> = { immediate: 0, high: 1, medium: 2, low: 3 }
export function getNext(queue: Notification[]): Notification | undefined {
  return queue.reduce((min, n) =>
    PRIORITIES[n.priority] < PRIORITIES[min.priority] ? n : min)
}
```

stats 模块的 Reservoir Sampling（Algorithm R）：

```typescript
if (h.reservoir.length < RESERVOIR_SIZE) {
  h.reservoir.push(value)
} else {
  const j = Math.floor(Math.random() * h.count)
  if (j < RESERVOIR_SIZE) h.reservoir[j] = value
}
```

## 设计亮点

1. **React Compiler 优化**：所有文件使用 `_c()` 编译器运行时进行细粒度 memo 缓存
2. **writer/reader 分离**：`promptOverlayContext` 将 data 和 setter 拆为独立 Context，写者不因自身写入而重渲染
3. **fold 合并**：通知支持 `Array.reduce` 风格的同 key 合并，避免重复消息堆积
4. **Modal 感知**：`useModalOrTerminalSize` 让组件自适应 modal 内的受限空间
5. **NON_MODAL_OVERLAYS**：autocomplete 等非模态覆盖层不禁用 TextInput 焦点，允许边打字边补全
6. **进程退出持久化**：stats 模块在 `process.on('exit')` 时将指标写入 `lastSessionMetrics`
7. **Mailbox 单例**：每个 Provider 只创建一��� Mailbox 实例，通过 React Compiler 的 memo sentinel 保证

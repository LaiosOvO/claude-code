# state 模块阅读笔记

> 源码路径：`src/state/`
> 文件数量：9 个（含 `__tests__/` 和 `src/`）

## 概述

`state/` 模块实现了 Claude Code 的 **应用级状态管理**。它不依赖 Redux 或 Zustand 等第三方库，而是自研了一个极简的 `Store<T>` 泛型容器，配合 React Context 和 `useSyncExternalStore` 实现响应式 UI 更新。

## 文件列表

| 文件 | 行数(约) | 职责 |
|---|---|---|
| `store.ts` | 35 | 泛型 Store 实现（getState / setState / subscribe） |
| `AppStateStore.ts` | 200+ | AppState 类型定义、默认值工厂 `getDefaultAppState()` |
| `AppState.tsx` | 120+ | `AppStateProvider` React 组件、`AppStoreContext` |
| `onChangeAppState.ts` | 80+ | 状态变更副作用（同步权限模式、模型覆盖等） |
| `selectors.ts` | 80+ | 纯函数选择器（getViewedTeammateTask 等） |
| `teammateViewHelpers.ts` | — | 团队视图辅助函数 |

## 核心类型

### `Store<T>`（store.ts）

```typescript
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

- 闭包实现，零依赖
- `setState` 使用 `Object.is` 浅比较避免无意义更新
- `onChange` 回调用于触发副作用（如通知 CCR 权限模式变更）

### `AppState`（AppStateStore.ts）

应用全局状态的超级对象，包含：

- `messages: Message[]` — 对话消息列表
- `toolPermissionContext` — 工具权限上下文
- `tasks: Record<string, TaskState>` — 后台任务
- `speculation` — 推测执行状态
- `isUltraplanMode` — 计划模式标志
- `viewingAgentTaskId` — 当前查看的 agent
- `mcpServers` — MCP 服务器连接
- `todos` — Todo 列表
- `notifications` — 通知队列

## 关键函数

| 函数 | 位置 | 说明 |
|---|---|---|
| `createStore()` | store.ts | 创建泛型状态容器 |
| `getDefaultAppState()` | AppStateStore.ts | 构建初始状态 |
| `AppStateProvider` | AppState.tsx | React Context Provider |
| `onChangeAppState()` | onChangeAppState.ts | 状态变更时的副作用处理 |
| `getViewedTeammateTask()` | selectors.ts | 获取当前查看的队友任务 |
| `getActiveAgentForInput()` | selectors.ts | 决定用户输入路由到哪个 agent |

### `SpeculationState`（AppStateStore.ts）

推测执行状态，用于预加载 AI 响应：

```typescript
type SpeculationState =
  | { status: 'idle' }
  | { status: 'active'; id: string; abort: () => void; ... }
```

### `CompletionBoundary`（AppStateStore.ts）

标记推测执行的完成边界，支持四种类型：

- `complete` — 正常完成（含 outputTokens）
- `bash` — Bash 命令完成
- `edit` — 文件编辑完成
- `denied_tool` — 工具被拒绝

## 设计亮点

1. **自研极简 Store** — 仅 35 行代码，避免引入 Redux/Zustand 等重量级依赖
2. **onChange 副作用隔离** — 状态变更的副作用（CCR 同步、模型切换）集中在 `onChangeAppState.ts`，不散落在 UI 组件中
3. **嵌套防护** — `AppStateProvider` 内部检查 `HasAppStateContext`，防止重复嵌套
4. **纯函数选择器** — selectors.ts 中的选择器是纯数据提取，无副作用
5. **推测执行** — SpeculationState 支持在用户输入前预测性地执行 AI 请求

## 与其他模块的关系

- **components/** — 通过 `AppStoreContext` 消费状态
- **bootstrap/** — `bootstrap/state.ts` 管理进程级全局单例，与本模块的 React 状态互补
- **bridge/** — `onChangeAppState` 将权限模式变更同步到远程控制
- **tasks/** — `AppState.tasks` 存储所有任务的状态快照

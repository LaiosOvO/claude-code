# 模块说明：状���管理 (State)

## 概述

Claude Code 使用类 Zustand 的状态管理方案，通过一个中央 AppState 存储驱动整个 UI 和业务逻辑。状态更新是不可变的（immutable），通过 React Context 传播到组件树。

## 核心文件

| 文件 | 作用 |
|------|------|
| `src/state/AppStateStore.ts` | AppState 类型定义 (~569行) |
| `src/state/AppState.tsx` | React Provider 包装 |
| `src/state/store.ts` | Store 实现（类 Zustand） |
| `src/state/selectors.ts` | 记忆化选择器 |
| `src/state/onChangeAppState.ts` | 状态变更副作用 |

## AppState 核心字段

```typescript
type AppState = {
  // 配置
  settings: SettingsJson         // 用户设置
  mainLoopModel: ModelSetting    // 当前模型
  toolPermissionContext: ...     // 权限规则

  // UI 状态
  spinnerTip?: string            // 加载提示
  expandedView: 'none' | 'tasks' | 'teammates'
  footerSelection: 'tasks' | 'bridge' | null

  // 远程状态
  replBridgeEnabled: boolean
  replBridgeConnected: boolean
  remoteConnectionStatus: 'connecting' | 'connected' | ...

  // 功能开关
  kairosEnabled: boolean
  verbose: boolean
}
```

## 状态更新模式

```typescript
// 不可变更新（创建新对象，不修改原对象）
setState(prev => ({
  ...prev,
  spinnerTip: '正在执行...',
  tasks: new Map(prev.tasks).set(id, newTask),
}))
```

## 设计模式

- **不可变状态**：每次更新都创建新对象，便于 React 检测变化
- **选择器记忆化**：使用 selectors 避免不必要的重渲染
- **副作用隔离**：状态变更的副作用集中在 `onChangeAppState` 中处理

# 模块说明：状态管理 (State)

## 概述

claude-code-best 使用类 Zustand 的状态管理方案，通过一个中央 `AppState` 存储驱动整个 UI 和业务逻辑。状态更新是不可变的（immutable），通过 React Context 传播到组件树。`AppStateStore.ts` 定义了 569 行的超大状态类型，覆盖了从 UI 交互到远程桥接、从插件系统到 Companion 小宠物的所有状态。

---

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/state/AppStateStore.ts` | AppState 类型定义 + 初始状态 | 569 |
| `src/state/AppState.tsx` | React Context Provider 包装 | 199 |
| `src/state/store.ts` | Store 实现（类 Zustand 的轻量状态容器） | 34 |
| `src/state/selectors.ts` | 记忆化选择器（避免不必要重渲染） | 中 |
| `src/state/onChangeAppState.ts` | 状态变更副作用处理 | 中 |
| `src/state/teammateViewHelpers.ts` | 队友视图辅助函数 | 小 |

---

## AppState 类型结构

AppState 使用 `DeepImmutable<{...}>` 包装，确保类型层面的不可变性。整体分为以下几大区域：

### 配置与模型

```typescript
type AppState = DeepImmutable<{
  settings: SettingsJson           // 用户设置
  verbose: boolean                 // 详细输出模式
  mainLoopModel: ModelSetting      // 当前主循环模型
  mainLoopModelForSession: ModelSetting  // 会话级模型覆盖
  toolPermissionContext: ToolPermissionContext  // 权限规则
  agent: string | undefined        // --agent CLI 标志指定的 Agent 名
}>
```

### UI 交互状态

```typescript
{
  statusLineText: string | undefined     // 状态行文本
  spinnerTip?: string                    // 加载提示
  expandedView: 'none' | 'tasks' | 'teammates'  // 展开面板
  isBriefOnly: boolean                   // 简洁模式
  selectedIPAgentIndex: number           // Agent 选择索引
  coordinatorTaskIndex: number           // Coordinator 面板选择
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  footerSelection: FooterItem | null     // Footer 焦点项
  // FooterItem = 'tasks' | 'tmux' | 'bagel' | 'teams' | 'bridge' | 'companion'
}
```

### Bridge 远程桥接状态

```typescript
{
  replBridgeEnabled: boolean          // 是否启用
  replBridgeExplicit: boolean         // 是否通过 /remote-control 显式激活
  replBridgeOutboundOnly: boolean     // 只推送不接收
  replBridgeConnected: boolean        // 环境注册 + 会话创建完成
  replBridgeSessionActive: boolean    // 用户已连接
  replBridgeReconnecting: boolean     // 轮询在错误退避中
  replBridgeConnectUrl?: string       // 连接 URL
  replBridgeSessionUrl?: string       // claude.ai 会话 URL
  replBridgeEnvironmentId?: string    // 环境 ID
  replBridgeSessionId?: string        // 会话 ID
  replBridgeError?: string            // 错误信息
  replBridgeInitialName?: string      // 会话名称
  showRemoteCallout: boolean          // 首次远程对话框
}
```

### 远程会话状态

```typescript
{
  remoteSessionUrl?: string           // --remote 模式的会话 URL
  remoteConnectionStatus:             // 远程 WS 连接状态
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  remoteBackgroundTaskCount: number   // 远程后台任务数
}
```

### Kairos 与功能开关

```typescript
{
  kairosEnabled: boolean              // 助手模式完全启用
  thinkingEnabled: boolean | undefined  // 思考模式开关
  promptSuggestionEnabled: boolean    // 提示建议开关
}
```

### 可变状态区（不在 DeepImmutable 内）

以下状态包含函数类型或 Map/Set，不能用 DeepImmutable 包装：

```typescript
{
  // 任务系统
  tasks: { [taskId: string]: TaskState }
  foregroundedTaskId?: string
  viewingAgentTaskId?: string

  // Agent 注册
  agentNameRegistry: Map<string, AgentId>

  // MCP 系统
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number
  }

  // 插件系统
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    errors: PluginError[]
    installationStatus: { marketplaces: [...], plugins: [...] }
    needsRefresh: boolean
  }

  // 文件历史与归因
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }

  // Companion 小宠物
  companionReaction?: string
  companionPetAt?: number

  // Tungsten Tmux 面板
  tungstenActiveSession?: { sessionName, socketName, target }
  tungstenLastCapturedTime?: number
  tungstenLastCommand?: { command, timestamp }
  tungstenPanelVisible?: boolean
  tungstenPanelAutoHidden?: boolean

  // WebBrowser (codename bagel)
  bagelActive?: boolean
  bagelUrl?: string
  bagelPanelVisible?: boolean

  // Computer Use MCP (codename chicago)
  computerUseMcpState?: {
    allowedApps?: readonly [...]
    grantFlags?: { clipboardRead, clipboardWrite, systemKeyCombos }
    lastScreenshotDims?: { width, height, ... }
    hiddenDuringTurn?: ReadonlySet<string>
    selectedDisplayId?: number
    displayPinnedByModel?: boolean
    displayResolvedForApps?: string
  }

  // 投机执行（Speculation）
  // ...SpeculationState 类型

  // 通知与 Elicitation
  notifications: { current, queue }
  elicitation: { queue }
  sessionHooks: SessionHooksState
}
```

---

## Store 实现

`store.ts` 仅 34 行，实现了一个极简的类 Zustand 状态容器：

```typescript
// 核心接口
type Store<T> = {
  getState(): T
  setState(updater: (prev: T) => T): void
  subscribe(listener: () => void): () => void
}
```

特点：

- 无外部依赖，纯 TypeScript 实现
- 订阅模式：监听者在每次 `setState` 后被同步通知
- 不可变更新：`setState` 接受 `(prev) => next` 函数

---

## React 集成

`AppState.tsx`（199 行）将 Store 桥接到 React：

1. 创建 `AppStateContext`（React Context）
2. `AppStateProvider` 组件包装整个应用
3. `useAppState()` Hook 返回当前状态
4. `useAppStateSelector(selector)` 通过选择器避免不必要的重渲染

---

## 状态变更副作用

`onChangeAppState.ts` 集中管理状态变更触发的副作用：

- Bridge 状态变化时更新 footer 显示
- 任务状态变化时触发通知
- 模型切换时重新组装工具池
- 插件状态变化时刷新 MCP 连接

---

## 初始状态构造

`AppStateStore.ts` 导出 `createInitialAppState()` 函数，接收启动参数构造初始状态：

```typescript
function createInitialAppState(options: {
  settings: SettingsJson
  model: ModelSetting
  verbose: boolean
  kairosEnabled: boolean
  // ...
}): AppState
```

---

## 与其他模块的关系

```
main.tsx ---------> AppStateProvider (创建 Store)
     |
     v
components/ ------> useAppState() / useAppStateSelector()
     |
hooks/ -----------> setState() (更新状态)
     |
bridge/ ----------> replBridge* 字段（远程桥接状态）
     |
daemon/ ----------> tasks 字段（后台任务状态）
     |
buddy/ -----------> companionReaction / companionPetAt
     |
services/mcp/ ----> mcp.clients / mcp.tools
     |
plugins/ ---------> plugins.enabled / plugins.errors
```

---

## 设计模式

- **不可变状态**：`DeepImmutable` 类型包装 + `setState(prev => ({...prev, ...}))` 更新模式，便于 React 检测变化
- **选择器记忆化**：`selectors.ts` 提供细粒度选择器，避免无关状态变化导致重渲染
- **副作用隔离**：状态变更的副作用集中在 `onChangeAppState` 中处理，不分散到各组件
- **混合可变性**：包含函数类型（TaskState）和复杂结构（Map/Set）的字段排除在 DeepImmutable 之外
- **极简 Store**：34 行实现类 Zustand 功能，无外部依赖

---

## 常见问题

**Q: 为什么不直接用 Zustand？**
A: claude-code-best 运行在 Bun + Ink（终端 React）环境中，对依赖大小敏感。34 行的自实现 Store 足够满足需求，且避免了额外依赖。

**Q: AppState 为什么这么大（569 行类型定义）？**
A: claude-code-best 是一个功能丰富的全栈应用（TUI + Bridge + Daemon + MCP + Plugins + Companion），所有模块的状态集中到一棵状态树中管理。这是有意的设计选择 -- 集中管理便于跨模块协调和调试。

**Q: DeepImmutable 和 mutable 区域的边界是什么？**
A: 所有纯数据字段（配置、UI 状态、开关）在 `DeepImmutable<{...}>` 内；包含函数类型（如 `TaskState` 的回调）、`Map`、`Set` 或需要频繁原地更新的复杂结构在交叉类型 `& {...}` 区域中。

**Q: 投机执行（Speculation）是什么？**
A: SpeculationState 用于预测用户下一步操作，提前执行工具调用。当用户确认时直接采纳结果，减少等待时间。状态包括活跃/空闲、预测结果、写入路径等信息。

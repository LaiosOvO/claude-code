# 第三章：模块组装 — 工具池、命令系统、MCP 集成

> 单个 Tool 是一块砖，工具池是一面墙。这一章看独立的模块如何组装成完整的子系统。

## 3.1 工具池组装

### 三层过滤

```typescript
// 第一层：获取所有内置工具
getAllBaseTools()
  → [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool,
     AgentTool, WebFetchTool, ... 共 60+ 个]

// 第二层：权限过滤
getTools(permissionContext)
  → 移除被 alwaysDeny 禁用的工具
  → --simple 模式只保留 [Bash, Read, Edit]
  → [BashTool, ReadTool, EditTool, ...]

// 第三层：合并 MCP 工具
assembleToolPool(builtIn, mcpTools)
  → 内置工具在前（保证 prompt-cache 稳定）
  → MCP 工具在后
  → 同名去重（内置优先）
  → [BashTool, ..., MCP_Tool_A, MCP_Tool_B]
```

### 为什么内置工具要在前面？

```
Claude API 的 prompt-cache 机制：
  如果两次请求的 system prompt 前缀相同，
  服务端可以复用缓存，减少计算量。

  请求1: [系统提示 | 工具A | 工具B | MCP_X | 消息...]
  请求2: [系统提示 | 工具A | 工具B | MCP_Y | 消息...]
                                    ↑
                              只有这里不同

  前缀 [系统提示 | 工具A | 工具B] 被缓存复用！
  
  如果把 MCP 工具插在中间，每次 MCP 工具变化
  都会导致后续所有内容的缓存失效。
```

## 3.2 命令系统组装

```typescript
// 命令来源的四个层级
async function getCommands(): Promise<Command[]> {
  return [
    // ① 内置命令（硬编码）
    helpCommand,        // /help
    clearCommand,       // /clear
    commitCommand,      // /commit
    configCommand,      // /config
    // ... 50+ 内置命令

    // ② 磁盘上的 Skill 文件
    ...await loadSkillsDir('.claude/skills/'),
    // 读取 *.md 文件，解析 frontmatter，生成 PromptCommand

    // ③ 插件注册的命令
    ...await getPluginCommands(),
    // 从已安装的插件中收集命令

    // ④ 代码中注册的内置 Skill
    ...getBundledSkills(),
    // registerBundledSkill() 注册的 Skill
  ]
}
```

### 命令查找流程

```
用户输入 "/commit -m fix bug"
    │
    ▼
解析命令名: "commit"
解析参数:   "-m fix bug"
    │
    ▼
在 commands 数组中查找 name === "commit"
    │
    ├─ 找到 PromptCommand
    │   → getPromptForCommand("-m fix bug")
    │   → 生成 prompt 发送给 Claude
    │
    ├─ 找到 LocalCommand
    │   → load() → call("-m fix bug")
    │   → 直接执行，返回结果
    │
    └─ 找到 LocalJSXCommand
        → load() → call(onDone)
        → 渲染 React 组件
```

## 3.3 MCP 集成

MCP (Model Context Protocol) 让外部服务以标准化方式提供工具给 Claude。

### MCP 连接生命周期

```
MCP 配置 (settings.json)
    │
    │  "mcpServers": {
    │    "github": {
    │      "command": "npx",
    │      "args": ["-y", "@modelcontextprotocol/server-github"]
    │    }
    │  }
    │
    ▼
init.ts: connectMcpServers()
    │
    │  对每个 MCP 配置：
    │  1. 启动子进程 (stdio transport)
    │  2. 发送 initialize 握手
    │  3. 获取 tools/list — 可用工具列表
    │  4. 获取 resources/list — 可用资源列表
    │
    ▼
MCPTool 包装
    │
    │  每个 MCP 工具被包装为一个 Tool 对象：
    │  - name: "mcp__github__create_issue"
    │  - inputSchema: 从 MCP 服务端获取
    │  - call(): 转发给 MCP 服务端执行
    │  - prompt(): 从 MCP 描述生成
    │
    ▼
assembleToolPool(builtIn, mcpTools)
    │  合并到工具池
    ▼
Claude 可以调用 MCP 工具了
```

### MCP 的消息传输

```
Claude Code                    MCP Server
    │                              │
    │  ── initialize ──────────►   │
    │  ◄── capabilities ────────   │
    │                              │
    │  ── tools/list ──────────►   │
    │  ◄── tool definitions ────   │
    │                              │
    │  ── tools/call ──────────►   │  (Claude 调用工具)
    │     {name, arguments}        │
    │  ◄── tool result ────────    │
    │     {content}                │
    │                              │
    │  ── resources/read ──────►   │  (读取资源)
    │  ◄── resource content ────   │
```

## 3.4 状态管理组装

AppState 是所有状态的汇聚点：

```typescript
// 创建 Store（类 Zustand 模式）
const store = createStore(initialState, onChangeAppState)

// 初始状态由多个模块贡献：
const initialState: AppState = {
  // 配置模块
  settings: loadedSettings,
  mainLoopModel: modelFromConfig,

  // 工具模块
  toolPermissionContext: builtPermissionContext,

  // MCP 模块
  mcp: {
    clients: connectedMcpClients,
    tools: mcpTools,
    commands: mcpCommands,
  },

  // UI 模块
  expandedView: 'none',
  footerSelection: null,

  // 功能开关
  kairosEnabled: featureFlag('KAIROS'),
  verbose: false,
}
```

### 状态更新的单向数据流

```
用户操作 / API 响应 / 工具结果
    │
    ▼
setState(prev => ({ ...prev, changes }))
    │
    ▼
onChangeAppState(newState, oldState)
    │  触发副作用（日志、持久化、通知）
    │
    ▼
React 重新渲染
    │  通过 Context 传播到组件树
    │  Selectors 过滤不相关的更新
    ▼
UI 更新
```

## 3.5 Hook 系统组装

React Hooks 是 UI 层的组装机制：

```typescript
// REPL.tsx 中的 Hook 层级

function REPL() {
  // 第一层：基础 hooks
  const [state, setState] = useAppState()        // 全局状态
  const { width, height } = useTerminalSize()      // 终端尺寸

  // 第二层：功能 hooks（组合基础 hooks）
  const canUseTool = useCanUseTool(state)          // 权限检查
  const { tools } = useMergedTools(state)           // 工具合并
  const { commands } = useMergedCommands(state)     // 命令合并

  // 第三层：交互 hooks
  useInput(handleKeyPress)                          // 键盘输入
  useArrowKeyHistory(history)                       // 历史导航

  // 第四层：后台 hooks
  useInboxPoller(session)                           // 消息轮询
  useScheduledTasks(state)                          // 定时任务
  useMcpConnectivityStatus(state)                   // MCP 状态

  // 第五层：通知 hooks
  useStartupNotification()                          // 启动通知
  useRateLimitWarningNotification()                 // 限流告警

  return <Screen>...</Screen>
}
```

## 3.6 事件驱动的模块协作

各模块通过事件（Signal / Mailbox）协作：

```
文件变化事件 (chokidar)
    │
    ├──→ KairosWatcher → 触发 reactive 任务
    ├──→ FileChangedWatcher → 更新 UI 中的文件标记
    └──→ HookSystem → 触发 fileChanged hook

UDS 消息 (InboxServer)
    │
    ├──→ InboxPoller → 处理跨会话消息
    ├──→ KairosEngine → 接收远程命令
    └──→ Bridge → 转发到手机端

定时器 tick (cronScheduler)
    │
    ├──→ KairosEngine → 检查到期任务
    ├──→ SessionMemory → 定期提取会话记忆
    └──→ Heartbeat → 发送心跳
```

## 3.7 本章总结

| 组装层面 | 输入 | 输出 | 机制 |
|----------|------|------|------|
| 工具池 | 60+ 内置 Tool + MCP Tool | 统一 Tools 集合 | assembleToolPool() |
| 命令系统 | 内置 + Skill + 插件 | Command[] 数组 | getCommands() |
| MCP 集成 | settings.json 配置 | MCPTool 包装 | stdio/SSE transport |
| 状态管理 | 各模块初始状态 | AppState store | createStore() |
| Hook 系统 | 基础 hook | 复合功能 | React 组合模式 |
| 事件协作 | Signal / Mailbox | 跨模块通知 | 发布-订阅 |

下一章我们继续向上，看这些子系统如何集成为完整的应用。

→ [第四章：系统集成 — 从子系统到完整应用](04-system-integration.md)

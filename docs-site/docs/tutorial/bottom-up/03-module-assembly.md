# 第三章：模块组装 -- 工具池、命��系统、MCP 集成

> 单个 Tool 是一块砖，工具池是一面墙。这一章看独立的模块如何组装成完整的子系统。

## 3.1 工具池组装

### 三层过滤

**文件**: `src/tools.ts` (387行)

```typescript
// 第一层：获取所有内置工具
getAllBaseTools()
  // -> [AgentTool, TaskOutputTool, BashTool, GlobTool, GrepTool,
  //     FileReadTool, FileEditTool, FileWriteTool, NotebookEditTool,
  //     WebFetchTool, TodoWriteTool, WebSearchTool, ...
  //     + feature-gated: SleepTool, WorkflowTool, RemoteTriggerTool, ...]
  //     共 58+ 个

// 第二层：权限过滤
getTools(permissionContext)
  // -> filterToolsByDenyRules() 移除被 alwaysDeny 禁用的工具
  // -> CLAUDE_CODE_SIMPLE=true 模式只保留 [Bash, Read, Edit]
  // -> coordinatorMode 时额外添加 Agent, TaskStop, SendMessage
  // -> REPLTool 模式时用 REPL 包装底层工具

// 第三层：合并 MCP 工具
assembleToolPool(builtIn, mcpTools)
  // -> 内置工具在前（保证 prompt-cache 稳定）
  // -> MCP 工具在后
  // -> 同名去重（内置优先）
  // -> 最终：[BashTool, ..., MCP_Tool_A, MCP_Tool_B]
```

### getAllBaseTools() 的真实代码

```typescript
// src/tools.ts — 工具注册的核心函数
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 当 bfs/ugrep 内嵌到 bun 二进制时，跳过 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool, FileEditTool, FileWriteTool,
    NotebookEditTool, WebFetchTool, TodoWriteTool,
    WebSearchTool, TaskStopTool, AskUserQuestionTool,
    SkillTool, EnterPlanModeTool,

    // Ant-only 工具
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool, TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),

    // Feature-gated 工具
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled() ? [getTeamCreateTool(), getTeamDeleteTool()] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,  // CronCreate, CronDelete, CronList
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(SnipTool ? [SnipTool] : []),

    // MCP 资源
    ListMcpResourcesTool, ReadMcpResourceTool,
    // ToolSearch（延迟加载优化）
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

### 为什么内置工具要在前面？

```
Claude API 的 prompt-cache 机制：
  如果两次请求的 system prompt 前缀相同，
  服务端可以复用缓存，减少计算量。

  请求1: [系统提示 | 工具A | 工具B | MCP_X | 消息...]
  请求2: [系统提示 | 工具A | 工具B | MCP_Y | 消息...]
                                    ^
                              只有这里不同

  前缀 [系统提示 | 工具A | 工具B] 被缓存复用!

  如果把 MCP 工具插在中间，每次 MCP 工具变化
  都会导致后续所有内容的缓存失效。
```

## 3.2 Coordinator 模式与工具过滤

**文件**: `src/coordinator/coordinatorMode.ts`

当启用 COORDINATOR_MODE 时，工具集会根据角色不同进行过滤：

```typescript
// coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}

// tools.ts 中的简单模式 + 协调器逻辑
if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
  const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
  if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
    // 协调器还需要：Agent（派发任务）、TaskStop（停止任务）、SendMessage（通信）
    simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
  }
  return filterToolsByDenyRules(simpleTools, permissionContext)
}
```

**角色分工**：

| 角色 | 可用工具 | 说明 |
|------|---------|------|
| 协调器 (Coordinator) | Agent, TaskStop, SendMessage + 基础工具 | 派发任务、监控进度 |
| 工作者 (Worker) | Bash, Read, Edit 等执行工具 | 实际执行任务 |

## 3.3 命令系统组装

**文件**: `src/commands.ts`

命令来源极其丰富，全部通过 `getCommands()` 汇总：

```typescript
// 命令来源的五个层级
async function getCommands(): Promise<Command[]> {
  return [
    // 1. 内置命令（硬编码）
    help, clear, commit, compact, config, cost, diff, doctor,
    memory, session, share, skills, status, tasks, teleport,
    // ... 80+ 内置命令

    // 2. Feature-gated 命令（编译时决定是否包含）
    ...(bridge ? [bridge] : []),
    ...(voiceCommand ? [voiceCommand] : []),
    ...(assistantCommand ? [assistantCommand] : []),
    ...(buddy ? [buddy] : []),
    ...(peersCmd ? [peersCmd] : []),
    ...(workflowsCmd ? [workflowsCmd] : []),

    // 3. 磁盘上的 Skill 文件
    ...await getSkillDirCommands(),
    // 读取 .claude/skills/*.md 文件

    // 4. 内置 Skill（代码注册）
    ...getBundledSkills(),
    // registerBundledSkill() 注册的 Skill

    // 5. 插件注册的命令
    ...await getPluginCommands(),
    ...getBuiltinPluginSkillCommands(),
    ...await getPluginSkills(),
  ]
}
```

### 命令查找流程

```
用户输入 "/commit -m fix bug"
    |
    v
解析命令名: "commit"
解析参数:   "-m fix bug"
    |
    v
在 commands 数组中查找 name === "commit"
    |
    +-- 找到 PromptCommand
    |   -> getPromptForCommand("-m fix bug")
    |   -> 生成 prompt 发送给 Claude
    |
    +-- 找到 LocalCommand
    |   -> load() -> call("-m fix bug")
    |   -> 直接执行，返回结果
    |
    +-- 找到 LocalJSXCommand
        -> load() -> call(onDone)
        -> 渲染 React 组件
```

## 3.4 MCP 集成

MCP (Model Context Protocol) 让外部服务以标准化方式提供工具给 Claude。

### MCP 服务目录

**文件**: `src/services/mcp/` (~20个文件)

```
src/services/mcp/
+-- client.ts              <- MCP 客户端核心
+-- config.ts              <- 配置加载
+-- types.ts               <- 类型定义
+-- MCPConnectionManager.tsx <- 连接管理（React 组件）
+-- normalization.ts       <- 工具名规范化
+-- auth.ts                <- MCP 认证
+-- channelAllowlist.ts    <- 通道白名单
+-- channelPermissions.ts  <- 通道权限
+-- elicitationHandler.ts  <- URL 弹窗处理
+-- InProcessTransport.ts  <- 进程内传输
+-- SdkControlTransport.ts <- SDK 控制传输
```

### MCP 连接生命周期

```
MCP 配置 (settings.json)
    |
    |  "mcpServers": {
    |    "github": {
    |      "command": "npx",
    |      "args": ["-y", "@modelcontextprotocol/server-github"]
    |    }
    |  }
    |
    v
init.ts: connectMcpServers()
    |
    |  对每个 MCP 配置：
    |  1. 启动子进程 (stdio transport)
    |  2. 发送 initialize 握手
    |  3. 获取 tools/list -- 可用工具列表
    |  4. 获取 resources/list -- 可用资源列表
    |
    v
MCPTool 包装
    |
    |  每个 MCP 工具被包装为一个 Tool 对象：
    |  - name: "mcp__github__create_issue"
    |  - inputJSONSchema: 从 MCP 服务端获取（非 Zod，原始 JSON Schema）
    |  - mcpInfo: { serverName: "github", toolName: "create_issue" }
    |  - call(): 转发给 MCP 服务端执行
    |
    v
assembleToolPool(builtIn, mcpTools)
    |  合并到工具池
    v
Claude 可以调用 MCP 工具了
```

### MCP 的消息传输

```
Claude Code (ccb)              MCP Server
    |                              |
    |  -- initialize ----------->  |
    |  <-- capabilities ---------- |
    |                              |
    |  -- tools/list ----------->  |
    |  <-- tool definitions ------ |
    |                              |
    |  -- tools/call ----------->  |  (Claude 调用工具)
    |     {name, arguments}        |
    |  <-- tool result ----------- |
    |     {content}                |
    |                              |
    |  -- resources/read -------->  |  (读取资源)
    |  <-- resource content ------- |
```

## 3.5 状态管理组装

**文件**: `src/state/AppState.tsx` + `src/state/AppStateStore.ts`

AppState 使用类 Zustand 模式，结合 React Context：

```typescript
// 创建 Store
const store = createStore(initialState ?? getDefaultAppState(), onChangeAppState)

// AppState 包含所有全局状态
type AppState = {
  // 配置
  settings: LoadedSettings
  mainLoopModel: string

  // 工具与权限
  toolPermissionContext: ToolPermissionContext

  // MCP
  mcp: {
    clients: MCPServerConnection[]
    tools: Tools
    commands: Command[]
    resources: Record<string, ServerResource[]>
  }

  // UI 状态
  expandedView: 'none' | 'thinking' | 'progress'
  footerSelection: string | null

  // 功能开关（运行时）
  kairosEnabled: boolean
  verbose: boolean

  // Coordinator
  coordinatorMode?: 'coordinator' | 'normal'
  // ... 更多字段
}
```

### Provider 层级

```tsx
// src/state/AppState.tsx
export function AppStateProvider({ children, initialState, onChangeAppState }) {
  const [store] = useState(() => createStore(...))

  return (
    <AppStoreContext.Provider value={store}>
      <MailboxProvider>
        <VoiceProvider>
          {children}
        </VoiceProvider>
      </MailboxProvider>
    </AppStoreContext.Provider>
  )
}
```

注意 VoiceProvider 也是 feature-gated 的：

```typescript
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children  // 外部构建时为透传组件
```

### 状态更新的单向数据流

```
用户操作 / API 响应 / 工具结果
    |
    v
store.setState(prev => ({ ...prev, changes }))
    |
    v
onChangeAppState({ newState, oldState })
    |  触发副作用（日志、持久化、通知）
    |
    v
React 重新渲染
    |  通过 useSyncExternalStore 传播到组件树
    v
UI 更新
```

## 3.6 服务层组装

**文件**: `src/services/` (~40+ 文件)

服务层是 ccb 最"厚"的一层，提供各种基础设施：

```
src/services/
+-- analytics/          <- 分析（GrowthBook/Datadog/Sentry）
|     index.ts, growthbook.ts, datadog.ts, sink.ts
+-- api/                <- Anthropic SDK 封装
|     claude.ts, errors.ts, withRetry.ts
+-- mcp/                <- MCP 客户端
|     client.ts, config.ts, MCPConnectionManager.tsx
+-- oauth/              <- OAuth 认证
+-- compact/            <- 消息压缩
|     compact.ts, autoCompact.ts, microCompact.ts
|     reactiveCompact.ts, contextCollapse/
+-- voice.ts            <- 语音 I/O (525行)
+-- SessionMemory/      <- 会话记忆
+-- plugins/            <- 插件服务
+-- lsp/                <- LSP 集成
+-- extractMemories/    <- 记忆提取
+-- MagicDocs/          <- 文档智能
+-- AgentSummary/       <- Agent 摘要
+-- awaySummary.ts      <- 离开摘要
+-- skillSearch/        <- Skill 搜索
+-- teamMemorySync/     <- 团队记忆同步
+-- tools/              <- 工具层服务
+-- tokenEstimation.ts  <- Token 估算
+-- vcr.ts              <- 录制/回放
```

## 3.7 事件驱动的模块协作

各模块通过事件（Signal / Mailbox）和 feature gate 协作：

```
文件变化事件 (chokidar)
    |
    +---> KairosWatcher -> 触发 reactive 任务
    +---> FileChangedWatcher -> 更新 UI 中的文件标记
    +---> HookSystem -> 触发 fileChanged hook

UDS 消息 (InboxServer)
    |
    +---> InboxPoller -> 处理跨会话消息
    +---> KairosEngine -> 接收远程命令
    +---> Bridge -> 转发到手机端

定时器 tick
    |
    +---> CronScheduler -> 检查到期的定时任务
    +---> SessionMemory -> 定期提取会话记忆
    +---> Heartbeat -> 发送守护进程心跳

设置变更事件
    |
    +---> useSettingsChange hook -> applySettingsChange
    +---> AppStateProvider -> store.setState
    +---> context.ts -> 清除 memoize 缓存
```

## 3.8 packages/ workspace

除了 `src/`，ccb 还有一个 packages/ workspace 提供原生能力：

```
packages/
+-- audio-capture-napi    <- 音频捕获 (NAPI)
+-- color-diff-napi       <- 颜色差异计算
+-- image-processor-napi  <- 图片处理
+-- modifiers-napi        <- 修饰符处理
+-- url-handler-napi      <- URL 处理
+-- @ant/                 <- Anthropic 内部包
    +-- claude-for-chrome-mcp   <- Chrome 扩展 MCP
    +-- computer-use-input      <- 计算机操作输��
    +-- computer-use-mcp        <- 计算机操作 MCP
    +-- computer-use-swift      <- Swift 原生层
```

这些 NAPI 模块用 Rust/C++ 编写，通过 Bun 的 NAPI 绑定提供高性能原生能力。

## 3.9 本章总结

| 组装层面 | 输入 | 输出 | 核心机制 |
|----------|------|------|---------|
| 工具池 | 58+ 内置 Tool + MCP Tool | 统一 Tools 集合 | getAllBaseTools() + assembleToolPool() |
| 命令系统 | 内置 + Skill + 插件 | Command[] 数组 | getCommands() |
| MCP 集成 | settings.json 配置 | MCPTool 包装 | stdio/SSE transport |
| 状态管理 | 各模块初始状态 | AppState store | createStore() + useSyncExternalStore |
| 服务层 | analytics/api/mcp/compact/... | 基础设施服务 | 模块化目录结构 |
| 事件协作 | Signal / Mailbox | 跨模块通知 | 发布-订阅 |
| Coordinator | coordinator/worker 角色 | 任务分发与执行 | COORDINATOR_MODE feature |
| NAPI 模块 | packages/ workspace | 原生高性能能力 | Bun NAPI 绑定 |

下一章我们继续向上，看这些子系统如何集成为完整的应用。

-> [第四章：系统集成 -- 从子系统到完整应用](04-system-integration.md)

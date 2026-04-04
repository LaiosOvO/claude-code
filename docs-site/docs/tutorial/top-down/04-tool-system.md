# 第四章：工具系统 — Claude 的手和脚

> 工具是 Claude 与外部世界交互的唯一方式。理解工具系统，就理解了 AI Agent 的执行能力。

## 4.1 工具的概念

在 AI Agent 架构中，LLM 本身只能「思考」和「说话」。要让它真正做事（读文件、执行命令、搜索代码），需要 **工具（Tool）**。ccb 拥有 58+ 内置工具，加上 MCP 协议可以无限扩展。

```
Claude 的能力 = 语言理解 + 工具调用
                │              │
                ▼              ▼
           分析问题        执行操作
           理解代码        读写文件
           制定计划        运行命令
           协调 Agent      搜索网络
```

## 4.2 Tool 类型定义：src/Tool.ts (978行)

Tool.ts 定义了工具的完整接口。核心类型是 `ToolUseContext` — 工具执行时可以访问的所有上下文：

```typescript
export type ToolUseContext = {
  options: {
    commands: Command[]              // 可用命令列表
    debug: boolean                   // 调试模式
    mainLoopModel: string            // 当前模型
    tools: Tools                     // 所有可用工具
    verbose: boolean                 // 详细输出
    thinkingConfig: ThinkingConfig   // 思考模式
    mcpClients: MCPServerConnection[] // MCP 连接
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean // 非交互（headless）
    agentDefinitions: AgentDefinitionsResult  // Agent 定义
    maxBudgetUsd?: number            // 预算限制
    customSystemPrompt?: string      // 自定义提示词
    appendSystemPrompt?: string      // 追加提示词
    refreshTools?: () => Tools       // 动态刷新工具（MCP 热连接）
  }
  abortController: AbortController   // 中断控制
  readFileState: FileStateCache      // 文件状态缓存
  getAppState(): AppState            // 读全局状态
  setAppState(f: (prev: AppState) => AppState): void  // 写全局状态
  setToolJSX?: SetToolJSXFn          // 设置工具 UI
  messages: Message[]                // 当前消息历史
  updateFileHistoryState: (...)      // 文件历史追踪
  updateAttributionState: (...)      // 提交归因追踪
  agentId?: AgentId                  // 子 Agent ID
  agentType?: string                 // Agent 类型名
  contentReplacementState?: ContentReplacementState  // 工具结果预算
  // ... 30+ 更多字段
}
```

### 权限上下文

```typescript
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode  // 'default' | 'auto' | 'bypassPermissions'
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  shouldAvoidPermissionPrompts?: boolean  // 后台 Agent 无 UI
  awaitAutomatedChecksBeforeDialog?: boolean  // 协调器 Worker
}>
```

## 4.3 三文件模式：工具的文件结构

每个工具由 3 个文件组成，职责分离：

```
src/tools/
├── BashTool/
│   ├── BashTool.ts      # 工具定义 + call() 执行逻辑
│   ├── prompt.ts         # 模型提示词 — 告诉 Claude 怎么用这个工具
│   └── UI.tsx            # 终端 UI 渲染 — 用户看到什么
├── FileReadTool/
│   ├── FileReadTool.ts
│   ├── prompt.ts
│   └── UI.tsx
├── AgentTool/
│   ├── AgentTool.ts
│   ├── constants.ts
│   ├── loadAgentsDir.ts  # Agent 定义加载
│   ├── agentColorManager.ts
│   └── ...
├── ScheduleCronTool/
│   ├── CronCreateTool.ts
│   ├── CronDeleteTool.ts
│   ├── CronListTool.ts
│   └── ...
├── shared/               # 共享工具类
├── testing/              # 测试用工具
├── utils.ts              # 工具共用函数
└── ...                   # 56+ 工具目录
```

**为什么分三个文件？**
- **工具定义 (Tool.ts)** — 核心逻辑，面向 QueryEngine。包含 `call()` 执行函数、`inputSchema` Zod 验证、安全属性
- **提示词 (prompt.ts)** — 面向 Claude。描述工具用途、参数含义、使用示例
- **UI (UI.tsx)** — 面向用户。React 组件，在终端中渲染工具调用过程和结果

## 4.4 如何定义一个工具：buildTool()

每个工具使用 `buildTool()` 工厂函数创建：

```typescript
import { buildTool } from '../Tool'
import { z } from 'zod/v4'

export const MyTool = buildTool({
  name: 'MyTool',

  // Zod Schema 定义输入参数 — 同时用于类型推导和运行时验证
  inputSchema: z.strictObject({
    query: z.string().describe('搜索关键词'),
    maxResults: z.number().optional().describe('最大结果数'),
  }),

  // 模型提示词 — 告诉 Claude 什么时候、怎么用这个工具
  async prompt() {
    return '使用此工具来搜索代码库中的内容...'
  },

  // 动态描述 — 可以根据输入变化
  async description(input) {
    return `搜索: ${input.query}`
  },

  // 执行函数 — 工具的核心逻辑
  async call(input, context) {
    const results = await searchCode(input.query, input.maxResults)
    return {
      type: 'text',
      text: formatResults(results),
    }
  },

  // 安全属性
  isReadOnly() { return true },         // 只读操作
  isConcurrencySafe() { return true },   // 可以并行
  isEnabled() { return true },           // 始终启用

  // UI 渲染 — 工具调用时用户看到什么
  renderToolUseMessage(input) {
    return <Text>搜索: {input.query}</Text>
  },
  renderToolResultMessage(content) {
    return <Text>{content}</Text>
  },
})
```

**buildTool() 的安全优先默认值**：

| 属性 | 默认值 | 原因 |
|------|--------|------|
| `isEnabled()` | `true` | 默认启用 |
| `isConcurrencySafe()` | `false` | 假设不安全（fail-closed） |
| `isReadOnly()` | `false` | 假设有写操作 |
| `checkPermissions()` | `allow` | 默认允许（权限由 canUseTool 层处理） |

## 4.5 内置工具清单

### 文件操作类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| FileRead | 读取文件内容（支持图片、PDF、Jupyter） | yes | yes |
| FileEdit | 精确字符串替换编辑 | no | no |
| FileWrite | 创建/覆盖文件 | no | no |
| Glob | 按模式搜索文件名 | yes | yes |
| Grep | 搜索文件内容（基于 ripgrep） | yes | yes |
| NotebookEdit | 编辑 Jupyter notebook | no | no |

### 系统操作类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| Bash | 执行 Shell 命令 | no | no |
| PowerShell | 执行 PowerShell（Windows） | no | no |
| WebFetch | 获取网页内容 | yes | yes |
| WebSearch | 搜索网络 | yes | yes |
| WebBrowser | 浏览器操作（feature gate） | no | no |
| TerminalCapture | 终端截屏（feature gate） | yes | yes |

### Agent 与任务类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| Agent | 启动子 Agent | no | no |
| SendMessage | 向子 Agent / 团队成员发消息 | no | no |
| TaskCreate | 创建任务 | no | yes |
| TaskGet | 获取任务状态 | yes | yes |
| TaskUpdate | 更新任务 | no | yes |
| TaskList | 列出任务 | yes | yes |
| TaskStop | 停止任务 | no | no |
| TaskOutput | 获取任务输出 | yes | yes |
| TeamCreate | 创建团队成员 | no | no |
| TeamDelete | 删除团队成员 | no | no |

### 交互与辅助类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| AskUserQuestion | 向用户提问 | yes | no |
| Skill | 调用技能 | no | no |
| ToolSearch | 搜索延迟加载的工具 | yes | yes |
| EnterPlanMode | 进入规划模式 | no | no |
| ExitPlanMode | 退出规划模式 | no | no |
| EnterWorktree | 进入 git worktree | no | no |
| ExitWorktree | 退出 git worktree | no | no |
| TodoWrite | 写入待办事项 | no | no |
| Config | 读写配置（内部） | no | no |
| Brief | 简要响应模式 | no | no |
| Snip | 历史修剪（feature gate） | no | no |
| ListPeers | 列出 UDS 对等节点 | yes | yes |
| Monitor | 监控工具（feature gate） | yes | yes |

### 调度类（Kairos 相关）
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| CronCreate | 创建 cron 调度 | no | no |
| CronDelete | 删除 cron 调度 | no | no |
| CronList | 列出 cron 调度 | yes | yes |
| RemoteTrigger | 远程触发器 | no | no |
| SleepTool | 等待一段时间 | yes | no |
| SendUserFile | 发送文件给用户 | no | no |
| PushNotification | 推送通知 | no | no |
| SubscribePR | 订阅 PR 变更 | no | no |

### MCP 集成类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| ListMcpResources | 列出 MCP 服务器资源 | yes | yes |
| ReadMcpResource | 读取 MCP 资源 | yes | yes |

## 4.6 工具注册表：src/tools.ts (469行)

tools.ts 是工具系统的注册中心，提供三层 API：

### 第一层：getAllBaseTools() — 完整工具清单

```typescript
// 这是所有工具的 source of truth
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 如果有内嵌搜索工具（bfs/ugrep），跳过 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // === 条件启用的工具 ===
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool, TungstenTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, ...] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
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
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

**注意条件加载模式**：很多工具使用 `feature()` 编译时门控 + `require()` 动态导入，确保外部构建中移除不需要的代码。

### 第二层：getTools() — 权限过滤

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // --bare / SIMPLE 模式：只保留 Bash + FileRead + FileEdit
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools = [BashTool, FileReadTool, FileEditTool]
    // 协调器模式额外加入 AgentTool + TaskStopTool
    if (isCoordinatorMode()) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // REPL 模式：隐藏被 REPL 包装的原始工具
  if (isReplModeEnabled()) {
    allowedTools = allowedTools.filter(tool => !REPL_ONLY_TOOLS.has(tool.name))
  }

  // 过滤 deny 规则和 isEnabled() 检查
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

### 第三层：assembleToolPool() — 合并 MCP 工具

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 关键：内置工具排在前面，MCP 工具排在后面
  // 这是为了 prompt-cache 稳定性 — 服务端在内置工具后设置缓存断点
  // 如果 MCP 工具插入到内置工具中间，会导致所有下游缓存失效
  const byName = (a, b) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',  // 同名去重，内置优先
  )
}
```

## 4.7 权限系统

```
工具调用请求
    │
    ▼
┌─ 工具自身检查 ─────────────┐
│ checkPermissions(input, ctx) │  ←─ 工具自定义的权限判断
│ (如 Bash 检查危险命令)        │      如 rm -rf / 等
└────────────┬────────────────┘
             │
             ▼
┌─ Deny Rules 过滤 ──────────┐
│ filterToolsByDenyRules()     │  ←─ settings.json 中的 deny 规则
│ 批量禁用工具或 MCP 服务器     │      支持前缀匹配 mcp__server
└────────────┬────────────────┘
             │
             ▼
┌─ 权限模式 ─────────────────┐
│ default: 每次都问用户        │
│ auto: ML 分类器自动判断      │  ←─ feature('TRANSCRIPT_CLASSIFIER')
│ bypassPermissions: 跳过检查  │  ←─ 仅沙箱环境允许
└────────────┬────────────────┘
             │
             ▼
┌─ canUseTool() 回调 ────────┐
│ hooks/useCanUseTool.tsx      │
│ ├─ alwaysAllow 规则匹配     │
│ ├─ alwaysDeny 规则匹配      │
│ ├─ alwaysAsk 规则匹配       │
│ └─ 默认行为（ask 或 auto）   │
└────────────┬────────────────┘
             │
             ▼
  allow / deny / ask(用户对话框)
```

## 4.8 ToolSearch 延迟加载

当工具数量超过阈值时，不是所有工具都发送给模型。而是通过 ToolSearch 工具让 Claude 按需查找：

```
初始工具集 = 核心工具（Bash, Read, Edit, Glob, Grep, ...）
            + ToolSearch 工具

Claude 需要更多工具时:
  Claude → 调用 ToolSearch("notebook jupyter")
        → 返回 NotebookEditTool 的完整 schema
        → Claude 现在可以使用 NotebookEditTool
```

这通过 `isToolSearchEnabledOptimistic()` 控制，减少了 prompt 中的 token 消耗。

## 4.9 Coordinator 模式下的工具过滤

协调器模式中，不同角色看到不同的工具子集：

```
Coordinator（主线程）:
  看到: AgentTool, TaskStopTool, SendMessageTool, TeamCreate/Delete
  不看到: Bash, FileRead, FileEdit 等原始工具
  → 只做编排，不做执行

Worker Agent（子线程）:
  看到: ASYNC_AGENT_ALLOWED_TOOLS 子集
  → Bash, FileRead, FileEdit, Glob, Grep, WebFetch...
  不看到: AgentTool（防止递归）
```

## 4.10 设计亮点

1. **安全优先的默认值** — 不确定就标记为不安全（`isConcurrencySafe = false`）
2. **声明式定义** — Zod schema 同时用于验证、类型推导和 API 描述
3. **关注点分离** — 逻辑 / 提示词 / UI 三层分离
4. **编译时门控** — `feature()` + Dead Code Elimination 移除不需要的工具代码
5. **Prompt-cache 稳定性** — 内置工具排前面，排序后合并，保证缓存命中率
6. **可扩展性** — MCP 协议让外部工具无缝集成
7. **并发优化** — 只读工具并行执行，减少延迟
8. **延迟加载** — ToolSearch 机制减少 prompt token 消耗

## 4.11 下一章预告

工具的调用结果需要展示给用户。下一章我们看 **终端 UI 系统** — 如何用 React 在终端中渲染完整的交互界面。

[第五章：终端 UI 系统](05-terminal-ui.md)

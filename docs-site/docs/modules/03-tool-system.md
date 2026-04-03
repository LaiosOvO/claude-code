# 模块说明：工具系统 (Tool System)

## 概述

工具系统是 Claude 与外部世界交互的接口层。每个工具定义了一种能力（读文件、执行命令、搜索代码等），Claude 通过工具调用来完成实际任务。claude-code-best 内建了 58+ 工具，并支持通过 MCP 协议和插件系统无限扩展。系统设计遵循"安全优先"原则 -- 默认假设工具不安全。

---

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/Tool.ts` | 工具接口定义 + `buildTool()` 工厂函数 + 类型导出 | 792 |
| `src/tools.ts` | 工具注册表 + `getAllBaseTools()` + `assembleToolPool()` | 387 |
| `src/tools/*/` | 58+ 工具实现目录（每个工具一个子目录） | 各异 |

---

## 架构设计

```
工具定义层                   工具注册层                  工具执行层
+-------------+          +--------------+          +---------------+
| BashTool    |          |              |          | QueryEngine   |
| FileReadTool|          | getAllBase   |          |               |
| FileEditTool|--注册--->| Tools()      |--组装--->| findToolByName|
| GrepTool    |          |              |          |               |
| AgentTool   |          | assemble     |          | 权限检查      |
| WebFetchTool|          | ToolPool()   |          | -> call()     |
| ...58+      |          |              |          | -> 收集结果   |
|             |          | + MCP 工具   |          |               |
| MCP Tools   |--动态--->| + Plugin 工具|          |               |
| Plugin Tools|          |              |          |               |
+-------------+          +--------------+          +---------------+
```

---

## 完整工具清单

### 核心工具（始终可用）

| 工具 | 功能 |
|------|------|
| `AgentTool` | 子 Agent 调用（spawn 独立会话） |
| `TaskOutputTool` | 后台任务输出管理 |
| `BashTool` | Shell 命令执行 |
| `FileReadTool` | 文件读取 |
| `FileEditTool` | 文件编辑（精确替换） |
| `FileWriteTool` | 文件写入（整体覆盖） |
| `GlobTool` | 文件名模式搜索 |
| `GrepTool` | 文件内容搜索 |
| `NotebookEditTool` | Jupyter Notebook 编辑 |
| `WebFetchTool` | HTTP 请求获取网页内容 |
| `WebSearchTool` | 网络搜索 |
| `TodoWriteTool` | Todo 清单管理 |
| `AskUserQuestionTool` | 向用户提问 |
| `SkillTool` | 调用 Skills |
| `SendMessageTool` | 向其他 Agent 发消息 |
| `BriefTool` | 简洁输出模式 |
| `TaskStopTool` | 停止后台任务 |
| `EnterPlanModeTool` | 进入计划模式 |
| `ExitPlanModeV2Tool` | 退出计划模式（v2） |
| `ListMcpResourcesTool` | 列出 MCP 资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源 |

### 条件工具（Feature Gate / 环境变量控制）

| 工具 | 条件 | 功能 |
|------|------|------|
| `TungstenTool` | `USER_TYPE=ant` | Tmux 面板控制 |
| `ConfigTool` | `USER_TYPE=ant` | 运行时配置修改 |
| `REPLTool` | `USER_TYPE=ant` | REPL 代码执行 |
| `SuggestBackgroundPRTool` | `USER_TYPE=ant` | 建议后台 PR |
| `WebBrowserTool` | `WEB_BROWSER_TOOL` | 浏览器操控 |
| `TerminalCaptureTool` | `TERMINAL_PANEL` | 终端截屏 |
| `OverflowTestTool` | `OVERFLOW_TEST_TOOL` | 溢出测试 |
| `CtxInspectTool` | `CONTEXT_COLLAPSE` | 上下文检查 |
| `SnipTool` | `HISTORY_SNIP` | 历史消息裁剪 |
| `ListPeersTool` | `UDS_INBOX` | 列出 UDS 对等端 |
| `WorkflowTool` | `WORKFLOW_SCRIPTS` | 工作流脚本执行 |
| `SleepTool` | `PROACTIVE` / `KAIROS` | 定时等待 |
| `MonitorTool` | `MONITOR_TOOL` | 监控工具 |
| `SendUserFileTool` | `KAIROS` | 发送文件给用户 |
| `PushNotificationTool` | `KAIROS` / `KAIROS_PUSH_NOTIFICATION` | 推送通知 |
| `SubscribePRTool` | `KAIROS_GITHUB_WEBHOOKS` | 订阅 GitHub PR 事件 |
| `RemoteTriggerTool` | `AGENT_TRIGGERS_REMOTE` | 远程触发器 |
| `CronCreateTool` | 始终加载 | 创建定时任务 |
| `CronDeleteTool` | 始终加载 | 删除定时任务 |
| `CronListTool` | 始终加载 | 列出定时任务 |
| `EnterWorktreeTool` | Worktree 模式开启 | 进入 Git Worktree |
| `ExitWorktreeTool` | Worktree 模式开启 | 退出 Git Worktree |
| `TaskCreateTool` | TodoV2 开启 | 创建任务 |
| `TaskGetTool` | TodoV2 开启 | 获取任务 |
| `TaskUpdateTool` | TodoV2 开启 | 更新任务 |
| `TaskListTool` | TodoV2 开启 | 列出任务 |
| `ToolSearchTool` | ToolSearch 启用 | 搜索延迟加载的工具 |
| `PowerShellTool` | Windows 环境 | PowerShell 执行 |
| `LSPTool` | `ENABLE_LSP_TOOL` 环境变量 | LSP 语言服务器交互 |
| `TeamCreateTool` | Agent Swarms 开启 | 创建团队 |
| `TeamDeleteTool` | Agent Swarms 开启 | 删除团队 |
| `VerifyPlanExecutionTool` | `CLAUDE_CODE_VERIFY_PLAN` | 验证计划执行 |

---

## 每个工具的三文件结构

```
src/tools/BashTool/
+-- BashTool.ts    # 工具定义：name、inputSchema、call()、isReadOnly() 等
+-- prompt.ts      # Claude 看到的工具使用说明文本
+-- UI.tsx         # 用户在终端看到的 Ink 渲染组件
```

部分工具还包含 `shared/` 目录（如 `tools/shared/`，存放跨工具复用的逻辑）和 `utils.ts`。

---

## Tool 接口核心字段

```typescript
type Tool = {
  name: string                           // 工具唯一标识
  description?: string                   // Claude 看到的功能描述
  inputSchema: ToolInputJSONSchema       // Zod 生成的 JSON Schema
  call(input, context): Promise<ToolResult>  // 工具执行函数
  prompt?: string | (() => string)       // 详细使用说明

  // 安全属性
  isEnabled(): boolean                   // 工具是否可用（默认 true）
  isReadOnly(): boolean                  // 是否只读（默认 false，安全优先）
  isConcurrencySafe(): boolean           // 能否并行执行（默认 false，安全优先）

  // UI
  renderToolUse?(input): ReactNode       // 终端渲染
  renderToolResult?(result): ReactNode   // 结果渲染
}
```

---

## 安全属性

| 属性 | 默认值 | 含义 |
|------|--------|------|
| `isEnabled()` | `true` | 工具是否可用 |
| `isConcurrencySafe()` | **`false`** | 能否并行执行（安全优先：默认串行） |
| `isReadOnly()` | **`false`** | 是否只读（安全优先：默认视为有写操作） |

`buildTool()` 工厂函数提供这些安全的默认值。工具需要显式声明自己是只读或并发安全的。

---

## 工具注册流程

```
1. getAllBaseTools()
   |--- 返回所有内建工具的数组（58+）
   |--- 通过 feature() / process.env 条件过滤
   |
2. assembleToolPool(baseTools, mcpTools, pluginTools)
   |--- 合并内建工具 + MCP 动态工具 + 插件工具
   |--- 去重（uniqBy name）
   |--- 应用 deny 规则（getDenyRuleForTool）
   |
3. getTools(toolPermissionContext)
   |--- 检查嵌入式搜索工具（bfs/ugrep）
   |--- 如有嵌入工具则移除 Glob/Grep
   |--- 返回最终工具池
```

---

## MCP 工具集成

MCP（Model Context Protocol）工具通过以下流程集成：

1. `services/mcp/MCPConnectionManager.tsx` 管理 MCP 服务器连接
2. 连接建立后，MCP 服务器暴露的工具被转换为 `Tool` 接口
3. `assembleToolPool()` 将 MCP 工具与内建工具合并
4. 工具名自动加 `mcp__serverName__` 前缀避免冲突

---

## 设计模式

- **工厂模式**：`buildTool()` 提供安全的默认值，所有工具通过统一工厂创建
- **Schema 驱动**：Zod schema 同时用于运行时验证、TypeScript 类型推导、API 描述生成
- **关注点分离**：逻辑（`Tool.ts`）/ 提示词（`prompt.ts`）/ UI（`UI.tsx`）三层独立
- **权限前置**：`canUseTool()` 在任何执行前必须通过权限检查
- **条件加载 + DCE**：通过 `feature()` 和 `process.env` 条件导入，构建时死代码消除
- **延迟求值**：部分工具（TeamCreate、TeamDelete、SendMessage、PowerShell）使用 `require()` 打破循环依赖

---

## 常见问题

**Q: 工具数量为什么是 58+ 而不是固定数字？**
A: 因为多个工具受 feature gate 和环境变量控制，不同构建配置下实际可用的工具数量不同。`getAllBaseTools()` 返回当前环境下所有合法的工具。

**Q: 嵌入式搜索工具是什么？**
A: Anthropic 内部构建时，将 `bfs`（快速 find）和 `ugrep`（快速 grep）嵌入 Bun 二进制。此时 Shell 中的 find/grep 已被别名到这些快速工具，所以专用的 `GlobTool` 和 `GrepTool` 变得冗余，会被自动移除。

**Q: 如何添加自定义工具？**
A: 三种方式：(1) 在 `src/tools/` 下创建新目录并在 `getAllBaseTools()` 中注册；(2) 通过 MCP 服务器暴露工具；(3) 通过插件系统加载。
